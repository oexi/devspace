import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

async function sourceFilesUsing(specifier: string): Promise<string[]> {
  const files = await readdir(sourceRoot, { recursive: true });
  const offenders: string[] = [];
  for (const relativePath of files) {
    if (!/\.(?:ts|tsx)$/.test(relativePath)) continue;
    if (relativePath === "mcp-v2-architecture.test.ts") continue;
    const content = await readFile(`${sourceRoot}/${relativePath}`, "utf8");
    if (content.includes(specifier)) offenders.push(relativePath);
  }
  return offenders.sort();
}

test("DevSpace source has no direct v1 MCP SDK imports", async () => {
  const sdkSpecifier = ["@modelcontextprotocol", "/", "sdk"].join("");
  assert.deepEqual(await sourceFilesUsing(sdkSpecifier), []);
});

test("legacy authorization helpers stay inside the OAuth compatibility boundary", async () => {
  assert.deepEqual(
    await sourceFilesUsing(["@modelcontextprotocol", "/", "server-legacy"].join("")),
    ["oauth-legacy-compat.ts"],
  );
});

test("package dependencies do not reintroduce the v1 MCP SDK directly", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.["@modelcontextprotocol/sdk"], undefined);
  assert.equal(packageJson.devDependencies?.["@modelcontextprotocol/sdk"], undefined);
});
