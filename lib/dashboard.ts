/**
 * My Day dashboard data, straight from Salesforce REST.
 *
 *   browser → /api/dashboard → this module → Named Query / REST query → JSON
 *
 * No Gemini, no MCP. Every function takes a ServiceResource id that the caller
 * read from the signed session; nothing here accepts one from the browser.
 * All calls are GETs, so loading the dashboard can never write to Salesforce.
 */

import 'server-only';

import { log } from './logger';
import {
  countAssignments,
  NAMED_QUERY,
  runTechnicianAppointments,
  runTechnicianAppointmentsViaQuery,
  type NamedQueryResult,
} from './named-query';
import { countOwnerAppointments, isOwnedBy, runOwnerAppointments, type AppointmentOwner } from './owner-query';
import { describeFields, isSalesforceId, pickFields, SalesforceRestError, soql, soqlString } from './salesforce-rest';
import { isValidDate, isValidTimeZone, localDate, rangeFor, startOfWeek } from './time-range';
import type {
  AppointmentWorkspaceResult,
  DashboardAppointment,
  DashboardResult,
  DashboardView,
  Section,
  TechnicianProfile,
  TechnicianProfileResult,
  Unavailable,
} from '@/types/dashboard';

type Raw = Record<string, unknown>;

const APPOINTMENT_TTL_MS = 60_000;
const PROFILE_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------------ */
/* Errors → honest unavailable states                                  */
/* ------------------------------------------------------------------ */

const SCOPE_HINT =
  'In Setup → External Client App Manager → (this app) → OAuth Settings, add the scope "Manage user data via APIs (api)". ' +
  'Add "api" to SALESFORCE_SCOPES in the environment, then re-run the one-time authorization ' +
  '(/api/auth/salesforce?secret=…) so a new token with that scope is issued.';

export function toUnavailable(error: unknown, context: 'named_query' | 'query' = 'query'): Unavailable {
  if (error instanceof SalesforceRestError) {
    switch (error.code) {
      case 'missing_api_scope':
        return { status: 'unavailable', code: 'missing_api_scope', message: error.message, adminHint: SCOPE_HINT };
      case 'not_authorized':
        return {
          status: 'unavailable',
          code: 'not_authorized',
          message: error.message,
          adminHint: 'Re-run the one-time Salesforce authorization from the setup route.',
        };
      case 'not_found':
        return context === 'named_query'
          ? {
              status: 'unavailable',
              code: 'named_query_unavailable',
              message: `Salesforce returned 404 for the Named Query ${NAMED_QUERY}: ${error.message}`,
              adminHint: `Check that ${NAMED_QUERY} is saved (not only validated) in Setup → Named Query API, and that its API name and version match.`,
            }
          : { status: 'unavailable', code: 'not_found', message: error.message };
      case 'forbidden':
        return context === 'named_query'
          ? {
              status: 'unavailable',
              code: 'named_query_unavailable',
              message: `Salesforce refused the Named Query ${NAMED_QUERY} (HTTP 403${error.sfErrorCode ? `, ${error.sfErrorCode}` : ''}): ${error.message}`,
              adminHint:
                'Grant the integration user permission to run Named Queries and read access to AssignedResource and ServiceAppointment. ' +
                'Do not grant broader permissions than that.',
            }
          : { status: 'unavailable', code: 'forbidden', message: error.message };
      default:
        return {
          status: 'unavailable',
          code: context === 'named_query' ? 'named_query_unavailable' : 'salesforce_error',
          message: `Salesforce error${error.httpStatus ? ` (HTTP ${error.httpStatus}${error.sfErrorCode ? `, ${error.sfErrorCode}` : ''})` : ''}: ${error.message}`,
        };
    }
  }
  log.error('dashboard', 'Unexpected dashboard failure', { message: (error as Error)?.message });
  return { status: 'unavailable', code: 'salesforce_error', message: 'Salesforce data could not be loaded.' };
}

