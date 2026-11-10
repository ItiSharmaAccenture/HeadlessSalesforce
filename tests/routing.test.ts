import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRoute } from '@/lib/routing';
import type { DashboardAppointment } from '@/types/dashboard';

function appt(id: string, start: string, end: string, coords: [number, number] | null, status = 'Scheduled'): DashboardAppointment {
  return {
    id,
    appointmentNumber: `SA-${id.slice(-3)}`,
    subject: 'Install',
    status,
    scheduledStart: start,
    scheduledEnd: end,
    customerName: null,
    address: { street: null, city: null, state: null, postalCode: null, country: null },
    latitude: coords ? coords[1] : null,
    longitude: coords ? coords[0] : null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MAPBOX_ACCESS_TOKEN;
});

describe('buildRoute', () => {
  const a = appt('08p000000000001', '2026-11-10T15:00:00Z', '2026-11-10T16:00:00Z', [-97.74, 30.27]);
  const b = appt('08p000000000002', '2026-11-10T16:10:00Z', '2026-11-10T17:00:00Z', [-97.68, 30.51]);

  it('reports a missing provider instead of estimating a distance', async () => {
    const result = await buildRoute([a, b]);
    expect(result.status).toBe('unavailable');
    expect(result.status === 'unavailable' && result.code).toBe('provider_not_configured');
    expect(result.stops).toHaveLength(2);
  });

  it('uses the provider distance, keeps scheduled order, and warns when a drive cannot fit', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'pk.test';
    const fetchMock = vi.fn<(url: string | URL) => Promise<Response>>(async () =>
      Response.json({
        code: 'Ok',
        routes: [{ distance: 32000, duration: 1500, geometry: { coordinates: [[-97.74, 30.27], [-97.68, 30.51]] }, legs: [{ distance: 32000, duration: 1500 }] }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await buildRoute([b, a]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.totalDistanceMeters).toBe(32000);
    expect(result.stops.map((stop) => stop.appointmentId)).toEqual([a.id, b.id]);
    // 10 minutes between jobs, 25 minutes of driving.
    expect(result.warnings.some((warning) => warning.includes('longer than the time between'))).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('-97.740000,30.270000;-97.680000,30.510000');
  });

  it('skips canceled appointments and reports them', async () => {
    const result = await buildRoute([a, appt('08p000000000003', '2026-11-10T18:00:00Z', '2026-11-10T19:00:00Z', [-97.7, 30.3], 'Canceled')]);
    expect(result.skipped).toEqual([{ appointmentId: '08p000000000003', appointmentNumber: 'SA-003', reason: 'Canceled' }]);
  });

  it('reports when no drivable route exists', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'pk.test';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'NoRoute', message: 'No route found' }, { status: 422 })));
    const result = await buildRoute([a, b]);
    expect(result.status === 'unavailable' && result.code).toBe('no_route');
  });
});
