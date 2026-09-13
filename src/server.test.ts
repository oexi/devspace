import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Result } from "better-result";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import type { LocalTaskAgentClient } from "./local-task-tools.js";
import type { LocalAgentRecord } from "./local-agent-store.js";
import type { ClientMetadataDocumentResolver } from "./oauth-client-metadata.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import {
  createServer,
  mcpServerInstructions,
  registerMcpSurface,
} from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { workspaceAppUri } from "./workspace-app-resource.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { chatGptClientMetadata, mockClientMetadataEndpoint } from "./test-support/oauth-client-metadata.test.js";

const execFileAsync = promisify(execFile);

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: ["open_workspace", "read", "write", "edit", "bash", "show_changes"],
    },
    {
      mode: "codex",
      expected: ["open_workspace", "read", "apply_patch", "exec_command", "write_stdin", "show_changes"],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("enabled subagents expose bounded high-level task tools", async (t) => {
  const context = await fixture(t, {
    uiEnabled: true,
    localAgentProviders: [{ name: "codex", available: true }],
  });
  const tools = await context.client.listTools();
  const names = tools.tools.map((tool) => tool.name);

  assert.ok(names.includes("run_task"));
  assert.ok(names.includes("continue_task"));
  assert.ok(names.includes("cancel_task"));
  assert.ok(names.includes("wait_task"));
  assert.match(context.client.getInstructions() ?? "", /prefer run_task as one bounded implementation task/i);
  assert.match(context.client.getInstructions() ?? "", /use continue_task instead of starting a new worker/i);
  assert.match(context.client.getInstructions() ?? "", /use cancel_task/i);

  const runTask = tools.tools.find((tool) => tool.name === "run_task");
  const waitTask = tools.tools.find((tool) => tool.name === "wait_task");
  for (const [name, kind] of [["open_workspace", "open_workspace"], ["show_changes", "show_changes"]] as const) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.equal(tool?._meta?.["openai/outputTemplate"], workspaceAppUri(kind));
  }
  const resources = await context.client.listResources();
  for (const kind of ["open_workspace", "task", "show_changes"] as const) {
    assert.ok(resources.resources.some((resource) => resource.uri === workspaceAppUri(kind)));
    const resource = await context.client.readResource({ uri: workspaceAppUri(kind) });
    const content = resource.contents[0];
    assert.equal(content?.uri, workspaceAppUri(kind));
    assert.ok(content && "text" in content);
    assert.ok(content.text.includes(`data-card-kind="${kind}"`));
  }
  const targetSchema = runTask?.inputSchema?.properties?.target as {
    description?: string;
  } | undefined;
  const runYieldSchema = runTask?.inputSchema?.properties?.yieldTimeMs as {
    maximum?: number;
    description?: string;
  } | undefined;
  const waitYieldSchema = waitTask?.inputSchema?.properties?.yieldTimeMs as {
    maximum?: number;
    description?: string;
  } | undefined;

  assert.match(targetSchema?.description ?? "", /profile or provider returned by open_workspace/i);
  assert.equal(runYieldSchema?.maximum, 30_000);
  assert.match(runYieldSchema?.description ?? "", /Defaults to 25000/);
  assert.match(runYieldSchema?.description ?? "", /capped at 30000/);
  assert.equal(waitYieldSchema?.maximum, 30_000);

  for (const name of ["run_task", "continue_task", "cancel_task", "wait_task"]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    const ui = (tool?._meta as {
      ui?: { resourceUri?: string; visibility?: string[] };
    } | undefined)?.ui;
    assert.equal(ui?.resourceUri, workspaceAppUri("task"));
    assert.deepEqual(ui?.visibility, ["model"]);
    assert.equal(
      (tool?._meta as { "openai/outputTemplate"?: string } | undefined)?.["openai/outputTemplate"],
      workspaceAppUri("task"),
    );
  }
});

test("both tool modes preserve nested instruction and skill guidance", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const instructions = context.client.getInstructions() ?? "";

      assert.match(instructions, /Before working under a path listed in availableAgentsFiles/i);
      assert.match(instructions, /When .*open_workspace.* returns available skills/i);
    });
  }
});

