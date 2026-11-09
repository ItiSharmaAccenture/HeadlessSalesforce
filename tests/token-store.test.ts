/**
 * Token storage backend selection and behaviour.
 *
 * The point of two backends is that one build runs locally and on Vercel, so
 * what matters is that the right one is picked from the environment, that
 * forcing Redis without credentials fails loudly instead of writing somewhere
 * that will not survive a cold start, and that the Redis backend keeps the
 * one-shot semantics the OAuth flow depends on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Stands in for Upstash, including its JSON round-trip. */
const redisStore = new Map<string, unknown>();
const redisCalls: { op: string; key: string; options?: unknown }[] = [];

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor(readonly config: { url: string; token: string }) {}
    async get<T>(key: string): Promise<T | null> {
      redisCalls.push({ op: 'get', key });
      return (redisStore.get(key) as T) ?? null;
    }
    async set(key: string, value: unknown, options?: unknown) {
      redisCalls.push({ op: 'set', key, options });
      redisStore.set(key, JSON.parse(JSON.stringify(value)));
      return 'OK';
    }
    async del(key: string) {
      redisCalls.push({ op: 'del', key });
      return redisStore.delete(key) ? 1 : 0;
    }
  },
}));

const REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://example-redis.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
};

async function loadStore(env: Record<string, string> = {}) {
  vi.resetModules();
  // vitest.config.mts sets no storage variables, so the baseline is the file backend.
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('@/lib/token-store');
}

const tokens = { accessToken: 'access-value', refreshToken: 'refresh-value', obtainedAt: Date.now() };

beforeEach(() => {
  redisStore.clear();
  redisCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */

describe('backend selection', () => {
  it('defaults to the file backend when no Redis credentials are set', async () => {
    const store = await loadStore();
    expect(store.tokenStoreDescription().kind).toBe('file');
  });

  it('switches to Redis as soon as its credentials appear, with no code change', async () => {
    const store = await loadStore(REDIS_ENV);
    expect(store.tokenStoreDescription().kind).toBe('redis');
  });

  it('accepts the legacy Vercel KV variable names too', async () => {
    const store = await loadStore({
      KV_REST_API_URL: 'https://legacy-kv.upstash.io',
      KV_REST_API_TOKEN: 'kv-token',
    });
    expect(store.tokenStoreDescription().kind).toBe('redis');
  });

  it('lets the file backend be forced even when Redis is configured', async () => {
    const store = await loadStore({ ...REDIS_ENV, TOKEN_STORE: 'file' });
    expect(store.tokenStoreDescription().kind).toBe('file');
  });

  it('fails loudly when Redis is demanded without credentials', async () => {
    const store = await loadStore({ TOKEN_STORE: 'redis' });

    // Writing to a file on a read-only host would look like it worked and then
    // lose the tokens, so this refuses instead.
    expect(() => store.tokenStoreDescription()).toThrow(store.TokenStoreConfigError);
    expect(() => store.tokenStoreDescription()).toThrow(/no Redis credentials/i);
  });

  it('rejects an unknown backend name', async () => {
    const store = await loadStore({ TOKEN_STORE: 'postgres' });
    expect(() => store.tokenStoreDescription()).toThrow(/Use "file" or "redis"/);
  });

  it('never reports the token itself in the location it describes', async () => {
    const store = await loadStore(REDIS_ENV);
    const { location } = store.tokenStoreDescription();

    expect(location).toContain('example-redis.upstash.io');
    expect(location).not.toContain('test-token');
  });
});

describe('redis backend', () => {
  it('round-trips tokens', async () => {
    const store = await loadStore(REDIS_ENV);

    await store.writeTokens(tokens);
    await expect(store.readTokens()).resolves.toMatchObject({ accessToken: 'access-value' });
  });

  it('treats a cleared store as unauthorized', async () => {
    const store = await loadStore(REDIS_ENV);

    await store.writeTokens(tokens);
    await store.clearTokens();
    await expect(store.readTokens()).resolves.toBeNull();
  });

  it('reports nothing when the key holds no access token', async () => {
    const store = await loadStore(REDIS_ENV);
    redisStore.set('salesforce-mcp-poc:tokens', { obtainedAt: 1 });

    await expect(store.readTokens()).resolves.toBeNull();
  });

  it('namespaces its keys so one Redis can serve several deployments', async () => {
    const store = await loadStore({ ...REDIS_ENV, TOKEN_STORE_PREFIX: 'staging' });

    await store.writeTokens(tokens);
    expect([...redisStore.keys()]).toEqual(['staging:tokens']);
  });

  it('expires a pending authorization in Redis as well as checking its age', async () => {
    const store = await loadStore(REDIS_ENV);

    await store.savePendingAuth({ state: 'abc', codeVerifier: 'verifier', createdAt: Date.now() });

    const set = redisCalls.find((call) => call.op === 'set' && call.key.endsWith(':pending'));
    expect(set?.options).toEqual({ px: 10 * 60 * 1000 });
  });
});

describe('pending authorization, on Redis', () => {
  it('redeems a matching state exactly once', async () => {
    const store = await loadStore(REDIS_ENV);
    const pending = { state: 'state-value', codeVerifier: 'verifier-value', createdAt: Date.now() };

    await store.savePendingAuth(pending);
    await expect(store.consumePendingAuth('state-value')).resolves.toMatchObject({ codeVerifier: 'verifier-value' });

    // Replaying the callback finds nothing.
    await expect(store.consumePendingAuth('state-value')).resolves.toBeNull();
  });

  it('burns the request on a forged state, so it cannot be retried', async () => {
    const store = await loadStore(REDIS_ENV);
    await store.savePendingAuth({ state: 'real-state', codeVerifier: 'verifier', createdAt: Date.now() });

    await expect(store.consumePendingAuth('forged-state')).resolves.toBeNull();
    await expect(store.consumePendingAuth('real-state')).resolves.toBeNull();
  });

  it('refuses a request older than its ten-minute window', async () => {
    const store = await loadStore(REDIS_ENV);
    const stale = { state: 'state-value', codeVerifier: 'verifier', createdAt: Date.now() - 11 * 60 * 1000 };

    await store.savePendingAuth(stale);
    await expect(store.consumePendingAuth('state-value')).resolves.toBeNull();
  });

  it('deletes the record before comparing, which is what makes it one-shot', async () => {
    const store = await loadStore(REDIS_ENV);
    await store.savePendingAuth({ state: 'state-value', codeVerifier: 'verifier', createdAt: Date.now() });
    redisCalls.length = 0;

    await store.consumePendingAuth('state-value');

    const ops = redisCalls.filter((call) => call.key.endsWith(':pending')).map((call) => call.op);
    expect(ops).toEqual(['get', 'del']);
  });
});
