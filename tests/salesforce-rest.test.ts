import { afterEach, describe, expect, it, vi } from 'vitest';

const getAccessToken = vi.fn<(force?: boolean) => Promise<string>>(async () => 'token-not-real');

vi.mock('@/lib/salesforce-auth', () => ({
  getAccessToken: (force?: boolean) => getAccessToken(force),
  SalesforceAuthError: class extends Error {},
}));
vi.mock('@/lib/token-store', () => ({
  readTokens: async () => ({ accessToken: 'x', instanceUrl: 'https://example.my.salesforce.com' }),
}));

const { sfGet, SalesforceRestError } = await import('@/lib/salesforce-rest');
const { toUnavailable } = await import('@/lib/dashboard');

afterEach(() => {
  vi.unstubAllGlobals();
  getAccessToken.mockClear();
});

describe('Salesforce REST errors', () => {
  it('reports INVALID_SCOPES as a missing api scope without retrying a refresh', async () => {
    // The exact body this org returned for the Named Query with an mcp_api-only token.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ message: 'INVALID_SCOPES', errorCode: 'INVALID_AUTH_HEADER' }], { status: 401 })));

    const error = (await sfGet('/services/data/v68.0/named/query/ADTTechnicianAppointments').catch((e) => e)) as InstanceType<typeof SalesforceRestError>;
    expect(error).toBeInstanceOf(SalesforceRestError);
    expect(error.code).toBe('missing_api_scope');
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    const state = toUnavailable(error, 'named_query');
    expect(state.code).toBe('missing_api_scope');
    expect(state.adminHint).toContain('api');
  });

  it('refreshes once on an expired token, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }], { status: 401 }))
      .mockResolvedValueOnce(Response.json({ records: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sfGet('/services/data/v68.0/query?q=x')).resolves.toEqual({ records: [] });
    expect(getAccessToken).toHaveBeenLastCalledWith(true);
  });

  it('explains a 404 from the Named Query as not saved / wrong name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }], { status: 404 })));
    const error = await sfGet('/services/data/v68.0/named/query/ADTTechnicianAppointments').catch((e) => e);
    const state = toUnavailable(error, 'named_query');
    expect(state.code).toBe('named_query_unavailable');
    expect(state.adminHint).toContain('saved');
  });

  it('never sends a write', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    await sfGet('/services/data/v68.0/query?q=x');
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });
});
