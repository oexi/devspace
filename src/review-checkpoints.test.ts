import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewCheckpointManager, readReviewRef } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);

test("a clean workspace reports no changes from the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_clean", root });
  const clean = await manager.reviewChanges({ workspaceId: "ws_clean", root });

  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
});

test("Git-backed reviews preserve binary content and rename metadata", async (t) => {
  const root = await committedRepository(t);
  await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
  await git(root, ["add", "asset.bin"]);
  await git(root, ["commit", "-m", "Add binary asset"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_binary_rename", root });
  await manager.trackDirectMutation(
    { workspaceId: "ws_binary_rename", root },
    () => rename(join(root, "asset.bin"), join(root, "renamed.bin")),
    ["asset.bin", "renamed.bin"],
  );

  const renamed = await manager.reviewChanges({ workspaceId: "ws_binary_rename", root });
  assert.deepEqual(renamed.files, [{
    path: "renamed.bin",
    previousPath: "asset.bin",
    type: "rename-pure",
    additions: 0,
    removals: 0,
  }]);
  assert.match(renamed.patch, /similarity index 100%/);

  const reopened = await manager.reviewByRef({
    workspaceId: "ws_binary_rename",
    root,
    reviewRef: renamed.reviewRef,
  });
  assert.deepEqual(reopened.files, renamed.files);
  assert.equal(reopened.patch, renamed.patch);

  await manager.trackDirectMutation(
    { workspaceId: "ws_binary_rename", root },
    () => writeFile(join(root, "renamed.bin"), Buffer.from([0, 1, 2, 3, 4, 6])),
    ["renamed.bin"],
  );
  const binary = await manager.reviewChanges({ workspaceId: "ws_binary_rename", root });
  assert.deepEqual(binary.files.map((file) => file.path), ["renamed.bin"]);
  assert.ok(binary.patch.length > 0);
});

test("initialization reports whether aggregate review is available", async (t) => {
  const gitRoot = await committedRepository(t);
  const plainRoot = await mkdtemp(join(tmpdir(), "devspace-review-plain-test-"));
  t.after(() => rm(plainRoot, { recursive: true, force: true }));
  const manager = createReviewCheckpointManager();

  assert.deepEqual(
    await manager.initializeWorkspace({ workspaceId: "ws_git", root: gitRoot }),
    { available: true },
  );
  const unavailable = await manager.initializeWorkspace({
    workspaceId: "ws_plain",
    root: plainRoot,
  });
  assert.equal(unavailable.available, false);
  if (!unavailable.available) assert.match(unavailable.reason, /git repository/i);
});

test("show_changes reports and advances the last-shown checkpoint", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_incremental", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");

  const unreviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: false,
  });
  assert.deepEqual(unreviewed.files.map((file) => file.path).sort(), ["README.md", "new.txt"]);
  assert.equal(unreviewed.summary.additions, 2);
  assert.match(unreviewed.patch, /world/);

  const markedReviewed = await manager.reviewChanges({
    workspaceId: "ws_incremental",
    root,
    markReviewed: true,
  });
  assert.equal(markedReviewed.summary.files, 2);
  assert.match(markedReviewed.reviewRef, /^[0-9a-f]{40,64}$/);

  const restored = await manager.reviewByRef({
    workspaceId: "ws_incremental",
    root,
    reviewRef: markedReviewed.reviewRef,
  });
  assert.deepEqual(restored.summary, markedReviewed.summary);
  assert.deepEqual(restored.files, markedReviewed.files);
  assert.equal(restored.patch, markedReviewed.patch);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_incremental", root });
  assert.equal(afterReviewed.summary.files, 0);
  assert.equal(afterReviewed.patch, "");
});

