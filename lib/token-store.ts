/**
 * Where Salesforce OAuth tokens live.
 *
 * Two backends, chosen by environment rather than by a code change, so one build
 * runs both locally and on a serverless host:
 *
 *   file  — a git-ignored JSON file. The local default; fine for one dev server.
 *   redis — Upstash over REST. Required on Vercel, where the filesystem is
 *           read-only and `/tmp` is per-instance and cleared on a cold start.
 *
 * Selection is automatic: Redis when its credentials are present, file
 * otherwise. `TOKEN_STORE` forces one explicitly, and forcing `redis` without
 * credentials fails loudly rather than quietly writing somewhere that will not
 * survive.
 *
 * Neither backend encrypts anything. This is still a POC store, not a secret
 * manager.
 */

import 'server-only';

import { log } from './logger';
import { safeCompare } from './pkce';
import { fileBackend } from './token-stores/file';
import { describeUnusableUrl, redisBackend, redisCredentials } from './token-stores/redis';
import { PENDING_TTL_MS, type PendingAuth, type StoredTokens, type TokenBackend } from './token-stores/types';

export type { PendingAuth, StoredTokens } from './token-stores/types';

export class TokenStoreConfigError extends Error {}

function select(): TokenBackend {
  const requested = process.env.TOKEN_STORE?.trim().toLowerCase();
  const credentials = redisCredentials();

  if (requested === 'redis' || (!requested && credentials)) {
    if (!credentials) {
      throw new TokenStoreConfigError(
        'TOKEN_STORE=redis but no Redis credentials were found. Provide KV_REST_API_URL and ' +
          'KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. A prefix added ' +
          'by the Vercel integration is fine; a read-only token is not.',
      );
    }

    // A rediss:// URL would otherwise fail on the first call with a fetch error.
    const unusable = describeUnusableUrl(credentials.url);
    if (unusable) throw new TokenStoreConfigError(unusable);

    log.info('token-store', 'Using Redis token storage', { host: new URL(credentials.url).host });
    return redisBackend(credentials);
  }

  if (requested && requested !== 'file') {
    throw new TokenStoreConfigError(`Unknown TOKEN_STORE "${requested}". Use "file" or "redis".`);
  }

  const backend = fileBackend();
  log.info('token-store', 'Using file token storage', { path: backend.paths.tokenFile });
  return backend;
}

// Resolved once per process; tests re-import the module to change backend.
let backend: TokenBackend | null = null;

function store(): TokenBackend {
  backend ??= select();
  return backend;
}

/** Test seam. */
export function resetTokenStore(): void {
  backend = null;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export async function readTokens(): Promise<StoredTokens | null> {
  return store().readTokens();
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  await store().writeTokens(tokens);
  log.info('token-store', 'Salesforce tokens saved', {
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'unknown',
  });
}

export async function clearTokens(): Promise<void> {
  await store().clearTokens();
}

/* ------------------------------------------------------------------ */
/* Pending authorization                                               */
/* ------------------------------------------------------------------ */

export async function savePendingAuth(pending: PendingAuth): Promise<void> {
  await store().savePending(pending);
}

/**
 * Redeems a pending authorization request exactly once.
 *
 * The backend removes the record before the state is compared, so a replayed
 * callback cannot reuse the verifier and a mismatch burns the pending request.
 * Kept here rather than in the backends so both enforce it identically.
 */
export async function consumePendingAuth(state: string): Promise<PendingAuth | null> {
  const pending = await store().takePending();

  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) return null;
  if (!safeCompare(pending.state, state)) return null;

  return pending;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

/** Exposed so /api/health can report where tokens live without leaking them. */
export function tokenStoreDescription(): { kind: 'file' | 'redis'; location: string } {
  const current = store();
  return { kind: current.kind, location: current.location };
}

/**
 * Only meaningful with the file backend; the Redis backend has no path.
 * Retained for local tooling and the OAuth tests.
 */
export const tokenStorePaths = fileBackend().paths;
