import type { Response } from "express";
import type {
  AuthInfo,
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/server";

/**
 * The authorization-server contract owned by DevSpace.
 *
 * The MCP v2 packages expose the common OAuth wire types, but not the v1
 * authorization-server provider contract. Keeping this contract local lets
 * the resource-server path use v2 types without coupling it to the legacy
 * authorization router.
 */
export interface AuthorizationParams {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
  issuer?: string;
}

export interface OAuthRegisteredClientsStore {
  getClient(clientId: string):
    | OAuthClientInformationFull
    | undefined
    | Promise<OAuthClientInformationFull | undefined>;
  registerClient?(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull | Promise<OAuthClientInformationFull>;
}

export interface OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void>;
  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string>;
  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens>;
  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens>;
  verifyAccessToken(token: string): Promise<AuthInfo>;
  revokeToken?(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void>;
  authorizationResponseIssParameterSupported?: boolean;
  skipLocalPkceValidation?: boolean;
}

export type OAuthAuthorizationErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "access_denied"
  | "server_error"
  | "invalid_token"
  | "invalid_scope";

/** An OAuth error raised by DevSpace's authorization-server implementation. */
export class OAuthAuthorizationError extends Error {
  readonly code: OAuthAuthorizationErrorCode;
  readonly errorUri?: string;

  constructor(code: OAuthAuthorizationErrorCode, message: string, errorUri?: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.errorUri = errorUri;
  }
}

export class InvalidRequestError extends OAuthAuthorizationError {
  constructor(message: string, errorUri?: string) {
    super("invalid_request", message, errorUri);
  }
}

export class InvalidClientError extends OAuthAuthorizationError {
  constructor(message: string, errorUri?: string) {
    super("invalid_client", message, errorUri);
  }
}

export class InvalidGrantError extends OAuthAuthorizationError {
  constructor(message: string, errorUri?: string) {
    super("invalid_grant", message, errorUri);
  }
}

export class AccessDeniedError extends OAuthAuthorizationError {
  constructor(message: string, errorUri?: string) {
    super("access_denied", message, errorUri);
  }
}

export class ServerError extends OAuthAuthorizationError {
  constructor(message: string, errorUri?: string) {
    super("server_error", message, errorUri);
  }
}

export function isOAuthAuthorizationError(
  error: unknown,
): error is OAuthAuthorizationError {
  return error instanceof OAuthAuthorizationError;
}
