import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createMcpExpressApp,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import {
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  checkResourceAllowed,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  resourceUrlFromServerUrl,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
} from "./logger.js";
import { readFileTool } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import type { ClientMetadataDocumentResolver } from "./oauth-client-metadata.js";
import { createLegacyOAuthRouter } from "./oauth-legacy-compat.js";
import {
  compileMcpRegistrationSurface,
  createModernMcpServerAdapter,
  modernMcpAdapterErrorLogFields,
  type McpRegistrationTarget,
} from "./mcp-modern-server.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { conversationScopeIdFromRequestMeta } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  cleanupWorkspaceLifecycle,
  WORKSPACE_CLEANUP_INTERVAL_MS,
} from "./workspace-lifecycle.js";
import {
  getLocalAgentProviderAvailabilitySnapshot,
} from "./local-agent-availability.js";
import type { LocalTaskAgentClient } from "./local-task-tools.js";
import {
  localTaskInstructions,
  registerLocalTaskTools,
} from "./local-task-tools.js";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
  formatLocalAgentProviderStatusSummary,
  type LocalAgentProviderStatus,
} from "./local-agent-catalog.js";
import { getToolSurface } from "./tool-surfaces/index.js";
import {
  contentText,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
  workspaceAppDescriptorMeta,
} from "./tool-surfaces/shared.js";
import {
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolSurface,
} from "./tool-surfaces/types.js";
import {
  buildInlineWorkspaceAppHtml,
  WORKSPACE_APP_URI,
} from "./workspace-app-resource.js";

const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const DEVSPACE_VERSION = packageVersion();

function packageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("DevSpace package.json must contain a non-empty version");
  }
  return packageJson.version;
}

function mcpServerInfo() {
  return {
    name: "devspace",
    title: "DevSpace",
    version: DEVSPACE_VERSION,
    description:
      "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
  };
}

