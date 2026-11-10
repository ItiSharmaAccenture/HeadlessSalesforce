/**
 * Server-side mapping from an application sign-in to a Salesforce ServiceResource.
 *
 * The app authenticates to Salesforce as ONE shared integration user, so
 * Salesforce cannot tell which technician is looking. That user is never
 * treated as the technician. Instead, a technician's dashboard is scoped to the
 * ServiceResource id configured for them here, on the server, and only after
 * they present the matching access code.
 *
 * This is the clearly-labelled DEMO mode the POC allows. It is off unless
 * ADT_DEMO_MODE=true, and a directory entry without an access code is ignored.
 * Replace it with a real identity provider (or per-technician Salesforce OAuth)
 * before production use.
 *
 *   ADT_DEMO_MODE=true
 *   ADT_TECHNICIAN_DIRECTORY=[{"technicianId":"TCH-7842","serviceResourceId":"0Hn…","accessCode":"…"}]
 */

import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { log } from './logger';
import { isSalesforceId } from './salesforce-rest';

export interface DirectoryEntry {
  technicianId: string;
  serviceResourceId: string;
  accessCode: string;
}

export function demoModeEnabled(): boolean {
  return process.env.ADT_DEMO_MODE === 'true';
}

let warned = false;

export function parseDirectory(raw: string | undefined): DirectoryEntry[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!warned) log.warn('technician-directory', 'ADT_TECHNICIAN_DIRECTORY is not valid JSON; no technicians are mapped');
    warned = true;
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: DirectoryEntry[] = [];
  for (const item of parsed) {
    const { technicianId, serviceResourceId, accessCode } = (item ?? {}) as Record<string, unknown>;
    if (typeof technicianId !== 'string' || !technicianId.trim()) continue;
    if (!isSalesforceId(serviceResourceId, '0Hn')) continue;
    // No access code, no mapping: an entry anyone could claim would expose that technician's customers.
    if (typeof accessCode !== 'string' || accessCode.length < 4) continue;
    entries.push({ technicianId: technicianId.trim(), serviceResourceId, accessCode });
  }
  return entries;
}

function directory(): DirectoryEntry[] {
  return demoModeEnabled() ? parseDirectory(process.env.ADT_TECHNICIAN_DIRECTORY) : [];
}

function sameSecret(a: string, b: string): boolean {
  // Hash first so lengths match and timing does not reveal the code's length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type MappingOutcome =
  | { mapped: true; serviceResourceId: string }
  | { mapped: false; reason: 'demo_mode_off' | 'not_in_directory' | 'no_code' | 'wrong_code' };

/** Decides, on the server, which ServiceResource a sign-in may see. */
export function resolveServiceResource(technicianId: string, accessCode: string | undefined, entries = directory()): MappingOutcome {
  if (!demoModeEnabled()) return { mapped: false, reason: 'demo_mode_off' };
  const entry = entries.find((candidate) => candidate.technicianId.toLowerCase() === technicianId.trim().toLowerCase());
  if (!entry) return { mapped: false, reason: 'not_in_directory' };
  if (!accessCode) return { mapped: false, reason: 'no_code' };
  if (!sameSecret(accessCode, entry.accessCode)) return { mapped: false, reason: 'wrong_code' };
  return { mapped: true, serviceResourceId: entry.serviceResourceId };
}

/** Whether the directory knows this technician id (so the sign-in can insist on a code). */
export function isDirectoryTechnician(technicianId: string): boolean {
  return directory().some((entry) => entry.technicianId.toLowerCase() === technicianId.trim().toLowerCase());
}
