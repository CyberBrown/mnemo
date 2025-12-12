/**
 * OAuth 2.0 Authorization Code Flow for Mnemo MCP Server
 *
 * This module implements OAuth 2.0 with CF Access as the identity backend:
 *
 * Flow:
 * 1. Client redirects to /oauth/authorize with client_id, redirect_uri, state
 * 2. CF Access intercepts (if configured) and authenticates user
 * 3. After auth, Mnemo generates authorization code and redirects back
 * 4. Client exchanges code for access token at /oauth/token
 * 5. Client uses access token for /mcp requests
 *
 * Storage:
 * - Authorization codes: KV with 10-minute TTL
 * - Access tokens: KV with 24-hour TTL
 *
 * Security:
 * - PKCE support for public clients
 * - One-time use authorization codes
 * - CF Access JWT validation for user identity
 */

export { handleAuthorize } from './authorize';
export { handleToken } from './token';
export { validateOAuthToken, requireAuthOrOAuth, type OAuthUser } from './validate';
export * from './types';
export * from './storage';
