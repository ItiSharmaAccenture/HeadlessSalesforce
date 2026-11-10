/**
 * Technician sign-in for /my-day.
 *
 * POST   — records who is using the dashboard, in a signed httpOnly cookie.
 * DELETE — signs them out.
 *
 * Name and technician id are self-declared: the Copilot looks the schedule up
 * by name. The dashboard is scoped to the ServiceResource id the server-side
 * directory maps the technician id to (lib/technician-directory.ts). The
 * browser never submits a ServiceResource id.
 */

import { cookies } from 'next/headers';

import { readSession, serialiseTechnician, sessionCookieOptions, SESSION_MAX_AGE_SECONDS, TECHNICIAN_COOKIE } from '@/lib/session';
import { resolveServiceResource } from '@/lib/technician-directory';
import { toTechnician } from '@/lib/technician';
import type { SignInRequest } from '@/types/technician';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FIELD_CHARS = 120;

function bad(message: string): Response {
  return Response.json({ error: message, retryable: false }, { status: 400 });
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

  const { name, id } = (raw ?? {}) as Partial<SignInRequest>;
  if (typeof name !== 'string' || name.trim().length === 0) return bad('Enter your full name.');
  if (typeof id !== 'string' || id.trim().length === 0) return bad('Enter your technician ID.');
  if (name.length > MAX_FIELD_CHARS || id.length > MAX_FIELD_CHARS) {
    return bad(`Name and ID are limited to ${MAX_FIELD_CHARS} characters.`);
  }

  const technician = toTechnician(name, id);
  const outcome = resolveServiceResource(technician.id);
  const serviceResourceId = outcome.mapped ? outcome.serviceResourceId : undefined;

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
