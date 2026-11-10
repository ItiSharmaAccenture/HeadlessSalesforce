/**
 * Server-side mapping from an application sign-in to a Salesforce ServiceResource.
 *
 * The app authenticates to Salesforce as ONE shared integration user, so
 * Salesforce cannot tell which technician is looking. That user is never
 * treated as the technician. Instead, a technician's dashboard is scoped to the
 * ServiceResource id configured for their technician ID here, on the server.
 * The browser never submits a ServiceResource id.
 *
 * There is no password or access code: whoever signs in with a technician ID
 * sees that technician's appointments. Acceptable for a controlled POC only;
 * replace with a real identity provider (or per-technician Salesforce OAuth)
 * before production use. Off unless ADT_DEMO_MODE=true.
 *
 *   ADT_DEMO_MODE=true
 *   ADT_TECHNICIAN_DIRECTORY=[{"technicianId":"TCH-7842","serviceResourceId":"0Hn…"}]
 */

import 'server-only';

import { log } from './logger';
import { isSalesforceId } from './salesforce-rest';

export interface DirectoryEntry {
  technicianId: string;
  serviceResourceId: string;
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
    const { technicianId, serviceResourceId } = (item ?? {}) as Record<string, unknown>;
    if (typeof technicianId !== 'string' || !technicianId.trim()) continue;
    if (!isSalesforceId(serviceResourceId, '0Hn')) continue;
    entries.push({ technicianId: technicianId.trim(), serviceResourceId });
  }
  return entries;
}

function directory(): DirectoryEntry[] {
  return demoModeEnabled() ? parseDirectory(process.env.ADT_TECHNICIAN_DIRECTORY) : [];
}

export type MappingOutcome =
  | { mapped: true; serviceResourceId: string }
  | { mapped: false; reason: 'demo_mode_off' | 'not_in_directory' };

/** Decides, on the server, which ServiceResource a sign-in may see. */
export function resolveServiceResource(technicianId: string, entries = directory()): MappingOutcome {
  if (!demoModeEnabled()) return { mapped: false, reason: 'demo_mode_off' };
  const entry = entries.find((candidate) => candidate.technicianId.toLowerCase() === technicianId.trim().toLowerCase());
  return entry ? { mapped: true, serviceResourceId: entry.serviceResourceId } : { mapped: false, reason: 'not_in_directory' };
}
