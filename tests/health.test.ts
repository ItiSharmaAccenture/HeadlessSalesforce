/**
 * /api/health must never be the thing that breaks.
 *
 * Its whole job is to report what is wrong, so a failure reading the token store
 * — unreachable Redis, wrong Upstash credentials, a paused instance — has to
 * come back as a sanitised status rather than a 500 with no body. That is the
 * first thing an operator checks after deploying.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HealthResponse } from '@/types/chat';

const getAuthorizationStatus = vi.fn();
const tokenStoreDescription = vi.fn();
const openMcpSession = vi.fn();

vi.mock('@/lib/salesforce-auth', () => ({
  getAuthorizationStatus,
  SalesforceAuthError: class extends Error {},
}));

vi.mock('@/lib/token-store', () => ({ tokenStoreDescription }));

vi.mock('@/lib/salesforce-mcp', async () => {
  const actual = await vi.importActual<typeof import('@/lib/salesforce-mcp')>('@/lib/salesforce-mcp');
  return { ...actual, openMcpSession };
});

const authorized = { authorized: true, hasRefreshToken: true, expiresAt: null, scope: null };

async function get(): Promise<{ status: number; body: HealthResponse }> {
  vi.resetModules();
  const { GET } = await import('@/app/api/health/route');
  const response = await GET();
  return { status: response.status, body: (await response.json()) as HealthResponse };
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenStoreDescription.mockReturnValue({ kind: 'redis', location: 'redis example.upstash.io/tokens' });
  getAuthorizationStatus.mockResolvedValue({ authorized: false, hasRefreshToken: false, expiresAt: null, scope: null });
  openMcpSession.mockRejectedValue(new Error('not probed in these tests'));
});

describe('token store reporting', () => {
  it('names the backend so a deployment can be checked at a glance', async () => {
    const { body } = await get();
    expect(body.checks.salesforceOAuth.storage).toBe('redis');
  });

  it('warns that the file backend will not survive a serverless host', async () => {
    tokenStoreDescription.mockReturnValue({ kind: 'file', location: '/app/.local/salesforce-tokens.json' });

    const { body } = await get();
    expect(body.checks.salesforceOAuth.storage).toBe('file');
    expect(body.checks.salesforceOAuth.detail).toMatch(/serverless host will not keep/i);
  });

  it('reports a misconfigured store rather than throwing', async () => {
    tokenStoreDescription.mockImplementation(() => {
      throw new Error('TOKEN_STORE=redis but no Redis credentials are set.');
    });

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.checks.salesforceOAuth.detail).toMatch(/no Redis credentials/);
  });
});

describe('when the token store cannot be read', () => {
  beforeEach(() => {
    getAuthorizationStatus.mockRejectedValue(new TypeError('fetch failed'));
  });

  it('still answers 200 with a usable body', async () => {
    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.status).toBe('configuration_required');
  });

  it('says the storage could not be read, and which backend it was', async () => {
    const { body } = await get();

    expect(body.checks.salesforceOAuth.detail).toMatch(/could not be read \(redis backend\)/);
    expect(body.checks.salesforceOAuth.detail).toMatch(/fetch failed/);
  });

  it('does not claim to be authorized', async () => {
    const { body } = await get();

    expect(body.checks.salesforceOAuth.authorized).toBe(false);
    expect(body.status).not.toBe('connected');
  });

  it('does not attempt an MCP probe it has no token for', async () => {
    await get();
    expect(openMcpSession).not.toHaveBeenCalled();
  });
});

describe('when everything is readable', () => {
  it('still refuses to say connected without a verified MCP handshake', async () => {
    getAuthorizationStatus.mockResolvedValue(authorized);
    openMcpSession.mockRejectedValue(new Error('endpoint unreachable'));

    const { body } = await get();

    expect(body.checks.salesforceOAuth.authorized).toBe(true);
    expect(body.status).not.toBe('connected');
    expect(body.checks.salesforceMcp.reachable).toBe(false);
  });
});
