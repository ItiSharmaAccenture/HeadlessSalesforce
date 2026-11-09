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
 * Accepts either naming scheme: `UPSTASH_REDIS_REST_*` (Upstash's own, and what
 * the Vercel Marketplace integration sets) or `KV_REST_API_*` (legacy Vercel KV).
 */
export function redisCredentials(env: NodeJS.ProcessEnv = process.env): RedisCredentials | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;

  if (!url?.trim() || !token?.trim()) return null;
  return { url: url.trim(), token: token.trim() };
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
