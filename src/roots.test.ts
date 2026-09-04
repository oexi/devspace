import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
  resolveConfinedPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

const root = await mkdtemp(join(tmpdir(), "devspace-roots-test-"));
try {
  const allowedRoot = join(root, "allowed");
  const legalName = join(allowedRoot, "..foo");
  await mkdir(allowedRoot, { recursive: true });
  await writeFile(legalName, "legal\n");

  assert.equal(
    await resolveConfinedPath(legalName, [allowedRoot]),
    legalName,
  );

  if (process.platform !== "win32") {
    const allowedAlias = join(root, "allowed-alias");
    const outsideRoot = join(root, "outside");
    const link = join(allowedRoot, "outside-link");
    await symlink(allowedRoot, allowedAlias, "dir");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, link, "dir");

    assert.equal(
      await resolveConfinedPath(join(allowedAlias, "..foo"), [allowedAlias]),
      join(allowedAlias, "..foo"),
    );

    await assert.rejects(
      resolveConfinedPath(join(link, "created.txt"), [allowedRoot]),
      /outside allowed roots/,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
