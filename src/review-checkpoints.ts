import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, getGitEligibility, safeWorkspaceRefSegment } from "./git.js";

export type ReviewSince = "last_shown" | "workspace_open";

export interface ProcessReviewObservation {
  sessionId?: number | string;
  running: boolean;
}

export interface ReviewSummary {
  files: number;
  additions: number;
  removals: number;
}

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  removals: number;
}

export interface ReviewChangesResult {
  reviewRef: string;
  result: string;
  summary: ReviewSummary;
  files: ReviewFile[];
  patch: string;
}

export interface ReviewCheckpointCleanupResult {
  cleaned: boolean;
  reason?: string;
}

export type ReviewAvailability =
  | { available: true }
  | { available: false; reason: string };

interface WorkspaceReviewState {
  root: string;
  gitRoot?: string;
  openRef: string;
  baselineRef: string;
  pendingRef: string;
  openRefAvailable: boolean;
  baselineRefAvailable: boolean;
  diagnostic?: string;
  turnScopeActive: boolean;
  // Retain the old aggregate behavior for callers that cannot report the
  // mutation boundary. Tool-backed turns disable this fallback explicitly.
  legacyFallbackAllowed: boolean;
  trackedPaths: Set<string>;
  processSnapshots: Map<number | string, string>;
}

export interface ReviewCheckpointManager {
  initializeWorkspace(input: { workspaceId: string; root: string }): Promise<ReviewAvailability>;
  cleanupWorkspace(input: {
    workspaceId: string;
    root: string;
    gitRoot?: string;
  }): Promise<ReviewCheckpointCleanupResult>;
  trackDirectMutation<T>(
    input: { workspaceId: string; root: string },
    operation: () => Promise<T>,
    paths: string[] | ((result: T) => string[]),
    shouldRecord?: (result: T) => boolean,
  ): Promise<T>;
  trackWorkspaceOperation<T>(
    input: { workspaceId: string; root: string },
    operation: () => Promise<T>,
    process?: (result: T) => ProcessReviewObservation,
  ): Promise<T>;
  trackProcessOperation<T>(
    input: { workspaceId: string; root: string; sessionId: number | string },
    operation: () => Promise<T>,
    process?: (result: T) => ProcessReviewObservation,
  ): Promise<T>;
  reviewChanges(input: {
    workspaceId: string;
    root: string;
    since?: ReviewSince;
    markReviewed?: boolean;
  }): Promise<ReviewChangesResult>;
  reviewByRef(input: {
    workspaceId: string;
    root: string;
    reviewRef: string;
  }): Promise<ReviewChangesResult>;
}

const REVIEW_REF_PREFIX = "refs/devspace/review";

