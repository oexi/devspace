import {
  McpServer,
  type Implementation,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import type {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

type AppToolRegistrationTarget = Parameters<typeof registerAppTool>[0];
type AppResourceRegistrationTarget = Parameters<typeof registerAppResource>[0];

export type McpRegistrationTarget = AppToolRegistrationTarget
  & AppResourceRegistrationTarget;

export const MODERN_MCP_CACHE_HINTS = Object.freeze({
  "server/discover": { ttlMs: 300_000, cacheScope: "private" },
  "tools/list": { ttlMs: 300_000, cacheScope: "private" },
  "resources/list": { ttlMs: 300_000, cacheScope: "private" },
  "resources/templates/list": { ttlMs: 300_000, cacheScope: "private" },
  "resources/read": { ttlMs: 300_000, cacheScope: "private" },
} satisfies NonNullable<ServerOptions["cacheHints"]>);

export interface ModernMcpServerAdapter {
  server: McpServer;
  registrationTarget: McpRegistrationTarget;
}

type RegistrationReplay = (target: McpRegistrationTarget) => void;

type ModernRegisterTool = (
  name: string,
  definition: Record<string, unknown>,
  handler: (input: unknown, context: ServerContext) => unknown,
) => unknown;

type ModernRegisterResource = (...args: unknown[]) => unknown;

export function createModernMcpServerAdapter(
  serverInfo: Implementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, {
    ...options,
    cacheHints: {
      ...MODERN_MCP_CACHE_HINTS,
      ...(options?.cacheHints ?? {}),
    },
  });
  const registerModernTool = server.registerTool.bind(server) as unknown as ModernRegisterTool;
  const registerModernResource = server.registerResource.bind(server) as unknown as ModernRegisterResource;
  const registrationTarget: McpRegistrationTarget = {
    registerTool: ((
      name: string,
      definition: Record<string, unknown>,
      handler: (input: unknown, extra: Record<string, unknown>) => unknown,
    ) => registerModernTool(
      name,
      definition,
      async (input, context) => handler(input, registrationHandlerExtra(context)),
    )) as McpRegistrationTarget["registerTool"],
    registerResource: ((...args: unknown[]) => {
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: unknown[]) => {
          const context = callbackArgs.at(-1) as ServerContext;
          return callback(
            ...callbackArgs.slice(0, -1),
            registrationHandlerExtra(context),
          );
        },
      );
    }) as unknown as McpRegistrationTarget["registerResource"],
  };

  return {
    server,
    registrationTarget,
  };
}

export function compileMcpRegistrationSurface(
  registerSurface: (target: McpRegistrationTarget) => void,
): (target: McpRegistrationTarget) => void {
  const registrations: RegistrationReplay[] = [];
  const recordingTarget: McpRegistrationTarget = {
    registerTool: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerTool as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerTool"],
    registerResource: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerResource as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerResource"],
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());
  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

export function modernMcpAdapterErrorLogFields(error: Error): Record<string, unknown> {
  const cause = error.cause;
  return {
    error: error.message,
    errorName: error.name,
    ...(cause === undefined ? {} : {
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: typeof cause, message: String(cause) },
    }),
  };
}

function registrationHandlerExtra(context: ServerContext): Record<string, unknown> {
  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: context.mcpReq.send,
  };
}
