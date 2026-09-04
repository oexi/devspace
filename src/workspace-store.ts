import { and, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceConversationBindings,
  workspaceSessions,
  type WorkspaceConversationBindingRow,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";
export type WorkspaceSessionStatus = "active" | "inactive";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: WorkspaceSessionStatus;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceConversationBinding {
  conversationScopeId: string;
  targetKey: string;
  workspaceSessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  findStaleSessions(
    inactiveBefore: string,
    protectedWorkspaceIds?: Iterable<string>,
  ): WorkspaceSession[];
  retireStaleSessions(
    inactiveBefore: string,
    protectedWorkspaceIds?: Iterable<string>,
  ): WorkspaceSession[];
  findInactiveSessions(): WorkspaceSession[];
  deleteInactiveSessions(ids: readonly string[]): void;
  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined;
  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding;
  touchConversationBinding(conversationScopeId: string, targetKey: string): void;
  deleteConversationBinding(conversationScopeId: string, targetKey: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(and(eq(workspaceSessions.id, id), eq(workspaceSessions.status, "active")))
      .run();
  }

  findStaleSessions(
    inactiveBefore: string,
    protectedWorkspaceIds: Iterable<string> = [],
  ): WorkspaceSession[] {
    return this.findStaleSessionRows(
      inactiveBefore,
      new Set(protectedWorkspaceIds),
    ).map(rowToWorkspaceSession);
  }

  retireStaleSessions(
    inactiveBefore: string,
    protectedWorkspaceIds: Iterable<string> = [],
  ): WorkspaceSession[] {
    const protectedIds = new Set(protectedWorkspaceIds);
    const retire = this.database.db.transaction(() => {
      this.deleteBindingsForInactiveSessions();
      const stale = this.findStaleSessionRows(inactiveBefore, protectedIds).map(rowToWorkspaceSession);
      if (stale.length === 0) return stale;

      for (const session of stale) {
        this.database.db
          .update(workspaceSessions)
          .set({ status: "inactive", lastUsedAt: session.lastUsedAt })
          .where(
            and(
              eq(workspaceSessions.id, session.id),
              eq(workspaceSessions.status, "active"),
            ),
          )
          .run();
        this.database.db
          .delete(workspaceConversationBindings)
          .where(eq(workspaceConversationBindings.workspaceSessionId, session.id))
          .run();
      }

      return stale.map((session) => ({ ...session, status: "inactive" as const }));
    });

    return retire;
  }

  findInactiveSessions(): WorkspaceSession[] {
    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.status, "inactive"))
      .all()
      .map(rowToWorkspaceSession);
  }

  deleteInactiveSessions(ids: readonly string[]): void {
    if (ids.length === 0) return;

    this.database.db.transaction(() => {
      for (const id of ids) {
        this.database.db
          .delete(workspaceSessions)
          .where(
            and(
              eq(workspaceSessions.id, id),
              eq(workspaceSessions.status, "inactive"),
            ),
          )
          .run();
      }
    });
  }

  getConversationBinding(
    conversationScopeId: string,
    targetKey: string,
  ): WorkspaceConversationBinding | undefined {
    const row = this.database.db
      .select()
      .from(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .get();

    return row ? rowToWorkspaceConversationBinding(row) : undefined;
  }

  setConversationBinding(input: {
    conversationScopeId: string;
    targetKey: string;
    workspaceSessionId: string;
  }): WorkspaceConversationBinding {
    const now = new Date().toISOString();
    const row = this.database.db
      .insert(workspaceConversationBindings)
      .values({
        conversationScopeId: input.conversationScopeId,
        targetKey: input.targetKey,
        workspaceSessionId: input.workspaceSessionId,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workspaceConversationBindings.conversationScopeId,
          workspaceConversationBindings.targetKey,
        ],
        set: {
          workspaceSessionId: input.workspaceSessionId,
          lastUsedAt: now,
        },
      })
      .returning()
      .get();

    if (!row) {
      throw new Error("Conversation workspace binding upsert returned no row.");
    }

    return rowToWorkspaceConversationBinding(row);
  }

  touchConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .update(workspaceConversationBindings)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  deleteConversationBinding(conversationScopeId: string, targetKey: string): void {
    this.database.db
      .delete(workspaceConversationBindings)
      .where(
        and(
          eq(workspaceConversationBindings.conversationScopeId, conversationScopeId),
          eq(workspaceConversationBindings.targetKey, targetKey),
        ),
      )
      .run();
  }

  close(): void {
    this.database.close();
  }

  private findStaleSessionRows(
    inactiveBefore: string,
    protectedWorkspaceIds: ReadonlySet<string> = new Set(),
  ): WorkspaceSessionRow[] {
    const recentBindingSessionIds = new Set(
      this.database.db
        .select({
          workspaceSessionId: workspaceConversationBindings.workspaceSessionId,
          lastUsedAt: workspaceConversationBindings.lastUsedAt,
        })
        .from(workspaceConversationBindings)
        .all()
        .filter((binding) => !isBefore(binding.lastUsedAt, inactiveBefore))
        .map((binding) => binding.workspaceSessionId),
    );

    return this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.status, "active"))
      .all()
      .filter(
        (session) =>
          isBefore(session.lastUsedAt, inactiveBefore) &&
          !protectedWorkspaceIds.has(session.id) &&
          !recentBindingSessionIds.has(session.id),
      );
  }

  private deleteBindingsForInactiveSessions(): void {
    const inactiveSessionIds = this.database.db
      .select({ id: workspaceSessions.id })
      .from(workspaceSessions)
      .where(eq(workspaceSessions.status, "inactive"))
      .all();

    for (const session of inactiveSessionIds) {
      this.database.db
        .delete(workspaceConversationBindings)
        .where(eq(workspaceConversationBindings.workspaceSessionId, session.id))
        .run();
    }
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status === "active" ? "active" : "inactive",
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function isBefore(value: string, cutoff: string): boolean {
  const timestamp = Date.parse(value);
  const cutoffTimestamp = Date.parse(cutoff);
  return Number.isFinite(timestamp) && Number.isFinite(cutoffTimestamp) && timestamp < cutoffTimestamp;
}

function rowToWorkspaceConversationBinding(
  row: WorkspaceConversationBindingRow,
): WorkspaceConversationBinding {
  return {
    conversationScopeId: row.conversationScopeId,
    targetKey: row.targetKey,
    workspaceSessionId: row.workspaceSessionId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
