import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import {
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./tool-surfaces/shared.js";
import {
  SHELL_TOOL_ANNOTATIONS,
  workspaceIdDescription,
} from "./tool-surfaces/types.js";
import type { WorkspaceRegistry } from "./workspaces.js";

export const RUN_TASK_TOOL_NAME = "run_task";
export const WAIT_TASK_TOOL_NAME = "wait_task";

// Keep one host-visible wait within the same practical window as long command
// calls. Long tasks remain inspectable through wait_task without rapid MCP
// polling or depending on an unusually long host request timeout.
export const TASK_WAIT_MS = 30_000;
const TASK_POLL_INTERVAL_MS = 1_000;

export type LocalTaskAgentClient = Pick<LocalAgentClient, "start" | "get">;

export interface LocalTaskToolOptions {
  server: McpServer;
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
  return ` For multi-step coding work that would otherwise require several reads, edits, and command calls, prefer ${RUN_TASK_TOOL_NAME} as one bounded implementation task. Keep host orchestration explicit: use it for one coherent task, not as an opaque replacement for the whole conversation. If it returns running, use ${WAIT_TASK_TOOL_NAME}; do not rapidly poll the same work with low-level tools. After the task finishes, use low-level tools only for targeted follow-up and call show_changes once if files changed.`;
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
  });

  server.registerTool(
    RUN_TASK_TOOL_NAME,
    {
      title: "Run coding task",
      description:
        "Delegate one coherent multi-step coding task to a bounded local worker in the current workspace. Prefer this when the task would otherwise require several separate read/edit/command calls. The call waits for useful progress; if the worker is still running, continue with wait_task instead of low-level polling.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        instruction: z
          .string()
          .trim()
          .min(1)
          .describe(
            "One coherent coding task with its requirements and validation goal. Do not split routine implementation steps into separate run_task calls.",
          ),
      },
      outputSchema,
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, instruction }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const catalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const target = selectDefaultTaskTarget(catalog);
      const scope = { workspaceId, workspaceRoot: workspace.root };

      const record = await reviewCheckpoints.trackWorkspaceOperation(
        { workspaceId, root: workspace.root },
        () => startAndWaitForTask(client, {
          target,
          instruction,
          scope,
        }),
        (result) => ({
          sessionId: taskReviewSessionId(result.id),
          running: isTaskRunning(result),
        }),
      );
      const response = taskToolResponse(record);
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
      },
      outputSchema,
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, taskId }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const scope = { workspaceId, workspaceRoot: workspace.root };
      const record = await reviewCheckpoints.trackProcessOperation(
        {
          workspaceId,
          root: workspace.root,
          sessionId: taskReviewSessionId(taskId),
        },
        () => getAndWaitForTask(client, taskId, scope),
        (result) => ({
          sessionId: taskReviewSessionId(result.id),
          running: isTaskRunning(result),
        }),
      );
      const response = taskToolResponse(record);
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

function taskToolResponse(record: LocalAgentRecord) {
  const observation = presentAgentObservation(record);
  const result = observation.status === "running"
    ? `${record.id} running\n\nThe coding task is still running. Call ${WAIT_TASK_TOOL_NAME} with this taskId and the same workspaceId; do not poll it with low-level tools.`
    : formatAgentObservation(observation);

  return {
    content: [textBlock(result)],
    structuredContent: {
      result,
      taskId: record.id,
      status: observation.status,
      target: record.profileName,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
