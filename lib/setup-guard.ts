/**
 * Access control for the OAuth setup routes.
 *
 * These routes start and finish the dedicated user's authorization, so they are
 * restricted to a local operator: bound to localhost and gated by a secret that
 * must be set explicitly. There is no default secret, and a missing one blocks
 * the route rather than opening it.
 */

import 'server-only';

import { config } from './config';
import { log } from './logger';
import { safeCompare } from './pkce';

export type GuardFailure = { status: number; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Strips the port and brackets so `[::1]:3000` and `::1` compare equal.
 *
 * A bare IPv6 address is left alone: its own colons are not a port separator,
 * so `::1` must not be trimmed down to `::`.
 */
function hostname(value: string): string {
  const trimmed = value.trim().toLowerCase();

  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed) return bracketed[1];

  // Two or more colons means an unbracketed IPv6 address, which carries no port.
  if ((trimmed.match(/:/g)?.length ?? 0) > 1) return trimmed;

  return trimmed.replace(/:\d+$/, '');
}

function isLoopbackAddress(value: string): boolean {
  const address = hostname(value);
  if (LOCAL_HOSTS.has(address)) return true;
  // The whole of 127.0.0.0/8 is loopback, as is the IPv4-mapped form of it.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address.replace(/^::ffff:/, ''));
}

/**
 * Rejects anything that did not originate from this machine.
 *
 * Next's dev server populates the `x-forwarded-*` headers itself, so their mere
 * presence proves nothing. What matters is that every address they carry is a
 * loopback address: a request relayed from another machine will not be.
 *
 * ALLOW_REMOTE_SETUP lifts this, for completing the authorization on a deployed
 * host where there is no localhost to reach. The authorize route still requires
 * SETUP_SECRET; the callback still depends on the one-shot `state` it issued.
 */
export function requireLocalhost(request: Request): GuardFailure | null {
  if (config.setup.allowRemote) return null;

  const host = hostname(request.headers.get('host') ?? '');

  if (!LOCAL_HOSTS.has(host)) {
    log.warn('setup-guard', 'Setup route refused for a non-local host', { host });
    return { status: 403, message: 'The Salesforce setup routes are only available on localhost.' };
  }

  const forwardedHost = request.headers.get('x-forwarded-host');
  if (forwardedHost && !LOCAL_HOSTS.has(hostname(forwardedHost))) {
    log.warn('setup-guard', 'Setup route refused for a forwarded host', { forwardedHost });
    return { status: 403, message: 'The Salesforce setup routes cannot be reached through a proxy.' };
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor && !forwardedFor.split(',').every(isLoopbackAddress)) {
    log.warn('setup-guard', 'Setup route refused for a remote client address');
    return { status: 403, message: 'The Salesforce setup routes are only available on localhost.' };
  }

  return null;
}

/** Validates the setup token supplied as `?secret=` or an `x-setup-secret` header. */
export function requireSetupSecret(request: Request): GuardFailure | null {
  const expected = config.setup.secret;

  if (!expected) {
    return {
      status: 503,
      message:
        'SETUP_SECRET is not configured. Set it to a long random value in .env.local, restart the server, and retry.',
    };
  }

  const url = new URL(request.url);
  const supplied = request.headers.get('x-setup-secret') ?? url.searchParams.get('secret') ?? '';

  if (!supplied || !safeCompare(supplied, expected)) {
    log.warn('setup-guard', 'Setup route refused: bad setup secret');
    return { status: 401, message: 'Invalid setup secret.' };
  }

  return null;
}

/** Applies both guards; returns the first failure or null when the request may proceed. */
export function guardSetupRoute(request: Request, options: { requireSecret: boolean }): GuardFailure | null {
  return requireLocalhost(request) ?? (options.requireSecret ? requireSetupSecret(request) : null);
}