export const NOT_MAPPED: Unavailable = {
  status: 'unavailable',
  code: 'not_mapped',
  message: 'Your sign-in is not linked to a Salesforce Service Resource, so no appointments can be shown.',
  adminHint:
    'Set ADT_DEMO_MODE=true and add this technician ID to ADT_TECHNICIAN_DIRECTORY with their ServiceResource Id, then sign in again.',
};

/* ------------------------------------------------------------------ */
/* Small per-user caches                                               */
/* ------------------------------------------------------------------ */

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

function cached<T>(store: Map<string, CacheEntry<T>>, key: string, ttl: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load();
  store.set(key, { at: Date.now(), value });
  // A failure must not be served from cache.
  value.catch(() => store.delete(key));
  if (store.size > 500) store.delete(store.keys().next().value as string);
  return value;
}

type Source = 'named_query' | 'rest_query' | 'owner_query';
const appointmentCache = new Map<string, CacheEntry<NamedQueryResult & { source: Source }>>();
const profileCache = new Map<string, CacheEntry<TechnicianProfile>>();

/* ------------------------------------------------------------------ */
/* Technician profile                                                  */
/* ------------------------------------------------------------------ */

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function rel(record: Raw, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Raw)[key] : undefined), record);
}

async function loadProfile(serviceResourceId: string): Promise<TechnicianProfile> {
  const available = await describeFields('ServiceResource');
  const fields = pickFields(available, [
    'Id', 'Name', 'IsActive', 'ResourceType', 'RelatedRecordId', 'RelatedRecord.Name', 'RelatedRecord.TimeZoneSidKey', 'LocationId',
  ]);
  const result = await soql<Raw>(`SELECT ${fields.join(', ')} FROM ServiceResource WHERE Id = ${soqlString(serviceResourceId)} LIMIT 1`);
  const record = result.records[0];
  if (!record) throw new SalesforceRestError(`ServiceResource ${serviceResourceId} was not found or is not visible.`, 'not_found', 404);

  const [territories, skills] = await Promise.all([
    soql<Raw>(
      `SELECT ServiceTerritory.Name FROM ServiceTerritoryMember WHERE ServiceResourceId = ${soqlString(serviceResourceId)} ` +
        `AND (EffectiveEndDate = null OR EffectiveEndDate > TODAY) LIMIT 10`,
    )
      .then((r) => r.records.map((row) => str(rel(row, 'ServiceTerritory.Name'))).filter((name): name is string => Boolean(name)))
      .catch(() => null),
    soql<Raw>(
      `SELECT Skill.MasterLabel, SkillLevel FROM ServiceResourceSkill WHERE ServiceResourceId = ${soqlString(serviceResourceId)} ` +
        `AND (EffectiveEndDate = null OR EffectiveEndDate > TODAY) LIMIT 20`,
    )
      .then((r) =>
        r.records
          .map((row) => ({ name: str(rel(row, 'Skill.MasterLabel')) ?? '', level: typeof row.SkillLevel === 'number' ? row.SkillLevel : null }))
          .filter((skill) => skill.name),
      )
      .catch(() => null),
  ]);

  const zone = str(rel(record, 'RelatedRecord.TimeZoneSidKey'));
  return {
    status: 'ok',
    serviceResourceId,
    name: str(record.Name),
    userId: str(record.RelatedRecordId),
    userName: str(rel(record, 'RelatedRecord.Name')),
    isActive: typeof record.IsActive === 'boolean' ? record.IsActive : null,
    resourceType: str(record.ResourceType),
    timezone: zone && isValidTimeZone(zone) ? zone : null,
    territories,
    skills,
    // Salesforce has no standard duty-status field on ServiceResource.
    dutyStatus: null,
    locationId: str(record.LocationId),
  };
}

export async function getTechnicianProfile(serviceResourceId: string, refresh = false): Promise<TechnicianProfileResult> {
  try {
    return await cached(profileCache, serviceResourceId, PROFILE_TTL_MS, refresh, () => loadProfile(serviceResourceId));
  } catch (error) {
    return toUnavailable(error);
  }
}

