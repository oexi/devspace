import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createManagedWorktree } from "./git-worktrees.js";
import { createReviewCheckpointManager, readReviewRef } from "./review-checkpoints.js";
import {
  cleanupWorkspaceLifecycle,
} from "./workspace-lifecycle.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("cleanup retires a stale conversation workspace and its review history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-lifecycle-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, "state");
  await mkdir(project);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, "README.md"), "hello\n");
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "Initial commit"]);

  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, "worktrees"),
    },
    storage: { stateDir },
    skills: { agentDir },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const registry = new WorkspaceRegistry(config, store);
  const reviewCheckpoints = createReviewCheckpointManager();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const opened = await registry.openWorkspace(project, {
    conversationScopeId: "conversation-1",
  });
  await reviewCheckpoints.initializeWorkspace({
    workspaceId: opened.workspace.id,
    root: project,
  });
  await writeFile(join(project, "README.md"), "hello\nstale review\n");
  const review = await reviewCheckpoints.reviewChanges({
    workspaceId: opened.workspace.id,
    root: project,
  });

  const oldTime = "2026-08-20T00:00:00.000Z";
  const database = openDatabase(stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(oldTime, opened.workspace.id);
    database.sqlite
      .prepare("update workspace_conversation_bindings set last_used_at = ? where workspace_session_id = ?")
      .run(oldTime, opened.workspace.id);
  } finally {
    database.close();
  }

  const cleanup = await cleanupWorkspaceLifecycle({
    config,
    store,
    registry,
    reviewCheckpoints,
    now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    inactivityTimeoutMs: 60 * 60 * 1_000,
    retentionTimeoutMs: 30 * 24 * 60 * 60 * 1_000,
  });

  assert.deepEqual(cleanup.retired.map((session) => session.id), [opened.workspace.id]);
  assert.deepEqual(cleanup.evictedWorkspaceIds, [opened.workspace.id]);
  assert.deepEqual(cleanup.cleanedReviewWorkspaceIds, [opened.workspace.id]);
  assert.equal(store.getSession(opened.workspace.id)?.status, "inactive");
  assert.equal(
    store.getConversationBinding("conversation-1", JSON.stringify(["checkout", project, null])),
    undefined,
  );
  await assert.rejects(
    () => registry.getWorkspace(opened.workspace.id),
    /Unknown workspaceId/,
  );
  await assert.rejects(
    () => gitOutput(project, ["show-ref", "--verify", `refs/devspace/review/${opened.workspace.id}/open`]),
  );
  await assert.rejects(
    () => readReviewRef(project, review.reviewRef),
    /Unknown DevSpace review reference/,
  );
});

test("cleanup removes a clean retired managed worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-workspace-worktree-lifecycle-test-"));
  const repository = join(root, "repository");
  const stateDir = join(root, "state");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "hello\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "devspace@example.com"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Initial commit"]);

  const config = loadConfig(writeTestDevspaceConfig(join(root, "config"), {
    server: { port: 1 },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, "worktrees"),
    },
    storage: { stateDir },
  }));
  const store = new SqliteWorkspaceStore(stateDir);
  const registry = new WorkspaceRegistry(config, store);
  const reviewCheckpoints = createReviewCheckpointManager();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const worktree = await createManagedWorktree({
    sourcePath: repository,
    config,
  });
  const session = store.createSession({
    id: "ws_retired_worktree",
    root: worktree.path,
    mode: "worktree",
    sourceRoot: worktree.sourceRoot,
    baseRef: worktree.baseRef,
    baseSha: worktree.baseSha,
    managed: true,
  });
  const database = openDatabase(stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run("2026-08-20T00:00:00.000Z", session.id);
  } finally {
    database.close();
  }

  const cleanup = await cleanupWorkspaceLifecycle({
    config,
    store,
    registry,
    reviewCheckpoints,
    now: () => Date.parse("2026-09-04T00:00:00.000Z"),
    inactivityTimeoutMs: 60 * 60 * 1_000,
    retentionTimeoutMs: 30 * 24 * 60 * 60 * 1_000,
  });

  assert.deepEqual(cleanup.removedWorktreeWorkspaceIds, [session.id]);
  assert.deepEqual(cleanup.retainedManagedWorktreeWorkspaceIds, []);
  assert.equal(store.getSession(session.id)?.status, "inactive");
  await assert.rejects(() => stat(worktree.path));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
