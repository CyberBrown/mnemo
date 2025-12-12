import type { Context } from 'hono';
import {
  AuthorizeRequestSchema,
  type OAuthError,
  type CFAccessJWTPayload,
} from './types';
import { generateSecureToken, storeAuthorizationCode } from './storage';

/**
 * Handle OAuth 2.0 authorization request (GET /oauth/authorize)
 *
 * Flow:
 * 1. User/client requests authorization
 * 2. CF Access intercepts (if configured) and authenticates user
 * 3. After CF Access auth, request arrives here with JWT
 * 4. We validate JWT, generate authorization code
 * 5. Redirect back to client with code
 *
 * @param c - Hono context
 */
export async function handleAuthorize(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Parse and validate request parameters
  const params = Object.fromEntries(new URL(c.req.url).searchParams);

  const parseResult = AuthorizeRequestSchema.safeParse(params);
  if (!parseResult.success) {
    return createErrorRedirect(
      params.redirect_uri,
      params.state,
      {
        error: 'invalid_request',
        error_description: `Invalid parameters: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      }
    );
  }

  const request = parseResult.data;

  // Validate client_id (single-tenant: check against configured client ID)
  const expectedClientId = c.env.OAUTH_CLIENT_ID;
  if (expectedClientId && request.client_id !== expectedClientId) {
    return createErrorRedirect(
      request.redirect_uri,
      request.state,
      {
        error: 'unauthorized_client',
        error_description: 'Unknown client_id',
      }
    );
  }

  // Get user identity from CF Access JWT
  const userInfo = await extractCFAccessUser(c);

  if (!userInfo) {
    // If CF Access is configured but no valid JWT, this shouldn't happen
    // because CF Access would intercept the request first.
    // If CF Access is NOT configured, we need an alternative auth method.

    // For now, if no CF Access user info, return an error.
    // In production, CF Access should be protecting this endpoint.
    return createErrorRedirect(
      request.redirect_uri,
      request.state,
      {
        error: 'access_denied',
        error_description: 'User authentication required. Please configure CF Access for this endpoint.',
      }
    );
  }

  // Generate authorization code
  const code = generateSecureToken(32);

  // Store code with associated data
  await storeAuthorizationCode(c.env.OAUTH_KV, code, {
    clientId: request.client_id,
    redirectUri: request.redirect_uri,
    userId: userInfo.sub,
    userEmail: userInfo.email,
    scope: request.scope,
    codeChallenge: request.code_challenge,
    codeChallengeMethod: request.code_challenge_method,
    createdAt: Date.now(),
  });

  // Redirect back to client with authorization code
  const redirectUrl = new URL(request.redirect_uri);
  redirectUrl.searchParams.set('code', code);
  redirectUrl.searchParams.set('state', request.state);

  return c.redirect(redirectUrl.toString(), 302);
}

/**
 * Extract user information from CF Access JWT
 *
 * CF Access sets the JWT in the "CF-Access-JWT-Assertion" header
 * after successful authentication.
 *
 * @param c - Hono context
 * @returns User info from JWT payload, or null if not authenticated
 */
async function extractCFAccessUser(
  c: Context<{ Bindings: Env }>
): Promise<CFAccessJWTPayload | null> {
  const jwt = c.req.header('CF-Access-JWT-Assertion');

  if (!jwt) {
    return null;
  }

  // Validate the JWT
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = c.env.CF_ACCESS_AUD;

  if (!teamDomain || !expectedAud) {
    // CF Access not configured - skip JWT validation
    // This allows development/testing without CF Access
    console.warn('CF Access not configured (CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD missing)');

    // Try to decode JWT without validation for development
    return decodeJWTPayload(jwt);
  }

  // Fetch CF Access public keys and validate JWT
  try {
    const payload = await validateCFAccessJWT(jwt, teamDomain, expectedAud);
    return payload;
  } catch (error) {
    console.error('CF Access JWT validation failed:', error);
    return null;
  }
}

/**
 * Decode JWT payload without validation (for development only)
 */
function decodeJWTPayload(jwt: string): CFAccessJWTPayload | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;

    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = atob(payloadB64);
    return JSON.parse(payloadJson) as CFAccessJWTPayload;
  } catch {
    return null;
  }
}

/**
 * Validate CF Access JWT against Cloudflare's public keys
 *
 * @param jwt - The JWT token
 * @param teamDomain - CF Access team domain (e.g., "yourteam.cloudflareaccess.com")
 * @param expectedAud - Expected audience claim
 */
async function validateCFAccessJWT(
  jwt: string,
  teamDomain: string,
  expectedAud: string
): Promise<CFAccessJWTPayload> {
  // Fetch public keys from CF Access
  const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  const certsResponse = await fetch(certsUrl);

  if (!certsResponse.ok) {
    throw new Error(`Failed to fetch CF Access certs: ${certsResponse.status}`);
  }

  const certs = await certsResponse.json() as { keys: JsonWebKey[] };

  // Parse JWT
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header to get key ID
  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'))) as {
    alg: string;
    kid: string;
  };

  // Find matching key
  const key = certs.keys.find((k: JsonWebKey) => k.kid === header.kid);
  if (!key) {
    throw new Error(`No matching key found for kid: ${header.kid}`);
  }

  // Import the public key
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Verify signature
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    signedData
  );

  if (!isValid) {
    throw new Error('Invalid JWT signature');
  }

  // Decode and validate payload
  const payload = JSON.parse(
    atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
  ) as CFAccessJWTPayload;

  // Validate claims
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    throw new Error('JWT expired');
  }

  if (!payload.aud.includes(expectedAud)) {
    throw new Error(`Invalid audience: expected ${expectedAud}, got ${payload.aud}`);
  }

  return payload;
}

/**
 * Base64URL decode
 */
function base64UrlDecode(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Create an error redirect response
 */
function createErrorRedirect(
  redirectUri: string | undefined,
  state: string | undefined,
  error: OAuthError
): Response {
  // If no valid redirect URI, return JSON error
  if (!redirectUri) {
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error.error);
    if (error.error_description) {
      url.searchParams.set('error_description', error.error_description);
    }
    if (state) {
      url.searchParams.set('state', state);
    }
    return Response.redirect(url.toString(), 302);
  } catch {
    // Invalid redirect URI, return JSON error
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