export function defaultTimeZone(): string {
  const configured = process.env.ADT_DEFAULT_TIMEZONE;
  return configured && isValidTimeZone(configured) ? configured : 'America/Chicago';
}

/* ------------------------------------------------------------------ */
/* Appointments                                                        */
/* ------------------------------------------------------------------ */

function appointmentSource(): Source {
  const configured = process.env.ADT_APPOINTMENT_SOURCE;
  return configured === 'rest_query' || configured === 'owner_query' ? configured : 'named_query';
}

/** The ServiceResource's related User, for the owner-based source. Resolved server-side only. */
async function resolveOwner(serviceResourceId: string): Promise<AppointmentOwner> {
  const profile = await getTechnicianProfile(serviceResourceId);
  if (profile.status !== 'ok') throw new SalesforceRestError(profile.message, 'salesforce_error');
  if (!profile.userId || !profile.userName) {
    throw new SalesforceRestError(
      `ServiceResource ${serviceResourceId} has no related User, so appointments cannot be matched by owner.`,
      'not_found',
    );
  }
  return { userId: profile.userId, name: profile.userName };
}

function loadAppointments(serviceResourceId: string, startUtc: string, endUtc: string, refresh: boolean) {
  const source = appointmentSource();
  return cached(appointmentCache, `${serviceResourceId}|${startUtc}|${endUtc}|${source}`, APPOINTMENT_TTL_MS, refresh, async () => {
    const result =
      source === 'owner_query'
        ? await runOwnerAppointments(await resolveOwner(serviceResourceId), startUtc, endUtc)
        : source === 'rest_query'
          ? await runTechnicianAppointmentsViaQuery(serviceResourceId, startUtc, endUtc)
          : await runTechnicianAppointments(serviceResourceId, startUtc, endUtc);
    return { ...result, source };
  });
}

/** Adds the customer (Account) name, which the Named Query does not select. */
async function enrichCustomers(appointments: DashboardAppointment[]): Promise<'ok' | 'unavailable'> {
  const ids = appointments.map((appointment) => appointment.id).filter((id) => isSalesforceId(id));
  if (ids.length === 0) return 'ok';
  try {
    const available = await describeFields('ServiceAppointment');
    if (!available.has('AccountId')) return 'unavailable';
    const result = await soql<Raw>(`SELECT Id, Account.Name FROM ServiceAppointment WHERE Id IN (${ids.map(soqlString).join(', ')}) LIMIT 100`);
    const names = new Map(result.records.map((row) => [String(row.Id), str(rel(row, 'Account.Name'))]));
    for (const appointment of appointments) {
      // Ids from REST are 18 chars; compare on the 15-char prefix to be safe.
      const name = names.get(appointment.id) ?? [...names.entries()].find(([id]) => id.slice(0, 15) === appointment.id.slice(0, 15))?.[1];
      appointment.customerName = name ?? null;
    }
    return 'ok';
  } catch (error) {
    log.warn('dashboard', 'Customer lookup failed', { code: (error as SalesforceRestError).code });
    return 'unavailable';
  }
}

async function countIfTruncated(
  result: NamedQueryResult,
  serviceResourceId: string,
  startUtc: string,
  endUtc: string,
): Promise<{ verifiedTotal: number | null; lowerBound: boolean }> {
  if (!result.possiblyTruncated) return { verifiedTotal: null, lowerBound: false };
  try {
    const total =
      appointmentSource() === 'owner_query'
        ? await countOwnerAppointments(await resolveOwner(serviceResourceId), startUtc, endUtc)
        : await countAssignments(serviceResourceId, startUtc, endUtc);
    return { verifiedTotal: total, lowerBound: false };
  } catch {
    return { verifiedTotal: null, lowerBound: true };
  }
}

export interface DashboardRequest {
  view: DashboardView;
  /** Required for view=date. */
  date?: string;
  refresh?: boolean;
}

