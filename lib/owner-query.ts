/**
 * Owner-based appointment source (ADT_APPOINTMENT_SOURCE=owner_query).
 *
 * In this org appointments are linked to a technician by Owner, not by
 * AssignedResource, so the ADTTechnicianAppointments Named Query finds none.
 * This runs the agreed query through the standard REST Query API:
 *
 *   SELECT Id, Status, Owner.Name, AppointmentNumber, Subject, Description,
 *          Address, Account.Name, ParentRecord.Name, SchedStartTime, SchedEndTime
 *   FROM ServiceAppointment
 *   WHERE Owner.Name LIKE :technicianName AND Status = 'Scheduled'
 *   ORDER BY SchedStartTime ASC LIMIT 50
 *
 * with two additions the dashboard needs:
 *   - a SchedStartTime range, so Today / Week / a chosen date work;
 *   - OwnerId = the technician's user Id, so two users sharing a name can
 *     never see each other's jobs.
 *
 * The technician name and user Id come from the mapped ServiceResource's
 * related User on the server — never from the browser.
 */

import 'server-only';

import { isSalesforceId, soql, soqlString } from './salesforce-rest';
import type { NamedQueryResult } from './named-query';
import type { DashboardAppointment } from '@/types/dashboard';

export const OWNER_QUERY_LIMIT = 50;

export interface AppointmentOwner {
  userId: string;
  name: string;
}

type Raw = Record<string, unknown>;

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A LIKE literal that matches the name exactly: quotes, backslashes and wildcards escaped. */
export function likeExact(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `'${escaped}'`;
}

export function ownerWhere(owner: AppointmentOwner, startUtc: string, endUtc: string): string {
  if (!isSalesforceId(owner.userId, '005')) throw new Error('Invalid owner user id');
  if (!DATETIME.test(startUtc) || !DATETIME.test(endUtc)) throw new Error('Invalid datetime boundary');
  return (
    `WHERE Owner.Name LIKE ${likeExact(owner.name)} AND OwnerId = ${soqlString(owner.userId)} ` +
    `AND Status = 'Scheduled' AND SchedStartTime >= ${startUtc} AND SchedStartTime < ${endUtc}`
  );
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Maps one ServiceAppointment row, reading the compound Address field. */
export function normaliseOwnerRecord(row: Raw): DashboardAppointment | null {
  const id = str(row.Id);
  if (!id) return null;
  const address = (row.Address && typeof row.Address === 'object' ? row.Address : {}) as Raw;
  const account = (row.Account && typeof row.Account === 'object' ? row.Account : {}) as Raw;
  return {
    id,
    appointmentNumber: str(row.AppointmentNumber),
    subject: str(row.Subject),
    status: str(row.Status),
    scheduledStart: str(row.SchedStartTime),
    scheduledEnd: str(row.SchedEndTime),
    customerName: str(account.Name),
    address: {
      street: str(address.street),
      city: str(address.city),
      state: str(address.state),
      postalCode: str(address.postalCode),
      country: str(address.country),
    },
    latitude: num(address.latitude),
    longitude: num(address.longitude),
  };
}

export async function runOwnerAppointments(owner: AppointmentOwner, startUtc: string, endUtc: string): Promise<NamedQueryResult> {
  const result = await soql<Raw>(
    'SELECT Id, Status, Owner.Name, AppointmentNumber, Subject, Description, Address, Account.Name, ParentRecord.Name, ' +
      `SchedStartTime, SchedEndTime FROM ServiceAppointment ${ownerWhere(owner, startUtc, endUtc)} ` +
      `ORDER BY SchedStartTime ASC LIMIT ${OWNER_QUERY_LIMIT}`,
  );
  const appointments = result.records.map(normaliseOwnerRecord).filter((a): a is DashboardAppointment => a !== null);
  return { appointments, rowCount: result.records.length, possiblyTruncated: result.records.length >= OWNER_QUERY_LIMIT };
}

export async function countOwnerAppointments(owner: AppointmentOwner, startUtc: string, endUtc: string): Promise<number> {
  return (await soql<never>(`SELECT COUNT() FROM ServiceAppointment ${ownerWhere(owner, startUtc, endUtc)}`)).totalSize;
}

/** True when the appointment is owned by the technician's user. */
export async function isOwnedBy(owner: AppointmentOwner, appointmentId: string): Promise<boolean> {
  if (!isSalesforceId(appointmentId, '08p') || !isSalesforceId(owner.userId, '005')) return false;
  const result = await soql<Raw>(
    `SELECT Id FROM ServiceAppointment WHERE Id = ${soqlString(appointmentId)} AND OwnerId = ${soqlString(owner.userId)} LIMIT 1`,
  );
  return result.records.length > 0;
}