test("historical review refs survive later reviews and manager restarts", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\n");
  const first = await manager.reviewChanges({ workspaceId: "ws_history", root });

  await writeFile(join(root, "README.md"), "hello\nfirst\nsecond\n");
  const second = await manager.reviewChanges({ workspaceId: "ws_history", root });
  assert.notEqual(first.reviewRef, second.reviewRef);

  const restarted = createReviewCheckpointManager();
  const restoredFirst = await restarted.reviewByRef({
    workspaceId: "ws_history",
    root,
    reviewRef: first.reviewRef,
  });
  assert.deepEqual(restoredFirst.summary, first.summary);
  assert.equal(restoredFirst.patch, first.patch);
  assert.match(restoredFirst.patch, /\+first/);
  assert.doesNotMatch(restoredFirst.patch, /\+second/);
});

test("cleanup removes all review refs for a retired workspace", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  const workspaceId = "ws_retired_review";
  await manager.initializeWorkspace({ workspaceId, root });

  await writeFile(join(root, "README.md"), "hello\nretired\n");
  const review = await manager.reviewChanges({ workspaceId, root });
  assert.notEqual(
    await gitOutput(root, ["show-ref", "--verify", "refs/devspace/review/ws_retired_review/open"]),
    "",
  );

  const cleanup = await manager.cleanupWorkspace({ workspaceId, root });
  assert.equal(cleanup.cleaned, true);
  await assert.rejects(
    () => gitOutput(root, ["show-ref", "--verify", "refs/devspace/review/ws_retired_review/open"]),
  );
  await assert.rejects(
    () => gitOutput(root, ["show-ref", "--verify", "refs/devspace/review/ws_retired_review/baseline"]),
  );
  await assert.rejects(() => readReviewRef(root, review.reviewRef), /Unknown DevSpace review reference/);
});

test("tracked historical reviews retain subdirectory path scope after restart", async (t) => {
  const { root, workspace } = await scopedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_tracked_history", root: workspace });

  await writeFile(join(root, "sibling.txt"), "background work\n");
  await manager.trackDirectMutation(
    { workspaceId: "ws_tracked_history", root: workspace },
    async () => writeFile(join(workspace, "README.md"), "workspace job\n"),
    ["README.md"],
  );
  const review = await manager.reviewChanges({
    workspaceId: "ws_tracked_history",
    root: workspace,
  });

  const restarted = createReviewCheckpointManager();
  const restored = await restarted.reviewByRef({
    workspaceId: "ws_tracked_history",
    root: workspace,
    reviewRef: review.reviewRef,
  });
  assert.deepEqual(restored.files.map((file) => file.path), ["README.md"]);
  assert.doesNotMatch(restored.patch, /sibling\.txt/);
});

test("tracked review commits contain only task paths while baseline absorbs workspace state", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  const workspaceId = "ws_scoped_review_tree";
  await manager.initializeWorkspace({ workspaceId, root });

  await writeFile(join(root, "background.txt"), "background\n");
  await manager.trackDirectMutation(
    { workspaceId, root },
    async () => writeFile(join(root, "job.txt"), "job\n"),
    ["job.txt"],
  );

  const review = await manager.reviewChanges({ workspaceId, root });
  assert.deepEqual(review.files.map((file) => file.path), ["job.txt"]);
  assert.equal(
    await gitOutput(root, ["diff", "--name-only", `${review.reviewRef}^1`, review.reviewRef]),
    "job.txt",
  );

  const baseline = await gitOutput(root, [
    "rev-parse",
    `refs/devspace/review/${workspaceId}/baseline`,
  ]);
  assert.equal(
    await gitOutput(root, ["diff", "--name-only", review.reviewRef, baseline]),
    "background.txt",
  );
});

test("review refs are scoped to the workspace review history", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_scoped", root });

  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    () => manager.reviewByRef({ workspaceId: "ws_scoped", root, reviewRef: head }),
    /Unknown review reference/,
  );
  await assert.rejects(
    () => readReviewRef(root, head),
    /Unknown DevSpace review reference/,
  );
});

