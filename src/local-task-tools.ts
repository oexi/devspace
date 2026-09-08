import * as z from "zod/v4";
import {
  buildLocalAgentCatalog,
  type LocalAgentCatalog,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import {
  createLocalAgentClient,
  type LocalAgentClient,
} from "./local-agent-client.js";
import {
  formatAgentObservation,
  presentAgentObservation,
} from "./local-agent-presentation.js";
import type { LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";
import type { ServerConfig } from "./config.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import {
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  SHELL_TOOL_ANNOTATIONS,
  workspaceIdDescription,
} from "./tool-surfaces/types.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const RUN_TASK_TOOL_NAME = "run_task";
export const CONTINUE_TASK_TOOL_NAME = "continue_task";
export const CANCEL_TASK_TOOL_NAME = "cancel_task";
export const WAIT_TASK_TOOL_NAME = "wait_task";

// Keep one host-visible wait within the same practical window as long command
// calls. Long tasks remain inspectable through wait_task without rapid MCP
// polling or depending on an unusually long host request timeout.
export const TASK_WAIT_MS = 90_000;
export const MAX_TASK_WAIT_MS = 110_000;
const TASK_POLL_INTERVAL_MS = 1_000;

export type LocalTaskAgentClient = Pick<LocalAgentClient, "start" | "continue" | "cancel" | "get">;

export interface LocalTaskToolOptions {
  server: McpRegistrationTarget;
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  reviewCheckpoints: ReviewCheckpointManager;
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[];
  client?: LocalTaskAgentClient;
}

export interface WaitForTaskOptions {
  waitMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function localTaskInstructions(enabled: boolean): string {
  if (!enabled) return "";
  return ` For multi-step coding work that would otherwise require several reads, edits, and command calls, prefer ${RUN_TASK_TOOL_NAME} as one bounded implementation task. Keep host orchestration explicit: use it for one coherent task, not as an opaque replacement for the whole conversation. When open_workspace exposes a suitable agent profile or provider, pass it as run_task target. If the same worker should address follow-up findings, use ${CONTINUE_TASK_TOOL_NAME} instead of starting a new worker. If a running worker should stop, use ${CANCEL_TASK_TOOL_NAME}; cancellation is scoped to that task and does not close a shared provider runtime. If run_task or continue_task returns running, use ${WAIT_TASK_TOOL_NAME}; do not rapidly poll the same work with low-level tools. After the task finishes or is cancelled, use low-level tools only for targeted follow-up and call show_changes once if files changed.`;
}

export function registerLocalTaskTools(options: LocalTaskToolOptions): void {
  const {
    server,
    config,
    workspaces,
    reviewCheckpoints,
    resolveLocalAgentProviders,
  } = options;
  if (!config.subagents.enabled) return;

  const client = options.client ?? createLocalAgentClient(config);
  const outputSchema = resultOutputSchema({
    taskId: z.string(),
    status: z.enum(["running", "completed", "failed", "stopped"]),
    target: z.string(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .optional(),
    nextAction: z.string().optional(),
  });
  const cancelOutputSchema = resultOutputSchema({
    taskId: z.string(),
    status: z.enum(["running", "completed", "failed", "stopped"]),
    target: z.string(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
      })
      .optional(),
    cancelRequested: z.boolean(),
    cancelAcknowledged: z.boolean(),
    nextAction: z.string().optional(),
  });
  const waitInputSchema = z
    .number()
    .int()
    .min(0)
    .max(MAX_TASK_WAIT_MS)
    .optional()
    .describe(
      `Milliseconds to wait locally before returning a still-running task. Defaults to ${TASK_WAIT_MS}; use a longer wait to reduce repeated host-visible polling calls.`,
    );

  server.registerTool(
    RUN_TASK_TOOL_NAME,
    {
      title: "Run coding task",
      description:
        "Delegate one coherent multi-step coding task to a bounded local worker in the current workspace. Prefer this when the task would otherwise require several separate read/edit/command calls. The call waits for useful progress; if the worker is still running, continue with wait_task instead of low-level polling.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        target: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional agent profile or provider returned by open_workspace. Defaults to the profile named default, otherwise the first usable provider.",
          ),
        instruction: z
          .string()
          .trim()
          .min(1)
          .describe(
            "One coherent coding task with its requirements and validation goal. Do not split routine implementation steps into separate run_task calls.",
          ),
        yieldTimeMs: waitInputSchema,
      },
      outputSchema,
      ...workspaceAppDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, target: requestedTarget, instruction, yieldTimeMs }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const catalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const target = selectTaskTarget(catalog, requestedTarget);
      const scope = { workspaceId, workspaceRoot: workspace.root };

      const record = await reviewCheckpoints.trackWorkspaceOperation(
        { workspaceId, root: workspace.root },
        () => startAndWaitForTask(client, {
          target,
          instruction,
          scope,
        }, { waitMs: yieldTimeMs }),
        (result) => ({
          sessionId: taskReviewSessionId(result.id),
          running: isTaskRunning(result),
        }),
      );
      const response = taskToolResponse(record, RUN_TASK_TOOL_NAME);
      logToolCall(config, {
        tool: RUN_TASK_TOOL_NAME,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    },
  );

  server.registerTool(
    CONTINUE_TASK_TOOL_NAME,
    {
      title: "Continue coding task",
      description:
        "Continue an existing run_task worker with follow-up instructions so it can reuse its provider session and prior context. Prefer this over starting a new worker when reviewing or refining the same task. If it remains running, use wait_task.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z
          .string()
          .min(1)
          .describe("Task identifier returned by run_task or a previous continue_task call."),
        instruction: z
          .string()
          .trim()
          .min(1)
          .describe("Follow-up instruction for the existing worker."),
        yieldTimeMs: waitInputSchema,
      },
      outputSchema,
      ...workspaceAppDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, instruction, yieldTimeMs }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const scope = { workspaceId, workspaceRoot: workspace.root };
      const record = await reviewCheckpoints.trackProcessOperation(
        {
          workspaceId,
          root: workspace.root,
          sessionId: taskReviewSessionId(taskId),
        },
        () => continueAndWaitForTask(client, taskId, instruction, scope, {
          waitMs: yieldTimeMs,
        }),
        (result) => ({
          sessionId: taskReviewSessionId(result.id),
          running: isTaskRunning(result),
        }),
      );
      const response = taskToolResponse(record, CONTINUE_TASK_TOOL_NAME);
      logToolCall(config, {
        tool: CONTINUE_TASK_TOOL_NAME,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    },
  );

  server.registerTool(
    CANCEL_TASK_TOOL_NAME,
    {
      title: "Cancel coding task",
      description:
        "Cancel the active turn for one run_task worker without closing a shared provider runtime. Cancellation is idempotent: already-finished tasks keep their terminal status. Files changed before cancellation remain in the workspace and are still visible to show_changes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z
          .string()
          .min(1)
          .describe("Task identifier returned by run_task or continue_task."),
      },
      outputSchema: cancelOutputSchema,
      ...workspaceAppDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const scope = { workspaceId, workspaceRoot: workspace.root };
      const outcome = await reviewCheckpoints.trackProcessOperation(
        {
          workspaceId,
          root: workspace.root,
          sessionId: taskReviewSessionId(taskId),
        },
        () => cancelTask(client, taskId, scope),
        (result) => ({
          sessionId: taskReviewSessionId(result.record.id),
          running: isTaskRunning(result.record),
        }),
      );
      const response = cancelTaskToolResponse(outcome.record, outcome.cancelRequested);
      logToolCall(config, {
        tool: CANCEL_TASK_TOOL_NAME,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    },
  );

  server.registerTool(
    WAIT_TASK_TOOL_NAME,
    {
      title: "Wait for coding task",
      description:
        "Wait for a run_task worker that is still running. This performs a long local wait before returning, so use one wait_task call rather than frequent polling. Do not use it for exec_command process sessions.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        taskId: z
          .string()
          .min(1)
          .describe("Task identifier returned by run_task."),
        yieldTimeMs: waitInputSchema,
      },
      outputSchema,
      ...workspaceAppDescriptorMeta(config),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId, yieldTimeMs }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const scope = { workspaceId, workspaceRoot: workspace.root };
      const record = await reviewCheckpoints.trackProcessOperation(
        {
          workspaceId,
          root: workspace.root,
          sessionId: taskReviewSessionId(taskId),
        },
        () => getAndWaitForTask(client, taskId, scope, { waitMs: yieldTimeMs }),
        (result) => ({
          sessionId: taskReviewSessionId(result.id),
          running: isTaskRunning(result),
        }),
      );
      const response = taskToolResponse(record, WAIT_TASK_TOOL_NAME);
      logToolCall(config, {
        tool: WAIT_TASK_TOOL_NAME,
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    },
  );
}

export async function cancelTask(
  client: LocalTaskAgentClient,
  taskId: string,
  scope: LocalAgentWorkspaceScope,
): Promise<{ record: LocalAgentRecord; cancelRequested: boolean }> {
  const loaded = await client.get(taskId, scope);
  if (loaded.isErr()) throw loaded.error;
  if (!isTaskRunning(loaded.value)) {
    return { record: loaded.value, cancelRequested: false };
  }
  const cancelled = await client.cancel(taskId, scope);
  if (cancelled.isErr()) throw cancelled.error;
  return { record: cancelled.value, cancelRequested: true };
}

export function selectTaskTarget(
  catalog: LocalAgentCatalog,
  requestedTarget?: string,
): string {
  const requested = requestedTarget?.trim();
  if (!requested) return selectDefaultTaskTarget(catalog);
  if (catalog.profiles.some((profile) => profile.name === requested)) return requested;
  if (catalog.providers.some((provider) => provider.id === requested && provider.usable)) {
    return requested;
  }

  const availableTargets = [
    ...catalog.profiles.map((profile) => profile.name),
    ...catalog.providers.filter((provider) => provider.usable).map((provider) => provider.id),
  ];
  throw new Error(
    availableTargets.length > 0
      ? `Unknown or unavailable subagent target: ${requested}. Available targets: ${availableTargets.join(", ")}.`
      : `Unknown or unavailable subagent target: ${requested}. No usable subagent target is currently available.`,
  );
}

export function selectDefaultTaskTarget(catalog: LocalAgentCatalog): string {
  const defaultProfile = catalog.profiles.find((profile) => profile.name === "default");
  if (defaultProfile) return defaultProfile.name;

  const provider = catalog.providers.find((candidate) => candidate.usable);
  if (provider) return provider.id;

  throw new Error(
    "run_task requires at least one enabled and available subagent provider. Use the low-level workspace tools or enable a subagent provider.",
  );
}

export async function startAndWaitForTask(
  client: LocalTaskAgentClient,
  input: {
    target: string;
    instruction: string;
    scope: LocalAgentWorkspaceScope;
  },
  waitOptions: WaitForTaskOptions = {},
): Promise<LocalAgentRecord> {
  const started = await client.start({
    target: input.target,
    prompt: taskPrompt(input.instruction),
    workspaceRoot: input.scope.workspaceRoot,
    workspaceId: input.scope.workspaceId,
    writeMode: "allowed",
  });
  if (started.isErr()) throw started.error;
  return waitForTaskRecord(client, started.value, input.scope, waitOptions);
}

export async function continueAndWaitForTask(
  client: LocalTaskAgentClient,
  taskId: string,
  instruction: string,
  scope: LocalAgentWorkspaceScope,
  waitOptions: WaitForTaskOptions = {},
): Promise<LocalAgentRecord> {
  const continued = await client.continue(
    taskId,
    taskContinuationPrompt(instruction),
    { writeMode: "allowed" },
    scope,
  );
  if (continued.isErr()) throw continued.error;
  return waitForTaskRecord(client, continued.value, scope, waitOptions);
}

export async function getAndWaitForTask(
  client: LocalTaskAgentClient,
  taskId: string,
  scope: LocalAgentWorkspaceScope,
  waitOptions: WaitForTaskOptions = {},
): Promise<LocalAgentRecord> {
  const loaded = await client.get(taskId, scope);
  if (loaded.isErr()) throw loaded.error;
  return waitForTaskRecord(client, loaded.value, scope, waitOptions);
}

export async function waitForTaskRecord(
  client: LocalTaskAgentClient,
  initial: LocalAgentRecord,
  scope: LocalAgentWorkspaceScope,
  options: WaitForTaskOptions = {},
): Promise<LocalAgentRecord> {
  const waitMs = options.waitMs ?? TASK_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, waitMs);
  let record = initial;

  while (isTaskRunning(record) && now() < deadline) {
    const remaining = Math.max(0, deadline - now());
    await sleep(Math.min(Math.max(1, pollIntervalMs), remaining));
    const refreshed = await client.get(record.id, scope);
    if (refreshed.isErr()) throw refreshed.error;
    record = refreshed.value;
  }

  return record;
}

function isTaskRunning(record: LocalAgentRecord): boolean {
  return record.status === "starting" || record.status === "running";
}

function taskReviewSessionId(taskId: string): string {
  return `task:${taskId}`;
}

function taskPrompt(instruction: string): string {
  return [
    "Complete this bounded coding task in the provided workspace.",
    "Inspect and follow applicable project instruction files before changing files.",
    "Make only changes needed for the requested task and run focused validation that meaningfully checks the result.",
    "Do not create commits, push, or broaden the task unless the task explicitly asks for it.",
    "Return a concise outcome summary including validation performed and any unresolved issue.",
    "",
    "Task:",
    instruction.trim(),
  ].join("\n");
}

function taskContinuationPrompt(instruction: string): string {
  return [
    "Continue the existing bounded coding task in the same workspace.",
    "Reuse the context you already gathered. Inspect additional files only when the follow-up requires it.",
    "Make only changes needed for this follow-up and run focused validation that meaningfully checks the result.",
    "Do not create commits, push, or broaden the task unless the follow-up explicitly asks for it.",
    "Return a concise outcome summary including validation performed and any unresolved issue.",
    "",
    "Follow-up:",
    instruction.trim(),
  ].join("\n");
}

function taskToolResponse(
  record: LocalAgentRecord,
  operation: typeof RUN_TASK_TOOL_NAME | typeof CONTINUE_TASK_TOOL_NAME | typeof WAIT_TASK_TOOL_NAME,
) {
  const observation = presentAgentObservation(record);
  const result = observation.status === "running"
    ? `${record.id} running\n\nThe coding task is still running. Call ${WAIT_TASK_TOOL_NAME} with this taskId and the same workspaceId; do not poll it with low-level tools.`
    : formatAgentObservation(observation);
  const error = "error" in observation ? observation.error : undefined;

  return {
    content: [textBlock(result)],
    _meta: {
      card: { tool: "task", operation },
    },
    structuredContent: {
      result,
      taskId: record.id,
      status: observation.status,
      target: record.profileName,
      ...(error ? { error } : {}),
      ...(observation.status === "running"
        ? { nextAction: `Call ${WAIT_TASK_TOOL_NAME} with this taskId and workspaceId.` }
        : {}),
    },
  };
}

function cancelTaskToolResponse(record: LocalAgentRecord, cancelRequested: boolean) {
  const observation = presentAgentObservation(record);
  const cancelAcknowledged = cancelRequested && observation.status === "stopped";
  const result = !cancelRequested
    ? `${formatAgentObservation(observation)}\n\nThe task was already terminal; no cancellation was needed.`
    : cancelAcknowledged
      ? formatAgentObservation(observation)
      : observation.status === "running"
        ? `${record.id} running\n\nCancellation was requested but the provider has not finished stopping the turn yet. Call ${WAIT_TASK_TOOL_NAME} once to observe the terminal state.`
        : `${formatAgentObservation(observation)}\n\nThe task reached a terminal state before cancellation was acknowledged.`;
  const error = "error" in observation ? observation.error : undefined;
  return {
    content: [textBlock(result)],
    _meta: {
      card: { tool: "task", operation: CANCEL_TASK_TOOL_NAME },
    },
    structuredContent: {
      result,
      taskId: record.id,
      status: observation.status,
      target: record.profileName,
      ...(error ? { error } : {}),
      cancelRequested,
      cancelAcknowledged,
      ...(cancelRequested && observation.status === "running"
        ? { nextAction: `Call ${WAIT_TASK_TOOL_NAME} with this taskId and workspaceId.` }
        : {}),
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
