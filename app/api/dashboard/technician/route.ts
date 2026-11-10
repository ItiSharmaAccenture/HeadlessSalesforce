/**
 * GET /api/dashboard/technician — the signed-in technician's ServiceResource
 * profile (name, territory, skills, time zone), from Salesforce REST.
 * Fields an org does not have are returned as null, never invented.
 */

import { getTechnicianProfile } from '@/lib/dashboard';
import { authorize, NO_STORE } from '@/lib/dashboard-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize();
  if (!auth.ok) return auth.response;

  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  return Response.json(await getTechnicianProfile(auth.serviceResourceId, refresh), { headers: NO_STORE });
}