test("tracked MCP tool handlers run through the activity wrapper", async (t) => {
  let active = 0;
  let completed = 0;
  const context = await fixture(t, {
    uiEnabled: false,
    trackToolActivity: async (operation) => {
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
        completed += 1;
      }
    },
  });

  await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project },
  });

  assert.equal(active, 0);
  assert.equal(completed, 1);
});

test("run_task changes participate in the turn-scoped show_changes review", async (t) => {
  let taskRecord: LocalAgentRecord | undefined;
  const taskClient = {
    async start(input) {
      await writeFile(join(input.workspaceRoot, "task-output.txt"), "worker change\n");
      taskRecord = {
        id: "agt_server_task",
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        profileName: input.target,
        provider: input.target,
        status: "idle",
        latestResponse: "Implemented the requested task and validated it.",
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:01.000Z",
      };
      return Result.ok(taskRecord);
    },
    async get() {
      assert.ok(taskRecord);
      return Result.ok(taskRecord);
    },
    async continue(agentId, prompt, overrides, scope) {
      assert.ok(taskRecord);
      assert.equal(agentId, taskRecord.id);
      assert.equal(scope.workspaceId, taskRecord.workspaceId);
      assert.equal(scope.workspaceRoot, taskRecord.workspaceRoot);
      assert.equal(overrides?.writeMode, "allowed");
      assert.match(prompt, /Continue the existing bounded coding task/);
      await writeFile(join(scope.workspaceRoot, "task-output.txt"), "worker change\nfollow-up change\n");
      taskRecord = {
        ...taskRecord,
        status: "idle",
        latestResponse: "Applied the follow-up and reran the focused validation.",
        updatedAt: "2026-09-04T00:00:02.000Z",
      };
      return Result.ok(taskRecord);
    },
    async cancel() {
      assert.ok(taskRecord);
      return Result.ok(taskRecord);
    },
  } satisfies LocalTaskAgentClient;
  const context = await fixture(t, {
    git: true,
    uiEnabled: false,
    localAgentProviders: [{ name: "codex", available: true }],
    taskAgentClient: taskClient,
  });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "task-review"),
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  const task = await context.client.callTool({
    name: "run_task",
    arguments: {
      workspaceId,
      target: "codex",
      instruction: "Create the task output file.",
    },
  });
  const taskOutput = structuredContent(task);
  assert.equal(taskOutput.status, "completed");
  assert.equal(taskOutput.target, "codex");
  assert.match(taskOutput.result as string, /Implemented the requested task/);

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual(
    (card.files as Array<{ path: string }>).map((file) => file.path),
    ["task-output.txt"],
  );

  const continued = await context.client.callTool({
    name: "continue_task",
    arguments: {
      workspaceId,
      taskId: taskOutput.taskId,
      instruction: "Add the follow-up line and validate again.",
      yieldTimeMs: 0,
    },
  });
  const continuedOutput = structuredContent(continued);
  assert.equal(continuedOutput.taskId, taskOutput.taskId);
  assert.equal(continuedOutput.status, "completed");
  assert.equal(continuedOutput.target, "codex");
  assert.match(continuedOutput.result as string, /Applied the follow-up/);

  const cancelledTerminal = await context.client.callTool({
    name: "cancel_task",
    arguments: {
      workspaceId,
      taskId: taskOutput.taskId,
    },
  });
  const cancelledTerminalOutput = structuredContent(cancelledTerminal);
  assert.equal(cancelledTerminalOutput.status, "completed");
  assert.equal(cancelledTerminalOutput.cancelRequested, false);
  assert.equal(cancelledTerminalOutput.cancelAcknowledged, false);

  const followUpReview = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const followUpCard = responseCard(followUpReview);
  assert.deepEqual(
    (followUpCard.files as Array<{ path: string }>).map((file) => file.path),
    ["task-output.txt"],
  );
});

test("codex process polling schema permits long poll-only waits", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();
  const writeStdin = tools.tools.find((tool) => tool.name === "write_stdin");
  const yieldSchema = writeStdin?.inputSchema?.properties?.yieldTimeMs as {
    maximum?: number;
    description?: string;
  } | undefined;

  assert.equal(yieldSchema?.maximum, 110_000);
  assert.match(yieldSchema?.description ?? "", /Poll-only calls default to 30000/);
});

