import assert from "node:assert/strict";
import test from "node:test";
import { parsePatchFiles } from "@pierre/diffs";
import { buildReviewLines } from "./review-payload.js";

test("review lines render unified line numbers and change markers", () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-old line
+new line
+added line
 tail
`;
  const file = parsePatchFiles(patch, "review", true)[0]?.files[0];
  assert.ok(file);

  assert.deepEqual(buildReviewLines(file), [
    { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
    { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
    { kind: "deletion", oldLine: 2, text: "old line" },
    { kind: "addition", newLine: 2, text: "new line" },
    { kind: "addition", newLine: 3, text: "added line" },
    { kind: "context", oldLine: 3, newLine: 4, text: "tail" },
  ]);
});
