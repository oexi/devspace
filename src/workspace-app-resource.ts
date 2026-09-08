import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WORKSPACE_APP_DEV_URI = "ui://devspace/workspace-app-dev.html";
const WORKSPACE_APP_RESOURCE_REVISION = "inline-v1";

export interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

export function workspaceAppResourceUriForEntry(
  entry: WorkspaceAppManifestEntry,
): string {
  const fingerprint = createHash("sha256")
    .update([
      WORKSPACE_APP_RESOURCE_REVISION,
      entry.file,
      ...(entry.css ?? []),
    ].join("\n"))
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

export function rewriteWorkspaceAppDynamicImports(
  script: string,
  manifest: WorkspaceAppManifest,
  assetBaseUrl: string,
): string {
  let rewritten = script;
  const baseUrl = assetBaseUrl.replace(/\/+$/, "");

  for (const entry of Object.values(manifest)) {
    if (!entry.isDynamicEntry || !entry.file) continue;
    const filename = entry.file.split("/").at(-1);
    if (!filename) continue;
    rewritten = rewritten.replaceAll(`./${filename}`, `${baseUrl}/${entry.file}`);
  }

  return rewritten;
}

export function buildInlineWorkspaceAppHtml(input: {
  script: string;
  styles: string[];
}): string {
  const styles = input.styles.map(escapeInlineStyle).join("\n");
  const script = escapeInlineScript(input.script);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <style>${styles}</style>
  </head>
  <body>
    <div id="app" class="shell">
      <section class="empty-state">Waiting for a tool result.</section>
    </div>
    <script type="module">${script}</script>
  </body>
</html>`;
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(value: string): string {
  return value.replace(/<\/style/gi, "<\\/style");
}
