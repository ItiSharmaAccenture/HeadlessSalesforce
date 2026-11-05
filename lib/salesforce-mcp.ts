/**
 * Salesforce Hosted MCP client.
 *
 * Wraps the official MCP TypeScript SDK's Streamable HTTP transport. Tools are
 * always discovered with `tools/list` rather than assumed, and the discovered
 * schemas are what both the policy layer and Gemini work from.
 *
 * Several endpoints can be configured at once, so a custom MCP server activated
 * in the org sits alongside the standard ones. Each endpoint is connected,
 * discovered and called independently: one unreachable server degrades the tool
 * list, it does not fail the turn.
 */

import 'server-only';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { config, type McpServerConfig } from './config';
import { log } from './logger';
import { getAccessToken, SalesforceAuthError } from './salesforce-auth';
import { approveTools, type ApprovedTool, type DiscoveredTool, type RejectedTool } from './tool-allowlist';

const CLIENT_INFO = { name: 'salesforce-ai-sales-assistant', version: '0.1.0' };

export class McpError extends Error {
  constructor(
    message: string,
    readonly stage: 'connect' | 'discover' | 'call',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** Normalised view of an MCP tool result. */
export interface ParsedToolResult {
  /** Compact text handed back to Gemini. Never the full raw payload. */
  text: string;
  /** Structured payload when the server returned one. */
  data?: unknown;
  /** Only set when a record count could be determined reliably. */
  recordCount?: number;
  isError: boolean;
  truncated: boolean;
}

/** Per-endpoint outcome, for the log and the health endpoint. */
export interface ServerStatus {
  id: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface DiscoveryResult {
  approved: ApprovedTool[];
  rejected: RejectedTool[];
  discoveredCount: number;
  servers: ServerStatus[];
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

interface Connection {
  id: string;
  close: () => Promise<void>;
  /**
   * Runs an operation against this endpoint's client, reconnecting once with a
   * fresh token if Salesforce rejects the current one. The client is passed in
   * rather than exposed, because a reconnect replaces it.
   */
  withAuthRetry: <T>(operation: (client: Client) => Promise<T>, stage: 'discover' | 'call') => Promise<T>;
}

async function dial(server: McpServerConfig, forceRefresh: boolean): Promise<{ client: Client; close: () => Promise<void> }> {
  const accessToken = await getAccessToken(forceRefresh);
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    // The token is attached directly rather than via an SDK auth provider: the
    // dedicated user's grant is obtained once by the operator, out of band.
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const close = async () => {
    // Either half can already be gone if the server dropped the stream.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };

  try {
    // connect() performs the MCP `initialize` handshake.
    await client.connect(transport, { timeout: config.limits.mcpTimeoutMs });
  } catch (error) {
    await close();
    throw toMcpError(error, 'connect');
  }

  const info = client.getServerVersion();
  log.info('salesforce-mcp', 'Connected to Salesforce Hosted MCP', {
    id: server.id,
    server: info?.name,
    version: info?.version,
    endpoint: redactEndpoint(server.url),
  });

  return { client, close };
}

async function openConnection(server: McpServerConfig): Promise<Connection> {
  let { client, close } = await dial(server, false);
  let retriedAuth = false;

  const withAuthRetry = async <T>(operation: (c: Client) => Promise<T>, stage: 'discover' | 'call'): Promise<T> => {
    try {
      return await operation(client);
    } catch (error) {
      if (retriedAuth || !isUnauthorized(error)) throw toMcpError(error, stage);

      retriedAuth = true;
      log.warn('salesforce-mcp', 'MCP rejected the access token; refreshing and reconnecting once', { id: server.id });
      await close();

      const reconnected = await dial(server, true);
      client = reconnected.client;
      close = reconnected.close;

      try {
        return await operation(client);
      } catch (retryError) {
        throw toMcpError(retryError, stage);
      }
    }
  };

  return {
    id: server.id,
    close: () => close(),
    withAuthRetry,
  };
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export interface McpSession {
  listTools(): Promise<DiscoveryResult>;
  callTool(name: string, args: Record<string, unknown>): Promise<ParsedToolResult>;
  close(): Promise<void>;
}

/** Where an exposed tool name actually lives. */
interface Route {
  connection: Connection;
  remoteName: string;
}

/**
 * Opens a session for one chat turn.
 *
 * One connection per configured endpoint serves tool discovery plus every tool
 * call in the turn, and all of them are closed when the turn ends.
 */
export async function openMcpSession(): Promise<McpSession> {
  const servers = config.salesforce.mcpServers;
  if (servers.length === 0) {
    throw new McpError('No Salesforce MCP endpoint is configured. Set SALESFORCE_MCP_URLS in .env.local.', 'connect');
  }

  const settled = await Promise.allSettled(servers.map((server) => openConnection(server)));

  const connections: Connection[] = [];
  const failures: { id: string; error: unknown }[] = [];

  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') connections.push(outcome.value);
    else failures.push({ id: servers[index].id, error: outcome.reason });
  });

  if (connections.length === 0) {
    // Nothing to degrade to; surface the first endpoint's real reason.
    const first = failures[0]?.error;
    if (first instanceof SalesforceAuthError || first instanceof McpError) throw first;
    throw toMcpError(first, 'connect');
  }

  for (const failure of failures) {
    log.warn('salesforce-mcp', 'MCP endpoint unavailable; continuing without it', {
      id: failure.id,
      message: describe(failure.error),
    });
  }

  const routes = new Map<string, Route>();
  let discovery: DiscoveryResult | null = null;

  const discover = async (): Promise<DiscoveryResult> => {
    const perServer = await Promise.all(
      connections.map(async (connection) => {
        try {
          const response = await connection.withAuthRetry(
            (client) => client.listTools(undefined, { timeout: config.limits.mcpTimeoutMs }),
            'discover',
          );
          const tools = (response.tools ?? []) as DiscoveredTool[];
          return { connection, tools, error: null as string | null };
        } catch (error) {
          log.warn('salesforce-mcp', 'Tool discovery failed for an endpoint', {
            id: connection.id,
            message: describe(error),
          });
          return { connection, tools: [] as DiscoveredTool[], error: describe(error) };
        }
      }),
    );

    // A tool name offered by two endpoints is ambiguous, so both get qualified
    // with their endpoint id rather than one silently shadowing the other.
    const nameCounts = new Map<string, number>();
    for (const entry of perServer) {
      for (const tool of entry.tools) {
        if (tool?.name) nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
      }
    }

    routes.clear();
    const approved: ApprovedTool[] = [];
    const rejected: RejectedTool[] = [];
    const statuses: ServerStatus[] = [];
    let discoveredCount = 0;

    for (const entry of perServer) {
      discoveredCount += entry.tools.length;
      const outcome = approveTools(entry.tools);
      rejected.push(...outcome.rejected);

      let exposedHere = 0;
      for (const tool of outcome.approved) {
        const ambiguous = (nameCounts.get(tool.name) ?? 0) > 1;
        const exposedName = ambiguous ? `${entry.connection.id}__${tool.name}` : tool.name;

        if (routes.has(exposedName)) {
          rejected.push({ name: exposedName, reason: 'duplicate tool name after qualification' });
          continue;
        }

        routes.set(exposedName, { connection: entry.connection, remoteName: tool.name });
        approved.push({ ...tool, name: exposedName });
        exposedHere += 1;
      }

      statuses.push({
        id: entry.connection.id,
        connected: entry.error === null,
        toolCount: exposedHere,
        ...(entry.error ? { error: entry.error } : {}),
      });
    }

    for (const failure of failures) {
      statuses.push({ id: failure.id, connected: false, toolCount: 0, error: describe(failure.error) });
    }

    log.info('salesforce-mcp', 'Tool discovery complete', {
      endpoints: statuses.map((status) => `${status.id}:${status.connected ? status.toolCount : 'unavailable'}`),
      approved: approved.map((tool) => tool.name),
      mutating: approved.filter((tool) => tool.mutating).map((tool) => tool.name),
      rejected,
    });

    discovery = { approved, rejected, discoveredCount, servers: statuses };
    return discovery;
  };

  return {
    listTools: discover,

    async callTool(name, args) {
      // Discovery may have been served from a cache upstream, in which case the
      // routing table for *this* session has not been built yet.
      if (routes.size === 0 && discovery === null) await discover();

      const route = routes.get(name);
      if (!route) {
        throw new McpError(`Tool "${name}" is not available on any configured MCP endpoint.`, 'call');
      }

      const result = await route.connection.withAuthRetry(
        (client) => client.callTool({ name: route.remoteName, arguments: args }, undefined, {
          timeout: config.limits.mcpTimeoutMs,
        }),
        'call',
      );
      return parseToolResult(result);
    },

    async close() {
      await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

interface RawContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * Flattens an MCP tool result into text Gemini can reason over.
 *
 * Hosted MCP returns data as JSON inside text blocks, sometimes alongside a
 * `structuredContent` object, so both are handled.
 */
export function parseToolResult(result: unknown): ParsedToolResult {
  const payload = (result ?? {}) as {
    content?: RawContentBlock[];
    structuredContent?: unknown;
    isError?: boolean;
  };

  const isError = payload.isError === true;

  const textBlocks = (payload.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);

  // Prefer a structured payload; fall back to JSON embedded in the text blocks.
  let data: unknown = payload.structuredContent;
  if (data === undefined) {
    for (const block of textBlocks) {
      const parsed = tryParseJson(block);
      if (parsed !== undefined) {
        data = parsed;
        break;
      }
    }
  }

  const recordCount = countRecords(data);

  const rendered = data !== undefined ? safeStringify(data) : textBlocks.join('\n\n');
  const body = rendered.trim() || (isError ? 'The tool reported an error with no detail.' : 'No content returned.');

  const limit = config.limits.maxToolResultChars;
  const truncated = body.length > limit;

  return {
    text: truncated ? `${body.slice(0, limit)}\n…[truncated: result exceeded the size limit]` : body,
    data,
    recordCount,
    isError,
    truncated,
  };
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Derives a record count from the shapes Salesforce actually returns.
 *
 * Returns undefined rather than guessing: the UI only shows a count when it is
 * genuinely known.
 */
export function countRecords(data: unknown): number | undefined {
  if (Array.isArray(data)) return data.length;
  if (!data || typeof data !== 'object') return undefined;

  const record = data as Record<string, unknown>;

  for (const key of ['records', 'searchRecords', 'recentItems', 'results', 'items', 'data']) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }

  // `totalSize` can exceed the page actually returned, so only trust it when
  // there is no array to measure directly.
  if (typeof record.totalSize === 'number' && Number.isFinite(record.totalSize)) return record.totalSize;

  // Some servers wrap the real payload one level down.
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>).records;
      if (Array.isArray(nested)) return nested.length;
    }
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isUnauthorized(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 401) return true;
  return /\b401\b|unauthorized|invalid[_ ]token|invalid[_ ]auth[_ ]header|invalid[_ ]jwt/i.test(
    (error as Error).message ?? '',
  );
}

function toMcpError(error: unknown, stage: 'connect' | 'discover' | 'call'): McpError {
  // Auth problems carry their own guidance; keep them intact.
  if (error instanceof SalesforceAuthError) throw error;
  if (error instanceof McpError) return error;

  const message = describe(error);
  log.error('salesforce-mcp', `MCP ${stage} failed`, { message });

  if (isUnauthorized(error)) {
    return new McpError(
      'Salesforce rejected the access token. Confirm the External Client App issues JWT-based access tokens and includes the mcp_api scope.',
      stage,
    );
  }
  if (/\b404\b|not found/i.test(message)) {
    return new McpError(
      'The Salesforce MCP endpoint was not found. Confirm the URL matches your org type and that the server is activated in Setup.',
      stage,
    );
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return new McpError(
      'Salesforce denied access to the MCP server. Check the dedicated user has permission to use it.',
      stage,
    );
  }
  if (/\b429\b|rate limit/i.test(message)) {
    return new McpError('Salesforce rate-limited the request. Please try again shortly.', stage, true);
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return new McpError('The Salesforce MCP request timed out.', stage, true);
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(message)) {
    return new McpError('Could not reach the Salesforce MCP endpoint. Check network connectivity.', stage, true);
  }

  return new McpError(`Salesforce MCP ${stage} failed: ${message}`, stage);
}

/** Endpoint paths can embed a My Domain name; keep only the server segment. */
function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…/${parsed.pathname.split('/').filter(Boolean).slice(-1)[0] ?? ''}`;
  } catch {
    return '[invalid url]';
  }
}
