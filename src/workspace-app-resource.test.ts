import assert from "node:assert/strict";
import test from "node:test";
import { workspaceAppResourceUriForEntry } from "./workspace-app-resource.js";

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
