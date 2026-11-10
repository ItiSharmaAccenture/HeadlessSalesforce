/**
 * GET /api/appointments/[id] — the appointment workspace: overview, customer,
 * work order, line items, required parts and van inventory.
 *
 * The id is checked against AssignedResource for the session's ServiceResource
 * before anything else is read, so a technician cannot open someone else's job
 * by editing the URL. Read-only.
 */

import { getAppointmentWorkspace } from '@/lib/dashboard';
import { authorize, NO_STORE } from '@/lib/dashboard-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/appointments/[id]'>): Promise<Response> {
  const auth = await authorize();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const result = await getAppointmentWorkspace(auth.serviceResourceId, id);
  const status = result.status === 'ok' ? 200 : result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 200;
  return Response.json(result, { status, headers: NO_STORE });
}