export function createReviewCheckpointManager(): ReviewCheckpointManager {
  const states = new Map<string, WorkspaceReviewState>();
  const initializations = new Map<string, Promise<void>>();
  const workspaceLocks = new Map<string, Promise<void>>();

  async function initializeWorkspace({ workspaceId, root }: { workspaceId: string; root: string }): Promise<ReviewAvailability> {
    const existingState = states.get(workspaceId);
    assertWorkspaceRoot(existingState, workspaceId, root);
    if (existingState?.root === root && existingState.gitRoot !== undefined) {
      return reviewAvailability(existingState);
    }

    const pending = initializations.get(workspaceId);
    if (pending) {
      await pending;
      const initializedState = states.get(workspaceId);
      assertWorkspaceRoot(initializedState, workspaceId, root);
      return reviewAvailability(initializedState);
    }

    const initialize = initializeWorkspaceState(states, workspaceId, root);
    initializations.set(workspaceId, initialize);
    try {
      await initialize;
    } finally {
      if (initializations.get(workspaceId) === initialize) {
        initializations.delete(workspaceId);
      }
    }
    return reviewAvailability(states.get(workspaceId));
  }

  async function readyState(workspaceId: string, root: string): Promise<WorkspaceReviewState> {
    let state = states.get(workspaceId);
    assertWorkspaceRoot(state, workspaceId, root);
    if (!isReadyState(state)) {
      await initializeWorkspace({ workspaceId, root });
      state = states.get(workspaceId);
    }
    assertWorkspaceRoot(state, workspaceId, root);
    if (!state) throw new Error(`Review checkpoint state is unavailable for ${workspaceId}.`);
    return state;
  }

  async function withWorkspaceLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    // Tool observations and review advancement share this queue. Files changed
    // by processes outside these calls remain inherently indistinguishable.
    const previous = workspaceLocks.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    workspaceLocks.set(workspaceId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (workspaceLocks.get(workspaceId) === queued) workspaceLocks.delete(workspaceId);
    }
  }

  return {
    initializeWorkspace,

    async trackDirectMutation<T>(
      { workspaceId, root }: { workspaceId: string; root: string },
      operation: () => Promise<T>,
      paths: string[] | ((result: T) => string[]),
      shouldRecord: (result: T) => boolean = (_result: T) => true,
    ) {
      const state = await readyState(workspaceId, root);
      return withWorkspaceLock(workspaceId, async () => {
        state.turnScopeActive = true;
        state.legacyFallbackAllowed = false;
        const result = await operation();
        if (shouldRecord(result) && state.gitRoot) {
          const affectedPaths = typeof paths === "function" ? paths(result) : paths;
          addWorkspacePaths(state, root, affectedPaths);
          await persistPendingPaths(state);
        }
        return result;
      });
    },

    async trackWorkspaceOperation<T>(
      { workspaceId, root }: { workspaceId: string; root: string },
      operation: () => Promise<T>,
      process?: (result: T) => ProcessReviewObservation,
    ) {
      const state = await readyState(workspaceId, root);
      return withWorkspaceLock(workspaceId, async () => {
        state.turnScopeActive = true;
        state.legacyFallbackAllowed = false;
        if (!state.gitRoot) return operation();

        const before = await safeCurrentWorkingTreeSnapshot(state.gitRoot);
        let result!: T;
        let completed = false;
        try {
          result = await operation();
          completed = true;
          return result;
        } finally {
          const after = await safeCurrentWorkingTreeSnapshot(state.gitRoot);
          if (before && after) await recordSnapshotDiff(state, before, after);
          if (completed && process && after) updateProcessSnapshot(state, process(result), after);
          await persistPendingPaths(state);
        }
      });
    },

    async trackProcessOperation<T>(
      { workspaceId, root, sessionId }: {
        workspaceId: string;
        root: string;
        sessionId: number | string;
      },
      operation: () => Promise<T>,
      process?: (result: T) => ProcessReviewObservation,
    ) {
      const state = await readyState(workspaceId, root);
      return withWorkspaceLock(workspaceId, async () => {
        state.turnScopeActive = true;
        state.legacyFallbackAllowed = false;
        if (!state.gitRoot) return operation();

        const before = state.processSnapshots.get(sessionId)
          ?? await safeCurrentWorkingTreeSnapshot(state.gitRoot);
        let result!: T;
        let completed = false;
        try {
          result = await operation();
          completed = true;
          return result;
        } finally {
          const after = await safeCurrentWorkingTreeSnapshot(state.gitRoot);
          if (before && after) await recordSnapshotDiff(state, before, after);
          if (completed && process && after) updateProcessSnapshot(state, process(result), after);
          await persistPendingPaths(state);
        }
      });
    },

    async cleanupWorkspace({ workspaceId, root, gitRoot }) {
      const existingState = states.get(workspaceId);
      assertWorkspaceRoot(existingState, workspaceId, root);

      const pending = initializations.get(workspaceId);
      if (pending) await pending.catch(() => undefined);

      const initializedState = states.get(workspaceId);
      assertWorkspaceRoot(initializedState, workspaceId, root);
      const result = await removeReviewRefs(gitRoot ?? root, workspaceId);
      states.delete(workspaceId);
      return result;
    },

    async reviewChanges({ workspaceId, root, since = "last_shown", markReviewed = true }) {
      const state = await readyState(workspaceId, root);
      if (!state.gitRoot) {
        throw new Error(state.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }

      return withWorkspaceLock(workspaceId, async () => {
        if (!state.gitRoot) {
          throw new Error(state.diagnostic ?? "show_changes requires a Git workspace in this version.");
        }

        let effectiveSince = since;
        let usedWorkspaceOpenFallback = false;
        if (since === "last_shown" && !state.baselineRefAvailable) {
          if (!state.openRefAvailable) {
            throw new Error("Review checkpoints are missing; show_changes cannot reconstruct that history safely.");
          }
          effectiveSince = "workspace_open";
          usedWorkspaceOpenFallback = true;
        } else if (since === "workspace_open" && !state.openRefAvailable) {
          throw new Error(
            "The workspace-open review checkpoint is missing; show_changes cannot reconstruct that history safely.",
          );
        }

        const baselineRef = effectiveSince === "workspace_open" ? state.openRef : state.baselineRef;
        const baseline = (await git(state.gitRoot, ["rev-parse", "--verify", `${baselineRef}^{commit}`])).stdout.trim();
        const tree = await captureWorkingTreeTree(state.gitRoot);
        let observation: string | undefined;
        if (state.processSnapshots.size > 0) {
          observation = await commitWorkingTreeSnapshot(state.gitRoot, baseline, tree);
          for (const [sessionId, previous] of state.processSnapshots) {
            await recordSnapshotDiff(state, previous, observation);
            state.processSnapshots.set(sessionId, observation);
          }
          await persistPendingPaths(state);
        }

        const scopePaths = effectiveSince !== "last_shown"
          ? undefined
          : state.turnScopeActive
            ? new Set(state.trackedPaths)
            : state.legacyFallbackAllowed
              ? undefined
              : new Set<string>();
        const reviewTree = scopePaths === undefined
          ? tree
          : await captureScopedWorkingTreeTree(
              state.gitRoot,
              baseline,
              state.root,
              scopePaths,
            );
        const current = await commitWorkingTreeSnapshot(
          state.gitRoot,
          baseline,
          reviewTree,
          scopePaths,
        );
        const review = await readReviewBetween(state.gitRoot, baseline, current, state.root, scopePaths);

        let baselineCheckpoint = current;
        if (markReviewed) {
          const wasTurnScoped = state.turnScopeActive;
          if (scopePaths !== undefined) {
            baselineCheckpoint = await commitWorkingTreeSnapshot(
              state.gitRoot,
              current,
              tree,
              scopePaths,
            );
          }
          await git(state.gitRoot, ["update-ref", state.baselineRef, baselineCheckpoint]);
          state.baselineRefAvailable = true;
          state.trackedPaths.clear();
          state.turnScopeActive = false;
          if (wasTurnScoped) state.legacyFallbackAllowed = false;
          await clearPendingPaths(state);
        }
        if (observation) {
          const processCheckpoint = markReviewed ? baselineCheckpoint : observation;
          for (const sessionId of state.processSnapshots.keys()) {
            state.processSnapshots.set(sessionId, processCheckpoint);
          }
        }

        const fallbackNote = usedWorkspaceOpenFallback
          ? ` The last-shown checkpoint was missing, so changes were compared from workspace open${markReviewed ? " and the baseline was re-established" : ""}.`
          : "";
        return {
          reviewRef: current,
          result: `${
            review.summary.files === 0
              ? `No changes since ${effectiveSince === "workspace_open" ? "workspace open" : "last shown changes"}.`
              : formatChangedFiles(review.summary)
          }${fallbackNote}`,
          ...review,
        };
      });
    },

    async reviewByRef({ workspaceId, root, reviewRef }) {
      const state = await readyState(workspaceId, root);
      if (!state.gitRoot) {
        throw new Error(state.diagnostic ?? "show_changes requires a Git workspace in this version.");
      }

      return withWorkspaceLock(workspaceId, async () => {
        if (!state.gitRoot) {
          throw new Error(state.diagnostic ?? "show_changes requires a Git workspace in this version.");
        }

        const [openCommit, baselineCommit, reviewCommit] = await Promise.all([
          commitForRef(state.gitRoot, state.openRef),
          commitForRef(state.gitRoot, state.baselineRef),
          resolveReviewCommitOrUndefined(state.gitRoot, reviewRef),
        ]);
        if (
          !openCommit
          || !baselineCommit
          || !reviewCommit
          || reviewCommit === openCommit
        ) {
          throw new Error(`Unknown review reference for workspace ${workspaceId}: ${reviewRef}`);
        }

        const [isAfterOpen, isBeforeBaseline] = await Promise.all([
          isAncestor(state.gitRoot, openCommit, reviewCommit),
          isAncestor(state.gitRoot, reviewCommit, baselineCommit),
        ]);
        if (!isAfterOpen || !isBeforeBaseline) {
          throw new Error(`Unknown review reference for workspace ${workspaceId}: ${reviewRef}`);
        }

        return readReviewCommit(state.gitRoot, state.root, reviewCommit);
      });
    },
  };
}

