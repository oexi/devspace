import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { databasePath, openDatabase } from "./db/client.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import { InvalidGrantError } from "./oauth-authorization.js";

const root = await mkdtemp(join(tmpdir(), "devspace-oauth-test-"));
const oauthConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const mcpUrl = new URL("https://agent.example.com/mcp");
const issuer = mcpUrl.origin;
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";

try {
  await testDatabaseConfiguration(join(root, "database-configuration"));
  testPersistenceAndTokenHashing(join(root, "persistence"));
  testExpiredTokenCleanup(join(root, "expiration"));
  testTokenCleanupCadence(join(root, "token-cleanup-cadence"));
  testTransactionalTokenRotation(join(root, "rotation"));
  await testAuthorizationCodeCleanup(join(root, "authorization-code-cleanup"));
  await testTokenExpirationBoundary(join(root, "expiration-boundary"));
  await testProviderRestartRotationAndRevocation(join(root, "provider"));
  await testIssuerBinding(join(root, "issuer-binding"));
  await testUnboundCredentialsAreRejected(join(root, "unbound-credentials"));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function testDatabaseConfiguration(stateDir: string): Promise<void> {
  const database = openDatabase(stateDir);
  try {
    assert.equal(database.sqlite.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.sqlite.pragma("synchronous", { simple: true }), 1);
    assert.equal(database.sqlite.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(database.sqlite.pragma("foreign_keys", { simple: true }), 1);

    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "local-agent-structured-errors" },
      { version: 6, name: "local-agent-effort-rename" },
      { version: 7, name: "oauth-issuer-binding" },
    ]);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(databasePath(stateDir))).mode & 0o777, 0o600);
  }
}

function testPersistenceAndTokenHashing(stateDir: string): void {
  const accessToken = "access-token-example";
  const refreshToken = "refresh-token-example";
  const firstStore = new SqliteOAuthStore(stateDir, { issuer });
  const firstClients = new SqliteOAuthClientsStore(firstStore, oauthConfig.allowedRedirectHosts);
  const client = firstClients.registerClient({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });

  firstStore.saveTokenPair({
    accessTokenHash: hashToken(accessToken),
    accessToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      resource: mcpUrl.href,
    },
    refreshTokenHash: hashToken(refreshToken),
    refreshToken: {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt: Math.floor(Date.now() / 1000) + 2592000,
      resource: mcpUrl.href,
    },
  });
  firstStore.close();

  const database = openDatabase(stateDir);
  try {
    const accessHashes = database.sqlite
      .prepare("select token_hash from oauth_access_tokens")
      .pluck()
      .all() as string[];
    const refreshHashes = database.sqlite
      .prepare("select token_hash from oauth_refresh_tokens")
      .pluck()
      .all() as string[];
    assert.deepEqual(accessHashes, [hashToken(accessToken)]);
    assert.deepEqual(refreshHashes, [hashToken(refreshToken)]);
    assert.equal(accessHashes.includes(accessToken), false);
    assert.equal(refreshHashes.includes(refreshToken), false);
  } finally {
    database.close();
  }

  const restoredStore = new SqliteOAuthStore(stateDir, { issuer });
  try {
    const restoredClient = restoredStore.getClient(client.client_id);
    assert.equal(restoredClient?.client_id, client.client_id);
    assert.equal(restoredStore.getAccessToken(hashToken(accessToken))?.resource, mcpUrl.href);
    assert.equal(restoredStore.getRefreshToken(hashToken(refreshToken))?.clientId, client.client_id);
  } finally {
    restoredStore.close();
  }
}

function testExpiredTokenCleanup(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir, { issuer });
  const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
    redirect_uris: [redirectUri],
  });
  const expiredAt = Math.floor(Date.now() / 1000) - 1;
  store.saveTokenPair({
    accessTokenHash: "expired-access-hash",
    accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
    refreshTokenHash: "expired-refresh-hash",
    refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt: expiredAt },
  });
  store.close();

  const reopened = new SqliteOAuthStore(stateDir, { issuer });
  try {
    assert.equal(reopened.getAccessToken("expired-access-hash"), undefined);
    assert.equal(reopened.getRefreshToken("expired-refresh-hash"), undefined);
  } finally {
    reopened.close();
  }
}

