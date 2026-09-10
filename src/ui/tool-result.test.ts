import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  decodeToolResult,
  acceptsToolResult,
  toolResultFromChatGptGlobals,
} from "./tool-result.js";

test("card templates reject results from other tool families on initial load and restoration", () => {
  const workspace: CallToolResult = { content: [], structuredContent: {
    workspaceId: "ws_1", root: "/tmp/project", mode: "checkout",
  } };
  const taskResult: CallToolResult = { content: [], structuredContent: {
    taskId: "task_1", operation: "run_task", status: "running", target: "codex",
  } };
  const review: CallToolResult = { content: [], structuredContent: {
    workspaceId: "ws_1", reviewRef: "a".repeat(40),
  } };
  const cases = [["open_workspace", workspace], ["task", taskResult], ["show_changes", review]] as const;
  for (const [kind] of cases) {
    for (const [resultKind, result] of cases) {
      assert.equal(acceptsToolResult(result, kind), kind === resultKind);
    }
    assert.equal(acceptsToolResult({ content: [] }, kind), false);
  }
  assert.equal(acceptsToolResult({ ...taskResult, structuredContent: {
    taskId: "task_1", operation: "run_task", status: "completed", target: "codex",
  } }, "task"), true);
});

test("current task output takes precedence over stale metadata operation", () => {
  const decoded = decodeToolResult({ content: [], structuredContent: {
    taskId: "task_1", operation: "wait_task", status: "completed", target: "codex",
  }, _meta: { card: { tool: "task", operation: "run_task" } } });
  assert.equal(decoded.kind, "card");
  if (decoded.kind === "card") assert.equal(decoded.card.task?.operation, "wait_task");
});

test("workspace cards can be rebuilt from structured content without result metadata", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      root: "/tmp/project",
      mode: "checkout",
      skills: [{ name: "tdd", description: "Tests first", path: "/tmp/tdd/SKILL.md" }],
      agentsFiles: [{ path: "AGENTS.md", content: "instructions" }],
      review: { available: true },
      instruction: "Reuse this workspace.",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "open_workspace");
  assert.equal(decoded.card.workspaceId, "ws_1");
  assert.equal(decoded.card.summary?.skills, 1);
  assert.equal(decoded.card.summary?.agentsFiles, 1);
});

test("review results use rich metadata when the host provides it", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "a".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
        files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
        payload: { patch: "diff --git ..." },
      },
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git ...");
});

test("task results render as task cards when the tool carries the DevSpace app", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      result: "agt_1 completed\n\nDone.",
      taskId: "agt_1",
      status: "completed",
      target: "codex",
    },
    _meta: {
      card: { tool: "task", operation: "run_task" },
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "task");
  assert.equal(decoded.card.task?.taskId, "agt_1");
  assert.equal(decoded.card.task?.status, "completed");
  assert.equal(decoded.card.task?.operation, "run_task");
});

test("task results can be rebuilt without result metadata", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      operation: "run_task",
      taskId: "agt_1",
      status: "failed",
      target: "codex",
      result: "agt_1 failed",
      error: {
        code: "PROVIDER_EXECUTION_ERROR",
        message: "provider failed",
        retryable: false,
      },
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "task");
  assert.equal(decoded.card.task?.operation, "run_task");
  assert.equal(decoded.card.task?.error?.message, "provider failed");
});

test("review structured content becomes a reload reference when metadata is missing", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "b".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "b".repeat(40),
  });
});

test("incomplete review metadata falls back to the durable review reference", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "e".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: { card: {} },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "e".repeat(40),
  });
});

test("older review results can reload from their structured patch", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      result: "Changed 1 file (+1 -0).",
      summary: { files: 1, additions: 1, removals: 0 },
      files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
      patch: "diff --git a/new.txt b/new.txt",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git a/new.txt b/new.txt");
});

test("ChatGPT globals restore structured output and hidden MCP result metadata together", () => {
  const fullResult: CallToolResult = {
    content: [{ type: "text", text: "Changed 1 file." }],
    structuredContent: { stale: true },
    _meta: { card: { workspaceId: "ws_1", payload: { patch: "patch" } } },
  };
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspaceId: "ws_1",
      reviewRef: "c".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      mcp_tool_result: fullResult,
    },
  });

  assert.deepEqual(restored?.structuredContent, {
    workspaceId: "ws_1",
    reviewRef: "c".repeat(40),
    result: "Changed 1 file.",
  });
  assert.deepEqual(restored?._meta, fullResult._meta);
});

test("ChatGPT globals also accept result metadata exposed directly", () => {
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspaceId: "ws_1",
      reviewRef: "d".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
      },
    },
  });

  assert.deepEqual(restored?._meta, {
    card: {
      workspaceId: "ws_1",
      summary: { files: 1, additions: 1, removals: 0 },
    },
  });
});
