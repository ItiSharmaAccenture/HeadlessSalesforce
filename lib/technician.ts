/**
 * Presentation details for the signed-in technician.
 *
 * Who the technician is now comes from the sign-in cookie (`lib/session.ts`).
 * What remains here is only what the demo does not collect: a stock avatar and
 * a role label.
 */

import type { Technician } from '@/types/technician';

export const TECHNICIAN_PHOTO = '/assets/my-day/technician.webp';
export const TECHNICIAN_ROLE = 'Field Service Technician';

/** "Sayantan Pal" -> "Sayantan". Falls back to the whole name. */
export function deriveFirstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

/** Builds the shared shape from the two fields the sign-in screen collects. */
export function toTechnician(fullName: string, id: string): Technician {
  const name = fullName.trim();
  return { fullName: name, firstName: deriveFirstName(name), id: id.trim() };
}
