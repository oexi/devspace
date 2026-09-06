/**
 * Compatibility boundary for the frozen legacy OAuth Authorization Server.
 *
 * MCP v2 intentionally no longer ships an Authorization Server implementation
 * in the main server package. DevSpace keeps the frozen
 * @modelcontextprotocol/server-legacy@2 router only at this boundary so
 * ChatGPT OAuth/CIMD pairing can continue to work while the MCP Resource
 * Server remains entirely on the v2 packages. The retired v1 SDK is not a
 * direct DevSpace dependency.
 */
import type { RequestHandler } from "express";
import {
  AccessDeniedError as LegacyAccessDeniedError,
  InvalidClientError as LegacyInvalidClientError,
  InvalidGrantError as LegacyInvalidGrantError,
  InvalidRequestError as LegacyInvalidRequestError,
  InvalidScopeError as LegacyInvalidScopeError,
  InvalidTokenError as LegacyInvalidTokenError,
  OAuthError as LegacyOAuthError,
  ServerError as LegacyServerError,
  mcpAuthRouter,
  type AuthInfo as LegacyAuthInfo,
  type AuthorizationParams as LegacyAuthorizationParams,
  type OAuthRegisteredClientsStore as LegacyOAuthRegisteredClientsStore,
  type OAuthServerProvider as LegacyOAuthServerProvider,
} from "@modelcontextprotocol/server-legacy/auth";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/server";
import type {
  AuthorizationParams,
  OAuthRegisteredClientsStore,
  OAuthServerProvider,
} from "./oauth-authorization.js";

type LegacyClient = Parameters<LegacyOAuthServerProvider["authorize"]>[0];
type LegacyRevocationRequest = Parameters<NonNullable<LegacyOAuthServerProvider["revokeToken"]>>[1];
type LegacyOAuthTokens = Awaited<ReturnType<LegacyOAuthServerProvider["exchangeAuthorizationCode"]>>;

export interface LegacyOAuthRouterOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  baseUrl?: URL;
  serviceDocumentationUrl?: URL;
  scopesSupported?: string[];
  resourceName?: string;
  resourceServerUrl?: URL;
}

/** Adapt DevSpace's local contract to the frozen legacy router. */
export function createLegacyOAuthRouter(
  options: LegacyOAuthRouterOptions,
): RequestHandler {
  return mcpAuthRouter({
    ...options,
    provider: toLegacyProvider(options.provider),
  });
}

function toLegacyProvider(
  provider: OAuthServerProvider,
): LegacyOAuthServerProvider {
  const legacyProvider: LegacyOAuthServerProvider = {
    get clientsStore() {
      return toLegacyClientsStore(provider.clientsStore);
    },
    async authorize(client, params, res) {
      try {
        await provider.authorize(
          toModernClient(client),
          toModernAuthorizationParams(params),
          res,
        );
      } catch (error) {
        throw toLegacyError(error);
      }
    },
    async challengeForAuthorizationCode(client, authorizationCode) {
      try {
        return await provider.challengeForAuthorizationCode(
          toModernClient(client),
          authorizationCode,
        );
      } catch (error) {
        throw toLegacyError(error);
      }
    },
    async exchangeAuthorizationCode(client, authorizationCode, codeVerifier, redirectUri, resource) {
      try {
        return toLegacyTokens(await provider.exchangeAuthorizationCode(
          toModernClient(client),
          authorizationCode,
          codeVerifier,
          redirectUri,
          resource,
        ));
      } catch (error) {
        throw toLegacyError(error);
      }
    },
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      try {
        return toLegacyTokens(await provider.exchangeRefreshToken(
          toModernClient(client),
          refreshToken,
          scopes,
          resource,
        ));
      } catch (error) {
        throw toLegacyError(error);
      }
    },
    async verifyAccessToken(token) {
      try {
        return toLegacyAuthInfo(await provider.verifyAccessToken(token));
      } catch (error) {
        throw toLegacyError(error);
      }
    },
    ...(provider.revokeToken
      ? {
          async revokeToken(client: LegacyClient, request: LegacyRevocationRequest) {
            try {
              await provider.revokeToken!(
                toModernClient(client),
                toModernRevocationRequest(request),
              );
            } catch (error) {
              throw toLegacyError(error);
            }
          },
        }
      : {}),
    authorizationResponseIssParameterSupported: provider.authorizationResponseIssParameterSupported,
    skipLocalPkceValidation: provider.skipLocalPkceValidation,
  };
  return legacyProvider;
}

function toLegacyClientsStore(
  store: OAuthRegisteredClientsStore,
): LegacyOAuthRegisteredClientsStore {
  const legacyStore: LegacyOAuthRegisteredClientsStore = {
    async getClient(clientId) {
      try {
        const client = await store.getClient(clientId);
        return client ? toLegacyClient(client) : undefined;
      } catch (error) {
        throw toLegacyError(error);
      }
    },
  };

  if (store.registerClient) {
    legacyStore.registerClient = async (client) => {
      try {
        const registered = await store.registerClient!(
          client as unknown as Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
        );
        return toLegacyClient(registered);
      } catch (error) {
        throw toLegacyError(error);
      }
    };
  }

  return legacyStore;
}

function toModernClient(client: LegacyClient): OAuthClientInformationFull {
  return client as unknown as OAuthClientInformationFull;
}

function toLegacyClient(client: OAuthClientInformationFull): LegacyClient {
  return client as unknown as LegacyClient;
}

function toModernAuthorizationParams(params: LegacyAuthorizationParams): AuthorizationParams {
  return params as AuthorizationParams;
}

function toModernRevocationRequest(request: LegacyRevocationRequest): OAuthTokenRevocationRequest {
  return request as unknown as OAuthTokenRevocationRequest;
}

function toLegacyTokens(tokens: OAuthTokens): LegacyOAuthTokens {
  return tokens as unknown as LegacyOAuthTokens;
}

function toLegacyAuthInfo(authInfo: {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL;
  extra?: Record<string, unknown>;
}): LegacyAuthInfo {
  return authInfo as LegacyAuthInfo;
}

function toLegacyError(error: unknown): unknown {
  if (error instanceof LegacyOAuthError) return error;

  const code = oauthErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const errorUri = oauthErrorUri(error);
  switch (code) {
    case "invalid_request": return new LegacyInvalidRequestError(message, errorUri);
    case "invalid_client": return new LegacyInvalidClientError(message, errorUri);
    case "invalid_grant": return new LegacyInvalidGrantError(message, errorUri);
    case "access_denied": return new LegacyAccessDeniedError(message, errorUri);
    case "invalid_scope": return new LegacyInvalidScopeError(message, errorUri);
    case "invalid_token": return new LegacyInvalidTokenError(message, errorUri);
    case "server_error": return new LegacyServerError(message, errorUri);
    default: return error;
  }
}

function oauthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function oauthErrorUri(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("errorUri" in error)) return undefined;
  const errorUri = (error as { errorUri?: unknown }).errorUri;
  return typeof errorUri === "string" ? errorUri : undefined;
}
