/**
 * One of the technician's appointments, live from Salesforce.
 *
 * GET  — every field the appointment action returns, for the Copilot detail view.
 * POST — `{ action }`: changes its status, then returns the re-read appointment.
 */

import { describeFailure, getAppointmentDetail, updateAppointmentStatus } from '@/lib/copilot';
import { STATUS_ACTION_LABELS, type StatusAction } from '@/types/copilot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failed(error: unknown): Response {
  const failure = describeFailure(error);
  return Response.json({ error: failure.message, retryable: failure.retryable }, { status: failure.status });
}

export async function GET(_request: Request, ctx: RouteContext<'/api/copilot/appointments/[number]'>): Promise<Response> {
  const { number } = await ctx.params;
  try {
    return Response.json(await getAppointmentDetail(number));
  } catch (error) {
    return failed(error);
  }
}

export async function POST(request: Request, ctx: RouteContext<'/api/copilot/appointments/[number]'>): Promise<Response> {
  const { number } = await ctx.params;

  let action: unknown;
  try {
    action = ((await request.json()) as { action?: unknown })?.action;
  } catch {
    return Response.json({ error: 'The request body was not valid JSON.', retryable: false }, { status: 400 });
  }
  if (typeof action !== 'string' || !(action in STATUS_ACTION_LABELS)) {
    return Response.json({ error: 'Unknown status action.', retryable: false }, { status: 400 });
  }

  try {
    return Response.json(await updateAppointmentStatus(number, action as StatusAction));
  } catch (error) {
    return failed(error);
  }
}
