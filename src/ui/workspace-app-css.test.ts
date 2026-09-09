import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./workspace-app.css", import.meta.url), "utf8");

test("mobile text autosizing is disabled for the embedded app", () => {
  assert.match(css, /-webkit-text-size-adjust:\s*none/);
  assert.match(css, /text-size-adjust:\s*none/);
});

test("review code keeps long lines inside its horizontal scroller", () => {
  assert.match(css, /\.review-code\s*\{[^}]*contain:\s*inline-size/s);
  assert.match(css, /\.review-code-line\s*\{[^}]*width:\s*max-content/s);
  assert.match(css, /\.review-code-line\s*\{[^}]*min-width:\s*100%/s);
  assert.doesNotMatch(css, /minmax\(max-content,\s*1fr\)/);
});
