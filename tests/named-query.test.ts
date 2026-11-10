import { describe, expect, it } from 'vitest';

import { extractRecords, normaliseAppointments } from '@/lib/named-query';

const nested = (id: string, number: string, start: string | null) => ({
  attributes: { type: 'AssignedResource' },
  ServiceAppointmentId: id,
  ServiceAppointment: {
    attributes: { type: 'ServiceAppointment' },
    AppointmentNumber: number,
    SchedStartTime: start,
    Status: 'Scheduled',
    City: 'Austin',
    Latitude: 30.1,
    Longitude: -97.7,
  },
});

describe('Named Query normalisation', () => {
  it('finds records in a query-style envelope or a bare array', () => {
    expect(extractRecords({ totalSize: 1, done: true, records: [{ a: 1 }] })).toHaveLength(1);
    expect(extractRecords([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(extractRecords({ unexpected: true })).toEqual([]);
  });

  it('deduplicates by ServiceAppointmentId', () => {
    const rows = [nested('08p000000000001AAA', 'SA-1', '2026-11-10T15:00:00.000+0000'), nested('08p000000000001AAA', 'SA-1', '2026-11-10T15:00:00.000+0000')];
    expect(normaliseAppointments(rows)).toHaveLength(1);
  });

  it('sorts chronologically with unscheduled last', () => {
    const rows = [
      nested('08p000000000003AAA', 'SA-3', null),
      nested('08p000000000002AAA', 'SA-2', '2026-11-10T18:00:00.000+0000'),
      nested('08p000000000001AAA', 'SA-1', '2026-11-10T15:00:00.000+0000'),
    ];
    expect(normaliseAppointments(rows).map((a) => a.appointmentNumber)).toEqual(['SA-1', 'SA-2', 'SA-3']);
  });

  it('reads flattened relationship keys too', () => {
    const [appointment] = normaliseAppointments([
      { ServiceAppointmentId: '08p000000000001AAA', 'ServiceAppointment.AppointmentNumber': 'SA-9', 'ServiceAppointment.Latitude': '30.5' },
    ]);
    expect(appointment.appointmentNumber).toBe('SA-9');
    expect(appointment.latitude).toBe(30.5);
  });

  it('never invents values: missing fields are null and customer is not assumed', () => {
    const [appointment] = normaliseAppointments([{ ServiceAppointmentId: '08p000000000001AAA', ServiceAppointment: {} }]);
    expect(appointment.customerName).toBeNull();
    expect(appointment.latitude).toBeNull();
    expect(appointment.address.street).toBeNull();
  });
});