function testTokenCleanupCadence(stateDir: string): void {
  let nowMs = 2_000_000;
  const store = new SqliteOAuthStore(stateDir, {
    issuer,
    now: () => nowMs,
    tokenCleanupIntervalMs: 1_000,
  });
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(nowMs / 1000);
    store.saveTokenPair({
      accessTokenHash: "cadence-access-hash",
      accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
      refreshTokenHash: "cadence-refresh-hash",
      refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
    });

    assert.ok(store.getAccessToken("cadence-access-hash"));
    assert.ok(store.getRefreshToken("cadence-refresh-hash"));

    nowMs += 999;
    assert.ok(store.getAccessToken("cadence-access-hash"));
    assert.ok(store.getRefreshToken("cadence-refresh-hash"));

    nowMs += 1;
    assert.equal(store.getAccessToken("cadence-access-hash"), undefined);
    assert.equal(store.getRefreshToken("cadence-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testAuthorizationCodeCleanup(stateDir: string): Promise<void> {
  let nowMs = 1_000_000;
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir, {
    now: () => nowMs,
    authorizationCodeCleanupIntervalMs: 1_000,
  });
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
    });
    assert.ok(client);

    const params = {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    };
    const codes = provider["codes"];
    codes.set("expired-before-sweep", {
      clientId: client.client_id,
      params,
      expiresAtMs: nowMs - 1,
    });
    codes.set("live", {
      clientId: client.client_id,
      params,
      expiresAtMs: nowMs + 10_000,
    });

    await provider.challengeForAuthorizationCode(client, "live");
    assert.equal(codes.has("expired-before-sweep"), false);

    nowMs += 500;
    codes.set("expired-during-cadence", {
      clientId: client.client_id,
      params,
      expiresAtMs: nowMs - 1,
    });
    await provider.challengeForAuthorizationCode(client, "live");
    assert.equal(codes.has("expired-during-cadence"), true);

    nowMs += 500;
    await provider.challengeForAuthorizationCode(client, "live");
    assert.equal(codes.has("expired-during-cadence"), false);

    codes.set("expires-at-boundary", {
      clientId: client.client_id,
      params,
      expiresAtMs: nowMs + 500,
    });
    nowMs += 500;
    await assert.rejects(
      provider.challengeForAuthorizationCode(client, "expires-at-boundary"),
      InvalidGrantError,
    );
    assert.equal(codes.has("expires-at-boundary"), false);
  } finally {
    provider.close();
  }
}

async function testTokenExpirationBoundary(stateDir: string): Promise<void> {
  let nowMs = 3_000_000;
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir, {
    now: () => nowMs,
    tokenCleanupIntervalMs: 1_000_000_000,
  });
  try {
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [redirectUri],
    });
    assert.ok(client);

    provider["codes"].set("expiration-boundary-code", {
      clientId: client.client_id,
      params: {
        redirectUri,
        codeChallenge: "challenge",
        scopes: ["devspace"],
        resource: mcpUrl,
      },
      expiresAtMs: nowMs + 60_000,
    });
    const issued = await provider.exchangeAuthorizationCode(
      client,
      "expiration-boundary-code",
      undefined,
      redirectUri,
      mcpUrl,
    );
    assert.ok(issued.refresh_token);
    const issuedAtSeconds = Math.floor(nowMs / 1000);

    nowMs = (issuedAtSeconds + oauthConfig.accessTokenTtlSeconds) * 1000;
    await assert.rejects(provider.verifyAccessToken(issued.access_token), isInvalidTokenError);

    nowMs = (issuedAtSeconds + oauthConfig.refreshTokenTtlSeconds) * 1000;
    await assert.rejects(
      provider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    provider.close();
  }
}

