import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
}

/** Resolve the project context used by local agent commands. */
export function resolveCliWorkspaceContext(
  allowedRoots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CliWorkspaceContext {
  const workspaceId = env.DEVSPACE_WORKSPACE_ID?.trim() || undefined;
  const injectedRoot = workspaceId ? env.DEVSPACE_WORKSPACE_ROOT?.trim() : undefined;
  const cwdGitRoot = findGitRoot(cwd);

  if (workspaceId && injectedRoot && cwdGitRoot) {
    const injectedGitRoot = findGitRoot(injectedRoot);
    if (
      injectedGitRoot &&
      canonicalizePath(cwdGitRoot) !== canonicalizePath(injectedGitRoot) &&
      sameGitRepository(cwd, injectedRoot)
    ) {
      return {
        workspaceId: undefined,
        workspaceRoot: canonicalizePath(cwdGitRoot),
      };
    }
  }

  const candidate = canonicalizePath(
    injectedRoot ? resolve(injectedRoot) : cwdGitRoot ?? resolve(cwd),
  );

  if (!workspaceId) return { workspaceId, workspaceRoot: candidate };

  return {
    workspaceId,
    workspaceRoot: assertAllowedPath(candidate, allowedRoots.map(canonicalizePath)),
  };
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function findGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}

function sameGitRepository(first: string, second: string): boolean {
  const firstCommonDir = findGitCommonDir(first);
  const secondCommonDir = findGitCommonDir(second);
  return Boolean(
    firstCommonDir &&
    secondCommonDir &&
    canonicalizePath(firstCommonDir) === canonicalizePath(secondCommonDir),
  );
}

function findGitCommonDir(cwd: string): string | undefined {
  const result = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: resolve(cwd),
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) return undefined;
  const commonDir = result.stdout.trim();
  return commonDir ? resolve(commonDir) : undefined;
}
