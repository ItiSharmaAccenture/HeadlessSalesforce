/**
 * GET /api/dashboard/route?view=today|week|date[&date=YYYY-MM-DD]
 *
 * Driving route through the period's appointments in scheduled order, from the
 * routing provider. Reuses the dashboard's cached appointment page, so it does
 * not trigger another Named Query call. Loaded separately so the timeline never
 * waits for routing.
 */

import { getAppointmentsForView } from '@/lib/dashboard';
import { authorize, NO_STORE, parseView } from '@/lib/dashboard-http';
import { buildRoute, distanceUnit } from '@/lib/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize({ unit: distanceUnit(), stops: [], skipped: [], warnings: [] });
  if (!auth.ok) return auth.response;

  const parsed = parseView(new URL(request.url));
  if (!parsed.ok) return parsed.response;

  const loaded = await getAppointmentsForView(auth.serviceResourceId, parsed.request);
  if (!loaded.ok) {
    return Response.json({ ...loaded.unavailable, unit: distanceUnit(), stops: [], skipped: [], warnings: [] }, { headers: NO_STORE });
  }
  return Response.json(await buildRoute(loaded.appointments), { headers: NO_STORE });
}