export async function getDashboard(serviceResourceId: string, request: DashboardRequest): Promise<DashboardResult> {
  const profile = await getTechnicianProfile(serviceResourceId, request.refresh);
  const timezone = profile.status === 'ok' && profile.timezone ? profile.timezone : defaultTimeZone();
  const timezoneSource = profile.status === 'ok' && profile.timezone ? 'salesforce_user' : 'server_default';

  const today = localDate(Date.now(), timezone);
  let start = today;
  let days = 1;
  if (request.view === 'week') {
    start = startOfWeek(today);
    days = 7;
  } else if (request.view === 'date') {
    if (!request.date || !isValidDate(request.date)) {
      return { status: 'unavailable', code: 'salesforce_error', message: 'Choose a valid date (YYYY-MM-DD).' };
    }
    start = request.date;
  }
  const range = rangeFor(start, days, timezone);

  let result: NamedQueryResult & { source: Source };
  try {
    result = await loadAppointments(serviceResourceId, range.startUtc, range.endUtc, Boolean(request.refresh));
  } catch (error) {
    // A missing scope is the root cause for every call, so report that rather than a Named Query problem.
    return toUnavailable(error, appointmentSource() === 'named_query' ? 'named_query' : 'query');
  }

  // Copies, so enrichment never mutates the cached page.
  const appointments = result.appointments.map((appointment) => ({ ...appointment, address: { ...appointment.address } }));
  const [customerLookup, completeness, todayStats] = await Promise.all([
    // The owner query already selects Account.Name.
    result.source === 'owner_query' ? Promise.resolve('ok' as const) : enrichCustomers(appointments),
    countIfTruncated(result, serviceResourceId, range.startUtc, range.endUtc),
    (async () => {
      if (request.view === 'today' || (request.view === 'date' && start === today)) return null;
      const todayRange = rangeFor(today, 1, timezone);
      try {
        const todayResult = await loadAppointments(serviceResourceId, todayRange.startUtc, todayRange.endUtc, Boolean(request.refresh));
        const check = await countIfTruncated(todayResult, serviceResourceId, todayRange.startUtc, todayRange.endUtc);
        return { count: check.verifiedTotal ?? todayResult.appointments.length, lowerBound: check.lowerBound };
      } catch {
        return { count: null, lowerBound: false };
      }
    })(),
  ]);

  const appointmentCount = completeness.verifiedTotal ?? appointments.length;
  return {
    status: 'ok',
    technician: { serviceResourceId, name: profile.status === 'ok' ? (profile.userName ?? profile.name) : null },
    view: request.view,
    date: range.startDate,
    endDate: range.endDate,
    timezone,
    timezoneSource,
    rangeUtc: { start: range.startUtc, end: range.endUtc },
    appointmentCount,
    countIsLowerBound: completeness.lowerBound,
    verifiedTotal: completeness.verifiedTotal,
    jobsToday: todayStats === null ? appointmentCount : todayStats.count,
    jobsTodayIsLowerBound: todayStats === null ? completeness.lowerBound : todayStats.lowerBound,
    appointments,
    customerLookup,
    source: result.source,
    fetchedAt: new Date().toISOString(),
  };
}

/** Today's appointments for the route endpoint; shares the dashboard cache. */
export async function getAppointmentsForView(
  serviceResourceId: string,
  request: DashboardRequest,
): Promise<{ ok: true; appointments: DashboardAppointment[] } | { ok: false; unavailable: Unavailable }> {
  const dashboard = await getDashboard(serviceResourceId, { ...request, refresh: false });
  if (dashboard.status !== 'ok') return { ok: false, unavailable: dashboard };
  return { ok: true, appointments: dashboard.appointments };
}

/* ------------------------------------------------------------------ */
/* Authorization of a single appointment                               */
/* ------------------------------------------------------------------ */

/**
 * True only when the appointment is assigned to this ServiceResource. Every
 * per-appointment read (detail view, Copilot context) goes through this.
 */
