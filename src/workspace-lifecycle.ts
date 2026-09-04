import { assertAllowedPath } from "./roots.js";
import {
  removeManagedWorktree,
  type ManagedWorktreeRemovalResult,
} from "./git-worktrees.js";
import type { ReviewCheckpointManager } from "./review-checkpoints.js";
import type { ServerConfig } from "./config.js";
import type {
  WorkspaceSession,
  WorkspaceStore,
} from "./workspace-store.js";
import type { WorkspaceRegistry } from "./workspaces.js";

// A conversation that has not used a workspace for a week is no longer
// considered active. Inactive rows are retained for a month so cleanup can be
// retried after a transient Git/filesystem failure.
export const WORKSPACE_INACTIVITY_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;
export const WORKSPACE_RETENTION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;
export const WORKSPACE_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;

export interface WorkspaceLifecycleCleanupOptions {
  config: Pick<ServerConfig, "allowedRoots" | "worktreeRoot">;
  store: WorkspaceStore;
  registry: Pick<WorkspaceRegistry, "evictRetiredWorkspaces">;
  reviewCheckpoints: Pick<ReviewCheckpointManager, "cleanupWorkspace">;
  protectedWorkspaceIds?: Iterable<string>;
  now?: () => number;
  inactivityTimeoutMs?: number;
  retentionTimeoutMs?: number;
}

export interface WorkspaceLifecycleCleanupResult {
  retired: WorkspaceSession[];
  evictedWorkspaceIds: string[];
  cleanedReviewWorkspaceIds: string[];
  removedWorktreeWorkspaceIds: string[];
  retainedManagedWorktreeWorkspaceIds: string[];
  deletedSessionIds: string[];
  errors: Array<{
    workspaceId: string;
    resource: "review" | "worktree";
    reason: string;
  }>;
}

export async function cleanupWorkspaceLifecycle(
  options: WorkspaceLifecycleCleanupOptions,
): Promise<WorkspaceLifecycleCleanupResult> {
  const now = options.now?.() ?? Date.now();
  const inactivityTimeoutMs = duration(
    options.inactivityTimeoutMs ?? WORKSPACE_INACTIVITY_TIMEOUT_MS,
    "Workspace inactivity timeout",
  );
  const retentionTimeoutMs = duration(
    options.retentionTimeoutMs ?? WORKSPACE_RETENTION_TIMEOUT_MS,
    "Workspace retention timeout",
  );
  const inactiveBefore = new Date(now - inactivityTimeoutMs).toISOString();
  const retainedUntil = new Date(now - retentionTimeoutMs).toISOString();

  const protectedWorkspaceIds = new Set(options.protectedWorkspaceIds ?? []);
  const retired = options.store.retireStaleSessions(
    inactiveBefore,
    protectedWorkspaceIds,
  );
  const candidates = uniqueSessions([
    ...retired,
    ...options.store.findInactiveSessions(),
  ]);
  const deletableSessionIds: string[] = [];
  const cleanedReviewWorkspaceIds: string[] = [];
  const removedWorktreeWorkspaceIds: string[] = [];
  const retainedManagedWorktreeWorkspaceIds: string[] = [];
  const errors: WorkspaceLifecycleCleanupResult["errors"] = [];

  for (const session of candidates) {
    if (protectedWorkspaceIds.has(session.id)) continue;

    const reviewCleaned = await cleanupReviewRefs(options, session, errors);
    let managedWorktreeSafeToForget = true;

    if (session.mode === "worktree" && session.managed) {
      const removal = await cleanupManagedWorktree(options, session, errors);
      managedWorktreeSafeToForget = removal.status !== "unsafe";
      if (removal.status === "removed") {
        removedWorktreeWorkspaceIds.push(session.id);
      } else if (removal.status === "unsafe") {
        retainedManagedWorktreeWorkspaceIds.push(session.id);
      }
    }

    if (reviewCleaned) cleanedReviewWorkspaceIds.push(session.id);
    if (
      reviewCleaned &&
      managedWorktreeSafeToForget &&
      isBefore(session.lastUsedAt, retainedUntil)
    ) {
      deletableSessionIds.push(session.id);
    }
  }

  const evictedWorkspaceIds = options.registry.evictRetiredWorkspaces(
    candidates.map((session) => session.id),
    protectedWorkspaceIds,
  );
  options.store.deleteInactiveSessions(deletableSessionIds);

  return {
    retired,
    evictedWorkspaceIds,
    cleanedReviewWorkspaceIds,
    removedWorktreeWorkspaceIds,
    retainedManagedWorktreeWorkspaceIds,
    deletedSessionIds: deletableSessionIds,
    errors,
  };
}

async function cleanupReviewRefs(
  options: WorkspaceLifecycleCleanupOptions,
  session: WorkspaceSession,
  errors: WorkspaceLifecycleCleanupResult["errors"],
): Promise<boolean> {
  let root: string;
  let gitRoot: string;
  try {
    root = session.mode === "worktree"
      ? assertAllowedPath(session.root, [options.config.worktreeRoot])
      : assertAllowedPath(session.root, options.config.allowedRoots);
    gitRoot = assertAllowedPath(
      session.sourceRoot ?? session.root,
      options.config.allowedRoots,
    );
  } catch (error) {
    errors.push({
      workspaceId: session.id,
      resource: "review",
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  try {
    const result = await options.reviewCheckpoints.cleanupWorkspace({
      workspaceId: session.id,
      root,
      gitRoot,
    });
    if (!result.cleaned) {
      errors.push({
        workspaceId: session.id,
        resource: "review",
        reason: result.reason ?? "Review refs could not be cleaned.",
      });
    }
    return result.cleaned;
  } catch (error) {
    errors.push({
      workspaceId: session.id,
      resource: "review",
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function cleanupManagedWorktree(
  options: WorkspaceLifecycleCleanupOptions,
  session: WorkspaceSession,
  errors: WorkspaceLifecycleCleanupResult["errors"],
): Promise<ManagedWorktreeRemovalResult> {
  if (!session.sourceRoot) {
    const result = {
      status: "unsafe" as const,
      reason: "Stored managed worktree session is missing sourceRoot.",
    };
    errors.push({ workspaceId: session.id, resource: "worktree", reason: result.reason });
    return result;
  }

  const result = await removeManagedWorktree({
    sourceRoot: session.sourceRoot,
    path: session.root,
    baseSha: session.baseSha,
    config: options.config,
  });
  if (result.status === "unsafe") {
    errors.push({
      workspaceId: session.id,
      resource: "worktree",
      reason: result.reason ?? "Managed worktree was not safe to remove.",
    });
  }
  return result;
}

function uniqueSessions(sessions: readonly WorkspaceSession[]): WorkspaceSession[] {
  const unique = new Map<string, WorkspaceSession>();
  for (const session of sessions) unique.set(session.id, session);
  return [...unique.values()];
}

function duration(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite duration.`);
  }
  return value;
}

function isBefore(value: string, cutoff: string): boolean {
  const timestamp = Date.parse(value);
  const cutoffTimestamp = Date.parse(cutoff);
  return Number.isFinite(timestamp) && Number.isFinite(cutoffTimestamp) && timestamp < cutoffTimestamp;
}
