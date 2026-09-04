import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

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
  assert.ok(outputProperties && "workspaceId" in outputProperties);
  assert.ok(outputProperties && "reviewRef" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
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
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
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
