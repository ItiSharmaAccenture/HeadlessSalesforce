/* Small formatting helpers shared by the Copilot views. */

/** Google Maps search for an address (opens the place). */
export function mapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** Google Maps directions from the device's location to an address. */
export function directionsUrl(address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

/** "10:42 AM" for message timestamps, in the device's locale and zone. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Salesforce ISO timestamps shown in the technician's zone; anything else as-is. */
export function formatFieldValue(value: string, timeZone?: string): string {
  if (!ISO_TIMESTAMP.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return date.toLocaleString();
  }
}

export type StatusTone = 'scheduled' | 'travel' | 'progress' | 'done' | 'stopped' | 'neutral';

export function statusTone(status: string | undefined): StatusTone {
  const value = (status ?? '').toLowerCase();
  if (/cancel|cannot/.test(value)) return 'stopped';
  if (/complete/.test(value)) return 'done';
  if (/in\s*progress|started|on\s*site/.test(value)) return 'progress';
  if (/on\s*my\s*way|en\s*route|travel|dispatched/.test(value)) return 'travel';
  if (/scheduled/.test(value)) return 'scheduled';
  return 'neutral';
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