test("server and open_workspace schema expose configured workspace roots", async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  const expectedRoot = context.project.replace(/\/project$/, "");

  assert.match(context.client.getInstructions() ?? "", new RegExp(`configured workspace root is ${escapeRegExp(expectedRoot)}`));

  const tools = await context.client.listTools();
  const openWorkspace = tools.tools.find((tool) => tool.name === "open_workspace");
  const pathSchema = openWorkspace?.inputSchema?.properties?.path as { description?: string } | undefined;
  assert.match(pathSchema?.description ?? "", new RegExp(`Configured roots: ${escapeRegExp(expectedRoot)}`));
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("review UI is callable from its app while workspace UI remains model-only", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: true });
  const tools = await context.client.listTools();
  const openWorkspace = tools.tools.find((tool) => tool.name === "open_workspace");
  const showChanges = tools.tools.find((tool) => tool.name === "show_changes");
  const openUi = (openWorkspace?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
  const reviewUi = (showChanges?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;

  assert.deepEqual(openUi?.visibility, ["model"]);
  assert.deepEqual(reviewUi?.visibility, ["model", "app"]);
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("open_workspace rejects a symlinked path whose missing target is outside the root", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-open-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const link = join(context.project, "outside-link");
  const escapedWorkspace = join(link, "created-workspace");
  await symlink(outside, link, "dir");

  const result = await callOpen(context.client, escapedWorkspace);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /outside allowed roots|outside workspace root/);
  await assert.rejects(() => stat(join(outside, "created-workspace")), /ENOENT/);
});

test("direct read, write, and edit tools reject symlink escapes", { skip: platform() === "win32" }, async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-tools-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(context.project, "outside-link"), "dir");

  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId;
  assert.equal(typeof workspaceId, "string");
  const readResult = await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "outside-link/secret.txt" },
  });
  const writeResult = await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "outside-link/created.txt", content: "blocked\n" },
  });
  const editResult = await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "outside-link/secret.txt",
      edits: [{ oldText: "secret", newText: "changed" }],
    },
  });

  for (const result of [readResult, writeResult, editResult]) {
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /outside workspace root|outside allowed roots/);
  }
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret\n");
  await assert.rejects(() => stat(join(outside, "created.txt")), /ENOENT/);
});

test("read exposes structured truncation metadata and a continuation offset", async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  const largeFile = Array.from({ length: 2_105 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
  await writeFile(join(context.project, "large.txt"), largeFile);
  const workspaceId = structuredContent(await callOpen(context.client, context.project)).workspaceId;
  assert.equal(typeof workspaceId, "string");

  const first = structuredContent(await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "large.txt" },
  }));
  const truncation = first.truncation as {
    truncated: boolean;
    truncatedBy: string | null;
    outputLines: number;
  };

  assert.equal(truncation.truncated, true);
  assert.equal(truncation.truncatedBy, "lines");
  assert.equal(truncation.outputLines, 2_000);
  assert.equal(first.nextOffset, 2_001);

  const continued = structuredContent(await context.client.callTool({
    name: "read",
    arguments: { workspaceId, path: "large.txt", offset: first.nextOffset },
  }));
  assert.match(continued.result as string, /line-2001/);
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspaceId, workspaceId);
  assert.match(structured.reviewRef as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && typeof outputProperties === "object" && "workspaceId" in outputProperties);
  assert.ok(outputProperties && typeof outputProperties === "object" && "reviewRef" in outputProperties);
  assert.equal(outputProperties && typeof outputProperties === "object" && "summary" in outputProperties, false);
  assert.equal(outputProperties && typeof outputProperties === "object" && "files" in outputProperties, false);
  assert.equal(outputProperties && typeof outputProperties === "object" && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes excludes dirty files that existed before the workspace opened", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "claude" });
  await writeFile(join(context.project, "background.txt"), "background work\n");

  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-preexisting"),
  ).workspaceId;
  await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "job.txt",
      content: "job change\n",
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual((card.files as Array<{ path: string }>).map((file) => file.path), ["job.txt"]);
  assert.doesNotMatch(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /background/,
  );
});

