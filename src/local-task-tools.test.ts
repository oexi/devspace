import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "better-result";
import {
  cancelTask,
  continueAndWaitForTask,
  MAX_TASK_WAIT_MS,
  selectDefaultTaskTarget,
  selectTaskTarget,
  startAndWaitForTask,
  TASK_WAIT_MS,
  waitForTaskRecord,
  type LocalTaskAgentClient,
} from "./local-task-tools.js";
import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentRecord } from "./local-agent-store.js";

test("task target selection prefers an explicit default profile then a usable provider", () => {
  const catalog: LocalAgentCatalog = {
    enabled: true,
    providers: [
      { id: "codex", enabled: true, available: true, usable: true },
      { id: "claude", enabled: true, available: true, usable: true },
    ],
    profiles: [{
      name: "default",
      description: "General implementation worker.",
      provider: "claude",
    }],
  };

  assert.equal(selectDefaultTaskTarget(catalog), "default");
  assert.equal(selectTaskTarget(catalog, "default"), "default");
  assert.equal(selectTaskTarget(catalog, "codex"), "codex");
  assert.equal(
    selectDefaultTaskTarget({ ...catalog, profiles: [] }),
    "codex",
  );
  assert.throws(
    () => selectTaskTarget(catalog, "missing"),
    /Available targets: default, codex, claude/,
  );
  assert.throws(
    () => selectDefaultTaskTarget({
      enabled: true,
      providers: [{ id: "codex", enabled: true, available: false, usable: false }],
      profiles: [],
    }),
    /requires at least one enabled and available subagent provider/,
  );
});

test("task waits use a long host-friendly default with the same upper bound as process polling", () => {
  assert.equal(TASK_WAIT_MS, 90_000);
  assert.equal(MAX_TASK_WAIT_MS, 110_000);
});

test("run_task worker polling stays internal until the bounded task completes", async () => {
  const running = agentRecord({ status: "running" });
  const completed = agentRecord({
    status: "idle",
    latestResponse: "implemented and tested",
  });
  let prompt = "";
  let writeMode = "";
  let getCalls = 0;
  const client = {
    async start(input) {
      prompt = input.prompt;
      writeMode = input.writeMode ?? "";
      return Result.ok(running);
    },
    async get() {
      getCalls += 1;
      return Result.ok(getCalls === 1 ? running : completed);
    },
    async continue() {
      return Result.ok(running);
    },
    async cancel() {
      return Result.ok(agentRecord({ status: "stopped", errorCode: "PROVIDER_CANCELLED" }));
    },
  } satisfies LocalTaskAgentClient;

  const result = await startAndWaitForTask(client, {
    target: "codex",
    instruction: "Fix the parser and run focused tests.",
    scope: {
      workspaceId: "ws_task",
      workspaceRoot: "/tmp/project",
    },
  }, {
    waitMs: 1_000,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });

  assert.equal(result.status, "idle");
  assert.equal(result.latestResponse, "implemented and tested");
  assert.equal(getCalls, 2);
  assert.equal(writeMode, "allowed");
  assert.match(prompt, /bounded coding task/);
  assert.match(prompt, /Fix the parser and run focused tests/);
  assert.match(prompt, /Do not create commits, push/);
});

test("continue_task reuses the same logical worker and waits for its follow-up", async () => {
  const running = agentRecord({ status: "running", profileName: "reviewer" });
  const completed = agentRecord({
    status: "idle",
    profileName: "reviewer",
    latestResponse: "follow-up fixed and tested",
  });
  let continuedId = "";
  let continuedPrompt = "";
  let writeMode = "";
  let getCalls = 0;
  const client = {
    async start() {
      return Result.ok(running);
    },
    async continue(agentId, prompt, overrides) {
      continuedId = agentId;
      continuedPrompt = prompt;
      writeMode = overrides?.writeMode ?? "";
      return Result.ok(running);
    },
    async get() {
      getCalls += 1;
      return Result.ok(completed);
    },
    async cancel() {
      return Result.ok(agentRecord({ status: "stopped", errorCode: "PROVIDER_CANCELLED" }));
    },
  } satisfies LocalTaskAgentClient;

  const result = await continueAndWaitForTask(
    client,
    "agt_task",
    "Address the review finding and rerun the focused test.",
    { workspaceId: "ws_task", workspaceRoot: "/tmp/project" },
    {
      waitMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    },
  );

  assert.equal(result.status, "idle");
  assert.equal(result.latestResponse, "follow-up fixed and tested");
  assert.equal(continuedId, "agt_task");
  assert.equal(writeMode, "allowed");
  assert.equal(getCalls, 1);
  assert.match(continuedPrompt, /Continue the existing bounded coding task/);
  assert.match(continuedPrompt, /Address the review finding/);
});

test("wait_task can return a still-running task without rapid polling", async () => {
  const running = agentRecord({ status: "running" });
  let getCalls = 0;
  const client = {
    async start() {
      return Result.ok(running);
    },
    async get() {
      getCalls += 1;
      return Result.ok(running);
    },
    async continue() {
      return Result.ok(running);
    },
    async cancel() {
      return Result.ok(agentRecord({ status: "stopped", errorCode: "PROVIDER_CANCELLED" }));
    },
  } satisfies LocalTaskAgentClient;

  const result = await waitForTaskRecord(
    client,
    running,
    { workspaceId: "ws_task", workspaceRoot: "/tmp/project" },
    { waitMs: 0 },
  );

  assert.equal(result.status, "running");
  assert.equal(getCalls, 0);
});

test("cancel_task requests cancellation only for a running task", async () => {
  const running = agentRecord({ status: "running" });
  const stopped = agentRecord({
    status: "stopped",
    error: "Subagent turn was cancelled.",
    errorCode: "PROVIDER_CANCELLED",
    errorRetryable: false,
  });
  let cancelCalls = 0;
  const client = {
    async start() { return Result.ok(running); },
    async continue() { return Result.ok(running); },
    async get() { return Result.ok(running); },
    async cancel() {
      cancelCalls += 1;
      return Result.ok(stopped);
    },
  } satisfies LocalTaskAgentClient;

  const outcome = await cancelTask(
    client,
    running.id,
    { workspaceId: "ws_task", workspaceRoot: "/tmp/project" },
  );
  assert.equal(outcome.cancelRequested, true);
  assert.equal(outcome.record.status, "stopped");
  assert.equal(cancelCalls, 1);

  const terminalClient = {
    ...client,
    async get() { return Result.ok(stopped); },
  } satisfies LocalTaskAgentClient;
  const terminal = await cancelTask(
    terminalClient,
    stopped.id,
    { workspaceId: "ws_task", workspaceRoot: "/tmp/project" },
  );
  assert.equal(terminal.cancelRequested, false);
  assert.equal(cancelCalls, 1, "terminal tasks remain idempotent and do not call cancel again");
});

function agentRecord(
  overrides: Partial<LocalAgentRecord> = {},
): LocalAgentRecord {
  return {
    id: "agt_task",
    workspaceId: "ws_task",
    workspaceRoot: "/tmp/project",
    profileName: "codex",
    provider: "codex",
    status: "running",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}
