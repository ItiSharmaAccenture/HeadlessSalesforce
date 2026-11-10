/**
 * Shared plumbing for the dashboard API routes: session → authorized
 * ServiceResource, and query-string parsing. The ServiceResource id is only
 * ever read from the signed session cookie.
 */

import 'server-only';

import { readSession } from './session';
import { NOT_MAPPED, type DashboardRequest } from './dashboard';
import { isValidDate } from './time-range';
import type { DashboardView } from '@/types/dashboard';

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export type Authorized = { ok: true; serviceResourceId: string } | { ok: false; response: Response };

/** Extra fields merged into the "not linked" body, so each route keeps its own response shape. */
export async function authorize(notMappedExtras: Record<string, unknown> = {}): Promise<Authorized> {
  const session = await readSession();
  if (!session) {
    return {
      ok: false,
      response: Response.json({ error: 'You are signed out. Reload the page and sign in again.', retryable: false }, { status: 401, headers: NO_STORE }),
    };
  }
  if (!session.serviceResourceId) {
    // 200 with an explicit state: the dashboard renders it rather than treating it as a failure.
    return { ok: false, response: Response.json({ ...NOT_MAPPED, ...notMappedExtras }, { headers: NO_STORE }) };
  }
  return { ok: true, serviceResourceId: session.serviceResourceId };
}

export function parseView(url: URL): { ok: true; request: DashboardRequest } | { ok: false; response: Response } {
  const view = (url.searchParams.get('view') ?? 'today') as DashboardView;
  if (!['today', 'week', 'date'].includes(view)) {
    return { ok: false, response: Response.json({ error: 'view must be today, week or date.', retryable: false }, { status: 400 }) };
  }
  const date = url.searchParams.get('date') ?? undefined;
  if (view === 'date' && (!date || !isValidDate(date))) {
    return { ok: false, response: Response.json({ error: 'date must be YYYY-MM-DD.', retryable: false }, { status: 400 }) };
  }
  return { ok: true, request: { view, date, refresh: url.searchParams.get('refresh') === '1' } };
}