function oauthServerMetadata(
  issuerUrl: URL,
  baseUrl: URL,
  scopes: string[],
): OAuthMetadata & { authorization_response_iss_parameter_supported: true } {
  return {
    issuer: issuerUrl.href,
    authorization_endpoint: new URL("/authorize", baseUrl).href,
    token_endpoint: new URL("/token", baseUrl).href,
    registration_endpoint: new URL("/register", baseUrl).href,
    revocation_endpoint: new URL("/revoke", baseUrl).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: scopes,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderStatus[];
  close(): Promise<void>;
}

export type TrackToolActivity = <T>(operation: () => Promise<T>) => Promise<T>;

class ToolActivityTracker {
  private readonly active = new Set<Promise<unknown>>();

  readonly track: TrackToolActivity = <T>(operation: () => Promise<T>): Promise<T> => {
    const promise = operation();
    this.active.add(promise);
    const remove = () => this.active.delete(promise);
    void promise.then(remove, remove);
    return promise;
  };

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
  isDynamicEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

function serverInstructions(
  config: ServerConfig,
  toolSurface: ToolSurface,
): string {
  const artifactInstruction =
    config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
      ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
      : "";
  const showChangesInstruction =
    " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change.";
  const skills = config.skillsEnabled
    ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
    : "";
  const agents = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
  const workspaceRoots = config.allowedRoots.map(formatPathForPrompt);
  const workspaceRootInstruction = workspaceRoots.length === 1
    ? ` The configured workspace root is ${workspaceRoots[0]}. When the user refers to a project or workspace by name without an explicit path, resolve it relative to this root.`
    : ` Configured workspace roots are ${workspaceRoots.join(", ")}. When the user refers to a project or workspace by name without an explicit path, resolve it against these roots.`;
  const common = `Use DevSpace for coding work.${workspaceRootInstruction} Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected.`;

  return `${common} ${toolSurface.instructions({ agents, skills })}${localTaskInstructions(config.subagents.enabled)}${artifactInstruction}${showChangesInstruction}`;
}

export function mcpServerInstructions(config: ServerConfig): string {
  return serverInstructions(config, getToolSurface(config.toolMode));
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  effort?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const effort = agent.effort ? `, effort ${agent.effort}` : "";
  return `${agent.name} (${agent.provider}${model}${effort})`;
}

function formatAvailableAgentProvider(provider: {
  id: string;
  model?: string;
  effort?: string;
  note?: string;
}): string {
  const details = [
    provider.model ? `model ${provider.model}` : undefined,
    provider.effort ? `effort ${provider.effort}` : undefined,
    provider.note,
  ].filter(Boolean).join(", ");
  return `${provider.id}${details ? ` (${details})` : ""}`;
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  note: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function workspaceAppHtml(): string {
  const entry = getWorkspaceAppManifestEntry();
  const entryScript = readFileSync(
    new URL(`../dist/ui/${entry.file}`, import.meta.url),
    "utf8",
  );
  const styles = (entry.css ?? []).map((stylesheet) =>
    readFileSync(new URL(`../dist/ui/${stylesheet}`, import.meta.url), "utf8")
  );
  return buildInlineWorkspaceAppHtml({ script: entryScript, styles });
}

function appCsp(): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  return {
    resourceDomains: [],
    connectDomains: [],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export function registerMcpSurface(
  server: McpRegistrationTarget,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  resolveLocalAgentProviders: () => LocalAgentProviderStatus[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
  taskAgentClient?: LocalTaskAgentClient,
  trackToolActivity?: TrackToolActivity,
): void {
  const toolSurface = getToolSurface(config.toolMode);
  const registrationTarget = trackToolActivity
    ? withTrackedToolHandlers(server, trackToolActivity)
    : server;

  registerAppResource(
    registrationTarget,
    "DevSpace Tool Cards",
    WORKSPACE_APP_URI,
    {
      description: "Interactive cards for DevSpace workspace, task, and change-review results.",
      _meta: {
        ui: {
          csp: appCsp(),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(),
            _meta: {
              ui: {
                csp: appCsp(),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    registrationTarget,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root. Configured roots: ${config.allowedRoots.map(formatPathForPrompt).join(", ")}.`,
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        review: z.discriminatedUnion("available", [
          z.object({ available: z.literal(true) }),
          z.object({
            available: z.literal(false),
            reason: z.string(),
          }),
        ]),
        instruction: z.string(),
      },
      ...workspaceAppDescriptorMeta(config),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef },
        { conversationScopeId: conversationScopeIdFromRequestMeta(_meta) },
      );
      const review = await reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const agentCatalog = buildLocalAgentCatalog(
        config.subagents,
        workspace.agentProfiles,
        resolveLocalAgentProviders(),
      );
      const cardAgentProviders = agentCatalog.providers
        .filter((provider) => provider.usable)
        .map((provider) => ({
          id: provider.id,
          model: provider.model,
          effort: provider.effort,
          note: provider.note,
        }));
      const cardAgents = agentCatalog.profiles;
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const cardInstruction = config.skillsEnabled
        ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
          ].join("\n\n")
        : workspace.mode === "worktree"
          ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
          : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.length > 0
              ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            review,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          review,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  registrationTarget.registerTool(
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Read a file in a workspace. Use this for file inspection instead of shell commands like cat or sed.",
          "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema({
        truncation: z
          .object({
            truncated: z.boolean(),
            truncatedBy: z.enum(["lines", "bytes"]).nullable(),
            totalLines: z.number().int().nonnegative(),
            totalBytes: z.number().int().nonnegative(),
            outputLines: z.number().int().nonnegative(),
            outputBytes: z.number().int().nonnegative(),
            firstLineExceedsLimit: z.boolean(),
          })
          .optional(),
        nextOffset: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const readPath = await workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);
      const truncation = response.details?.truncation;
      const nextOffset = truncation?.truncated && !truncation.firstLineExceedsLimit
        ? (input.offset ?? 1) + truncation.outputLines
        : undefined;

      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        structuredContent: {
          result: contentText(response.content),
          ...(truncation
            ? {
                truncation: {
                  truncated: truncation.truncated,
                  truncatedBy: truncation.truncatedBy,
                  totalLines: truncation.totalLines,
                  totalBytes: truncation.totalBytes,
                  outputLines: truncation.outputLines,
                  outputBytes: truncation.outputBytes,
                  firstLineExceedsLimit: truncation.firstLineExceedsLimit,
                },
              }
            : {}),
          ...(nextOffset === undefined ? {} : { nextOffset }),
        },
      };
    },
  );

  registerLocalTaskTools({
    server: registrationTarget,
    config,
    workspaces,
    reviewCheckpoints,
    resolveLocalAgentProviders,
    client: taskAgentClient,
  });

  toolSurface.register({
    server: registrationTarget,
    config,
    workspaces,
    processSessions,
    reviewCheckpoints,
  });

  registerAppTool(
    registrationTarget,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
      },
      outputSchema: resultOutputSchema({
        workspaceId: z.string(),
        reviewRef: z.string().regex(/^[0-9a-f]{40,64}$/),
      }),
      ...workspaceAppDescriptorMeta(config, ["model", "app"]),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId }, { _meta }) => {
      const startedAt = performance.now();
      const workspace = await workspaces.getWorkspace(workspaceId);
      const reviewRef = typeof _meta?.["devspace/reviewRef"] === "string"
        ? _meta["devspace/reviewRef"]
        : undefined;
      const review = reviewRef
        ? await reviewCheckpoints.reviewByRef({
            workspaceId,
            root: workspace.root,
            reviewRef,
          })
        : await reviewCheckpoints.reviewChanges({
            workspaceId,
            root: workspace.root,
            markReviewed: true,
          });

      const content = [textBlock(review.result)];
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: {
              patch: review.patch,
            },
          },
        },
        structuredContent: {
          workspaceId,
          reviewRef: review.reviewRef,
          result: contentText(content),
        },
      };
    },
  );

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(registrationTarget, {
      config,
      workspaces,
      reviewCheckpoints,
      incomingArtifactAdapters,
    });
  }
}

function withTrackedToolHandlers(
  server: McpRegistrationTarget,
  trackToolActivity: TrackToolActivity,
): McpRegistrationTarget {
  return {
    registerTool: ((...args: unknown[]) => {
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(
        ...args.slice(0, -1),
        (...handlerArgs: unknown[]) => trackToolActivity(
          () => Promise.resolve(handler(...handlerArgs)),
        ),
      );
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
  clientMetadataResolver?: ClientMetadataDocumentResolver;
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
    // Browser pairing forms use the public URL even when a tunnel forwards
    // to a loopback listener. The SDK otherwise allows only local Origins.
    allowedOrigins: Array.from(new Set([
      "localhost",
      "127.0.0.1",
      "[::1]",
      new URL(config.publicBaseUrl).hostname,
      ...config.allowedHosts.filter((host) => host !== "*"),
    ])),
  });
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const issuerUrl = new URL(config.publicBaseUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir, {
    issuerUrl,
    clientMetadataResolver: options.clientMetadataResolver,
  });
  const oauthMetadata = oauthServerMetadata(issuerUrl, issuerUrl, config.oauth.scopes);
  const oauthMetadataOptions = {
    oauthMetadata,
    resourceServerUrl,
    scopesSupported: config.oauth.scopes,
    resourceName: "DevSpace",
  };
  buildOAuthProtectedResourceMetadata(oauthMetadataOptions);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const toolActivities = new ToolActivityTracker();
  const localAgentProviders = buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );
  const bindModernMcpSurface = compileMcpRegistrationSurface((target) => {
    registerMcpSurface(
      target,
      config,
      workspaces,
      reviewCheckpoints,
      processSessions,
      resolveLocalAgentProviders,
      incomingArtifactAdapters,
      undefined,
      toolActivities.track,
    );
  });
  const logMcpHandlerError = (error: Error) => logEvent(
    config.logging,
    "error",
    "mcp_handler_error",
    modernMcpAdapterErrorLogFields(error),
  );
  const modernMcpHandler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter(
      mcpServerInfo(),
      { instructions: mcpServerInstructions(config) },
    );
    bindModernMcpSurface(adapter.registrationTarget);
    return adapter.server;
  }, {
    legacy: "reject",
    onerror: logMcpHandlerError,
  });
  const modernNodeHandler = toNodeHandler(modernMcpHandler, {
    onerror: logMcpHandlerError,
  });

  let workspaceCleanupPromise: Promise<void> | undefined;
  const runWorkspaceCleanup = (): Promise<void> => {
    if (workspaceCleanupPromise) return workspaceCleanupPromise;

    const cleanup: Promise<void> = cleanupWorkspaceLifecycle({
      config,
      store: workspaceStore,
      registry: workspaces,
      reviewCheckpoints,
      protectedWorkspaceIds: processSessions.activeWorkspaceIds(),
    })
      .then((result) => {
        if (
          result.retired.length > 0 ||
          result.evictedWorkspaceIds.length > 0 ||
          result.cleanedReviewWorkspaceIds.length > 0 ||
          result.removedWorktreeWorkspaceIds.length > 0 ||
          result.deletedSessionIds.length > 0
        ) {
          logEvent(config.logging, "info", "workspace_cleanup_completed", {
            retired: result.retired.length,
            evicted: result.evictedWorkspaceIds.length,
            reviewRefsCleaned: result.cleanedReviewWorkspaceIds.length,
            worktreesRemoved: result.removedWorktreeWorkspaceIds.length,
            sessionsDeleted: result.deletedSessionIds.length,
          });
        }
        if (result.errors.length > 0) {
          logEvent(config.logging, "warn", "workspace_cleanup_partial", {
            failures: result.errors,
            retainedManagedWorktrees: result.retainedManagedWorktreeWorkspaceIds.length,
          });
        }
      })
      .catch((error: unknown) => {
        logEvent(config.logging, "warn", "workspace_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    let trackedCleanup: Promise<void>;
    trackedCleanup = cleanup.finally(() => {
      if (workspaceCleanupPromise === trackedCleanup) workspaceCleanupPromise = undefined;
    });
    workspaceCleanupPromise = trackedCleanup;
    return trackedCleanup;
  };

  void runWorkspaceCleanup();
  const workspaceCleanupTimer = setInterval(() => {
    void runWorkspaceCleanup();
  }, WORKSPACE_CLEANUP_INTERVAL_MS);
  workspaceCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.use(async (req, res, next) => {
    const path = requestPath(req);
    if (
      path !== "/.well-known/oauth-authorization-server" &&
      !path.startsWith("/.well-known/oauth-protected-resource")
    ) {
      next();
      return;
    }
    try {
      const response = oauthMetadataResponse(
        await toWebRequest(req, req.body),
        oauthMetadataOptions,
      );
      if (!response) {
        next();
        return;
      }
      await sendWebResponse(res, response);
    } catch (error) {
      next(error);
    }
  });

  app.use(createLegacyOAuthRouter({
    provider: oauthProvider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl,
    scopesSupported: config.oauth.scopes,
    resourceName: "DevSpace",
  }));

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.all("/mcp", bearerAuth, async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      await sendWebResponse(
        res,
        bearerAuthChallengeResponse(
          new OAuthError(
            OAuthErrorCode.InvalidToken,
            "Access token is not valid for this resource",
          ),
          {
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
          },
        ),
      );
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
    });

    try {
      await modernNodeHandler(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(workspaceCleanupTimer);
        await workspaceCleanupPromise;
        try {
          await modernMcpHandler.close();
        } catch (error) {
          logEvent(config.logging, "warn", "mcp_handler_close_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await toolActivities.waitForIdle();
        await processSessions.shutdown();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function sendWebResponse(res: Response, response: globalThis.Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    console.log(`subagent providers: ${formatLocalAgentProviderStatusSummary(localAgentProviders)}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
