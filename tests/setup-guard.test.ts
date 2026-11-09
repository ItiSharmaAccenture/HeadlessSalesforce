import { describe, expect, it, vi } from 'vitest';

import { guardSetupRoute, requireLocalhost, requireSetupSecret } from '@/lib/setup-guard';

/** SETUP_SECRET is set to this by vitest.config.mts. */
const SECRET = 'test-setup-secret';

function makeRequest(headers: Record<string, string>, url = 'http://localhost:3000/api/auth/salesforce'): Request {
  return new Request(url, { headers: { host: 'localhost:3000', ...headers } });
}

describe('requireLocalhost', () => {
  it('allows a plain localhost request', () => {
    expect(requireLocalhost(makeRequest({}))).toBeNull();
  });

  it('allows loopback IP hosts', () => {
    expect(requireLocalhost(makeRequest({ host: '127.0.0.1:3000' }))).toBeNull();
    expect(requireLocalhost(makeRequest({ host: '[::1]:3000' }))).toBeNull();
  });

  it('refuses a non-local host header', () => {
    expect(requireLocalhost(makeRequest({ host: 'assistant.example.com' }))?.status).toBe(403);
  });

  it('refuses a LAN address, which would expose the route beyond this machine', () => {
    expect(requireLocalhost(makeRequest({ host: '10.211.40.73:3000' }))?.status).toBe(403);
  });

  it('allows the loopback forwarding headers that the dev server adds itself', () => {
    // Next populates these on every request; their presence is not a proxy signal.
    expect(
      requireLocalhost(makeRequest({ 'x-forwarded-for': '::1', 'x-forwarded-host': 'localhost:3000' })),
    ).toBeNull();
    expect(requireLocalhost(makeRequest({ 'x-forwarded-for': '127.0.0.1' }))).toBeNull();
    expect(requireLocalhost(makeRequest({ 'x-forwarded-for': '::ffff:127.0.0.1' }))).toBeNull();
  });

  it('refuses a request relayed from another machine', () => {
    expect(requireLocalhost(makeRequest({ 'x-forwarded-for': '203.0.113.9' }))?.status).toBe(403);
  });

  it('refuses a chain where any hop is remote', () => {
    expect(requireLocalhost(makeRequest({ 'x-forwarded-for': '203.0.113.9, 127.0.0.1' }))?.status).toBe(403);
  });

  it('refuses a forwarded host outside this machine', () => {
    expect(requireLocalhost(makeRequest({ 'x-forwarded-host': 'assistant.example.com' }))?.status).toBe(403);
  });

  it('is not fooled by an address that merely starts with the loopback digits', () => {
    expect(requireLocalhost(makeRequest({ 'x-forwarded-for': '127.0.0.1.evil.com' }))?.status).toBe(403);
  });
});

describe('requireSetupSecret', () => {
  it('accepts the secret as a query parameter', () => {
    expect(requireSetupSecret(makeRequest({}, `http://localhost:3000/api/auth/salesforce?secret=${SECRET}`))).toBeNull();
  });

  it('accepts the secret as a header', () => {
    expect(requireSetupSecret(makeRequest({ 'x-setup-secret': SECRET }))).toBeNull();
  });

  it('refuses a wrong secret', () => {
    const failure = requireSetupSecret(makeRequest({}, 'http://localhost:3000/api/auth/salesforce?secret=nope'));

    expect(failure?.status).toBe(401);
    expect(failure?.message).toMatch(/Invalid setup secret/);
  });

  it('refuses a missing secret', () => {
    expect(requireSetupSecret(makeRequest({}))?.status).toBe(401);
  });

  it('refuses a secret that is only a prefix of the real one', () => {
    const url = `http://localhost:3000/api/auth/salesforce?secret=${SECRET.slice(0, 5)}`;
    expect(requireSetupSecret(makeRequest({}, url))?.status).toBe(401);
  });
});

describe('guardSetupRoute', () => {
  it('reports the host failure before even looking at the secret', () => {
    const url = `http://localhost:3000/api/auth/salesforce?secret=${SECRET}`;
    const request = new Request(url, { headers: { host: 'assistant.example.com' } });

    expect(guardSetupRoute(request, { requireSecret: true })?.status).toBe(403);
  });

  it('allows a local request carrying the right secret', () => {
    const url = `http://localhost:3000/api/auth/salesforce?secret=${SECRET}`;
    expect(guardSetupRoute(makeRequest({}, url), { requireSecret: true })).toBeNull();
  });

  it('skips the secret for the callback, which Salesforce redirects to directly', () => {
    expect(guardSetupRoute(makeRequest({}), { requireSecret: false })).toBeNull();
  });

  it('still enforces localhost for the callback', () => {
    const request = new Request('http://localhost:3000/api/auth/callback/salesforce', {
      headers: { host: 'assistant.example.com' },
    });

    expect(guardSetupRoute(request, { requireSecret: false })?.status).toBe(403);
  });
});

describe('ALLOW_REMOTE_SETUP', () => {
  it('still refuses a remote host by default', async () => {
    vi.resetModules();
    const guard = await import('@/lib/setup-guard');

    expect(guard.requireLocalhost(makeRequest({ host: 'my-app.vercel.app' }))?.status).toBe(403);
  });

  it('permits a deployed host when the operator opts in', async () => {
    vi.resetModules();
    vi.stubEnv('ALLOW_REMOTE_SETUP', 'true');
    const guard = await import('@/lib/setup-guard');

    expect(guard.requireLocalhost(makeRequest({ host: 'my-app.vercel.app' }))).toBeNull();
    vi.unstubAllEnvs();
  });

  it('keeps requiring the secret on the authorize route when opted in', async () => {
    vi.resetModules();
    vi.stubEnv('ALLOW_REMOTE_SETUP', 'true');
    const guard = await import('@/lib/setup-guard');

    const request = new Request('https://my-app.vercel.app/api/auth/salesforce', {
      headers: { host: 'my-app.vercel.app' },
    });
    expect(guard.guardSetupRoute(request, { requireSecret: true })?.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it('is off unless the value is exactly "true"', async () => {
    vi.resetModules();
    vi.stubEnv('ALLOW_REMOTE_SETUP', '1');
    const guard = await import('@/lib/setup-guard');

    expect(guard.requireLocalhost(makeRequest({ host: 'my-app.vercel.app' }))?.status).toBe(403);
    vi.unstubAllEnvs();
  });
});
