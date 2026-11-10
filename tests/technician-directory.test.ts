import { afterEach, describe, expect, it } from 'vitest';

import { parseDirectory, resolveServiceResource } from '@/lib/technician-directory';

const SR = '0Hng7000000AbcDEFG';
const entries = parseDirectory(JSON.stringify([{ technicianId: 'TCH-7842', serviceResourceId: SR, accessCode: 'tulip-42' }]));

afterEach(() => {
  delete process.env.ADT_DEMO_MODE;
});

describe('technician directory (demo mode)', () => {
  it('ignores entries without an access code or with a non-ServiceResource id', () => {
    expect(
      parseDirectory(
        JSON.stringify([
          { technicianId: 'A', serviceResourceId: SR },
          { technicianId: 'B', serviceResourceId: '005000000000001AAA', accessCode: 'abcd' },
        ]),
      ),
    ).toEqual([]);
    expect(parseDirectory('not json')).toEqual([]);
  });

  it('maps nobody while demo mode is off', () => {
    expect(resolveServiceResource('TCH-7842', 'tulip-42', entries)).toEqual({ mapped: false, reason: 'demo_mode_off' });
  });

  it('maps only with the matching access code', () => {
    process.env.ADT_DEMO_MODE = 'true';
    expect(resolveServiceResource('tch-7842', 'tulip-42', entries)).toEqual({ mapped: true, serviceResourceId: SR });
    expect(resolveServiceResource('TCH-7842', 'wrong', entries)).toEqual({ mapped: false, reason: 'wrong_code' });
    expect(resolveServiceResource('TCH-7842', undefined, entries)).toEqual({ mapped: false, reason: 'no_code' });
    expect(resolveServiceResource('TCH-0001', 'tulip-42', entries)).toEqual({ mapped: false, reason: 'not_in_directory' });
  });
});
