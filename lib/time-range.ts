/**
 * Calendar arithmetic in a technician's IANA time zone, without a date library.
 *
 * "Today" is the technician's local calendar day, so its UTC boundaries depend
 * on the zone and on DST. Everything here is pure, so it is unit-tested
 * directly.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function isValidDate(date: string): boolean {
  const match = DATE_RE.exec(date);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Offset of `zone` from UTC at the given instant, in milliseconds. */
function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The local calendar date (YYYY-MM-DD) of an instant in `zone`. */
export function localDate(instant: number, zone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant),
  );
}

/** The UTC instant at which local midnight starts `date` in `zone`. */
export function localMidnightUtc(date: string, zone: string): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  const [, y, m, d] = match.map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = offsetMs(guess, zone);
  let instant = guess - first;
  // Across a DST change the offset at the guess and at the answer differ.
  const second = offsetMs(instant, zone);
  if (second !== first) instant = guess - second;
  return instant;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** Salesforce dateTime literal: no milliseconds, Z suffix. */
export function toSalesforceDateTime(instant: number): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface LocalRange {
  /** First local date in range. */
  startDate: string;
  /** Exclusive end date. */
  endDate: string;
  startUtc: string;
  endUtc: string;
}

export function rangeFor(startDate: string, days: number, zone: string): LocalRange {
  const endDate = addDays(startDate, days);
  return {
    startDate,
    endDate,
    startUtc: toSalesforceDateTime(localMidnightUtc(startDate, zone)),
    endUtc: toSalesforceDateTime(localMidnightUtc(endDate, zone)),
  };
}
