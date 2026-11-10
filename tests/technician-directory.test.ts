import { afterEach, describe, expect, it } from 'vitest';

import { parseDirectory, resolveServiceResource } from '@/lib/technician-directory';

const SR = '0Hng7000000AbcDEFG';
const entries = parseDirectory(JSON.stringify([{ technicianId: 'TCH-7842', serviceResourceId: SR }]));

afterEach(() => {
  delete process.env.ADT_DEMO_MODE;
});

describe('technician directory', () => {
  it('ignores entries whose id is not a ServiceResource', () => {
    expect(parseDirectory(JSON.stringify([{ technicianId: 'B', serviceResourceId: '005000000000001AAA' }]))).toEqual([]);
    expect(parseDirectory('not json')).toEqual([]);
  });

  it('maps nobody while demo mode is off', () => {
    expect(resolveServiceResource('TCH-7842', entries)).toEqual({ mapped: false, reason: 'demo_mode_off' });
  });

  it('maps a technician ID from the server-side directory, case-insensitively', () => {
    process.env.ADT_DEMO_MODE = 'true';
    expect(resolveServiceResource(' tch-7842 ', entries)).toEqual({ mapped: true, serviceResourceId: SR });
    expect(resolveServiceResource('TCH-0001', entries)).toEqual({ mapped: false, reason: 'not_in_directory' });
  });
});
