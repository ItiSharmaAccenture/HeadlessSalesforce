/**
 * In-memory rate limiting and concurrency capping.
 *
 * Deliberately process-local: this POC runs as a single dev server. It would
 * need a shared store before any multi-instance deployment.
 */

import 'server-only';

import { config } from './config';

const windows = new Map<string, { count: number; resetAt: number }>();
let inFlight = 0;

export type GateResult = { ok: true; release: () => void } | { ok: false; reason: string };

/**
 * Applies both the fixed-window request limit and the concurrency cap.
 * On success the caller must invoke `release()` exactly once.
 */
export function acquire(key: string): GateResult {
  // Checked before the window is touched, so a request turned away for
  // concurrency does not also burn the caller's quota.
  if (inFlight >= config.limits.maxConcurrentChats) {
    return { ok: false, reason: 'The assistant is busy with another request. Please try again in a moment.' };
  }

  const now = Date.now();
  const window = windows.get(key);

  if (!window || now >= window.resetAt) {
    windows.set(key, { count: 1, resetAt: now + config.limits.rateLimitWindowMs });
  } else if (window.count >= config.limits.rateLimitRequests) {
    const seconds = Math.ceil((window.resetAt - now) / 1000);
    return { ok: false, reason: `Too many requests. Please wait ${seconds}s and try again.` };
  } else {
    window.count += 1;
  }

  inFlight += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    },
  };
}

/** Drops expired windows so the map cannot grow without bound. */
export function sweep(now = Date.now()): void {
  for (const [key, window] of windows) {
    if (now >= window.resetAt) windows.delete(key);
  }
}

/** Test seam. */
export function resetRateLimiter(): void {
  windows.clear();
  inFlight = 0;
}
