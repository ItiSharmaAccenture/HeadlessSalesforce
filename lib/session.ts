/**
 * The technician sign-in cookie.
 *
 * The name and technician id are still self-declared (the Copilot looks up the
 * schedule by name, as before). What is new is the ServiceResource id that
 * scopes the dashboard: it is set by the server from the server-side directory
 * (lib/technician-directory.ts), and the cookie is HMAC-signed so it cannot be edited to claim another
 * technician's ServiceResource.
 *
 * Signing key: SESSION_SECRET, falling back to SETUP_SECRET. Without either,
 * sign-in still works for the Copilot, but no dashboard mapping is honoured.
 *
 * The cookie is httpOnly: page scripts cannot read it and the browser never
 * re-sends the identity in a request body.
 */

import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { toTechnician } from './technician';
import type { Technician } from '@/types/technician';

export const TECHNICIAN_COOKIE = 'adt-technician';

/** A sign-in lasts a working day; after that the screen comes back. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Keeps a pasted-in value from becoming an unbounded cookie. */
const MAX_FIELD_CHARS = 120;

function signingKey(): string | null {
  const secret = process.env.SESSION_SECRET?.trim() || process.env.SETUP_SECRET?.trim();
  return secret ? `adt-my-day-session:${secret}` : null;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

interface SessionPayload {
  fullName: string;
  id: string;
  /** ServiceResource id the dashboard is scoped to; only present when verified. */
  sr?: string;
  /** Issued-at, seconds. */
  iat: number;
}

/**
 * Encodes the session. `serviceResourceId` is only written when there is a key
 * to sign it with; an unsigned cookie can never carry a mapping.
 */
export function serialiseTechnician(fullName: string, id: string, serviceResourceId?: string): string {
  const key = signingKey();
  const payload: SessionPayload = {
    fullName: fullName.slice(0, MAX_FIELD_CHARS),
    id: id.slice(0, MAX_FIELD_CHARS),
    iat: Math.floor(Date.now() / 1000),
    ...(serviceResourceId && key ? { sr: serviceResourceId } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${key ? sign(body, key) : '-'}`;
}

export interface Session {
  technician: Technician;
  /** Verified ServiceResource id, or null when this sign-in is not mapped. */
  serviceResourceId: string | null;
}

/** Parses and verifies a cookie value. Exported for tests. */
export function parseSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  const key = signingKey();
  let verified = false;
  if (key && signature !== '-') {
    const expected = Buffer.from(sign(body, key));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    verified = true;
  } else if (key) {
    // A key exists but the cookie is unsigned: it predates the key or was forged.
    return null;
  }

  let parsed: Partial<SessionPayload>;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
  } catch {
    return null;
  }

  const fullName = typeof parsed.fullName === 'string' ? parsed.fullName.trim() : '';
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!fullName || !id) return null;
  if (typeof parsed.iat === 'number' && Date.now() / 1000 - parsed.iat > SESSION_MAX_AGE_SECONDS) return null;

  return {
    technician: toTechnician(fullName, id),
    serviceResourceId: verified && typeof parsed.sr === 'string' ? parsed.sr : null,
  };
}

export async function readSession(): Promise<Session | null> {
  return parseSession((await cookies()).get(TECHNICIAN_COOKIE)?.value);
}

/**
 * The signed-in technician, or null when nobody is signed in.
 *
 * A malformed, tampered or expired cookie returns null rather than throwing,
 * so a stale value shows the sign-in screen instead of a 500.
 */
export async function readTechnician(): Promise<Technician | null> {
  return (await readSession())?.technician ?? null;
}

/** Cookie attributes shared by the setter and the sign-out clear. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    // `secure` would stop the cookie working over http://localhost.
    secure: process.env.NODE_ENV === 'production',
  };
}
