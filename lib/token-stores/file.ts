/**
 * File-backed token storage, for local development.
 *
 * A single JSON file in the project root — outside `public/`, never served, and
 * git-ignored. Adequate for a single-process dev server and nothing more: it is
 * not encrypted and not shared between instances.
 *
 * This backend cannot be used on a serverless host: the deployment filesystem is
 * read-only, and the one writable path (`/tmp`) is per-instance and cleared on a
 * cold start, which would strand both the tokens and the pending authorization.
 * Use the Redis backend there.
 */

import 'server-only';

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { log } from '../logger';
import type { PendingAuth, StoredTokens, TokenBackend } from './types';

export function fileBackend(): TokenBackend & { paths: { dir: string; tokenFile: string } } {
  const dir = process.env.TOKEN_STORE_DIR ?? join(process.cwd(), '.local');
  const tokenFile = join(dir, 'salesforce-tokens.json');
  const pendingFile = join(dir, 'salesforce-oauth-pending.json');

  async function readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn('token-store', `Could not read ${path.split(/[\\/]/).pop()}`, { code });
      return null;
    }
  }

  /** Temp file + rename, so a crash mid-write cannot leave a half-written file. */
  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
    // rename preserves the temp file's mode on POSIX; set it again for clarity.
    await chmod(path, 0o600).catch(() => undefined);
  }

  return {
    kind: 'file',
    location: tokenFile,
    paths: { dir, tokenFile },

    async readTokens() {
      const tokens = await readJson<StoredTokens>(tokenFile);
      return tokens?.accessToken ? tokens : null;
    },

    writeTokens: (tokens) => writeJson(tokenFile, tokens),

    async clearTokens() {
      await unlink(tokenFile).catch(() => undefined);
    },

    savePending: (pending) => writeJson(pendingFile, pending),

    async takePending() {
      const pending = await readJson<PendingAuth>(pendingFile);
      await unlink(pendingFile).catch(() => undefined);
      return pending;
    },
  };
}
