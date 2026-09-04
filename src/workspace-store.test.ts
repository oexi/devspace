import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";

test("retiring stale sessions marks them inactive and removes their bindings", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const stale = store.createSession({ id: "ws_stale", root: "/tmp/stale" });
  const active = store.createSession({ id: "ws_active", root: "/tmp/active" });
  store.setConversationBinding({
    conversationScopeId: "conversation-stale",
    targetKey: "target",
    workspaceSessionId: stale.id,
  });
  store.setConversationBinding({
    conversationScopeId: "conversation-active",
    targetKey: "target",
    workspaceSessionId: active.id,
  });

  const oldTime = "2026-08-01T00:00:00.000Z";
  const recentBindingTime = "2026-09-04T00:00:00.000Z";
  const database = openDatabase(stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(oldTime, stale.id);
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run(oldTime, active.id);
    database.sqlite
      .prepare(
        "update workspace_conversation_bindings set last_used_at = ? where conversation_scope_id = ?",
      )
      .run(oldTime, "conversation-stale");
    database.sqlite
      .prepare(
        "update workspace_conversation_bindings set last_used_at = ? where conversation_scope_id = ?",
      )
      .run(recentBindingTime, "conversation-active");
  } finally {
    database.close();
  }

  const cutoff = "2026-09-03T00:00:00.000Z";
  assert.deepEqual(store.findStaleSessions(cutoff).map((session) => session.id), [stale.id]);

  const retired = store.retireStaleSessions(cutoff);
  assert.deepEqual(retired.map((session) => ({ id: session.id, status: session.status })), [
    { id: stale.id, status: "inactive" },
  ]);
  assert.equal(store.getSession(stale.id)?.status, "inactive");
  assert.equal(store.getConversationBinding("conversation-stale", "target"), undefined);
  assert.equal(store.getSession(active.id)?.status, "active");
  assert.equal(
    store.getConversationBinding("conversation-active", "target")?.workspaceSessionId,
    active.id,
  );
});

test("inactive sessions can be deleted after their retention window", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-retention-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const inactive = store.createSession({ id: "ws_inactive", root: "/tmp/inactive" });
  const database = openDatabase(stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set status = 'inactive' where id = ?")
      .run(inactive.id);
  } finally {
    database.close();
  }

  assert.deepEqual(store.findInactiveSessions().map((session) => session.id), [inactive.id]);
  store.deleteInactiveSessions([inactive.id]);
  assert.equal(store.getSession(inactive.id), undefined);
});

test("retirement can protect a workspace that is still in use", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-store-protected-test-"));
  const store = new SqliteWorkspaceStore(stateDir);
  t.after(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const current = store.createSession({ id: "ws_current", root: "/tmp/current" });
  const database = openDatabase(stateDir);
  try {
    database.sqlite
      .prepare("update workspace_sessions set last_used_at = ? where id = ?")
      .run("2026-08-01T00:00:00.000Z", current.id);
  } finally {
    database.close();
  }

  assert.deepEqual(
    store.retireStaleSessions("2026-09-03T00:00:00.000Z", [current.id]),
    [],
  );
  assert.equal(store.getSession(current.id)?.status, "active");
});
