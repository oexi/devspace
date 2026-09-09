import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildInlineWorkspaceAppHtml,
  workspaceAppResourceUriForEntry,
} from "./workspace-app-resource.js";

test("workspace app resource URI changes with built JS or CSS assets", () => {
  const first = workspaceAppResourceUriForEntry({
    file: "assets/workspace-app-first.js",
    css: ["assets/workspace-app-first.css"],
  });
  const same = workspaceAppResourceUriForEntry({
    file: "assets/workspace-app-first.js",
    css: ["assets/workspace-app-first.css"],
  });
  const changedJs = workspaceAppResourceUriForEntry({
    file: "assets/workspace-app-second.js",
    css: ["assets/workspace-app-first.css"],
  });
  const changedCss = workspaceAppResourceUriForEntry({
    file: "assets/workspace-app-first.js",
    css: ["assets/workspace-app-second.css"],
  });

  assert.equal(first, same);
  assert.match(first, /^ui:\/\/devspace\/workspace-app-[0-9a-f]{12}\.html$/);
  assert.notEqual(first, changedJs);
  assert.notEqual(first, changedCss);
});

test("inline resource revision produces a different URI from the legacy asset-only key", () => {
  const entry = {
    file: "assets/workspace-app-BR6HS6jt.js",
    css: ["assets/workspace-app-C8amhnWe.css"],
  };
  const legacyFingerprint = createHash("sha256")
    .update([entry.file, ...entry.css].join("\n"))
    .digest("hex")
    .slice(0, 12);

  assert.notEqual(
    workspaceAppResourceUriForEntry(entry),
    `ui://devspace/workspace-app-${legacyFingerprint}.html`,
  );
});

test("workspace app HTML inlines the entry bundle and stylesheet", () => {
  const html = buildInlineWorkspaceAppHtml({
    script: "console.log('ready'); const marker = '</script>';",
    styles: [".shell{display:block}.marker::after{content:'</style>'}"],
  });

  assert.match(html, /<style>\.shell\{display:block\}/);
  assert.match(html, /<script type="module">console\.log\('ready'\)/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.match(html, /<\\\/script>/);
  assert.match(html, /<\\\/style>/);
});

