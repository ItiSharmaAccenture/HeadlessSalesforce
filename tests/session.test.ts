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

const { readTechnician, serialiseTechnician, sessionCookieOptions, TECHNICIAN_COOKIE } = await import('@/lib/session');
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
    const parsed = JSON.parse(serialiseTechnician('x'.repeat(500), 'y'.repeat(500)));

    expect(parsed.fullName.length).toBe(120);
    expect(parsed.id.length).toBe(120);
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