test("show_changes discovers shell-generated paths and excludes concurrent background paths", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "claude" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-shell"),
  ).workspaceId;

  await writeFile(join(context.project, "background.txt"), "background work\n");
  await context.client.callTool({
    name: "bash",
    arguments: {
      workspaceId,
      command: "printf 'generated\\n' > generated.txt",
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual((card.files as Array<{ path: string }>).map((file) => file.path), ["generated.txt"]);
});

test("show_changes records direct edit mutations", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "claude" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-edit"),
  ).workspaceId;

  await context.client.callTool({
    name: "edit",
    arguments: {
      workspaceId,
      path: "README.md",
      edits: [{ oldText: "hello", newText: "edited by the job" }],
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual((card.files as Array<{ path: string }>).map((file) => file.path), ["README.md"]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /edited by the job/,
  );
});

test("show_changes records apply_patch mutations", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "codex" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-apply-patch"),
  ).workspaceId;

  await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspaceId,
      patch: [
        "*** Begin Patch",
        "*** Add File: generated-by-patch.txt",
        "+patch change",
        "*** End Patch",
      ].join("\n"),
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual(
    (card.files as Array<{ path: string }>).map((file) => file.path),
    ["generated-by-patch.txt"],
  );
});

test("show_changes tracks long-running process changes through write_stdin", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "codex" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-process"),
  ).workspaceId;
  const script = "setTimeout(() => require('node:fs').writeFileSync('late.txt', 'late\\n'), 100)";
  const started = structuredContent(await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspaceId,
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      yieldTimeMs: 10,
    },
  }));
  assert.equal(started.running, true);
  assert.equal(typeof started.sessionId, "number");

  await context.client.callTool({
    name: "write_stdin",
    arguments: {
      workspaceId,
      sessionId: started.sessionId,
      yieldTimeMs: 2_000,
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual((card.files as Array<{ path: string }>).map((file) => file.path), ["late.txt"]);
});

test("show_changes isolates a workspace subdirectory from sibling repository files", async (t) => {
  const context = await fixture(t, { git: true, nestedGit: true, toolMode: "claude" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-subdirectory"),
  ).workspaceId;
  await writeFile(join(context.project, "..", "sibling.txt"), "background work\n");

  await context.client.callTool({
    name: "write",
    arguments: {
      workspaceId,
      path: "README.md",
      content: "workspace change\n",
    },
  });

  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  const card = responseCard(review);
  assert.deepEqual((card.files as Array<{ path: string }>).map((file) => file.path), ["README.md"]);
  assert.doesNotMatch(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /sibling\.txt/,
  );
});

test("repeated show_changes reviews only the next tracked turn", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "claude" });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "turn-scoped-repeat"),
  ).workspaceId;

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "first.txt", content: "first\n" },
  });
  const first = responseCard(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  assert.deepEqual((first.files as Array<{ path: string }>).map((file) => file.path), ["first.txt"]);

  const repeated = responseCard(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  assert.deepEqual(repeated.files, []);

  await context.client.callTool({
    name: "write",
    arguments: { workspaceId, path: "second.txt", content: "second\n" },
  });
  const second = responseCard(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  assert.deepEqual((second.files as Array<{ path: string }>).map((file) => file.path), ["second.txt"]);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspaceId;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  }));
  const reviewRef = first.reviewRef;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).reviewRef, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agentProviders as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(firstStructured.workspaceId, structuredContent(repeated).workspaceId);
  assert.ok(Array.isArray(firstStructured.agentsFiles));
  assert.ok(Array.isArray(firstStructured.availableAgentsFiles));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agentProviders));
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skillDiagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.equal(repeatedStructured.agentsFiles, undefined);
  assert.equal(repeatedStructured.availableAgentsFiles, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agentProviders, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skillDiagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agentProviders, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agentProviders as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agentProviders as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspaceId, structuredContent(first).workspaceId);
  assert.equal(structuredContent(repeated).agentsFiles, undefined);
  assert.notEqual(structuredContent(otherSession).workspaceId, structuredContent(first).workspaceId);
  assert.notEqual(structuredContent(unscoped).workspaceId, structuredContent(first).workspaceId);
  assert.ok(Array.isArray(structuredContent(otherSession).agentsFiles));
  assert.ok(Array.isArray(structuredContent(unscoped).agentsFiles));
});

