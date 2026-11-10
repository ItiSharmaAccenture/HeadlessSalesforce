/**
 * The technician sign-in cookie.
 *
 * It is not a security boundary — the sign-in screen lets anyone name
 * themselves — so what these check is that a bad or stale cookie sends the user
 * back to the sign-in screen rather than crashing the dashboard.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
  }),
}));

const { parseSession, readTechnician, serialiseTechnician, sessionCookieOptions, TECHNICIAN_COOKIE } = await import('@/lib/session');
const { deriveFirstName, toTechnician } = await import('@/lib/technician');

function signIn(value: string) {
  store.set(TECHNICIAN_COOKIE, value);
}

beforeEach(() => {
  store.clear();
});

describe('deriveFirstName', () => {
  it('takes the first word', () => {
    expect(deriveFirstName('Sayantan Pal')).toBe('Sayantan');
    expect(deriveFirstName('  Ada  Lovelace ')).toBe('Ada');
  });

  it('falls back to the whole name when there is only one word', () => {
    expect(deriveFirstName('Prince')).toBe('Prince');
  });
});

describe('toTechnician', () => {
  it('trims both fields and derives the first name', () => {
    expect(toTechnician('  Sayantan Pal ', ' TCH-7842 ')).toEqual({
      fullName: 'Sayantan Pal',
      firstName: 'Sayantan',
      id: 'TCH-7842',
    });
  });
});

describe('readTechnician', () => {
  it('returns null when nobody is signed in', async () => {
    await expect(readTechnician()).resolves.toBeNull();
  });

  it('reads back what the sign-in route wrote', async () => {
    signIn(serialiseTechnician('Sayantan Pal', 'TCH-7842'));

    await expect(readTechnician()).resolves.toEqual({
      fullName: 'Sayantan Pal',
      firstName: 'Sayantan',
      id: 'TCH-7842',
    });
  });

  it('returns null for a malformed cookie rather than throwing', async () => {
    signIn('not json at all');
    await expect(readTechnician()).resolves.toBeNull();
  });

  it('returns null when either field is missing or blank', async () => {
    signIn(JSON.stringify({ fullName: 'Sayantan Pal' }));
    await expect(readTechnician()).resolves.toBeNull();

    signIn(JSON.stringify({ fullName: '   ', id: 'TCH-7842' }));
    await expect(readTechnician()).resolves.toBeNull();
  });

  it('returns null when a field is the wrong type', async () => {
    signIn(JSON.stringify({ fullName: 42, id: 'TCH-7842' }));
    await expect(readTechnician()).resolves.toBeNull();
  });

  it('caps a pasted-in value so the cookie cannot grow unbounded', () => {
    const session = parseSession(serialiseTechnician('x'.repeat(500), 'y'.repeat(500)));

    expect(session?.technician.fullName.length).toBe(120);
    expect(session?.technician.id.length).toBe(120);
  });
});

describe('signed ServiceResource mapping', () => {
  const SR = '0Hng7000000AbcDEFG';
  const encode = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  const now = () => Math.floor(Date.now() / 1000);

  it('round-trips a verified ServiceResource id', () => {
    expect(parseSession(serialiseTechnician('Sayantan Pal', 'TCH-7842', SR))?.serviceResourceId).toBe(SR);
  });

  it('has no mapping unless the server set one', () => {
    expect(parseSession(serialiseTechnician('Sayantan Pal', 'TCH-7842'))?.serviceResourceId).toBeNull();
  });

  it('rejects a cookie whose payload was edited to claim another ServiceResource', () => {
    const signature = serialiseTechnician('Sayantan Pal', 'TCH-7842', SR).split('.')[1];
    const forged = encode({ fullName: 'Sayantan Pal', id: 'TCH-7842', sr: '0Hng7000000ZZZZZZZ', iat: now() });
    expect(parseSession(`${forged}.${signature}`)).toBeNull();
  });

  it('rejects an unsigned cookie when a signing key is configured', () => {
    expect(parseSession(`${encode({ fullName: 'A B', id: 'X', sr: SR, iat: now() })}.-`)).toBeNull();
  });
});

describe('sessionCookieOptions', () => {
  it('keeps the cookie off the page scripts and off cross-site requests', () => {
    const options = sessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('does not set Secure outside production, which would break http://localhost', () => {
    expect(sessionCookieOptions().secure).toBe(false);
  });
});