test("review checkpoints survive a manager restart", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_restart", root });

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await manager.reviewChanges({ workspaceId: "ws_restart", root, markReviewed: true });

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_restart", root });
  await writeFile(join(root, "later.txt"), "after restart\n");

  const afterRestart = await restartedManager.reviewChanges({
    workspaceId: "ws_restart",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterRestart.files.map((file) => file.path), ["later.txt"]);
  assert.match(afterRestart.patch, /after restart/);
  assert.doesNotMatch(afterRestart.patch, /world/);
});

test("turn-scoped pending paths survive a manager restart before show_changes", async (t) => {
  const root = await committedRepository(t);
  const workspaceId = "ws_pending_restart";
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId, root });

  await manager.trackDirectMutation(
    { workspaceId, root },
    async () => writeFile(join(root, "first.txt"), "first\n"),
    ["first.txt"],
  );
  const first = await manager.reviewChanges({ workspaceId, root, markReviewed: true });
  assert.deepEqual(first.files.map((file) => file.path), ["first.txt"]);

  await manager.trackDirectMutation(
    { workspaceId, root },
    async () => writeFile(join(root, "second.txt"), "second\n"),
    ["second.txt"],
  );
  await git(root, ["add", "second.txt"]);
  await git(root, ["commit", "-m", "Commit before review"]);

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId, root });
  const afterRestart = await restartedManager.reviewChanges({
    workspaceId,
    root,
    markReviewed: true,
  });
  assert.deepEqual(afterRestart.files.map((file) => file.path), ["second.txt"]);
  assert.match(afterRestart.patch, /second/);
  assert.doesNotMatch(afterRestart.patch, /first/);

  const restartedAgain = createReviewCheckpointManager();
  await restartedAgain.initializeWorkspace({ workspaceId, root });
  const repeated = await restartedAgain.reviewChanges({
    workspaceId,
    root,
    markReviewed: false,
  });
  assert.equal(repeated.summary.files, 0);
});

test("concurrent initialization produces one usable checkpoint state", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [, concurrentReview] = await Promise.all([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent", root }),
    manager.reviewChanges({ workspaceId: "ws_concurrent", root, markReviewed: false }),
  ]);
  assert.equal(concurrentReview.summary.files, 0);

  await writeFile(join(root, "later.txt"), "visible after initialization\n");
  const afterInitialization = await manager.reviewChanges({
    workspaceId: "ws_concurrent",
    root,
    markReviewed: false,
  });
  assert.deepEqual(afterInitialization.files.map((file) => file.path), ["later.txt"]);
});

test("tracked mutations and concurrent reviews are serialized per workspace", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_tracked_concurrent", root });

  await Promise.all([
    manager.trackDirectMutation(
      { workspaceId: "ws_tracked_concurrent", root },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(join(root, "first.txt"), "first\n");
      },
      ["first.txt"],
    ),
    manager.trackDirectMutation(
      { workspaceId: "ws_tracked_concurrent", root },
      async () => {
        await writeFile(join(root, "second.txt"), "second\n");
      },
      ["second.txt"],
    ),
  ]);

  const reviews = await Promise.all([
    manager.reviewChanges({ workspaceId: "ws_tracked_concurrent", root }),
    manager.reviewChanges({ workspaceId: "ws_tracked_concurrent", root }),
  ]);
  const fileSets = reviews.map((review) => review.files.map((file) => file.path).sort());
  assert.deepEqual(fileSets.sort((left, right) => left.length - right.length), [[], ["first.txt", "second.txt"]]);
});

