import { describe, expect, it } from 'vitest';

import { likeExact, normaliseOwnerRecord, ownerWhere } from '@/lib/owner-query';

const owner = { userId: '005g700000GFHk5AAH', name: 'Sayantan Pal' };

describe('owner-based appointment query', () => {
  it('matches the name exactly: wildcards and quotes are escaped', () => {
    expect(likeExact("O'Brien_100%")).toBe("'O\\'Brien\\_100\\%'");
  });

  it('filters by name, owner id, Scheduled status and the date range', () => {
    const where = ownerWhere(owner, '2026-11-09T18:30:00Z', '2026-11-10T18:30:00Z');
    expect(where).toContain("Owner.Name LIKE 'Sayantan Pal'");
    expect(where).toContain("OwnerId = '005g700000GFHk5AAH'");
    expect(where).toContain("Status = 'Scheduled'");
    expect(where).toContain('SchedStartTime >= 2026-11-09T18:30:00Z AND SchedStartTime < 2026-11-10T18:30:00Z');
  });

  it('refuses a non-user owner id or a malformed boundary', () => {
    expect(() => ownerWhere({ ...owner, userId: '0Hng7000000SLG1CAO' }, '2026-11-09T18:30:00Z', '2026-11-10T18:30:00Z')).toThrow();
    expect(() => ownerWhere(owner, '2026-11-09 OR Id != null', '2026-11-10T18:30:00Z')).toThrow();
  });

  it('reads the compound Address field and the account name', () => {
    const appointment = normaliseOwnerRecord({
      Id: '08pg7000001UjwBAAS',
      AppointmentNumber: 'SA-0063',
      Status: 'Scheduled',
      SchedStartTime: '2026-11-10T13:30:00.000+0000',
      Account: { Name: 'Biospan, LLC.' },
      Address: { street: '1 Joe st', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'United States', latitude: 37.73, longitude: -122.43 },
    });
    expect(appointment?.customerName).toBe('Biospan, LLC.');
    expect(appointment?.address.city).toBe('San Francisco');
    expect(appointment?.latitude).toBe(37.73);
  });

  it('leaves missing coordinates null rather than inventing them', () => {
    expect(normaliseOwnerRecord({ Id: '08pg7000001bX7hAAE', Address: { city: 'Cedar Park' } })?.latitude).toBeNull();
  });
});
