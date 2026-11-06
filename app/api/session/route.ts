/**
 * Technician sign-in for /my-day.
 *
 * POST   — records who is using the dashboard, in an httpOnly cookie.
 * DELETE — signs them out.
 *
 * Deliberately unverified: this is a demo stand-in for real authentication, not
 * a security boundary. What a technician types is what the Copilot looks up, so
 * a name Salesforce does not know simply yields an empty schedule.
 */

import { cookies } from 'next/headers';

import { readTechnician, serialiseTechnician, sessionCookieOptions, SESSION_MAX_AGE_SECONDS, TECHNICIAN_COOKIE } from '@/lib/session';
import { toTechnician } from '@/lib/technician';
import type { SignInRequest } from '@/types/technician';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FIELD_CHARS = 120;

function bad(message: string): Response {
  return Response.json({ error: message, retryable: false }, { status: 400 });
}

export async function GET(): Promise<Response> {
  const technician = await readTechnician();
  return Response.json({ technician }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return bad('The request body was not valid JSON.');
  }

  const { name, id } = (raw ?? {}) as Partial<SignInRequest>;
  if (typeof name !== 'string' || name.trim().length === 0) return bad('Enter your full name.');
  if (typeof id !== 'string' || id.trim().length === 0) return bad('Enter your technician ID.');
  if (name.length > MAX_FIELD_CHARS || id.length > MAX_FIELD_CHARS) {
    return bad(`Name and ID are limited to ${MAX_FIELD_CHARS} characters.`);
  }

  const technician = toTechnician(name, id);

  (await cookies()).set(TECHNICIAN_COOKIE, serialiseTechnician(technician.fullName, technician.id), {
    ...sessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return Response.json({ technician });
}

export async function DELETE(): Promise<Response> {
  (await cookies()).set(TECHNICIAN_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return Response.json({ technician: null });
}
