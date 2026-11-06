/**
 * Shared types for the ADT Copilot widget on /my-day and its API routes.
 *
 * Imported from both server and client code, so nothing here may touch secrets
 * or server-only modules.
 */

/**
 * One service appointment exactly as FSTechAppointmentAction returned it. Every
 * field is optional because the Apex action, not this app, owns the shape; the
 * detail view renders whatever keys actually arrive.
 */
export interface Appointment {
  appointmentNumber: string;
  appointmentId?: string;
  subject?: string;
  status?: string;
  appointmentDate?: string;
  scheduledWindow?: string;
  arrivalWindow?: string;
  schedStartTime?: string;
  schedEndTime?: string;
  accountName?: string;
  address?: string;
  description?: string;
  ownerName?: string;
  parentRecordName?: string;
  [field: string]: string | undefined;
}

/** Context that came back with an appointment lookup. */
export interface ScheduleMeta {
  technicianName: string;
  /** IANA zone of the technician, as reported by Salesforce. */
  timeZone?: string;
  /** "Thu, Nov 5, 2026 11:51 PM" in the technician's zone. */
  currentDateTime?: string;
}

/** Status changes the widget can request. Which ones work depends on the org. */
export type StatusAction = 'on_my_way' | 'start' | 'complete' | 'cannot_complete' | 'cancel';

export const STATUS_ACTION_LABELS: Record<StatusAction, string> = {
  on_my_way: 'On my way',
  start: 'Start',
  complete: 'Mark completed',
  cannot_complete: 'Cannot complete',
  cancel: 'Cancel appointment',
};

/** These end the job, so the widget asks before sending them. */
export const CONFIRM_ACTIONS: readonly StatusAction[] = ['complete', 'cannot_complete', 'cancel'];

/** GET /api/copilot */
export interface CopilotCapabilities {
  /** Status actions the connected Salesforce tools can actually perform. */
  actions: StatusAction[];
}

/** POST /api/copilot */
export interface CopilotChatRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** GET /api/copilot/appointments/[number] */
export interface AppointmentDetailResponse {
  appointment: Appointment;
  meta: ScheduleMeta;
  /** False when Salesforce no longer lists it and this is the last known copy. */
  live: boolean;
  /** Record page in the org, when the instance URL is known. */
  salesforceUrl?: string;
  note?: string;
}

/** POST /api/copilot/appointments/[number] */
export interface StatusUpdateRequest {
  action: StatusAction;
}

export interface StatusUpdateResponse extends AppointmentDetailResponse {
  /** What Salesforce said about the change. */
  message: string;
  status: string;
}

export interface CopilotErrorBody {
  error: string;
  retryable: boolean;
}

/** SSE events streamed by POST /api/copilot. */
export type CopilotEvent =
  | { type: 'progress'; label: string }
  | { type: 'delta'; text: string }
  /** Withdraws text streamed so far: it was a preamble to a tool call. */
  | { type: 'reset' }
  | { type: 'appointments'; appointments: Appointment[]; meta: ScheduleMeta }
  | { type: 'done' }
  | { type: 'error'; message: string; retryable: boolean };
