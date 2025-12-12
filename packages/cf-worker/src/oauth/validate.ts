import type { Context, Next } from 'hono';
import { getAccessToken } from './storage';
import type { AccessTokenData } from './types';

/**
 * OAuth access token validation middleware
 *
 * Validates the Bearer token from the Authorization header against
 * tokens stored in KV. This middleware:
 * 1. Checks for Bearer token in Authorization header
 * 2. Looks up token in KV storage
 * 3. Validates token expiry
 * 4. Attaches user info to context for downstream handlers
 *
 * Note: This middleware works alongside the existing requireAuth() middleware.
 * It's designed to accept EITHER the static MNEMO_AUTH_TOKEN OR a valid OAuth token.
 *
 * @returns Hono middleware function
 */
export function validateOAuthToken() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const header = c.req.header('Authorization');

    if (!header) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing Authorization header. Use: Authorization: Bearer <token>',
      }, 401);
    }

    if (!header.toLowerCase().startsWith('bearer ')) {
      return c.json({
        error: 'Unauthorized',
        message: 'Invalid Authorization header format. Use: Authorization: Bearer <token>',
      }, 401);
    }

    const token = header.slice(7).trim(); // Remove "Bearer " prefix

    if (!token) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing token in Authorization header',
      }, 401);
    }

    // First, check if this is the static MNEMO_AUTH_TOKEN (backwards compatibility)
    const staticToken = c.env.MNEMO_AUTH_TOKEN;
    if (staticToken && token === staticToken) {
      // Static token is valid, proceed
      return await next();
    }

    // Check if this is a valid OAuth token
    const tokenData = await getAccessToken(c.env.OAUTH_KV, token);

    if (!tokenData) {
      return c.json({
        error: 'Unauthorized',
        message: 'Invalid or expired access token',
      }, 401);
    }

    // Attach user info to context for downstream handlers
    c.set('oauth_user', {
      userId: tokenData.userId,
      userEmail: tokenData.userEmail,
      clientId: tokenData.clientId,
      scope: tokenData.scope,
    });

    return await next();
  };
}

/**
 * Combined auth middleware that accepts either:
 * 1. Static MNEMO_AUTH_TOKEN (for CLI/Claude Code)
 * 2. OAuth access token (for web clients like Claude.ai)
 * 3. Service binding requests (internal worker-to-worker calls)
 * 4. No auth if MNEMO_AUTH_TOKEN is not configured
 *
 * This replaces the existing requireAuth() middleware to support both auth methods.
 *
 * @returns Hono middleware function
 */
export function requireAuthOrOAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const staticToken = c.env.MNEMO_AUTH_TOKEN;

    // If no static auth token configured, check if OAuth is enabled
    // OAuth is enabled if OAUTH_CLIENT_ID is configured
    const oauthEnabled = !!c.env.OAUTH_CLIENT_ID;

    if (!staticToken && !oauthEnabled) {
      // No auth configured, allow access (backwards compatible)
      return await next();
    }

    // Allow service binding requests from same-account workers
    // Service binding requests don't have CF-Connecting-IP (external requests always do)
    const cfConnectingIP = c.req.header('CF-Connecting-IP');
    if (!cfConnectingIP) {
      console.log('Service binding request detected (no CF-Connecting-IP), allowing access');
      return await next();
    }

    // Get Authorization header
    const header = c.req.header('Authorization');
    if (!header) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing Authorization header. Use: Authorization: Bearer <token>',
      }, 401);
    }

    if (!header.toLowerCase().startsWith('bearer ')) {
      return c.json({
        error: 'Unauthorized',
        message: 'Invalid Authorization header format. Use: Authorization: Bearer <token>',
      }, 401);
    }

    const token = header.slice(7).trim();
    if (!token) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing token in Authorization header',
      }, 401);
    }

    // Check static token first (fast path for CLI)
    if (staticToken && token === staticToken) {
      return await next();
    }

    // Check OAuth token
    if (oauthEnabled) {
      const tokenData = await getAccessToken(c.env.OAUTH_KV, token);

      if (tokenData) {
        // Valid OAuth token, attach user info
        c.set('oauth_user', {
          userId: tokenData.userId,
          userEmail: tokenData.userEmail,
          clientId: tokenData.clientId,
          scope: tokenData.scope,
        });
        return await next();
      }
    }

    // Neither static token nor OAuth token is valid
    return c.json({
      error: 'Unauthorized',
      message: 'Invalid authentication token',
    }, 401);
  };
}

/**
 * Type for OAuth user info attached to context
 */
export interface OAuthUser {
  userId: string;
  userEmail?: string;
  clientId: string;
  scope?: string;
}

// Extend Hono's context to include oauth_user
declare module 'hono' {
  interface ContextVariableMap {
    oauth_user?: OAuthUser;
  }
}
