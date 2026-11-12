/**
 * GET /api/appointments/[id]/account — the customer account behind one
 * appointment: address, contacts and property details.
 *
 * Nested under the appointment because that is where the technician's claim
 * comes from: `getAccountSummary` re-checks AssignedResource before reading
 * anything, so an account id cannot be supplied from the browser. Read-only.
 */

import { getAccountSummary } from '@/lib/dashboard';
import { authorize, NO_STORE } from '@/lib/dashboard-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/api/appointments/[id]/account'>): Promise<Response> {
  const auth = await authorize();
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const result = await getAccountSummary(auth.serviceResourceId, id);
  const status = result.status === 'ok' ? 200 : result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 200;
  return Response.json(result, { status, headers: NO_STORE });
}
