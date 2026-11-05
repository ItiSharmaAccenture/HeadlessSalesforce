/**
 * PKCE and OAuth `state` primitives (RFC 7636).
 *
 * Kept free of framework imports so the security-critical parts can be unit
 * tested directly.
 */

import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/** base64url: base64 with `+/` swapped for `-_` and padding stripped. */
export function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A code verifier is 43–128 characters from the unreserved set. 32 random
 * bytes base64url-encode to 43 characters, the specified minimum.
 */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge: base64url(SHA256(ASCII(verifier))). */
export function createCodeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** Opaque, unguessable CSRF token for the authorization request. */
export function createState(): string {
  return base64url(randomBytes(32));
}

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function createPkce(): Pkce {
  const codeVerifier = createCodeVerifier();
  return { codeVerifier, codeChallenge: createCodeChallenge(codeVerifier), codeChallengeMethod: 'S256' };
}

/** Validates the shape the authorization server will accept. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** Constant-time comparison for secrets such as `state` and the setup token. */
export function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}
