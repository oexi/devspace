import { dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      relationship !== ".." &&
      !relationship.startsWith(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

/**
 * Resolve a path and verify that its real filesystem location is inside one
 * of the supplied roots. Missing path components are checked against the
 * nearest existing ancestor so callers can safely create new targets.
 *
 * The returned path keeps the caller's logical path spelling. This preserves
 * compatibility for configured allowed roots that are themselves symlinks;
 * the real paths are used only for the confinement check.
 */
export async function resolveConfinedPath(
  path: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const resolvedPath = resolve(expandHomePath(path));
  const candidateRoots = allowedRoots
    .map((root) => resolve(expandHomePath(root)))
    .filter((root) => isPathInsideRoot(resolvedPath, root));
  if (candidateRoots.length === 0) {
    throw new AccessDeniedError(`Path resolves outside allowed roots: ${path}`);
  }

  const resolvedRealPath = await resolvePathWithMissingSegments(resolvedPath);
  const resolvedRealRoots = await Promise.all(
    candidateRoots.map((root) => resolvePathWithMissingSegments(root)),
  );

  if (resolvedRealRoots.some((root) => isPathInsideRoot(resolvedRealPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path resolves outside allowed roots: ${path}`);
}

async function resolvePathWithMissingSegments(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;

      try {
        if ((await lstat(candidate)).isSymbolicLink()) {
          throw new AccessDeniedError(`Path resolves outside allowed roots: ${path}`);
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }

      const parent = dirname(candidate);
      if (parent === candidate) return path;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
