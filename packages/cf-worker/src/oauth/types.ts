import { z } from 'zod';

/**
 * OAuth 2.0 Authorization Request parameters
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1
 */
export const AuthorizeRequestSchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.literal('code'),
  state: z.string().min(1),
  scope: z.string().optional(),
  code_challenge: z.string().optional(), // PKCE
  code_challenge_method: z.enum(['S256', 'plain']).optional(), // PKCE
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/**
 * OAuth 2.0 Token Request parameters
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3
 */
export const TokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(), // PKCE
});

export type TokenRequest = z.infer<typeof TokenRequestSchema>;

/**
 * OAuth 2.0 Token Response
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.4
 */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * OAuth 2.0 Error Response
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2.1
 */
export interface OAuthError {
  error: OAuthErrorCode;
  error_description?: string;
  error_uri?: string;
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_grant'
  | 'invalid_client';

/**
 * Stored authorization code data
 */
export interface AuthorizationCodeData {
  clientId: string;
  redirectUri: string;
  userId: string;
  userEmail?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  createdAt: number;
}

/**
 * Stored access token data
 */
export interface AccessTokenData {
  clientId: string;
  userId: string;
  userEmail?: string;
  scope?: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * CF Access JWT payload (relevant claims)
 * @see https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export interface CFAccessJWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  identity_nonce?: string;
  custom?: Record<string, unknown>;
}

// Constants
export const AUTHORIZATION_CODE_TTL_SECONDS = 600; // 10 minutes
export const ACCESS_TOKEN_TTL_SECONDS = 86400; // 24 hours

// KV key prefixes
export const KV_PREFIX_AUTH_CODE = 'oauth:code:';
export const KV_PREFIX_ACCESS_TOKEN = 'oauth:token:';
