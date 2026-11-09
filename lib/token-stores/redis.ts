/**
 * Redis-backed token storage, for Vercel and anywhere else with more than one
 * instance or a read-only filesystem.
 *
 * Uses Upstash's REST client rather than a TCP Redis driver: serverless
 * invocations are short-lived and cannot keep a connection pool, and the REST
 * client needs no sockets. `@vercel/kv` is deprecated in favour of provisioning
 * Upstash through the Vercel Marketplace, so the Upstash client is used directly
 * and both sets of environment variable names are accepted.
 *
 * The pending authorization matters as much as the tokens here: the authorize
 * request and the Salesforce callback can land on different instances, so the
 * `state` and PKCE verifier have to be somewhere both can see.
 */

import 'server-only';

import { log } from '../logger';
import { PENDING_TTL_MS, type PendingAuth, type StoredTokens, type TokenBackend } from './types';

export interface RedisCredentials {
  url: string;
  token: string;
}

/**
 * The REST endpoint and a read/write token, under whatever names they arrived.
 *
 * Three naming schemes are in play: Upstash's own `UPSTASH_REDIS_REST_*`, the
 * legacy Vercel KV `KV_REST_API_*`, and — because the Vercel Marketplace
 * integration offers an environment-variable prefix — either of those with an
 * arbitrary prefix, e.g. `MYAPP_KV_REST_API_URL`. So exact names are tried
 * first, then a suffix match across the environment.
 *
 * Two variables in a typical Upstash set must *not* be picked up:
 * `KV_REST_API_READ_ONLY_TOKEN`, which cannot write, and `REDIS_URL` / `KV_URL`,
 * which are `rediss://` connection strings the REST client cannot use.
 */
export function redisCredentials(env: NodeJS.ProcessEnv = process.env): RedisCredentials | null {
  const value = (name: string | undefined) => (name && env[name]?.trim() ? env[name]!.trim() : undefined);

  // Exact names, in preference order.
  for (const [urlName, tokenName] of [
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ]) {
    const url = value(urlName);
    const token = value(tokenName);
    if (url && token) return { url, token };
  }

  // Prefixed variants. Both halves must share a prefix, so two provisioned
  // instances cannot be mixed into one set of credentials.
  for (const [urlSuffix, tokenSuffix] of [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ]) {
    for (const key of Object.keys(env)) {
      if (!key.endsWith(`_${urlSuffix}`)) continue;

      const prefix = key.slice(0, -urlSuffix.length);
      const url = value(key);
      const token = value(`${prefix}${tokenSuffix}`);
      // A read-only token is never a substitute: this store has to write.
      if (url && token && !`${prefix}${tokenSuffix}`.includes('READ_ONLY')) return { url, token };
    }
  }

  return null;
}

/** Explains a URL that was found but cannot be used, rather than failing at the first call. */
export function describeUnusableUrl(url: string): string | null {
  if (/^https:\/\//i.test(url)) return null;
  if (/^rediss?:\/\//i.test(url)) {
    return (
      `Redis URL "${url.replace(/\/\/[^@]*@/, '//***@')}" is a TCP connection string. ` +
      'The REST client needs the HTTPS endpoint, which Upstash publishes as KV_REST_API_URL ' +
      '(or UPSTASH_REDIS_REST_URL) rather than REDIS_URL or KV_URL.'
    );
  }
  return `Redis URL "${url}" is not an HTTPS endpoint.`;
}

/** Namespaced so one Redis instance can serve several deployments. */
function keyPrefix(): string {
  return (process.env.TOKEN_STORE_PREFIX ?? 'salesforce-mcp-poc').replace(/:+$/, '');
}

export function redisBackend(credentials: RedisCredentials): TokenBackend {
  const prefix = keyPrefix();
  const tokenKey = `${prefix}:tokens`;
  const pendingKey = `${prefix}:pending`;

  // Imported lazily so a local run using the file backend never loads the client.
  let client: Promise<import('@upstash/redis').Redis> | null = null;
  const redis = () => {
    client ??= import('@upstash/redis').then(({ Redis }) => new Redis(credentials));
    return client;
  };

  return {
    kind: 'redis',
    location: `redis ${new URL(credentials.url).host}/${tokenKey}`,

    async readTokens() {
      // The client parses JSON itself, so this comes back as an object.
      const tokens = await (await redis()).get<StoredTokens>(tokenKey);
      return tokens?.accessToken ? tokens : null;
    },

    async writeTokens(tokens: StoredTokens) {
      await (await redis()).set(tokenKey, tokens);
    },

    async clearTokens() {
      await (await redis()).del(tokenKey);
    },

    async savePending(pending: PendingAuth) {
      // A TTL as well as the facade's own age check: an abandoned flow should not
      // leave the verifier sitting in Redis indefinitely.
      await (await redis()).set(pendingKey, pending, { px: PENDING_TTL_MS });
    },

    async takePending() {
      const connection = await redis();
      const pending = await connection.get<PendingAuth>(pendingKey);
      // Deleted before the caller compares the state, so a replayed callback
      // finds nothing and a mismatch burns the request.
      await connection.del(pendingKey).catch(() => undefined);
      return pending ?? null;
    },
  };
}

export function logRedisSelection(credentials: RedisCredentials): void {
  log.info('token-store', 'Using Redis token storage', { host: new URL(credentials.url).host });
}
