import { randomUUID } from "node:crypto";
import type {
  OAuthClientInformationFull,
} from "@modelcontextprotocol/server";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  HttpsClientMetadataDocumentResolver,
  parseClientMetadataUrl,
  type ClientMetadataDocumentResolver,
} from "./oauth-client-metadata.js";
import {
  InvalidRequestError,
  type OAuthRegisteredClientsStore,
} from "./oauth-authorization.js";

const DEFAULT_TOKEN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface SqliteOAuthStoreOptions {
  issuer: string;
  now?: () => number;
  tokenCleanupIntervalMs?: number;
}

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;
  private readonly issuer: string;
  private readonly now: () => number;
  private readonly tokenCleanupIntervalMs: number;
  private lastTokenCleanupAtMs?: number;

  constructor(stateDir: string, options: SqliteOAuthStoreOptions) {
    this.issuer = canonicalIssuer(options.issuer);
    this.now = options.now ?? Date.now;
    this.tokenCleanupIntervalMs = nonNegativeFiniteDuration(
      options.tokenCleanupIntervalMs ?? DEFAULT_TOKEN_CLEANUP_INTERVAL_MS,
      "OAuth token cleanup interval",
    );
    this.database = openDatabase(stateDir);
    const nowMs = this.now();
    this.deleteExpiredTokens(Math.floor(nowMs / 1000));
    this.lastTokenCleanupAtMs = nowMs;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ? and issuer = ?")
      .get(clientId, this.issuer) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = this.nowSeconds();
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at, issuer) values (?, ?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now, this.issuer);

    return registered;
  }

  upsertResolvedClient(client: OAuthClientInformationFull): void {
    const issuedAt = client.client_id_issued_at ?? this.nowSeconds();
    this.database.sqlite
      .prepare(
        `insert into oauth_clients (client_id, client_json, issued_at, issuer)
         values (?, ?, ?, ?)
         on conflict(client_id) do update set
           client_json = excluded.client_json,
           issued_at = excluded.issued_at,
           issuer = excluded.issuer`,
      )
      .run(client.client_id, JSON.stringify(client), issuedAt, this.issuer);
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.maybeDeleteExpiredTokens();
    this.saveAccessTokenRecord(tokenHash, record);
  }

  private saveAccessTokenRecord(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource, issuer)
         values (?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource,
           issuer = excluded.issuer`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
        this.issuer,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    this.maybeDeleteExpiredTokens();
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ? and issuer = ?",
      )
      .get(tokenHash, this.issuer) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.maybeDeleteExpiredTokens();
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.maybeDeleteExpiredTokens();
    this.saveRefreshTokenRecord(tokenHash, record);
  }

  private saveRefreshTokenRecord(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource, issuer)
         values (?, ?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource,
           issuer = excluded.issuer`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
        this.issuer,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    this.maybeDeleteExpiredTokens();
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ? and issuer = ?")
          .run(consumedRefreshTokenHash, this.issuer);
        if (result.changes !== 1) return false;
      }

      this.saveAccessTokenRecord(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshTokenRecord(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    this.maybeDeleteExpiredTokens();
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ? and issuer = ?",
      )
      .get(tokenHash, this.issuer) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.maybeDeleteExpiredTokens();
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private maybeDeleteExpiredTokens(): void {
    const nowMs = this.now();
    const lastCleanupAtMs = this.lastTokenCleanupAtMs;
    if (
      lastCleanupAtMs !== undefined &&
      nowMs >= lastCleanupAtMs &&
      nowMs - lastCleanupAtMs < this.tokenCleanupIntervalMs
    ) {
      return;
    }

    this.deleteExpiredTokens(Math.floor(nowMs / 1000));
    this.lastTokenCleanupAtMs = nowMs;
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at <= ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at <= ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    private readonly clientMetadataResolver: ClientMetadataDocumentResolver = new HttpsClientMetadataDocumentResolver(),
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (!parseClientMetadataUrl(clientId)) return this.store.getClient(clientId);
    const resolved = await this.clientMetadataResolver.resolve(clientId);
    if (resolved) this.store.upsertResolvedClient(resolved);
    return resolved;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function nonNegativeFiniteDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite duration.`);
  }
  return value;
}

function canonicalIssuer(value: string): string {
  const issuer = new URL(value);
  if (issuer.search || issuer.hash) throw new Error("OAuth issuer must not contain a query or fragment");
  return issuer.href;
}
