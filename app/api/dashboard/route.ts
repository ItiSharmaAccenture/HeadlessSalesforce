/**
 * GET /api/dashboard?view=today|week|date[&date=YYYY-MM-DD][&refresh=1]
 *
 * The technician's appointments from the ADTTechnicianAppointments Named Query,
 * scoped to the ServiceResource in their signed session. Direct Salesforce
 * REST only — no Gemini, no MCP — and read-only.
 */

import { getDashboard } from '@/lib/dashboard';
import { authorize, NO_STORE, parseView } from '@/lib/dashboard-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize();
  if (!auth.ok) return auth.response;

  const parsed = parseView(new URL(request.url));
  if (!parsed.ok) return parsed.response;

  return Response.json(await getDashboard(auth.serviceResourceId, parsed.request), { headers: NO_STORE });
}
