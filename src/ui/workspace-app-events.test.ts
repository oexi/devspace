import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { acceptsToolResult, toolResultFromChatGptGlobals } from "./tool-result.js";

// Exercise the actual browser event handler without starting a task provider.
const source = readFileSync(new URL("./workspace-app.tsx", import.meta.url), "utf8");
const start = source.indexOf("function handleChatGptGlobalsChanged(");
const end = source.indexOf("\nfunction applyHostContext", start);
assert.ok(start >= 0 && end > start);
const handler = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test("ChatGPT result events refresh an existing task card but ignore workspace and theme events", () => {
  const applied: unknown[] = [];
  const context = {
    connected: true,
    card: { tool: "task" },
    document: { documentElement: { dataset: { cardKind: "task" } } },
    acceptsToolResult,
    toolResultFromChatGptGlobals,
    chatGptRestoredResult: () => undefined,
    applyToolResult: (result: unknown) => { applied.push(result); },
  };
  const dispatch = runInNewContext(`${handler}\nhandleChatGptGlobalsChanged`, context);
  dispatch({ detail: { globals: { toolOutput: {
    taskId: "task_1", operation: "run_task", status: "completed", target: "codex",
  } } } });
  assert.equal(applied.length, 1);
  dispatch({ detail: { globals: { toolOutput: {
    workspaceId: "ws_1", root: "/tmp/project", mode: "checkout",
  } } } });
  dispatch({ detail: { globals: { theme: "dark" } } });
  assert.equal(applied.length, 1);
});

test("unrelated result cannot replace a queued workspace result during connection", () => {
  const pending = { content: [], structuredContent: {
    workspaceId: "ws_1", root: "/tmp/project", mode: "checkout",
  } };
  const context = {
    connected: false,
    pendingToolResult: pending,
    document: { documentElement: { dataset: { cardKind: "open_workspace" } } },
    acceptsToolResult,
    toolResultFromChatGptGlobals,
    chatGptRestoredResult: () => undefined,
  };
  const dispatch = runInNewContext(`${handler}\nhandleChatGptGlobalsChanged`, context);
  dispatch({ detail: { globals: { toolOutput: {
    taskId: "task_1", operation: "run_task", status: "completed", target: "codex",
  } } } });
  assert.equal(context.pendingToolResult, pending);
});