function testTransactionalTokenRotation(stateDir: string): void {
  const store = new SqliteOAuthStore(stateDir, { issuer });
  try {
    const client = new SqliteOAuthClientsStore(store, oauthConfig.allowedRedirectHosts).registerClient({
      redirect_uris: [redirectUri],
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    store.saveRefreshToken("old-refresh-hash", {
      clientId: client.client_id,
      scopes: ["devspace"],
      expiresAt,
    });

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "new-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "new-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      true,
    );
    assert.equal(store.getRefreshToken("old-refresh-hash"), undefined);
    assert.ok(store.getAccessToken("new-access-hash"));
    assert.ok(store.getRefreshToken("new-refresh-hash"));

    assert.equal(
      store.saveTokenPair(
        {
          accessTokenHash: "losing-access-hash",
          accessToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
          refreshTokenHash: "losing-refresh-hash",
          refreshToken: { clientId: client.client_id, scopes: ["devspace"], expiresAt },
        },
        "old-refresh-hash",
      ),
      false,
    );
    assert.equal(store.getAccessToken("losing-access-hash"), undefined);
    assert.equal(store.getRefreshToken("losing-refresh-hash"), undefined);
  } finally {
    store.close();
  }
}

async function testProviderRestartRotationAndRevocation(stateDir: string): Promise<void> {
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await firstProvider.clientsStore.registerClient?.({
    redirect_uris: [redirectUri],
    client_name: "ChatGPT",
  });
  assert.ok(client);

  const code = "code-test-123";
  firstProvider["codes"].set(code, {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    code,
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    const verified = await secondProvider.verifyAccessToken(issued.access_token);
    assert.equal(verified.clientId, client.client_id);

    const refreshed = await secondProvider.exchangeRefreshToken(
      client,
      issued.refresh_token,
      ["devspace"],
      mcpUrl,
    );
    assert.ok(refreshed.refresh_token);
    assert.notEqual(refreshed.access_token, issued.access_token);

    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );

    await secondProvider.revokeToken(client, { token: refreshed.access_token });
    await assert.rejects(secondProvider.verifyAccessToken(refreshed.access_token), isInvalidTokenError);

    await secondProvider.revokeToken(client, { token: refreshed.refresh_token });
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, refreshed.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

async function testIssuerBinding(stateDir: string): Promise<void> {
  const issuerA = new URL("https://issuer-a.example.com");
  const issuerB = new URL("https://issuer-b.example.com");
  const firstProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir, {
    issuerUrl: issuerA,
  });
  const client = await firstProvider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(client);
  firstProvider["codes"].set("issuer-bound-code", {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await firstProvider.exchangeAuthorizationCode(
    client,
    "issuer-bound-code",
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  firstProvider.close();

  const secondProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir, {
    issuerUrl: issuerB,
  });
  try {
    assert.equal(await secondProvider.clientsStore.getClient(client.client_id), undefined);
    await assert.rejects(secondProvider.verifyAccessToken(issued.access_token), isInvalidTokenError);
    await assert.rejects(
      secondProvider.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    secondProvider.close();
  }
}

async function testUnboundCredentialsAreRejected(stateDir: string): Promise<void> {
  const provider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  const client = await provider.clientsStore.registerClient?.({ redirect_uris: [redirectUri] });
  assert.ok(client);
  provider["codes"].set("unbound-code", {
    clientId: client.client_id,
    params: {
      redirectUri,
      codeChallenge: "challenge",
      scopes: ["devspace"],
      resource: mcpUrl,
    },
    expiresAtMs: Date.now() + 60_000,
  });
  const issued = await provider.exchangeAuthorizationCode(
    client,
    "unbound-code",
    undefined,
    redirectUri,
    mcpUrl,
  );
  assert.ok(issued.refresh_token);
  provider.close();

  const database = openDatabase(stateDir);
  try {
    database.sqlite.prepare("update oauth_clients set issuer = null").run();
    database.sqlite.prepare("update oauth_access_tokens set issuer = null").run();
    database.sqlite.prepare("update oauth_refresh_tokens set issuer = null").run();
  } finally {
    database.close();
  }

  const reopened = new SingleUserOAuthProvider(oauthConfig, mcpUrl, stateDir);
  try {
    assert.equal(await reopened.clientsStore.getClient(client.client_id), undefined);
    await assert.rejects(reopened.verifyAccessToken(issued.access_token), isInvalidTokenError);
    await assert.rejects(
      reopened.exchangeRefreshToken(client, issued.refresh_token, ["devspace"], mcpUrl),
      InvalidGrantError,
    );
  } finally {
    reopened.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function isInvalidTokenError(error: unknown): boolean {
  return OAuthError.isInstance(error) && error.code === OAuthErrorCode.InvalidToken;
}