export async function isAssignedTo(serviceResourceId: string, appointmentId: string): Promise<boolean> {
  if (!isSalesforceId(serviceResourceId) || !isSalesforceId(appointmentId, '08p')) return false;
  // Owner-based orgs have no AssignedResource rows; ownership is the link there.
  if (appointmentSource() === 'owner_query') return isOwnedBy(await resolveOwner(serviceResourceId), appointmentId);
  const result = await soql<Raw>(
    `SELECT Id FROM AssignedResource WHERE ServiceAppointmentId = ${soqlString(appointmentId)} ` +
      `AND ServiceResourceId = ${soqlString(serviceResourceId)} LIMIT 1`,
  );
  return result.records.length > 0;
}

/* ------------------------------------------------------------------ */
/* Appointment workspace                                               */
/* ------------------------------------------------------------------ */

function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  return load()
    .then((data) => ({ status: 'ok' as const, data }))
    .catch((error) => toUnavailable(error));
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function getAppointmentWorkspace(serviceResourceId: string, appointmentId: string): Promise<AppointmentWorkspaceResult> {
  if (!isSalesforceId(appointmentId, '08p')) {
    return { status: 'unavailable', code: 'not_found', message: 'That is not a service appointment id.' };
  }

  try {
    if (!(await isAssignedTo(serviceResourceId, appointmentId))) {
      return { status: 'unavailable', code: 'forbidden', message: 'This appointment is not assigned to you.' };
    }
  } catch (error) {
    return toUnavailable(error);
  }

  let record: Raw;
  try {
    const available = await describeFields('ServiceAppointment');
    const fields = pickFields(available, [
      'Id', 'AppointmentNumber', 'Subject', 'Status', 'Description', 'SchedStartTime', 'SchedEndTime',
      'ArrivalWindowStartTime', 'ArrivalWindowEndTime', 'Street', 'City', 'State', 'PostalCode', 'Country',
      'Latitude', 'Longitude', 'ParentRecordId', 'ParentRecordType', 'WorkType.Name',
      'Account.Name', 'Account.Phone', 'Contact.Name', 'Contact.Phone',
    ]);
    const result = await soql<Raw>(`SELECT ${fields.join(', ')} FROM ServiceAppointment WHERE Id = ${soqlString(appointmentId)} LIMIT 1`);
    if (!result.records[0]) return { status: 'unavailable', code: 'not_found', message: 'The appointment was not found.' };
    record = result.records[0];
  } catch (error) {
    return toUnavailable(error);
  }

  const parentId = str(record.ParentRecordId);
  const workOrderId = parentId && (str(record.ParentRecordType) === 'WorkOrder' || parentId.startsWith('0WO')) ? parentId : null;

  const workOrder = await section(async () => {
    if (!workOrderId) return null;
    const result = await soql<Raw>(
      `SELECT Id, WorkOrderNumber, Subject, Status, Priority, Description FROM WorkOrder WHERE Id = ${soqlString(workOrderId)} LIMIT 1`,
    );
    const row = result.records[0];
    return row
      ? { id: String(row.Id), number: str(row.WorkOrderNumber), subject: str(row.Subject), status: str(row.Status), priority: str(row.Priority), description: str(row.Description) }
      : null;
  });

  const [lineItems, parts] = await Promise.all([
    section(async () => {
      if (!workOrderId) return [];
      const result = await soql<Raw>(
        `SELECT LineItemNumber, Product2.Name, Quantity, Status FROM WorkOrderLineItem WHERE WorkOrderId = ${soqlString(workOrderId)} ORDER BY LineItemNumber LIMIT 50`,
      );
      return result.records.map((row) => ({
        lineItemNumber: str(row.LineItemNumber),
        productName: str(rel(row, 'Product2.Name')),
        quantity: numOrNull(row.Quantity),
        status: str(row.Status),
      }));
    }),
    section(async () => {
      if (!workOrderId) return [];
      const result = await soql<Raw>(
        `SELECT Product2Id, Product2.Name, QuantityRequired, QuantityUnitOfMeasure FROM ProductRequired WHERE ParentRecordId = ${soqlString(workOrderId)} LIMIT 50`,
      );
      return result.records.map((row) => ({
        productId: str(row.Product2Id),
        productName: str(rel(row, 'Product2.Name')),
        quantityRequired: numOrNull(row.QuantityRequired),
        unit: str(row.QuantityUnitOfMeasure),
      }));
    }),
  ]);

  const profile = await getTechnicianProfile(serviceResourceId);
  const locationId = profile.status === 'ok' ? profile.locationId : null;

  const inventory: Section<Array<{ productId: string | null; productName: string | null; required: number | null; onHand: number; missing: number }>> =
    parts.status !== 'ok'
      ? parts
      : !locationId
        ? {
            status: 'unavailable',
            code: 'not_found',
            message: 'No inventory location is linked to your Service Resource, so stock on hand cannot be checked.',
            adminHint: 'Set the Location field on the technician’s ServiceResource record to their van/stock location.',
          }
        : await section(async () => {
            const productIds = parts.data.map((part) => part.productId).filter((id): id is string => isSalesforceId(id));
            if (productIds.length === 0) return [];
            const result = await soql<Raw>(
              `SELECT Product2Id, QuantityOnHand FROM ProductItem WHERE LocationId = ${soqlString(locationId)} ` +
                `AND Product2Id IN (${productIds.map(soqlString).join(', ')}) LIMIT 100`,
            );
            const onHand = new Map<string, number>();
            for (const row of result.records) {
              const id = String(row.Product2Id);
              onHand.set(id, (onHand.get(id) ?? 0) + (numOrNull(row.QuantityOnHand) ?? 0));
            }
            return parts.data.map((part) => {
              const have = part.productId ? (onHand.get(part.productId) ?? 0) : 0;
              const required = part.quantityRequired;
              return { productId: part.productId, productName: part.productName, required, onHand: have, missing: Math.max(0, (required ?? 0) - have) };
            });
          });

  return {
    status: 'ok',
    appointment: {
      id: appointmentId,
      appointmentNumber: str(record.AppointmentNumber),
      subject: str(record.Subject),
      status: str(record.Status),
      scheduledStart: str(record.SchedStartTime),
      scheduledEnd: str(record.SchedEndTime),
      customerName: str(rel(record, 'Account.Name')),
      address: {
        street: str(record.Street),
        city: str(record.City),
        state: str(record.State),
        postalCode: str(record.PostalCode),
        country: str(record.Country),
      },
      latitude: numOrNull(record.Latitude),
      longitude: numOrNull(record.Longitude),
      description: str(record.Description),
      arrivalWindowStart: str(record.ArrivalWindowStartTime),
      arrivalWindowEnd: str(record.ArrivalWindowEndTime),
      workType: str(rel(record, 'WorkType.Name')),
    },
    customer: {
      status: 'ok',
      data: {
        accountName: str(rel(record, 'Account.Name')),
        accountPhone: str(rel(record, 'Account.Phone')),
        contactName: str(rel(record, 'Contact.Name')),
        contactPhone: str(rel(record, 'Contact.Phone')),
      },
    },
    workOrder,
    lineItems,
    parts,
    inventory,
  };
}

/** Lightweight lookup for Copilot context: number and subject of an authorized appointment. */
export async function describeAuthorizedAppointment(
  serviceResourceId: string,
  appointmentId: string,
): Promise<{ id: string; appointmentNumber: string | null; subject: string | null } | null> {
  try {
    if (!(await isAssignedTo(serviceResourceId, appointmentId))) return null;
    const result = await soql<Raw>(`SELECT Id, AppointmentNumber, Subject FROM ServiceAppointment WHERE Id = ${soqlString(appointmentId)} LIMIT 1`);
    const row = result.records[0];
    return row ? { id: appointmentId, appointmentNumber: str(row.AppointmentNumber), subject: str(row.Subject) } : null;
  } catch (error) {
    log.warn('dashboard', 'Copilot context could not be verified', { code: (error as SalesforceRestError).code });
    return null;
  }
}
