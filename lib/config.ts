/**
 * Central configuration. Every value is read from the environment so that a
 * missing credential becomes a documented setup step rather than a code change.
 *
 * Nothing in this module may be imported from a client component: it reads
 * secrets that must never reach the browser.
 */

import 'server-only';

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const raw = optional(name);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * `*` means "do not restrict this dimension" — access is left to Salesforce.
 * An empty list means the same thing, so an unset variable cannot accidentally
 * lock the assistant out of everything.
 */
export function isUnrestricted(values: readonly string[]): boolean {
  return values.length === 0 || values.includes('*');
}

/** A short, stable id for an MCP endpoint, used to disambiguate tool names. */
function serverId(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? 'mcp';
    return last.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) || 'mcp';
  } catch {
    return 'mcp';
  }
}

export interface McpServerConfig {
  id: string;
  url: string;
}

/**
 * Every MCP endpoint the assistant may use.
 *
 * `SALESFORCE_MCP_URLS` takes a comma-separated list so that custom MCP servers
 * activated in the org can be added alongside the standard one. The older
 * single-valued `SALESFORCE_MCP_URL` still works.
 */
function mcpServers(): McpServerConfig[] {
  const urls = list('SALESFORCE_MCP_URLS', []);
  const single = optional('SALESFORCE_MCP_URL');
  const resolved = urls.length > 0 ? urls : single ? [single] : [];

  const seen = new Set<string>();
  return resolved.map((url) => {
    let id = serverId(url);
    // Two endpoints can end in the same segment; keep ids unique regardless.
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${id}_${suffix}`)) suffix += 1;
      id = `${id}_${suffix}`;
    }
    seen.add(id);
    return { id, url };
  });
}

export const config = {
  gemini: {
    apiKey: optional('GEMINI_API_KEY'),
    /**
     * `gemini-flash-latest` is an alias that tracks the current Flash model, so
     * the POC does not pin a version that can be deprecated. Override with
     * GEMINI_MODEL to use a specific free-tier Flash release.
     */
    model: optional('GEMINI_MODEL') ?? 'gemini-flash-latest',
  },

  salesforce: {
    clientId: optional('SALESFORCE_CLIENT_ID'),
    /** Omitted entirely when the External Client App is configured as a public PKCE client. */
    clientSecret: optional('SALESFORCE_CLIENT_SECRET'),
    loginUrl: (optional('SALESFORCE_LOGIN_URL') ?? 'https://login.salesforce.com').replace(/\/+$/, ''),
    redirectUri: optional('SALESFORCE_REDIRECT_URI') ?? 'http://localhost:3000/api/auth/callback/salesforce',
    /**
     * Hosted MCP endpoints. Sandboxes and My Domain orgs use different paths,
     * and an org can activate custom MCP servers alongside the standard ones,
     * so this is a configurable list rather than a derived single value.
     */
    mcpServers: mcpServers(),
    scopes: list('SALESFORCE_SCOPES', ['mcp_api', 'refresh_token', 'offline_access']),
  },

  setup: {
    secret: optional('SETUP_SECRET'),
    /**
     * Lets the one-time authorization run on a deployed host instead of
     * localhost. Off by default: the setup routes are an operator tool, and on
     * a public URL the authorize route is protected only by SETUP_SECRET.
     */
    allowRemote: optional('ALLOW_REMOTE_SETUP') === 'true',
  },

  /** Guardrails. These are safety limits, not tuning knobs. */
  limits: {
    maxToolRounds: num('MAX_TOOL_ROUNDS', 5),
    /** Upper bound injected into every SOQL query to cap response size. */
    maxRecords: num('MAX_RECORDS', 50),
    /** Characters of tool output handed back to Gemini. */
    maxToolResultChars: num('MAX_TOOL_RESULT_CHARS', 12000),
    maxMessageChars: num('MAX_MESSAGE_CHARS', 4000),
    maxHistoryTurns: num('MAX_HISTORY_TURNS', 12),
    maxConcurrentChats: num('MAX_CONCURRENT_CHATS', 2),
    /** Simple fixed-window rate limit for the single-process POC. */
    rateLimitRequests: num('RATE_LIMIT_REQUESTS', 20),
    rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    mcpTimeoutMs: num('MCP_TIMEOUT_MS', 30_000),
  },

  /**
   * Objects the assistant may touch. `*` delegates the decision to Salesforce,
   * where the dedicated user's profile and permission sets are the real control
   * plane. Set an explicit list to re-impose an application-side restriction.
   */
  allowedObjects: list('SALESFORCE_ALLOWED_OBJECTS', ['*']),

  /**
   * Relationship names permitted as a traversal prefix (`Account.Name`) or as a
   * child subquery target (`(SELECT ... FROM Opportunities)`). Only consulted
   * when SALESFORCE_ALLOWED_OBJECTS is itself restricted.
   */
  allowedRelationships: list('SALESFORCE_ALLOWED_RELATIONSHIPS', ['*']),

  /**
   * Which discovered MCP tools may be exposed to Gemini. `*` admits every tool
   * the server offers the dedicated user, including custom MCP servers whose
   * tool names are not known ahead of time. Tools are always discovered via
   * tools/list; this list only filters what discovery returned.
   */
  toolAllowlist: list('SALESFORCE_TOOL_ALLOWLIST', ['*']),

  /**
   * Blocklist applied after the allowlist, for pinning off individual tools
   * without having to enumerate every tool you do want.
   */
  toolBlocklist: list('SALESFORCE_TOOL_BLOCKLIST', []),

  /**
   * Optional overrides for the My Day Copilot's capability detection, matched
   * as a case-insensitive substring of the tool name.
   *
   * Normally left unset: capabilities are inferred from the published schemas
   * (see lib/copilot-capabilities.ts). Set one only when an org's schemas do
   * not expose enough to infer from, or to force a particular tool.
   */
  copilotTools: {
    schedule: optional('COPILOT_TOOL_SCHEDULE'),
    status: optional('COPILOT_TOOL_STATUS'),
    close: optional('COPILOT_TOOL_CLOSE'),
  },

  appName: process.env.NEXT_PUBLIC_APP_NAME ?? 'Salesforce AI Sales Assistant',
} as const;

/** True when the OAuth app is configured as a confidential client. */
export function hasClientSecret(): boolean {
  return Boolean(config.salesforce.clientSecret);
}
