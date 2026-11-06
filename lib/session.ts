/**
 * The technician sign-in cookie.
 *
 * A stand-in for real authentication: the sign-in screen lets anyone name
 * themselves, so the cookie is not signed — a signature would protect nothing
 * that the form itself does not already give away. What it does buy is that the
 * identity is read server-side on every request and is never re-sent by the
 * browser, so the chat payloads stay free of it and page scripts cannot read it.
 *
 * Replace this module with a real session to make the demo multi-user for real.
 */

import 'server-only';

import { cookies } from 'next/headers';

import { toTechnician } from './technician';
import type { Technician } from '@/types/technician';

export const TECHNICIAN_COOKIE = 'adt-technician';

/** A sign-in lasts a working day; after that the screen comes back. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Keeps a pasted-in value from becoming an unbounded cookie. */
const MAX_FIELD_CHARS = 120;

export function serialiseTechnician(fullName: string, id: string): string {
  return JSON.stringify({ fullName: fullName.slice(0, MAX_FIELD_CHARS), id: id.slice(0, MAX_FIELD_CHARS) });
}

/**
 * The signed-in technician, or null when nobody is signed in.
 *
 * A malformed or truncated cookie returns null rather than throwing, so a stale
 * value shows the sign-in screen instead of a 500.
 */
export async function readTechnician(): Promise<Technician | null> {
  const raw = (await cookies()).get(TECHNICIAN_COOKIE)?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { fullName?: unknown; id?: unknown };
    const fullName = typeof parsed.fullName === 'string' ? parsed.fullName.trim() : '';
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    if (!fullName || !id) return null;
    return toTechnician(fullName, id);
  } catch {
    return null;
  }
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
