import assert from "node:assert/strict";
import test from "node:test";
import { isExpandableCard, isInitiallyExpandedCard } from "./card-types.js";

test("aggregate review opens when a patch is available", () => {
  const card = {
    tool: "show_changes" as const,
    files: [{ path: "src/a.ts", type: "change" as const }],
    payload: { patch: "diff --git a/src/a.ts b/src/a.ts" },
  };
  assert.equal(isExpandableCard(card), true);
});

test("workspace details open only when there is useful context", () => {
  assert.equal(isExpandableCard({ tool: "open_workspace" }), false);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    instruction: "Reuse this workspace.",
  }), false);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    skills: [{ name: "research" }],
  }), true);
  assert.equal(isExpandableCard({
    tool: "open_workspace",
    review: { available: false, reason: "Not a Git repository." },
  }), true);
});

test("workspace details stay compact unless they need attention", () => {
  assert.equal(isInitiallyExpandedCard({
    tool: "open_workspace",
    skills: [{ name: "research" }],
  }), false);
  assert.equal(isInitiallyExpandedCard({
    tool: "open_workspace",
    review: { available: false, reason: "Not a Git repository." },
  }), true);
  assert.equal(isInitiallyExpandedCard({
    tool: "open_workspace",
    worktree: { dirtySource: true },
  }), true);
});

test("failed task cards expand automatically while successful tasks stay compact", () => {
  const baseTask = {
    operation: "run_task" as const,
    taskId: "agt_1",
    target: "codex",
    result: "Done.",
  };
  assert.equal(isInitiallyExpandedCard({
    tool: "task",
    task: { ...baseTask, status: "completed" },
  }), false);
  assert.equal(isInitiallyExpandedCard({
    tool: "task",
    task: {
      ...baseTask,
      status: "failed",
      error: { code: "FAILED", message: "Nope", retryable: false },
    },
  }), true);
});
