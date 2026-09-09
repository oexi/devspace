import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import {
  effectiveSkillPaths,
  formatPathForPrompt,
  loadWorkspaceSkills,
  resolveSkillReadPath,
} from "./skills.js";
import { readFileTool } from "./pi-tools.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const root = await mkdtemp(join(tmpdir(), "devspace-skills-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

try {
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const explicitSkills = join(root, "explicit-skills");
  const devspaceSkills = join(root, ".devspace", "skills");
  const globalAgentsSkills = join(root, ".agents", "skills");
  const projectAgentsSkills = join(projectRoot, ".agents", "skills");
  const globalClaudeSkills = join(root, ".claude", "skills");
  const projectClaudeSkills = join(projectRoot, ".claude", "skills");
  await mkdir(join(globalAgentsSkills, "agent-global-skill"), { recursive: true });
  await mkdir(join(projectAgentsSkills, "agent-project-skill"), { recursive: true });
  await mkdir(join(globalClaudeSkills, "claude-global-skill"), { recursive: true });
  await mkdir(join(projectClaudeSkills, "claude-project-skill"), { recursive: true });
  await mkdir(join(projectRoot, ".pi", "skills", "project-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
  await mkdir(join(agentDir, "skills", "subagents"), { recursive: true });
  await mkdir(join(explicitSkills, "duplicate"), { recursive: true });
  await mkdir(join(explicitSkills, "disabled"), { recursive: true });
  await mkdir(join(explicitSkills, "subagents"), { recursive: true });
  await mkdir(join(devspaceSkills, "devspace-local-skill"), { recursive: true });

  await writeFile(
    join(globalAgentsSkills, "agent-global-skill", "SKILL.md"),
    [
      "---",
      "name: agent-global-skill",
      "description: Agent global skill description.",
      "---",
      "",
      "# Agent Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectAgentsSkills, "agent-project-skill", "SKILL.md"),
    [
      "---",
      "name: agent-project-skill",
      "description: Agent project skill description.",
      "---",
      "",
      "# Agent Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(globalClaudeSkills, "claude-global-skill", "SKILL.md"),
    [
      "---",
      "name: claude-global-skill",
      "description: Claude global skill description.",
      "---",
      "",
      "# Claude Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectClaudeSkills, "claude-project-skill", "SKILL.md"),
    [
      "---",
      "name: claude-project-skill",
      "description: Claude project skill description.",
      "---",
      "",
      "# Claude Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(projectRoot, ".pi", "skills", "project-skill", "SKILL.md"),
    [
      "---",
      "name: project-skill",
      "description: Project skill description.",
      "---",
      "",
      "# Project Skill",
    ].join("\n"),
  );
  await writeFile(
    join(devspaceSkills, "devspace-local-skill", "SKILL.md"),
    [
      "---",
      "name: devspace-local-skill",
      "description: DevSpace local skill description.",
      "---",
      "",
      "# DevSpace Local Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "global-skill", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: First duplicate wins.",
      "---",
      "",
      "# Global Skill",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "duplicate", "SKILL.md"),
    [
      "---",
      "name: duplicate-skill",
      "description: Duplicate loser.",
      "---",
      "",
      "# Duplicate Skill",
    ].join("\n"),
  );
  await writeFile(
    join(agentDir, "skills", "subagents", "SKILL.md"),
    [
      "---",
      "name: subagents",
      "description: Hidden subagent skill winner.",
      "---",
      "",
      "# Subagent Delegation",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "subagents", "SKILL.md"),
    [
      "---",
      "name: subagents",
      "description: Hidden subagent skill loser.",
      "---",
      "",
      "# Subagent Delegation Duplicate",
    ].join("\n"),
  );
  await writeFile(
    join(explicitSkills, "disabled", "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Hidden skill.",
      "disable-model-invocation: true",
      "---",
      "",
      "# Hidden Skill",
    ].join("\n"),
  );

  const configDir = join(root, ".devspace");
  const disabledConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    server: { port: 1 },
    workspaces: { allowedRoots: [projectRoot] },
    skills: { agentDir, paths: [explicitSkills], enabled: false },
  }));
  assert.deepEqual(loadWorkspaceSkills(disabledConfig, projectRoot).skills, []);

  const config = loadConfig(writeTestDevspaceConfig(configDir, {
    server: { port: 1 },
    workspaces: { allowedRoots: [projectRoot] },
    skills: {
      agentDir,
      paths: [explicitSkills, "~/.claude/skills", "./.claude/skills"],
    },
  }));
  const loaded = loadWorkspaceSkills(config, projectRoot);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "agent-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-global-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "claude-project-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "project-skill"), false);
  assert.equal(loaded.skills.some((skill) => skill.name === "devspace-local-skill"), true);
  assert.equal(loaded.skills.some((skill) => skill.name === "subagents"), false);
  assert.equal(loaded.skills.filter((skill) => skill.name === "duplicate-skill").length, 1);
  assert.equal(loaded.skills.some((skill) => skill.name === "hidden-skill"), true);
  assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.type === "collision"), true);
  assert.equal(
    loaded.diagnostics.some(
      (diagnostic) => diagnostic.collision?.name === "subagents",
    ),
    false,
  );

  await mkdir(join(devspaceSkills, "subagents"), { recursive: true });
  await writeFile(
    join(devspaceSkills, "subagents", "SKILL.md"),
    [
      "---",
      "name: subagents",
      "description: stale user copy",
      "---",
      "",
      "# Stale subagents skill",
    ].join("\n"),
  );
  const experimentalConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    server: { port: 1 },
    workspaces: { allowedRoots: [projectRoot] },
    skills: { agentDir },
    subagents: { enabled: true, providers: [] },
  }));
  const experimentalSkills = loadWorkspaceSkills(experimentalConfig, projectRoot).skills;
  assert.equal(experimentalSkills.some((skill) => skill.name === "subagents"), false);
  assert.match(
    await readFile(join(devspaceSkills, "subagents", "SKILL.md"), "utf8"),
    /# Stale subagents skill/,
  );
  await rm(join(devspaceSkills, "subagents"), { recursive: true });
  assert.equal(
    loadWorkspaceSkills(experimentalConfig, projectRoot).skills.some((skill) => skill.name === "subagents"),
    false,
  );
  await assert.rejects(
    readFile(join(devspaceSkills, "subagents", "SKILL.md")),
    { code: "ENOENT" },
  );

  const duplicateConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    server: { port: 1 },
    workspaces: { allowedRoots: [projectRoot] },
    skills: { agentDir, paths: [explicitSkills, "./.agents/skills"] },
  }));
  assert.equal(
    effectiveSkillPaths(duplicateConfig, projectRoot).filter((path) => path === projectAgentsSkills).length,
    1,
  );

  const legacyPiConfig = loadConfig(writeTestDevspaceConfig(configDir, {
    server: { port: 1 },
    workspaces: { allowedRoots: [projectRoot] },
    skills: { agentDir, paths: [explicitSkills, join(projectRoot, ".pi", "skills")] },
  }));
  assert.equal(
    loadWorkspaceSkills(legacyPiConfig, projectRoot).skills.some((skill) => skill.name === "project-skill"),
    true,
  );

  const projectSkill = loaded.skills.find((skill) => skill.name === "agent-project-skill");
  assert.ok(projectSkill);
  assert.match(formatPathForPrompt(projectSkill.filePath), /SKILL\.md$/);

  const skillFileRead = await resolveSkillReadPath(loaded.skills, new Set(), projectSkill.filePath);
  assert.equal(skillFileRead?.isSkillFile, true);
  assert.equal(skillFileRead?.absolutePath, projectSkill.filePath);

  const registry = new WorkspaceRegistry(config);
  const opened = await registry.openWorkspace(projectRoot);
  const advertisedSkill = opened.workspace.skills.find(
    (skill) => skill.name === "agent-global-skill",
  );
  assert.ok(advertisedSkill);
  const advertisedPath = formatPathForPrompt(advertisedSkill.filePath);
  assert.match(advertisedPath, /^~\//);
  const advertisedReadPath = await registry.resolveReadPath(
    opened.workspace,
    advertisedPath,
  );
  assert.equal(advertisedReadPath.absolutePath, advertisedSkill.filePath);
  const advertisedRead = await readFileTool(
    { path: advertisedReadPath.absolutePath },
    {
      cwd: opened.workspace.root,
      root: opened.workspace.root,
      readRoots: advertisedReadPath.readRoots,
    },
  );
  assert.equal(advertisedRead.isError, undefined);
  assert.match(JSON.stringify(advertisedRead.content), /# Agent Global Skill/);

  const homeSecretPath = join(root, "private", "secret.txt");
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(homeSecretPath, "home secret\n");
  const unadvertisedPath = "~/private/secret.txt";
  assert.equal(formatPathForPrompt(homeSecretPath), unadvertisedPath);
  assert.equal(
    await resolveSkillReadPath(loaded.skills, new Set(), unadvertisedPath),
    undefined,
  );
  await assert.rejects(
    () => registry.resolveReadPath(opened.workspace, unadvertisedPath),
    /outside workspace root/,
  );

  const resourcePath = join(projectSkill.baseDir, "references.md");
  await writeFile(resourcePath, "reference\n");
  assert.equal(await resolveSkillReadPath(loaded.skills, new Set(), resourcePath), undefined);
  assert.equal(
    (await resolveSkillReadPath(loaded.skills, new Set([projectSkill.baseDir]), resourcePath))
      ?.isSkillFile,
    false,
  );

  if (process.platform !== "win32") {
    const safeSkillDir = join(root, "safe-skill");
    const outsideSkillFile = join(root, "outside-skill.md");
    const unsafeSkillFile = join(safeSkillDir, "SKILL.md");
    await mkdir(safeSkillDir);
    await writeFile(outsideSkillFile, "outside skill\n");
    await symlink(outsideSkillFile, unsafeSkillFile);

    const unsafeSkill = {
      baseDir: safeSkillDir,
      filePath: unsafeSkillFile,
    } as Skill;
    await assert.rejects(
      resolveSkillReadPath([unsafeSkill], new Set(), unsafeSkillFile),
      /outside allowed roots/,
    );
  }
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(root, { recursive: true, force: true });
}