export async function readReviewRef(root: string, reviewRef: string): Promise<ReviewChangesResult> {
  const eligibility = await getGitEligibility(root);
  if (!eligibility.ok || !eligibility.gitRoot) {
    throw new Error(eligibility.message ?? "show-changes requires a Git workspace.");
  }

  const commit = await resolveReviewCommit(eligibility.gitRoot, reviewRef);
  if (!await isKnownReviewCommit(eligibility.gitRoot, commit)) {
    throw new Error(`Unknown DevSpace review reference: ${reviewRef}`);
  }
  return readReviewCommit(eligibility.gitRoot, root, commit);
}

export async function removeReviewRefs(
  root: string,
  workspaceId: string,
): Promise<ReviewCheckpointCleanupResult> {
  try {
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      return {
        cleaned: false,
        reason: "Review workspace root is not a directory.",
      };
    }
  } catch (error) {
    return {
      cleaned: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let eligibility;
  try {
    eligibility = await getGitEligibility(root);
  } catch (error) {
    return {
      cleaned: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!eligibility.gitRoot) {
    return {
      // A checkout with no Git root cannot have DevSpace review refs. Treat
      // this as a successful no-op so old plain-directory sessions can age out.
      cleaned: true,
    };
  }

  try {
    const refs = reviewRefs(workspaceId);
    await git(eligibility.gitRoot, ["update-ref", "-d", refs.openRef]);
    await git(eligibility.gitRoot, ["update-ref", "-d", refs.baselineRef]);
    await git(eligibility.gitRoot, ["update-ref", "-d", refs.pendingRef]);
    return { cleaned: true };
  } catch (error) {
    return {
      cleaned: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertWorkspaceRoot(
  state: WorkspaceReviewState | undefined,
  workspaceId: string,
  root: string,
): void {
  if (state && state.root !== root) {
    throw new Error(`Review checkpoint workspace root mismatch for ${workspaceId}.`);
  }
}

async function initializeWorkspaceState(
  states: Map<string, WorkspaceReviewState>,
  workspaceId: string,
  root: string,
): Promise<void> {
  const refs = reviewRefs(workspaceId);
  const state: WorkspaceReviewState = {
    root,
    ...refs,
    openRefAvailable: false,
    baselineRefAvailable: false,
    turnScopeActive: false,
    legacyFallbackAllowed: true,
    trackedPaths: new Set(),
    processSnapshots: new Map(),
  };

  try {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) {
      state.diagnostic = eligibility.message ?? "show_changes requires a Git workspace in this version.";
      return;
    }

    const [openCommit, baselineCommit] = await Promise.all([
      commitForRef(eligibility.gitRoot, state.openRef),
      commitForRef(eligibility.gitRoot, state.baselineRef),
    ]);

    if (!openCommit && !baselineCommit) {
      const head = (await git(eligibility.gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
      const initialCommit = await createWorkingTreeSnapshot(eligibility.gitRoot, head);
      await git(eligibility.gitRoot, ["update-ref", state.openRef, initialCommit]);
      await git(eligibility.gitRoot, ["update-ref", state.baselineRef, initialCommit]);
      state.openRefAvailable = true;
      state.baselineRefAvailable = true;
    } else {
      state.openRefAvailable = openCommit !== undefined;
      state.baselineRefAvailable = baselineCommit !== undefined;
    }

    if (state.baselineRefAvailable && await readReviewPaths(eligibility.gitRoot, state.baselineRef)) {
      state.legacyFallbackAllowed = false;
    }

    const pendingPaths = await readReviewPaths(eligibility.gitRoot, state.pendingRef);
    if (pendingPaths) {
      state.trackedPaths = pendingPaths;
      state.turnScopeActive = true;
      state.legacyFallbackAllowed = false;
    }

    state.gitRoot = eligibility.gitRoot;
  } catch (error) {
    state.diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    states.set(workspaceId, state);
  }
}

function reviewAvailability(state: WorkspaceReviewState | undefined): ReviewAvailability {
  return state?.gitRoot
    ? { available: true }
    : {
        available: false,
        reason: state?.diagnostic ?? "show_changes is unavailable for this workspace.",
      };
}

function isReadyState(state: WorkspaceReviewState | undefined): boolean {
  return state?.gitRoot !== undefined;
}

async function commitForRef(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch {
    return undefined;
  }
}

function reviewRefs(
  workspaceId: string,
): Pick<WorkspaceReviewState, "openRef" | "baselineRef" | "pendingRef"> {
  const segment = safeWorkspaceRefSegment(workspaceId);
  return {
    openRef: `${REVIEW_REF_PREFIX}/${segment}/open`,
    baselineRef: `${REVIEW_REF_PREFIX}/${segment}/baseline`,
    pendingRef: `${REVIEW_REF_PREFIX}/${segment}/pending`,
  };
}

const REVIEW_PATHS_MARKER = "DevSpace-Review-Paths: ";

async function createWorkingTreeSnapshot(gitRoot: string, parent: string): Promise<string> {
  const tree = await captureWorkingTreeTree(gitRoot);
  return commitWorkingTreeSnapshot(gitRoot, parent, tree);
}

async function captureWorkingTreeTree(gitRoot: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);

  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(gitRoot, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
    return tree;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function captureScopedWorkingTreeTree(
  gitRoot: string,
  baseline: string,
  workspaceRoot: string,
  paths: ReadonlySet<string>,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "devspace-review-scope-index-"));
  const indexPath = join(tempDir, "index");
  const env = checkpointEnv(indexPath);
  const scope = reviewPathScope(gitRoot, workspaceRoot, paths);

  try {
    await git(gitRoot, ["read-tree", baseline], { env });
    if (scope.pathspecs.length > 0) {
      const existingPathspecs = await resolveScopedSnapshotPathspecs(
        gitRoot,
        scope.pathspecs,
        env,
      );
      if (existingPathspecs.length > 0) {
        await git(gitRoot, ["add", "-A", "--", ...existingPathspecs], { env });
      }
    }
    return (await git(gitRoot, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveScopedSnapshotPathspecs(
  gitRoot: string,
  pathspecs: string[],
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const output = (await git(gitRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...pathspecs,
  ], { env })).stdout;
  const paths = new Set(
    output
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizeGitPath),
  );
  return [...paths].map((path) => `:(top,literal)${path}`);
}

async function commitWorkingTreeSnapshot(
  gitRoot: string,
  parent: string,
  tree: string,
  paths?: ReadonlySet<string>,
): Promise<string> {
  let tempDir: string | undefined;
  try {
    const args = ["commit-tree", tree, "-p", parent];
    const env = checkpointEnv();
    if (paths === undefined) {
      args.push("-m", "DevSpace review snapshot");
    } else {
      tempDir = await mkdtemp(join(tmpdir(), "devspace-review-message-"));
      const messagePath = join(tempDir, "message");
      const encodedPaths = Buffer.from(JSON.stringify([...paths].sort()), "utf8").toString("base64url");
      await writeFile(messagePath, `DevSpace review snapshot\n\n${REVIEW_PATHS_MARKER}${encodedPaths}\n`, "utf8");
      args.push("-F", messagePath);
    }
    return (await git(gitRoot, args, { env })).stdout.trim();
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

async function safeCurrentWorkingTreeSnapshot(gitRoot: string): Promise<string | undefined> {
  try {
    const head = (await git(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    return createWorkingTreeSnapshot(gitRoot, head);
  } catch {
    return undefined;
  }
}

async function recordSnapshotDiff(
  state: WorkspaceReviewState,
  before: string,
  after: string,
): Promise<void> {
  if (!state.gitRoot) return;
  const paths = await changedPathsBetween(state.gitRoot, before, after, state.root);
  for (const path of paths) state.trackedPaths.add(path);
}

async function persistPendingPaths(state: WorkspaceReviewState): Promise<void> {
  if (!state.gitRoot) return;
  if (state.trackedPaths.size === 0) {
    await clearPendingPaths(state);
    return;
  }

  const parent = await commitForRef(state.gitRoot, state.baselineRef)
    ?? await commitForRef(state.gitRoot, state.openRef);
  if (!parent) return;

  const tree = (await git(state.gitRoot, ["rev-parse", "--verify", `${parent}^{tree}`])).stdout.trim();
  const pending = await commitWorkingTreeSnapshot(
    state.gitRoot,
    parent,
    tree,
    state.trackedPaths,
  );
  await git(state.gitRoot, ["update-ref", state.pendingRef, pending]);
}

async function clearPendingPaths(state: WorkspaceReviewState): Promise<void> {
  if (!state.gitRoot) return;
  await git(state.gitRoot, ["update-ref", "-d", state.pendingRef]);
}

function updateProcessSnapshot(
  state: WorkspaceReviewState,
  observation: ProcessReviewObservation,
  snapshot: string,
): void {
  if (observation.sessionId === undefined) return;
  if (observation.running) state.processSnapshots.set(observation.sessionId, snapshot);
  else state.processSnapshots.delete(observation.sessionId);
}

function addWorkspacePaths(
  state: WorkspaceReviewState,
  workspaceRoot: string,
  paths: string[],
): void {
  if (!state.gitRoot) return;
  for (const path of paths) {
    state.trackedPaths.add(workspacePathToGitPath(state.gitRoot, workspaceRoot, path));
  }
}

function workspacePathToGitPath(gitRoot: string, workspaceRoot: string, inputPath: string): string {
  const absolutePath = resolve(workspaceRoot, inputPath);
  const workspaceRelative = relative(resolve(workspaceRoot), absolutePath);
  if (!isInsideRelativePath(workspaceRelative)) {
    throw new Error(`Tracked path is outside workspace root: ${inputPath}`);
  }

  const gitRelative = relative(resolve(gitRoot), absolutePath);
  if (!isInsideRelativePath(gitRelative)) {
    throw new Error(`Tracked path is outside Git repository: ${inputPath}`);
  }
  return normalizeGitPath(gitRelative);
}

async function changedPathsBetween(
  gitRoot: string,
  before: string,
  after: string,
  workspaceRoot: string,
): Promise<string[]> {
  const scope = reviewPathScope(gitRoot, workspaceRoot);
  const output = (await git(gitRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    before,
    after,
    "--",
    ...scope.pathspecs,
  ], { maxBuffer: 50 * 1024 * 1024 })).stdout;

  const fields = output.split("\0").filter((field) => field.length > 0);
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    const previousPath = fields[index++];
    if (!previousPath) continue;
    paths.add(normalizeGitPath(previousPath));
    if (status.startsWith("R") || status.startsWith("C")) {
      const path = fields[index++];
      if (path) paths.add(normalizeGitPath(path));
    }
  }
  return [...paths];
}

async function readReviewCommit(
  gitRoot: string,
  workspaceRoot: string,
  reviewRef: string,
): Promise<ReviewChangesResult> {
  const parent = (await git(gitRoot, ["rev-parse", "--verify", `${reviewRef}^1`])).stdout.trim();
  const paths = await readReviewPaths(gitRoot, reviewRef);
  const review = await readReviewBetween(gitRoot, parent, reviewRef, workspaceRoot, paths);
  return {
    reviewRef,
    result: review.summary.files === 0 ? "No changes in this review." : formatChangedFiles(review.summary),
    ...review,
  };
}

async function readReviewBetween(
  gitRoot: string,
  before: string,
  after: string,
  workspaceRoot: string,
  paths?: ReadonlySet<string>,
): Promise<Pick<ReviewChangesResult, "summary" | "files" | "patch">> {
  const scope = reviewPathScope(gitRoot, workspaceRoot, paths);
  if (scope.pathspecs.length === 0) {
    return {
      summary: { files: 0, additions: 0, removals: 0 },
      files: [],
      patch: "",
    };
  }

  const relativeOption = scope.relativePath ? [`--relative=${scope.relativePath}`] : [];
  const patch = (await git(gitRoot, [
    "diff",
    "--binary",
    "--no-color",
    "--find-renames",
    ...relativeOption,
    before,
    after,
    "--",
    ...scope.pathspecs,
  ], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  const numstat = (await git(gitRoot, [
    "diff",
    "--numstat",
    "-z",
    "--find-renames",
    ...relativeOption,
    before,
    after,
    "--",
    ...scope.pathspecs,
  ], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  const nameStatus = (await git(gitRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    ...relativeOption,
    before,
    after,
    "--",
    ...scope.pathspecs,
  ], {
    maxBuffer: 50 * 1024 * 1024,
  })).stdout;
  const renameStatuses = parseNameStatus(nameStatus);
  const files = parseNumstat(numstat)
    .map((file) => refineReviewFile(file, renameStatuses))
    .map((file) => displayReviewFile(file, scope.relativePath));
  return {
    summary: summarizeFiles(files),
    files,
    patch,
  };
}

function parseNameStatus(output: string): Map<string, string> {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const statuses = new Map<string, string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] ?? "";
    const firstPath = fields[index++];
    if (!firstPath) continue;

    if (status.startsWith("R") || status.startsWith("C")) {
      const path = fields[index++];
      if (path) statuses.set(normalizeGitPath(path), status);
    } else {
      statuses.set(normalizeGitPath(firstPath), status);
    }
  }
  return statuses;
}

function refineReviewFile(file: ReviewFile, statuses: Map<string, string>): ReviewFile {
  if (!file.previousPath || file.type !== "rename-pure") return file;
  const status = statuses.get(normalizeGitPath(file.path));
  return status && status !== "R100"
    ? { ...file, type: "rename-changed" }
    : file;
}

async function readReviewPaths(gitRoot: string, reviewRef: string): Promise<Set<string> | undefined> {
  try {
    const message = (await git(gitRoot, ["show", "-s", "--format=%B", reviewRef])).stdout;
    const marker = message
      .split("\n")
      .find((line) => line.startsWith(REVIEW_PATHS_MARKER));
    if (!marker) return undefined;
    const encoded = marker.slice(REVIEW_PATHS_MARKER.length).trim();
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || !parsed.every((path): path is string => typeof path === "string")) {
      return undefined;
    }
    return new Set(parsed);
  } catch {
    return undefined;
  }
}

interface ReviewPathScope {
  pathspecs: string[];
  relativePath?: string;
}

function reviewPathScope(
  gitRoot: string,
  workspaceRoot: string,
  paths?: ReadonlySet<string>,
): ReviewPathScope {
  const relativePath = workspaceGitPrefix(gitRoot, workspaceRoot);
  if (paths === undefined) {
    return {
      pathspecs: [workspacePathspec(relativePath)],
      relativePath: relativePath || undefined,
    };
  }

  const pathspecs = [...paths]
    .map(normalizeGitPath)
    .filter((path) => isPathInWorkspace(path, relativePath))
    .map((path) => `:(top,literal)${path}`);
  return {
    pathspecs,
    relativePath: relativePath || undefined,
  };
}

function workspacePathspec(relativePath: string): string {
  return relativePath ? `:(top,literal)${relativePath}` : ".";
}

function workspaceGitPrefix(gitRoot: string, workspaceRoot: string): string {
  const path = relative(resolve(gitRoot), resolve(workspaceRoot));
  if (!isInsideRelativePath(path)) {
    throw new Error(`Workspace root is outside its Git repository: ${workspaceRoot}`);
  }
  return normalizeGitPath(path);
}

function isPathInWorkspace(path: string, relativePath: string): boolean {
  if (!isInsideRelativePath(path)) return false;
  return !relativePath || path === relativePath || path.startsWith(`${relativePath}/`);
}

function isInsideRelativePath(path: string): boolean {
  return path === ""
    || (!isAbsolute(path)
      && path !== ".."
      && !path.startsWith("../")
      && !path.startsWith(`..${sep}`));
}

function normalizeGitPath(path: string): string {
  return path.split(sep).join("/");
}

function displayReviewFile(file: ReviewFile, relativePath: string | undefined): ReviewFile {
  if (!relativePath) return file;
  return {
    ...file,
    path: displayWorkspacePath(file.path, relativePath),
    previousPath: file.previousPath
      ? displayWorkspacePath(file.previousPath, relativePath)
      : undefined,
  };
}

function displayWorkspacePath(path: string, relativePath: string): string {
  return path === relativePath
    ? ""
    : path.startsWith(`${relativePath}/`)
      ? path.slice(relativePath.length + 1)
      : path;
}

async function resolveReviewCommit(gitRoot: string, reviewRef: string): Promise<string> {
  if (!isReviewRef(reviewRef)) {
    throw new Error(`Invalid review reference: ${reviewRef}`);
  }
  return (await git(gitRoot, ["rev-parse", "--verify", `${reviewRef}^{commit}`])).stdout.trim();
}

async function resolveReviewCommitOrUndefined(
  gitRoot: string,
  reviewRef: string,
): Promise<string | undefined> {
  try {
    return await resolveReviewCommit(gitRoot, reviewRef);
  } catch {
    return undefined;
  }
}

async function isAncestor(gitRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(gitRoot, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function isKnownReviewCommit(gitRoot: string, reviewCommit: string): Promise<boolean> {
  const refs = (await git(gitRoot, [
    "for-each-ref",
    "--format=%(refname)\t%(objectname)",
    REVIEW_REF_PREFIX,
  ])).stdout.trim();
  if (!refs) return false;

  const histories = new Map<string, { open?: string; baseline?: string }>();
  for (const line of refs.split("\n")) {
    const [ref, commit] = line.split("\t");
    if (!ref || !commit) continue;

    const match = ref.match(/^refs\/devspace\/review\/(.+)\/(open|baseline)$/);
    if (!match) continue;
    const [, workspace, kind] = match;
    if (!workspace || !kind) continue;

    const history = histories.get(workspace) ?? {};
    history[kind as "open" | "baseline"] = commit;
    histories.set(workspace, history);
  }

  const memberships = await Promise.all(
    [...histories.values()].map(async ({ open, baseline }) => {
      if (!open || !baseline || reviewCommit === open) return false;
      const [isAfterOpen, isBeforeBaseline] = await Promise.all([
        isAncestor(gitRoot, open, reviewCommit),
        isAncestor(gitRoot, reviewCommit, baseline),
      ]);
      return isAfterOpen && isBeforeBaseline;
    }),
  );
  return memberships.some(Boolean);
}

function isReviewRef(value: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(value);
}

function formatChangedFiles(summary: ReviewSummary): string {
  return `Changed ${summary.files} ${summary.files === 1 ? "file" : "files"} (+${summary.additions} -${summary.removals}).`;
}

function checkpointEnv(indexPath?: string): NodeJS.ProcessEnv {
  return {
    ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
    GIT_AUTHOR_NAME: "DevSpace",
    GIT_AUTHOR_EMAIL: "devspace@users.noreply.local",
    GIT_COMMITTER_NAME: "DevSpace",
    GIT_COMMITTER_EMAIL: "devspace@users.noreply.local",
  };
}

function parseNumstat(output: string): ReviewFile[] {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const files: ReviewFile[] = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++] ?? "";
    const parts = header.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);

    const pathInHeader = parts[2] ?? "";
    if (pathInHeader) {
      files.push({
        path: pathInHeader,
        type: fileType(pathInHeader, undefined, additions, removals),
        additions,
        removals,
      });
      continue;
    }

    const previousPath = fields[index++];
    const path = fields[index++];
    if (!path) continue;

    files.push({
      path,
      previousPath,
      type: fileType(path, previousPath, additions, removals),
      additions,
      removals,
    });
  }

  return files;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileType(
  path: string,
  previousPath: string | undefined,
  additions: number,
  removals: number,
): ReviewFile["type"] {
  if (previousPath) return additions === 0 && removals === 0 ? "rename-pure" : "rename-changed";
  if (additions > 0 && removals === 0) return "new";
  if (additions === 0 && removals > 0) return "deleted";
  return "change";
}

function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      removals: summary.removals + file.removals,
    }),
    { files: 0, additions: 0, removals: 0 },
  );
}
