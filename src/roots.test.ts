import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
  resolveConfinedPath,
} from "./roots.js";
import { writeFileTool } from "./pi-tools.js";

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
  const regularMissing = join(allowedRoot, "new-directory", "created.txt");
  assert.equal(
    await resolveConfinedPath(regularMissing, [allowedRoot]),
    regularMissing,
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
    assert.equal(
      await resolveConfinedPath(join(allowedAlias, "new-directory", "created.txt"), [allowedAlias]),
      join(allowedAlias, "new-directory", "created.txt"),
    );

    await assert.rejects(
      resolveConfinedPath(join(link, "created.txt"), [allowedRoot]),
      /outside allowed roots/,
    );

    const danglingTarget = join(outsideRoot, "dangling-target.txt");
    const danglingLink = join(allowedRoot, "dangling-link");
    await symlink(danglingTarget, danglingLink, "file");
    await assert.rejects(
      resolveConfinedPath(danglingLink, [allowedRoot]),
      /outside allowed roots/,
    );

    await assert.rejects(
      writeFileTool(
        { path: "dangling-link", content: "must stay outside\n" },
        { cwd: allowedRoot, root: allowedRoot },
      ),
      /outside allowed roots/,
    );
    await assert.rejects(access(danglingTarget), /ENOENT/);

    const danglingAncestorTarget = join(outsideRoot, "missing-directory");
    const danglingAncestor = join(allowedRoot, "dangling-ancestor");
    await symlink(danglingAncestorTarget, danglingAncestor, "dir");
    await assert.rejects(
      resolveConfinedPath(join(danglingAncestor, "created.txt"), [allowedRoot]),
      /outside allowed roots/,
    );

    const internalDanglingTarget = join(allowedRoot, "not-created-yet");
    const internalDanglingLink = join(allowedRoot, "internal-dangling-link");
    const internalDanglingChain = join(allowedRoot, "internal-dangling-chain");
    await symlink(internalDanglingTarget, internalDanglingLink, "file");
    await symlink(internalDanglingLink, internalDanglingChain, "file");
    await assert.rejects(
      resolveConfinedPath(internalDanglingChain, [allowedRoot]),
      /outside allowed roots/,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