test("background task snapshots capture changes made between visible tool calls", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  const workspaceId = "ws_background_task";
  const taskSessionId = "task:agt_background";
  await manager.initializeWorkspace({ workspaceId, root });

  await manager.trackWorkspaceOperation(
    { workspaceId, root },
    async () => {
      await writeFile(join(root, "during-run.txt"), "first window\n");
      return { running: true };
    },
    (result) => ({ sessionId: taskSessionId, running: result.running }),
  );

  // Simulate the worker continuing after run_task returned but before the host
  // issues wait_task. This mutation must still belong to the task turn.
  await writeFile(join(root, "between-calls.txt"), "background window\n");

  await manager.trackProcessOperation(
    { workspaceId, root, sessionId: taskSessionId },
    async () => ({ running: false }),
    (result) => ({ sessionId: taskSessionId, running: result.running }),
  );

  const review = await manager.reviewChanges({ workspaceId, root });
  assert.deepEqual(
    review.files.map((file) => file.path).sort(),
    ["between-calls.txt", "during-run.txt"],
  );
});

test("a missing last-shown checkpoint falls back after restart and can be re-established", async (t) => {
  const root = await committedRepository(t);
  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  await writeFile(join(root, "README.md"), "hello\nchanged\n");
  await deleteReviewRef(root, "ws_missing_baseline", "baseline");

  const restartedManager = createReviewCheckpointManager();
  await restartedManager.initializeWorkspace({ workspaceId: "ws_missing_baseline", root });

  const fallback = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(fallback.summary.files, 1);
  assert.match(fallback.patch, /changed/);

  const reestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: true,
  });
  assert.equal(reestablished.summary.files, 1);

  const afterReestablished = await restartedManager.reviewChanges({
    workspaceId: "ws_missing_baseline",
    root,
    markReviewed: false,
  });
  assert.equal(afterReestablished.summary.files, 0);
});

test("a checkpoint workspace rejects a different root without changing its state", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_root_mismatch", root });

  await assert.rejects(
    () => manager.reviewChanges({
      workspaceId: "ws_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
    /workspace root mismatch/,
  );

  await writeFile(join(root, "only-first-root.txt"), "first root\n");
  const review = await manager.reviewChanges({
    workspaceId: "ws_root_mismatch",
    root,
    markReviewed: false,
  });
  assert.deepEqual(review.files.map((file) => file.path), ["only-first-root.txt"]);
});

test("a concurrent review rejects a different root after initialization", async (t) => {
  const root = await committedRepository(t);
  const otherRoot = await committedRepository(t);
  const manager = createReviewCheckpointManager();

  const [initialization, review] = await Promise.allSettled([
    manager.initializeWorkspace({ workspaceId: "ws_concurrent_root_mismatch", root }),
    manager.reviewChanges({
      workspaceId: "ws_concurrent_root_mismatch",
      root: otherRoot,
      markReviewed: false,
    }),
  ]);

  assert.equal(initialization.status, "fulfilled");
  assert.equal(review.status, "rejected");
  if (review.status === "rejected") {
    assert.match(String(review.reason), /workspace root mismatch/);
  }
});

test("an unborn repository becomes reviewable after its first commit", async (t) => {
  const root = await unbornRepository(t);
  const manager = createReviewCheckpointManager();

  await manager.initializeWorkspace({ workspaceId: "ws_unborn", root });
  await assert.rejects(
    () => manager.reviewChanges({ workspaceId: "ws_unborn", root }),
    /repository has no HEAD commit/,
  );

  await writeFile(join(root, "README.md"), "first commit\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const afterFirstCommit = await manager.reviewChanges({
    workspaceId: "ws_unborn",
    root,
    markReviewed: false,
  });
  assert.equal(afterFirstCommit.summary.files, 0);
  assert.equal(afterFirstCommit.patch, "");
});

async function committedRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return root;
}

async function scopedRepository(t: TestContext): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-scoped-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "hello\n");
  await writeFile(join(root, "sibling.txt"), "sibling\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial commit"]);
  return { root, workspace };
}

async function unbornRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devspace-review-unborn-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  return root;
}

async function deleteReviewRef(
  root: string,
  workspaceId: string,
  checkpoint: "open" | "baseline",
): Promise<void> {
  await git(root, ["update-ref", "-d", `refs/devspace/review/${workspaceId}/${checkpoint}`]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
