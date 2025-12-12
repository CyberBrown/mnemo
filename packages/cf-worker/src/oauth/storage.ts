import {
  type AuthorizationCodeData,
  type AccessTokenData,
  KV_PREFIX_AUTH_CODE,
  KV_PREFIX_ACCESS_TOKEN,
  AUTHORIZATION_CODE_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
} from './types';

/**
 * Generate a cryptographically secure random string
 * @param length - Length of the string (default: 32)
 */
export function generateSecureToken(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Store an authorization code in KV
 * @param kv - KV namespace
 * @param code - The authorization code
 * @param data - Data associated with the code
 */
export async function storeAuthorizationCode(
  kv: KVNamespace,
  code: string,
  data: AuthorizationCodeData
): Promise<void> {
  const key = `${KV_PREFIX_AUTH_CODE}${code}`;
  await kv.put(key, JSON.stringify(data), {
    expirationTtl: AUTHORIZATION_CODE_TTL_SECONDS,
  });
}

/**
 * Retrieve and consume an authorization code (one-time use)
 * @param kv - KV namespace
 * @param code - The authorization code
 * @returns The code data, or null if not found/expired
 */
export async function consumeAuthorizationCode(
  kv: KVNamespace,
  code: string
): Promise<AuthorizationCodeData | null> {
  const key = `${KV_PREFIX_AUTH_CODE}${code}`;
  const value = await kv.get(key);

  if (!value) {
    return null;
  }

  // Delete the code immediately (one-time use)
  await kv.delete(key);

  try {
    return JSON.parse(value) as AuthorizationCodeData;
  } catch {
    return null;
  }
}

/**
 * Store an access token in KV
 * @param kv - KV namespace
 * @param token - The access token
 * @param data - Data associated with the token
 */
export async function storeAccessToken(
  kv: KVNamespace,
  token: string,
  data: AccessTokenData
): Promise<void> {
  const key = `${KV_PREFIX_ACCESS_TOKEN}${token}`;
  await kv.put(key, JSON.stringify(data), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Retrieve an access token from KV
 * @param kv - KV namespace
 * @param token - The access token
 * @returns The token data, or null if not found/expired
 */
export async function getAccessToken(
  kv: KVNamespace,
  token: string
): Promise<AccessTokenData | null> {
  const key = `${KV_PREFIX_ACCESS_TOKEN}${token}`;
  const value = await kv.get(key);

  if (!value) {
    return null;
  }

  try {
    const data = JSON.parse(value) as AccessTokenData;

    // Double-check expiry (KV TTL is best-effort)
    if (data.expiresAt < Date.now()) {
      await kv.delete(key);
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Revoke an access token
 * @param kv - KV namespace
 * @param token - The access token to revoke
 */
export async function revokeAccessToken(
  kv: KVNamespace,
  token: string
): Promise<void> {
  const key = `${KV_PREFIX_ACCESS_TOKEN}${token}`;
  await kv.delete(key);
}

/**
 * Hash a PKCE code verifier using SHA-256
 * @param verifier - The code verifier
 * @returns Base64URL-encoded hash
 */
export async function hashCodeVerifier(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Base64URL encode (no padding, URL-safe characters)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