test("HTTP endpoint serves MCP 2026-07-28 and rejects legacy protocol requests", async (t) => {
  const { root, localBaseUrl, accessToken, publicBaseUrl } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const authorizationMetadata = await fetch(`${localBaseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationMetadata.status, 200, await authorizationMetadata.clone().text());
  const authorizationMetadataBody = await authorizationMetadata.json() as Record<string, unknown>;
  assert.equal(authorizationMetadataBody.issuer, `${publicBaseUrl}/`);
  assert.equal(authorizationMetadataBody.client_id_metadata_document_supported, true);
  assert.equal(authorizationMetadataBody.authorization_response_iss_parameter_supported, true);
  assert.equal(authorizationMetadataBody.registration_endpoint, `${publicBaseUrl}/register`);

  const protectedResourceMetadata = await fetch(
    `${localBaseUrl}/.well-known/oauth-protected-resource/mcp`,
  );
  assert.equal(protectedResourceMetadata.status, 200, await protectedResourceMetadata.clone().text());
  const protectedResourceBody = await protectedResourceMetadata.json() as Record<string, unknown>;
  assert.equal(protectedResourceBody.resource, `${publicBaseUrl}/mcp`);
  assert.deepEqual(protectedResourceBody.authorization_servers, [`${publicBaseUrl}/`]);

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());
  assert.match(
    unauthenticated.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );

  const insufficientScopeToken = await issueTestAccessToken(
    localBaseUrl,
    publicBaseUrl,
    "test-owner-token-that-is-long-enough",
    "other",
  );
  const insufficientScope = await postModernMcp(
    localBaseUrl,
    insufficientScopeToken,
    "tools/list",
    {},
  );
  assert.equal(insufficientScope.status, 403, await insufficientScope.clone().text());
  const insufficientScopeChallenge = insufficientScope.headers.get("www-authenticate") ?? "";
  assert.match(insufficientScopeChallenge, /insufficient_scope/);
  assert.match(insufficientScopeChallenge, /scope="devspace"/);
  assert.match(
    insufficientScopeChallenge,
    /resource_metadata="https:\/\/example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await readModernMcpJson(discovery) as {
    result?: {
      supportedVersions?: string[];
      ttlMs?: number;
      cacheScope?: string;
      _meta?: Record<string, unknown>;
    };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));
  assert.equal(discoveryBody.result?.ttlMs, 300_000);
  assert.equal(discoveryBody.result?.cacheScope, "private");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  const serverInfo = discoveryBody.result?._meta?.["io.modelcontextprotocol/serverInfo"] as
    | Record<string, unknown>
    | undefined;
  assert.equal(serverInfo?.name, "devspace");
  assert.equal(serverInfo?.version, packageJson.version);

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  assert.match(listed.headers.get("content-type") ?? "", /text\/event-stream/);
  const listBody = await readModernMcpJson(listed) as {
    result?: {
      tools?: Array<{ name?: string }>;
      ttlMs?: number;
      cacheScope?: string;
    };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));
  assert.equal(listBody.result?.ttlMs, 300_000);
  assert.equal(listBody.result?.cacheScope, "private");

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await readModernMcpJson(called) as {
    result?: { structuredContent?: { workspaceId?: string } };
  };
  const modernWorkspaceId = callBody.result?.structuredContent?.workspaceId;
  assert.equal(typeof modernWorkspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await readModernMcpJson(repeated) as {
    result?: { structuredContent?: { workspaceId?: string; agentsFiles?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspaceId, modernWorkspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agentsFiles, undefined);

  const legacy = await postLegacyMcp(
    localBaseUrl,
    accessToken,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
    },
  );
  assert.notEqual(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
});

test("resource-server token failures use OAuth bearer semantics", async (t) => {
  const context = await httpServerFixture(t, "devspace-oauth-bearer-errors-");

  const invalidToken = await postModernMcp(
    context.localBaseUrl,
    "not-a-valid-devspace-token",
    "tools/list",
    {},
  );
  assert.equal(invalidToken.status, 401, await invalidToken.clone().text());
  const invalidTokenBody = await invalidToken.json() as { error?: string };
  assert.equal(invalidTokenBody.error, "invalid_token");
  assert.match(
    invalidToken.headers.get("www-authenticate") ?? "",
    /Bearer .*invalid_token/,
  );

  const resourceMismatchToken = "resource-mismatch-token";
  const tokenStore = new SqliteOAuthStore(join(context.root, ".state"), {
    issuer: new URL(context.publicBaseUrl).href,
  });
  const resourceMismatchClient = new SqliteOAuthClientsStore(
    tokenStore,
    [],
  ).registerClient({ redirect_uris: ["http://127.0.0.1/callback"] });
  tokenStore.saveAccessToken(
    hashTokenForTest(resourceMismatchToken),
    {
      clientId: resourceMismatchClient.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: new URL("/different-resource", context.publicBaseUrl).href,
    },
  );
  tokenStore.close();

  const resourceMismatch = await postModernMcp(
    context.localBaseUrl,
    resourceMismatchToken,
    "tools/list",
    {},
  );
  assert.equal(resourceMismatch.status, 401, await resourceMismatch.clone().text());
  const resourceMismatchBody = await resourceMismatch.json() as {
    error?: string;
    error_description?: string;
  };
  assert.equal(resourceMismatchBody.error, "invalid_token");
  assert.match(resourceMismatchBody.error_description ?? "", /resource/);
  assert.match(
    resourceMismatch.headers.get("www-authenticate") ?? "",
    /resource_metadata=/,
  );
});

test("OAuth supports Client ID Metadata Documents with exact redirect matching", async (t) => {
  const clientId = "https://client.example.com/oauth/client.json";
  const redirectUri = "http://127.0.0.1:4317/callback";
  let resolveCount = 0;
  const clientMetadataResolver: ClientMetadataDocumentResolver = {
    async resolve(requestedClientId) {
      resolveCount += 1;
      assert.equal(requestedClientId, clientId);
      return {
        client_id: clientId,
        client_name: "DevSpace CIMD test client",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
  };
  const { localBaseUrl, publicBaseUrl, ownerToken } = await httpServerFixture(
    t,
    "devspace-cimd-http-test-",
    { clientMetadataResolver },
  );

  const mismatchedRedirect = await authorizeTestClient({
    localBaseUrl,
    publicBaseUrl,
    ownerToken,
    clientId,
    redirectUri: "http://127.0.0.1:9999/callback",
    verifier: "cimd-verifier-mismatch-0123456789",
  });
  assert.equal(mismatchedRedirect.status, 400, await mismatchedRedirect.clone().text());
  assert.equal(mismatchedRedirect.headers.get("location"), null);

  const accessToken = await issueCimdAccessToken({
    localBaseUrl,
    publicBaseUrl,
    ownerToken,
    clientId,
    redirectUri,
  });
  assert.ok(resolveCount >= 2);

  const listed = await postModernMcp(localBaseUrl, accessToken, "tools/list", {});
  assert.equal(listed.status, 200, await listed.clone().text());
});

test("ChatGPT pairing uses the production metadata resolver through authorization and token exchange", async (t) => {
  mockClientMetadataEndpoint(t);
  const context = await httpServerFixture(t, "devspace-chatgpt-pairing-test-");
  const authorization = new URL("/authorize", context.localBaseUrl);
  authorization.search = new URLSearchParams({
    client_id: chatGptClientMetadata.client_id,
    redirect_uri: chatGptClientMetadata.redirect_uris[0]!,
    response_type: "code",
    code_challenge: createHash("sha256").update("pairing-verifier").digest("base64url"),
    code_challenge_method: "S256",
    scope: "devspace",
    resource: new URL("/mcp", context.publicBaseUrl).href,
  }).toString();
  const page = await fetch(authorization, { redirect: "manual" });
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(await page.text(), /Owner password/);
  const token = await issueCimdAccessToken({
    ...context,
    clientId: chatGptClientMetadata.client_id,
    redirectUri: chatGptClientMetadata.redirect_uris[0]!,
  });
  const listed = await postModernMcp(context.localBaseUrl, token, "tools/list", {});
  assert.equal(listed.status, 200, await listed.clone().text());
});

test("browser pairing rejects untrusted and malformed Origins", async (t) => {
  const context = await httpServerFixture(t, "devspace-pairing-origin-test-");
  for (const origin of ["https://untrusted.example", "null", "not-a-url"]) {
    const response = await fetch(`${context.localBaseUrl}/authorize`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ owner_token: context.ownerToken }),
      redirect: "manual",
    });
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /Invalid Origin/);
  }
});

test("invalid client metadata produces an OAuth error instead of an opaque pairing 500", async (t) => {
  mockClientMetadataEndpoint(t, { body: {
    ...chatGptClientMetadata,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
  } });
  const context = await httpServerFixture(t, "devspace-cimd-error-test-");
  const page = await fetch(`${context.localBaseUrl}/authorize?${new URLSearchParams({
    client_id: chatGptClientMetadata.client_id,
    redirect_uri: chatGptClientMetadata.redirect_uris[0]!,
  })}`, { redirect: "manual" });
  assert.equal(page.status, 400, await page.clone().text());
  assert.equal(page.headers.get("location"), null);
  const body = await page.json() as { error: string; error_description: string };
  assert.equal(body.error, "invalid_client");
  assert.match(body.error_description, /authentication method/);
});

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  publicBaseUrl: string;
  ownerToken: string;
}

interface HttpServerFixtureOptions {
  clientMetadataResolver?: ClientMetadataDocumentResolver;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
  options: HttpServerFixtureOptions = {},
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
    oauth: { scopes: ["devspace", "other"] },
  }));
  const running = createServer(config, {
    incomingArtifactAdapters: [],
    clientMetadataResolver: options.clientMetadataResolver,
  });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return {
    root,
    localBaseUrl,
    accessToken,
    publicBaseUrl: config.publicBaseUrl,
    ownerToken,
  };
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
  scope: string | undefined = "devspace",
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localBaseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      application_type: "native",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const authorizationParams = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    state: "modern-test",
    owner_token: ownerToken,
  });
  if (scope !== undefined) authorizationParams.set("scope", scope);
  const approval = await fetch(`${localBaseUrl}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizationParams,
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const approvalUrl = new URL(location);
  assert.equal(approvalUrl.searchParams.get("iss"), `${publicBaseUrl}/`);
  const code = approvalUrl.searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

async function issueCimdAccessToken(input: {
  localBaseUrl: string;
  publicBaseUrl: string;
  ownerToken: string;
  clientId: string;
  redirectUri: string;
}): Promise<string> {
  const verifier = "devspace-cimd-verifier-0123456789";
  const approval = await authorizeTestClient({ ...input, verifier });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const approvalUrl = new URL(location);
  assert.equal(approvalUrl.searchParams.get("iss"), `${input.publicBaseUrl}/`);
  const code = approvalUrl.searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${input.localBaseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: input.redirectUri,
      resource: new URL("/mcp", input.publicBaseUrl).href,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function authorizeTestClient(input: {
  localBaseUrl: string;
  publicBaseUrl: string;
  ownerToken: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
}): Promise<Response> {
  const challenge = createHash("sha256").update(input.verifier).digest("base64url");
  return fetch(`${input.localBaseUrl}/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(input.publicBaseUrl).origin,
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource: new URL("/mcp", input.publicBaseUrl).href,
      state: "cimd-test",
      owner_token: input.ownerToken,
    }),
    redirect: "manual",
  });
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

async function readModernMcpJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return await response.json() as Record<string, unknown>;
  }

  const messages = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  const lastMessage = messages.at(-1);
  if (!lastMessage) throw new Error("Modern MCP SSE response did not contain a data frame.");
  return JSON.parse(lastMessage) as Record<string, unknown>;
}

function postLegacyMcp(
  localBaseUrl: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `legacy-${method}`,
      method,
      params,
    }),
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface ServerFixture {
  client: Client;
  project: string;
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    nestedGit?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
    taskAgentClient?: LocalTaskAgentClient;
    trackToolActivity?: <T>(operation: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = options.nestedGit
    ? join(root, "repository", "project")
    : join(root, "project");
  const repository = options.nestedGit ? join(root, "repository") : project;
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(repository, ["init"]);
    await git(repository, ["config", "user.email", "devspace@example.com"]);
    await git(repository, ["config", "user.name", "DevSpace Test"]);
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: { enabled: options.localAgentProviders !== undefined, providers: [] },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const serverAdapter = createModernMcpServerAdapter(
    { name: "devspace-test", version: "1.0.0" },
    { instructions: mcpServerInstructions(config) },
  );
  registerMcpSurface(
    serverAdapter.registrationTarget,
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    options.taskAgentClient,
    options.trackToolActivity,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "devspace-test-client", version: "1.0.0" },
  );
  await Promise.all([
    client.connect(clientTransport),
    serverAdapter.server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await serverAdapter.server.close();
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashTokenForTest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
