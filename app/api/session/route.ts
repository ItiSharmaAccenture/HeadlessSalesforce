/**
 * Technician sign-in for /my-day.
 *
 * POST   — records who is using the dashboard, in a signed httpOnly cookie.
 * DELETE — signs them out.
 *
 * Name and technician id are self-declared, as before: the Copilot looks the
 * schedule up by name. The dashboard is different: it is scoped to a
 * ServiceResource id that the server assigns only when the technician id is in
 * the server-side directory AND the access code matches (demo mode, see
 * lib/technician-directory.ts). The browser never submits a ServiceResource id.
 */

import { cookies } from 'next/headers';

import { log } from '@/lib/logger';
import { readSession, serialiseTechnician, sessionCookieOptions, SESSION_MAX_AGE_SECONDS, TECHNICIAN_COOKIE } from '@/lib/session';
import { demoModeEnabled, isDirectoryTechnician, resolveServiceResource } from '@/lib/technician-directory';
import { toTechnician } from '@/lib/technician';
import type { SignInRequest } from '@/types/technician';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FIELD_CHARS = 120;

function bad(message: string, status = 400): Response {
  return Response.json({ error: message, retryable: false }, { status });
}

export async function GET(): Promise<Response> {
  const session = await readSession();
  return Response.json(
    { technician: session?.technician ?? null, dashboardAuthorized: Boolean(session?.serviceResourceId) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return bad('The request body was not valid JSON.');
  }

  const { name, id, accessCode } = (raw ?? {}) as Partial<SignInRequest>;
  if (typeof name !== 'string' || name.trim().length === 0) return bad('Enter your full name.');
  if (typeof id !== 'string' || id.trim().length === 0) return bad('Enter your technician ID.');
  if (name.length > MAX_FIELD_CHARS || id.length > MAX_FIELD_CHARS) {
    return bad(`Name and ID are limited to ${MAX_FIELD_CHARS} characters.`);
  }
  if (accessCode !== undefined && (typeof accessCode !== 'string' || accessCode.length > MAX_FIELD_CHARS)) {
    return bad('The access code is not valid.');
  }

  const technician = toTechnician(name, id);
  const code = typeof accessCode === 'string' && accessCode.length > 0 ? accessCode : undefined;

  let serviceResourceId: string | undefined;
  if (demoModeEnabled()) {
    const outcome = resolveServiceResource(technician.id, code);
    if (outcome.mapped) {
      serviceResourceId = outcome.serviceResourceId;
    } else if (outcome.reason === 'wrong_code') {
      log.warn('session', 'Sign-in refused: access code did not match');
      return bad('That access code is not correct for this technician ID.', 401);
    } else if (outcome.reason === 'no_code' && isDirectoryTechnician(technician.id)) {
      return bad('Enter the access code for this technician ID.', 401);
    }
  }

  (await cookies()).set(TECHNICIAN_COOKIE, serialiseTechnician(technician.fullName, technician.id, serviceResourceId), {
    ...sessionCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return Response.json({ technician, dashboardAuthorized: Boolean(serviceResourceId) });
}

export async function DELETE(): Promise<Response> {
  (await cookies()).set(TECHNICIAN_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return Response.json({ technician: null });
}
