/**
 * Multi-endpoint MCP sessions.
 *
 * An org can activate custom MCP servers alongside the standard one, so a
 * session fans out across several endpoints. What has to hold: tools from every
 * endpoint are offered, a call is routed back to the endpoint that published
 * the tool, a name offered by two endpoints is disambiguated rather than
 * silently shadowed, and one unreachable endpoint degrades the tool list
 * instead of failing the turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

/** Per-endpoint scripted behaviour, keyed by the URL the client dials. */
const endpoints = new Map<
  string,
  { tools: { name: string; inputSchema?: unknown }[]; connectError?: Error; listError?: Error }
>();

/** Records which endpoint each callTool landed on. */
const calls: { url: string; name: string; args: unknown }[] = [];

class FakeClient {
  private url = '';

  async connect(transport: { url: string }) {
    this.url = transport.url;
    const endpoint = endpoints.get(this.url);
    if (endpoint?.connectError) throw endpoint.connectError;
  }

  getServerVersion() {
    return { name: 'fake', version: '1.0.0' };
  }

  async listTools() {
    const endpoint = endpoints.get(this.url);
    if (endpoint?.listError) throw endpoint.listError;
    return { tools: endpoint?.tools ?? [] };
  }

  async callTool({ name, arguments: args }: { name: string; arguments: unknown }) {
    calls.push({ url: this.url, name, args });
    return { content: [{ type: 'text', text: JSON.stringify({ records: [{ Id: '001' }], from: this.url }) }] };
  }

  async close() {}
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: FakeClient }));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    url: string;
    constructor(url: URL) {
      this.url = url.toString();
    }
    async close() {}
  },
}));

vi.mock('@/lib/salesforce-auth', () => ({
  getAccessToken: vi.fn(async () => 'fake-access-token'),
  SalesforceAuthError: class extends Error {},
}));

const PRIMARY = 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all';
const CUSTOM = 'https://api.salesforce.com/platform/mcp/v1/platform/acme-quotes';

/** Config is read at import time, so each case re-imports with its own env. */
async function sessionWith(urls: string[]) {
  vi.resetModules();
  vi.stubEnv('SALESFORCE_MCP_URLS', urls.join(','));
  const { openMcpSession } = await import('@/lib/salesforce-mcp');
  return openMcpSession();
}

beforeEach(() => {
  endpoints.clear();
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */

describe('a single endpoint', () => {
  it('discovers and routes its tools', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });

    const session = await sessionWith([PRIMARY]);
    const discovery = await session.listTools();

    expect(discovery.approved.map((tool) => tool.name)).toEqual(['soqlQuery']);
    expect(discovery.servers).toEqual([{ id: 'sobject_all', connected: true, toolCount: 1 }]);

    await session.callTool('soqlQuery', { query: 'SELECT Id FROM Account' });
    expect(calls).toEqual([{ url: PRIMARY, name: 'soqlQuery', args: { query: 'SELECT Id FROM Account' } }]);

    await session.close();
  });
});

describe('several endpoints', () => {
  it('offers the union of their tools', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });
    endpoints.set(CUSTOM, { tools: [{ name: 'submitQuote' }, { name: 'approveQuote' }] });

    const session = await sessionWith([PRIMARY, CUSTOM]);
    const discovery = await session.listTools();

    expect(discovery.approved.map((tool) => tool.name).sort()).toEqual(['approveQuote', 'soqlQuery', 'submitQuote']);
    expect(discovery.discoveredCount).toBe(3);

    await session.close();
  });

  it('routes each call to the endpoint that published the tool', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });
    endpoints.set(CUSTOM, { tools: [{ name: 'submitQuote' }] });

    const session = await sessionWith([PRIMARY, CUSTOM]);
    await session.listTools();

    await session.callTool('submitQuote', { quoteId: 'Q1' });
    await session.callTool('soqlQuery', { query: 'SELECT Id FROM Account' });

    expect(calls.map((call) => call.url)).toEqual([CUSTOM, PRIMARY]);

    await session.close();
  });

  it('qualifies a tool name that two endpoints both publish', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'find' }] });
    endpoints.set(CUSTOM, { tools: [{ name: 'find' }] });

    const session = await sessionWith([PRIMARY, CUSTOM]);
    const discovery = await session.listTools();

    // Neither shadows the other; both stay reachable under a qualified name.
    expect(discovery.approved.map((tool) => tool.name).sort()).toEqual(['acme_quotes__find', 'sobject_all__find']);

    await session.callTool('acme_quotes__find', { term: 'x' });
    expect(calls).toEqual([{ url: CUSTOM, name: 'find', args: { term: 'x' } }]);

    await session.close();
  });

  it('builds its routing table on demand when discovery was served from a cache', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });

    const session = await sessionWith([PRIMARY]);
    // No listTools() first: the caller reused a cached tool list.
    await session.callTool('soqlQuery', { query: 'SELECT Id FROM Account' });

    expect(calls).toHaveLength(1);
    await session.close();
  });

  it('refuses a tool no endpoint published', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });

    const session = await sessionWith([PRIMARY]);
    await session.listTools();

    await expect(session.callTool('madeUpTool', {})).rejects.toThrow(/not available on any configured MCP endpoint/i);
    expect(calls).toHaveLength(0);

    await session.close();
  });
});

describe('endpoint failures', () => {
  it('keeps working when one endpoint cannot be reached', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });
    endpoints.set(CUSTOM, { tools: [], connectError: new Error('fetch failed') });

    const session = await sessionWith([PRIMARY, CUSTOM]);
    const discovery = await session.listTools();

    expect(discovery.approved.map((tool) => tool.name)).toEqual(['soqlQuery']);

    const failed = discovery.servers.find((server) => server.id === 'acme_quotes');
    expect(failed).toMatchObject({ connected: false, toolCount: 0 });
    expect(failed?.error).toBeTruthy();

    await session.close();
  });

  it('keeps working when one endpoint connects but fails discovery', async () => {
    endpoints.set(PRIMARY, { tools: [{ name: 'soqlQuery' }] });
    endpoints.set(CUSTOM, { tools: [], listError: new Error('500 internal error') });

    const session = await sessionWith([PRIMARY, CUSTOM]);
    const discovery = await session.listTools();

    expect(discovery.approved.map((tool) => tool.name)).toEqual(['soqlQuery']);
    expect(discovery.servers.find((server) => server.id === 'acme_quotes')).toMatchObject({ connected: false });

    await session.close();
  });

  it('fails the session only when every endpoint is unreachable', async () => {
    endpoints.set(PRIMARY, { tools: [], connectError: new Error('fetch failed') });
    endpoints.set(CUSTOM, { tools: [], connectError: new Error('fetch failed') });

    await expect(sessionWith([PRIMARY, CUSTOM])).rejects.toThrow(/could not reach|fetch failed/i);
  });

  it('refuses to open a session with no endpoint configured', async () => {
    vi.resetModules();
    vi.stubEnv('SALESFORCE_MCP_URLS', '');
    vi.stubEnv('SALESFORCE_MCP_URL', '');
    const { openMcpSession } = await import('@/lib/salesforce-mcp');

    await expect(openMcpSession()).rejects.toThrow(/No Salesforce MCP endpoint is configured/i);
  });
});
