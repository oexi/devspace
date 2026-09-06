import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  OAuthError,
  OAuthErrorCode,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/server";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "./oauth-store.js";
import {
  HttpsClientMetadataDocumentResolver,
  parseClientMetadataUrl,
  type ClientMetadataDocumentResolver,
} from "./oauth-client-metadata.js";

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUTHORIZATION_CODE_CLEANUP_INTERVAL_MS = 60 * 1000;
const AUTHORIZATION_CODE_CLEANUP_BATCH_SIZE = 100;

export interface SingleUserOAuthProviderOptions {
  now?: () => number;
  authorizationCodeCleanupIntervalMs?: number;
  tokenCleanupIntervalMs?: number;
  issuerUrl?: URL;
  clientMetadataResolver?: ClientMetadataDocumentResolver;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize DevSpace</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly oauthStore: SqliteOAuthStore;
  private readonly resourceServerUrl: URL;
  private readonly issuerUrl: URL;
  private readonly now: () => number;
  private readonly authorizationCodeCleanupIntervalMs: number;
  private lastAuthorizationCodeCleanupAtMs?: number;
  private authorizationCodeCleanupIterator?: Iterator<[string, AuthorizationCodeRecord]>;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir: string,
    options: SingleUserOAuthProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.authorizationCodeCleanupIntervalMs = nonNegativeFiniteDuration(
      options.authorizationCodeCleanupIntervalMs ?? DEFAULT_AUTHORIZATION_CODE_CLEANUP_INTERVAL_MS,
      "OAuth authorization code cleanup interval",
    );
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.issuerUrl = new URL(options.issuerUrl?.href ?? resourceServerUrl.origin);
    this.oauthStore = new SqliteOAuthStore(stateDir, {
      issuer: this.issuerUrl.href,
      now: this.now,
      tokenCleanupIntervalMs: options.tokenCleanupIntervalMs,
    });
    this.clientsStore = new SqliteOAuthClientsStore(
      this.oauthStore,
      config.allowedRedirectHosts,
      options.clientMetadataResolver ?? new HttpsClientMetadataDocumentResolver(this.now),
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const nowMs = this.now();
    this.maybeCleanupExpiredAuthorizationCodes(nowMs);
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }
    if (
      parseClientMetadataUrl(client.client_id) &&
      !client.redirect_uris.includes(params.redirectUri)
    ) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Client ID Metadata Document redirect_uri must match exactly",
      });
      return;
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    const codeIssuedAtMs = this.now();
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: codeIssuedAtMs + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("iss", this.issuerUrl.href);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const nowMs = this.now();
    this.maybeCleanupExpiredAuthorizationCodes(nowMs);
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.oauthStore.getRefreshToken(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt <= this.nowSeconds()) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      refreshTokenHash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const nowMs = this.now();
    this.maybeCleanupExpiredAuthorizationCodes(nowMs);
    const record = this.oauthStore.getAccessToken(hashToken(token));
    if (!record || record.expiresAt <= this.nowSeconds()) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.maybeCleanupExpiredAuthorizationCodes(this.now());
    const hashed = hashToken(request.token);
    this.oauthStore.deleteAccessToken(hashed);
    this.oauthStore.deleteRefreshToken(hashed);
  }

  close(): void {
    this.oauthStore.close();
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const nowMs = this.now();
    this.maybeCleanupExpiredAuthorizationCodes(nowMs);
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs <= nowMs) {
      if (record && record.expiresAtMs <= nowMs) {
        this.codes.delete(authorizationCode);
      }
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    const now = this.nowSeconds();
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.oauthStore.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: {
          clientId,
          scopes,
          expiresAt: accessExpiresAt,
          resource: resource?.href,
        },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: {
          clientId,
          scopes,
          expiresAt: refreshExpiresAt,
          resource: resource?.href,
        },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private maybeCleanupExpiredAuthorizationCodes(nowMs: number): void {
    const lastCleanupAtMs = this.lastAuthorizationCodeCleanupAtMs;
    if (
      lastCleanupAtMs !== undefined &&
      nowMs >= lastCleanupAtMs &&
      nowMs - lastCleanupAtMs < this.authorizationCodeCleanupIntervalMs
    ) {
      return;
    }

    this.cleanupExpiredAuthorizationCodes(nowMs);
    this.lastAuthorizationCodeCleanupAtMs = nowMs;
  }

  private cleanupExpiredAuthorizationCodes(nowMs: number): void {
    if (this.codes.size === 0) {
      this.authorizationCodeCleanupIterator = undefined;
      return;
    }

    const iterator = this.authorizationCodeCleanupIterator ?? this.codes.entries();
    for (let inspected = 0; inspected < AUTHORIZATION_CODE_CLEANUP_BATCH_SIZE; inspected += 1) {
      const next = iterator.next();
      if (next.done) {
        this.authorizationCodeCleanupIterator = undefined;
        return;
      }

      const [code, record] = next.value;
      if (record.expiresAtMs <= nowMs) this.codes.delete(code);
    }

    this.authorizationCodeCleanupIterator = iterator;
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function nonNegativeFiniteDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite duration.`);
  }
  return value;
}
