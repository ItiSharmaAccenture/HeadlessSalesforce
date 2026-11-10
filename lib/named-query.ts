/**
 * The ADTTechnicianAppointments Named Query, configured in Salesforce Setup:
 *
 *   GET /services/data/v68.0/named/query/ADTTechnicianAppointments
 *       ?serviceresourceid=…&startutc=…&endutc=…
 *
 * It selects from AssignedResource, so one appointment can appear more than
 * once (several assignment rows); results are deduplicated here. It also has
 * LIMIT 100, so a full page is treated as possibly incomplete and the total is
 * confirmed with a separate COUNT() query.
 *
 * The caller must pass a ServiceResource id resolved on the server. A browser
 * never chooses whose appointments are read.
 */

import 'server-only';

import { API_VERSION, isSalesforceId, sfGet, soql, soqlString } from './salesforce-rest';
import type { DashboardAppointment } from '@/types/dashboard';

export const NAMED_QUERY = 'ADTTechnicianAppointments';
export const NAMED_QUERY_LIMIT = 100;

type Raw = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Reads `ServiceAppointment.Field` whether Salesforce nested the relationship
 * (`{ ServiceAppointment: { Field } }`, the REST query shape) or flattened it
 * (`{ "ServiceAppointment.Field": … }`).
 */
function field(record: Raw, name: string): unknown {
  const nested = record.ServiceAppointment;
  if (nested && typeof nested === 'object' && name in (nested as Raw)) return (nested as Raw)[name];
  return record[`ServiceAppointment.${name}`];
}

/** Finds the record array in a Named Query response without assuming its envelope. */
export function extractRecords(body: unknown): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  if (body && typeof body === 'object') {
    for (const key of ['records', 'data', 'results']) {
      const value = (body as Raw)[key];
      if (Array.isArray(value)) return value as Raw[];
    }
  }
  return [];
}

export function normaliseRecord(record: Raw): DashboardAppointment | null {
  const id = str(record.ServiceAppointmentId) ?? str(field(record, 'Id'));
  if (!id) return null;
  return {
    id,
    appointmentNumber: str(field(record, 'AppointmentNumber')),
    subject: str(field(record, 'Subject')),
    status: str(field(record, 'Status')),
    scheduledStart: str(field(record, 'SchedStartTime')),
    scheduledEnd: str(field(record, 'SchedEndTime')),
    customerName: null,
    address: {
      street: str(field(record, 'Street')),
      city: str(field(record, 'City')),
      state: str(field(record, 'State')),
      postalCode: str(field(record, 'PostalCode')),
      country: str(field(record, 'Country')),
    },
    latitude: num(field(record, 'Latitude')),
    longitude: num(field(record, 'Longitude')),
  };
}

/** Deduplicates by ServiceAppointmentId and sorts by scheduled start (unscheduled last). */
export function normaliseAppointments(records: Raw[]): DashboardAppointment[] {
  const byId = new Map<string, DashboardAppointment>();
  for (const record of records) {
    const appointment = normaliseRecord(record);
    if (appointment && !byId.has(appointment.id)) byId.set(appointment.id, appointment);
  }
  return [...byId.values()].sort((a, b) => {
    if (!a.scheduledStart) return 1;
    if (!b.scheduledStart) return -1;
    return a.scheduledStart.localeCompare(b.scheduledStart);
  });
}

export interface NamedQueryResult {
  appointments: DashboardAppointment[];
  /** Raw rows returned (before deduplication). */
  rowCount: number;
  /** The query returned a full page, so more rows may exist. */
  possiblyTruncated: boolean;
}

export async function runTechnicianAppointments(serviceResourceId: string, startUtc: string, endUtc: string): Promise<NamedQueryResult> {
  if (!isSalesforceId(serviceResourceId)) throw new Error('Invalid ServiceResource id');

  // Exact lowercase parameter names, as shown in the Named Query API setup page.
  const params = new URLSearchParams({ serviceresourceid: serviceResourceId, startutc: startUtc, endutc: endUtc });
  const body = await sfGet<unknown>(`/services/data/v${API_VERSION}/named/query/${NAMED_QUERY}?${params}`);
  const records = extractRecords(body);
  return {
    appointments: normaliseAppointments(records),
    rowCount: records.length,
    possiblyTruncated: records.length >= NAMED_QUERY_LIMIT,
  };
}

const FALLBACK_FIELDS = [
  'ServiceAppointmentId',
  'ServiceAppointment.AppointmentNumber',
  'ServiceAppointment.Subject',
  'ServiceAppointment.Status',
  'ServiceAppointment.SchedStartTime',
  'ServiceAppointment.SchedEndTime',
  'ServiceAppointment.Street',
  'ServiceAppointment.City',
  'ServiceAppointment.State',
  'ServiceAppointment.PostalCode',
  'ServiceAppointment.Country',
  'ServiceAppointment.Latitude',
  'ServiceAppointment.Longitude',
];

function whereClause(serviceResourceId: string, startUtc: string, endUtc: string): string {
  // Datetime literals are unquoted in SOQL; both values are generated server-side.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startUtc) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(endUtc)) {
    throw new Error('Invalid datetime boundary');
  }
  return (
    `WHERE ServiceResourceId = ${soqlString(serviceResourceId)} ` +
    `AND ServiceAppointment.SchedStartTime >= ${startUtc} AND ServiceAppointment.SchedStartTime < ${endUtc}`
  );
}

/**
 * Documented fallback: the same query through the standard REST Query API.
 * Only used when ADT_APPOINTMENT_SOURCE=rest_query is set explicitly, so a
 * Named Query permission problem is never silently bypassed.
 */
export async function runTechnicianAppointmentsViaQuery(
  serviceResourceId: string,
  startUtc: string,
  endUtc: string,
): Promise<NamedQueryResult> {
  if (!isSalesforceId(serviceResourceId)) throw new Error('Invalid ServiceResource id');
  const result = await soql<Raw>(
    `SELECT ${FALLBACK_FIELDS.join(', ')} FROM AssignedResource ${whereClause(serviceResourceId, startUtc, endUtc)} ` +
      `ORDER BY ServiceAppointment.SchedStartTime ASC LIMIT ${NAMED_QUERY_LIMIT}`,
  );
  return {
    appointments: normaliseAppointments(result.records),
    rowCount: result.records.length,
    possiblyTruncated: result.records.length >= NAMED_QUERY_LIMIT,
  };
}

/**
 * Distinct appointment count for a truncated page. COUNT_DISTINCT is not
 * available on a lookup in every org, so this counts assignment rows, which is
 * an upper bound on distinct appointments; the caller labels it accordingly.
 */
export async function countAssignments(serviceResourceId: string, startUtc: string, endUtc: string): Promise<number> {
  const result = await soql<never>(`SELECT COUNT() FROM AssignedResource ${whereClause(serviceResourceId, startUtc, endUtc)}`);
  return result.totalSize;
}
