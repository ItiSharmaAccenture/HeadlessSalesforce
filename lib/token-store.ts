/**
 * Development-only token persistence.
 *
 * Tokens are written to a single JSON file in the project root — outside
 * `public/`, never served, and git-ignored. This is adequate for a
 * single-process POC and nothing more: it is not encrypted, not shared between
 * instances, and must be replaced with a secret manager before any real
 * deployment.
 */

import 'server-only';

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { log } from './logger';
import { safeCompare } from './pkce';

const STORE_DIR = process.env.TOKEN_STORE_DIR ?? join(process.cwd(), '.local');
const TOKEN_FILE = join(STORE_DIR, 'salesforce-tokens.json');
const PENDING_FILE = join(STORE_DIR, 'salesforce-oauth-pending.json');

/** Authorization requests expire quickly; a stale `state` must not be redeemable. */
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
  /** Epoch ms. Undefined when Salesforce did not return `expires_in`. */
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log.warn('token-store', `Could not read ${path.split(/[\/]/).pop()}`, { code });
    return null;
  }
}

/**
 * Writes via a temp file + rename so a crash mid-write cannot leave a
 * half-written token file behind.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  // rename preserves the temp file's mode on POSIX; set it again for clarity.
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readTokens(): Promise<StoredTokens | null> {
  const tokens = await readJson<StoredTokens>(TOKEN_FILE);
  return tokens?.accessToken ? tokens : null;
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  await writeJson(TOKEN_FILE, tokens);
  log.info('token-store', 'Salesforce tokens saved', {
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'unknown',
  });
}

export async function clearTokens(): Promise<void> {
  await unlink(TOKEN_FILE).catch(() => undefined);
}

export async function savePendingAuth(pending: PendingAuth): Promise<void> {
  await writeJson(PENDING_FILE, pending);
}

/**
 * Redeems a pending authorization request exactly once.
 *
 * The file is removed before the state is compared so that a replayed callback
 * cannot reuse the same verifier, and so a mismatch burns the pending request.
 */
export async function consumePendingAuth(state: string): Promise<PendingAuth | null> {
  const pending = await readJson<PendingAuth>(PENDING_FILE);
  await unlink(PENDING_FILE).catch(() => undefined);

  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) return null;
  if (!safeCompare(pending.state, state)) return null;

  return pending;
}

/** Exposed so /api/health can report storage location without leaking contents. */
export const tokenStorePaths = { dir: STORE_DIR, tokenFile: TOKEN_FILE } as const;

