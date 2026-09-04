import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createManagedWorktree,
  removeManagedWorktree,
} from "./git-worktrees.js";

const execFileAsync = promisify(execFile);

test("managed worktree cleanup leaves dirty worktrees in place", async (t) => {
  const context = await fixture(t);
  const worktree = await createManagedWorktree({
    sourcePath: context.repository,
    config: context.config,
  });
  const dirtyPath = join(worktree.path, "dirty.txt");
  await writeFile(dirtyPath, "keep this work\n");

  const skipped = await removeManagedWorktree({
    sourceRoot: worktree.sourceRoot,
    path: worktree.path,
    baseSha: worktree.baseSha,
    config: context.config,
  });
  assert.equal(skipped.status, "unsafe");
  assert.equal((await stat(worktree.path)).isDirectory(), true);

  await rm(dirtyPath, { force: true });
  await writeFile(join(worktree.path, "committed.txt"), "keep this commit\n");
  await git(worktree.path, ["add", "committed.txt"]);
  await git(worktree.path, ["commit", "-m", "Worktree commit"]);
  const committed = await removeManagedWorktree({
    sourceRoot: worktree.sourceRoot,
    path: worktree.path,
    baseSha: worktree.baseSha,
    config: context.config,
  });
  assert.equal(committed.status, "unsafe");
  assert.equal((await stat(worktree.path)).isDirectory(), true);
  await git(worktree.path, ["reset", "--hard", worktree.baseSha]);

  const removed = await removeManagedWorktree({
    sourceRoot: worktree.sourceRoot,
    path: worktree.path,
    baseSha: worktree.baseSha,
    config: context.config,
  });
  assert.equal(removed.status, "removed");
  await assert.rejects(() => stat(worktree.path));
});

interface WorktreeFixture {
  repository: string;
  config: { allowedRoots: string[]; worktreeRoot: string };
}

async function fixture(t: TestContext): Promise<WorktreeFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-git-worktree-test-"));
  const repository = join(root, "repository");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "hello\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "devspace@example.com"]);
  await git(repository, ["config", "user.name", "DevSpace Test"]);
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "Initial commit"]);

  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    repository,
    config: { allowedRoots: [root], worktreeRoot },
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
