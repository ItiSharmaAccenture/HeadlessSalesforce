import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  base64url,
  createCodeChallenge,
  createCodeVerifier,
  createPkce,
  createState,
  isValidCodeVerifier,
  safeCompare,
} from '@/lib/pkce';

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

describe('base64url', () => {
  it('drops padding and uses the URL-safe alphabet', () => {
    const bytes = Buffer.from([251, 255, 190, 1]);

    expect(base64url(bytes)).not.toMatch(/[+/=]/);
    expect(base64url(bytes)).toBe(bytes.toString('base64url'));
  });
});

describe('createCodeVerifier', () => {
  it('produces a verifier of the length RFC 7636 requires', () => {
    const verifier = createCodeVerifier();

    expect(verifier).toHaveLength(43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
  });

  it('produces a different verifier every time', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));
    expect(verifiers.size).toBe(50);
  });

  it('only uses unreserved characters', () => {
    expect(createCodeVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe('createCodeChallenge', () => {
  it('matches the worked example from RFC 7636 appendix B', () => {
    expect(createCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('is the base64url SHA-256 of the ASCII verifier', () => {
    const verifier = createCodeVerifier();
    expect(createCodeChallenge(verifier)).toBe(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  });

  it('changes completely when the verifier changes by one character', () => {
    expect(createCodeChallenge('a'.repeat(43))).not.toBe(createCodeChallenge(`${'a'.repeat(42)}b`));
  });
});

describe('createPkce', () => {
  it('pairs a valid verifier with its S256 challenge', () => {
    const pkce = createPkce();

    expect(pkce.codeChallengeMethod).toBe('S256');
    expect(isValidCodeVerifier(pkce.codeVerifier)).toBe(true);
    expect(pkce.codeChallenge).toBe(createCodeChallenge(pkce.codeVerifier));
    // The challenge must not be the verifier in disguise.
    expect(pkce.codeChallenge).not.toBe(pkce.codeVerifier);
  });
});

describe('isValidCodeVerifier', () => {
  it('rejects a verifier below the minimum length', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
  });

  it('rejects a verifier above the maximum length', () => {
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
  });

  it('rejects reserved characters', () => {
    expect(isValidCodeVerifier(`${'a'.repeat(42)}/`)).toBe(false);
  });

  it('accepts both boundary lengths', () => {
    expect(isValidCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
  });
});

describe('createState', () => {
  it('produces a long, unique value on every call', () => {
    const states = new Set(Array.from({ length: 50 }, () => createState()));

    expect(states.size).toBe(50);
    expect(createState().length).toBeGreaterThanOrEqual(43);
  });
});

describe('safeCompare', () => {
  it('matches identical values', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  it('rejects differing values of equal length', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
  });

  it('rejects values of differing length without throwing', () => {
    expect(safeCompare('short', 'a-much-longer-value')).toBe(false);
  });

  it('rejects an empty candidate', () => {
    expect(safeCompare('', 'secret')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* State handling in the token store                                   */
/* ------------------------------------------------------------------ */

describe('pending authorization state', () => {
  let directory: string;
  // Imported per-test because the store resolves its path at module load.
  let store: typeof import('@/lib/token-store');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sf-oauth-test-'));
    process.env.TOKEN_STORE_DIR = directory;

    vi.resetModules();
    store = await import('@/lib/token-store');
  });

  afterEach(async () => {
    delete process.env.TOKEN_STORE_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it('redeems a pending request whose state matches', async () => {
    const pending = { state: createState(), codeVerifier: createCodeVerifier(), createdAt: Date.now() };
    await store.savePendingAuth(pending);

    const redeemed = await store.consumePendingAuth(pending.state);

    expect(redeemed?.codeVerifier).toBe(pending.codeVerifier);
  });

  it('refuses a state that does not match the pending request', async () => {
    await store.savePendingAuth({ state: createState(), codeVerifier: createCodeVerifier(), createdAt: Date.now() });

    expect(await store.consumePendingAuth(createState())).toBeNull();
  });

  it('refuses a replay of an already-redeemed state', async () => {
    const pending = { state: createState(), codeVerifier: createCodeVerifier(), createdAt: Date.now() };
    await store.savePendingAuth(pending);

    expect(await store.consumePendingAuth(pending.state)).not.toBeNull();
    // A second callback with the same code must find nothing to redeem.
    expect(await store.consumePendingAuth(pending.state)).toBeNull();
  });

  it('burns the pending request even when the state was wrong', async () => {
    const pending = { state: createState(), codeVerifier: createCodeVerifier(), createdAt: Date.now() };
    await store.savePendingAuth(pending);

    await store.consumePendingAuth('wrong-state');
    expect(await store.consumePendingAuth(pending.state)).toBeNull();
  });

  it('refuses an expired pending request', async () => {
    const pending = {
      state: createState(),
      codeVerifier: createCodeVerifier(),
      createdAt: Date.now() - 11 * 60 * 1000,
    };
    await store.savePendingAuth(pending);

    expect(await store.consumePendingAuth(pending.state)).toBeNull();
  });

  it('returns null when no authorization is pending', async () => {
    expect(await store.consumePendingAuth(createState())).toBeNull();
  });

  it('round-trips tokens and clears them on request', async () => {
    await store.writeTokens({ accessToken: 'token-value', refreshToken: 'refresh-value', obtainedAt: Date.now() });

    expect((await store.readTokens())?.refreshToken).toBe('refresh-value');

    await store.clearTokens();
    expect(await store.readTokens()).toBeNull();
  });

  it('writes the token file outside any publicly served directory', async () => {
    await store.writeTokens({ accessToken: 'token-value', obtainedAt: Date.now() });

    const path = store.tokenStorePaths.tokenFile;
    expect(path).not.toMatch(/[\\/]public[\\/]/);

    // Sanity check that the file really is where the store reports.
    await expect(readFile(path, 'utf8')).resolves.toContain('accessToken');
  });
});
