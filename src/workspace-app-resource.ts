import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WORKSPACE_APP_DEV_URI = "ui://devspace/workspace-app-dev.html";

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export function workspaceAppResourceUriForEntry(
  entry: WorkspaceAppManifestEntry,
): string {
  const fingerprint = createHash("sha256")
    .update([entry.file, ...(entry.css ?? [])].join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `ui://devspace/workspace-app-${fingerprint}.html`;
}

function resolveWorkspaceAppResourceUri(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../dist/ui/.vite/manifest.json", import.meta.url), "utf8"),
    ) as WorkspaceAppManifest;
    const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
    if (!entry?.file) return WORKSPACE_APP_DEV_URI;
    return workspaceAppResourceUriForEntry(entry);
  } catch {
    // Source-only tests and dev workflows may run before the UI bundle exists.
    // Production packages always include dist/ui and therefore use a build-
    // fingerprinted URI so ChatGPT cannot reuse stale HTML across UI builds.
    return WORKSPACE_APP_DEV_URI;
  }
}

export const WORKSPACE_APP_URI = resolveWorkspaceAppResourceUri();
