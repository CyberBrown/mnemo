import type { Context } from 'hono';
import {
  TokenRequestSchema,
  type TokenResponse,
  type OAuthError,
  ACCESS_TOKEN_TTL_SECONDS,
} from './types';
import {
  consumeAuthorizationCode,
  generateSecureToken,
  storeAccessToken,
  hashCodeVerifier,
} from './storage';

/**
 * Handle OAuth 2.0 token request (POST /oauth/token)
 *
 * Exchanges an authorization code for an access token.
 *
 * @param c - Hono context
 */
export async function handleToken(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Parse request body (supports both JSON and form-urlencoded)
  let body: Record<string, string>;

  const contentType = c.req.header('Content-Type') || '';

  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await c.req.parseBody();
    body = Object.fromEntries(
      Object.entries(formData).map(([k, v]) => [k, String(v)])
    );
  } else {
    return createErrorResponse({
      error: 'invalid_request',
      error_description: 'Content-Type must be application/json or application/x-www-form-urlencoded',
    });
  }

  // Validate request
  const parseResult = TokenRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return createErrorResponse({
      error: 'invalid_request',
      error_description: `Invalid parameters: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
    });
  }

  const request = parseResult.data;

  // Validate client credentials
  const expectedClientId = c.env.OAUTH_CLIENT_ID;
  const expectedClientSecret = c.env.OAUTH_CLIENT_SECRET;

  if (expectedClientId && request.client_id !== expectedClientId) {
    return createErrorResponse({
      error: 'invalid_client',
      error_description: 'Unknown client_id',
    });
  }

  // Check client_secret if configured
  if (expectedClientSecret && request.client_secret !== expectedClientSecret) {
    return createErrorResponse({
      error: 'invalid_client',
      error_description: 'Invalid client_secret',
    });
  }

  // Consume authorization code (one-time use)
  const codeData = await consumeAuthorizationCode(c.env.OAUTH_KV, request.code);

  if (!codeData) {
    return createErrorResponse({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
  }

  // Validate that the code was issued to this client
  if (codeData.clientId !== request.client_id) {
    return createErrorResponse({
      error: 'invalid_grant',
      error_description: 'Authorization code was not issued to this client',
    });
  }

  // Validate redirect_uri matches
  if (codeData.redirectUri !== request.redirect_uri) {
    return createErrorResponse({
      error: 'invalid_grant',
      error_description: 'redirect_uri does not match the one used in authorization',
    });
  }

  // Validate PKCE code_verifier if code_challenge was used
  if (codeData.codeChallenge) {
    if (!request.code_verifier) {
      return createErrorResponse({
        error: 'invalid_grant',
        error_description: 'code_verifier required for PKCE',
      });
    }

    const isValidPKCE = await validatePKCE(
      request.code_verifier,
      codeData.codeChallenge,
      codeData.codeChallengeMethod || 'plain'
    );

    if (!isValidPKCE) {
      return createErrorResponse({
        error: 'invalid_grant',
        error_description: 'Invalid code_verifier',
      });
    }
  }

  // Generate access token
  const accessToken = generateSecureToken(64);
  const now = Date.now();
  const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS * 1000;

  // Store access token
  await storeAccessToken(c.env.OAUTH_KV, accessToken, {
    clientId: request.client_id,
    userId: codeData.userId,
    userEmail: codeData.userEmail,
    scope: codeData.scope,
    createdAt: now,
    expiresAt,
  });

  // Return token response
  const response: TokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  };

  if (codeData.scope) {
    response.scope = codeData.scope;
  }

  return c.json(response, 200, {
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
  });
}

/**
 * Validate PKCE code_verifier against code_challenge
 */
async function validatePKCE(
  verifier: string,
  challenge: string,
  method: 'S256' | 'plain'
): Promise<boolean> {
  if (method === 'plain') {
    return verifier === challenge;
  }

  // S256: challenge = BASE64URL(SHA256(verifier))
  const computedChallenge = await hashCodeVerifier(verifier);
  return computedChallenge === challenge;
}

/**
 * Create an OAuth error response
 */
function createErrorResponse(error: OAuthError, status: number = 400): Response {
  return new Response(JSON.stringify(error), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
    },
  });
}
