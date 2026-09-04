import assert from "node:assert/strict";
import test from "node:test";
import { Result } from "better-result";
import {
  selectDefaultTaskTarget,
  startAndWaitForTask,
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
  assert.equal(
    selectDefaultTaskTarget({ ...catalog, profiles: [] }),
    "codex",
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
