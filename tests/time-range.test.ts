import { describe, expect, it } from 'vitest';

import { addDays, isValidDate, localDate, localMidnightUtc, rangeFor, startOfWeek, toSalesforceDateTime } from '@/lib/time-range';

describe('time-range', () => {
  it('computes local midnight in a zone west of UTC', () => {
    expect(new Date(localMidnightUtc('2026-11-10', 'America/Chicago')).toISOString()).toBe('2026-11-10T06:00:00.000Z');
  });

  it('computes local midnight in a zone east of UTC with a half-hour offset', () => {
    expect(new Date(localMidnightUtc('2026-11-10', 'Asia/Kolkata')).toISOString()).toBe('2026-11-09T18:30:00.000Z');
  });

  it('handles the day DST ends (25-hour day)', () => {
    const range = rangeFor('2026-11-01', 1, 'America/Chicago');
    expect(range.startUtc).toBe('2026-11-01T05:00:00Z');
    expect(range.endUtc).toBe('2026-11-02T06:00:00Z');
  });

  it('handles the day DST starts (23-hour day)', () => {
    const range = rangeFor('2026-03-08', 1, 'America/Chicago');
    expect(range.startUtc).toBe('2026-03-08T06:00:00Z');
    expect(range.endUtc).toBe('2026-03-09T05:00:00Z');
  });

  it('finds the local date of an instant', () => {
    // 02:00 UTC on Nov 10 is still Nov 9 in Chicago.
    expect(localDate(Date.parse('2026-11-10T02:00:00Z'), 'America/Chicago')).toBe('2026-11-09');
  });

  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-11-10')).toBe('2026-11-09'); // Tuesday → Monday
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09'); // Sunday → previous Monday
    expect(startOfWeek('2026-11-09')).toBe('2026-11-09');
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('validates dates strictly', () => {
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-11-10T00:00')).toBe(false);
  });

  it('formats Salesforce datetime literals without milliseconds', () => {
    expect(toSalesforceDateTime(Date.parse('2026-11-10T06:00:00.123Z'))).toBe('2026-11-10T06:00:00Z');
  });
});
