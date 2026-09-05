export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
}

export type McpSessionRoute<TTransport> =
  | { kind: "initialize" }
  | { kind: "existing"; transport: TTransport }
  | { kind: "unknown" }
  | { kind: "missing" };

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  register(sessionId: string, transport: TTransport): void {
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
    });
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions);
  }
}

/**
 * Decide how an incoming Streamable HTTP request should be routed.
 *
 * Initialization deliberately wins over an inherited/stale MCP session ID.
 * Some clients restore a conversation after a page refresh and send a fresh
 * initialize request while still carrying the previous session header. Routing
 * that request to the old transport makes the SDK reject it as an attempted
 * re-initialization; if the old transport has already disappeared, the server
 * returns 404 before the client gets a chance to establish a replacement
 * session. Treating initialize as a fresh session keeps reconnects recoverable.
 */
export function resolveMcpSessionRoute<TTransport extends ClosableMcpTransport>(
  registry: McpSessionRegistry<TTransport>,
  sessionId: string | undefined,
  initializeRequest: boolean,
): McpSessionRoute<TTransport> {
  if (initializeRequest) return { kind: "initialize" };
  if (!sessionId) return { kind: "missing" };

  const transport = registry.get(sessionId);
  return transport
    ? { kind: "existing", transport }
    : { kind: "unknown" };
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
