/**
 * GET /api/health
 *
 * Sanitised readiness report. "Connected" is only ever reported after a real
 * MCP handshake and tool discovery have succeeded — never from the mere
 * presence of environment variables.
 */

import { config } from '@/lib/config';
import { log } from '@/lib/logger';
import { getAuthorizationStatus } from '@/lib/salesforce-auth';
import { openMcpSession, type ServerStatus } from '@/lib/salesforce-mcp';
import type { HealthResponse } from '@/types/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The MCP handshake is a real round trip; don't repeat it on every poll. */
const PROBE_TTL_MS = 30_000;

type Probe = {
  reachable: boolean;
  toolCount: number | null;
  detail: string;
  endpoints?: ServerStatus[];
};

let probeCache: { at: number; result: Probe } | null = null;

async function probeMcp(): Promise<Probe> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.result;

  let session = null;
  try {
    session = await openMcpSession();
    const { approved, rejected, discoveredCount, servers } = await session.listTools();

    const unreachable = servers.filter((server) => !server.connected);
    const endpointNote =
      unreachable.length > 0 ? ` ${unreachable.length} of ${servers.length} endpoints unreachable.` : '';

    const result: Probe = approved.length
      ? {
          reachable: true,
          toolCount: approved.length,
          detail:
            `Connected. ${approved.length} of ${discoveredCount} discovered tools available` +
            `${rejected.length > 0 ? `, ${rejected.length} filtered out by policy` : ''}.${endpointNote}`,
          endpoints: servers,
        }
      : {
          reachable: true,
          toolCount: 0,
          detail:
            discoveredCount === 0
              ? `Connected, but no tools were returned.${endpointNote} Confirm the MCP servers are activated and the dedicated user may use them.`
              : `Connected, but all ${discoveredCount} discovered tools were filtered out by policy. Check SALESFORCE_TOOL_ALLOWLIST and SALESFORCE_TOOL_BLOCKLIST.`,
          endpoints: servers,
        };

    probeCache = { at: Date.now(), result };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('health', 'MCP probe failed', { message });

    const result: Probe = { reachable: false, toolCount: null, detail: message };
    probeCache = { at: Date.now(), result };
    return result;
  } finally {
    await session?.close().catch(() => undefined);
  }
}

export async function GET(): Promise<Response> {
  const geminiConfigured = Boolean(config.gemini.apiKey);
  const mcpConfigured = Boolean(config.salesforce.mcpServers.length > 0 && config.salesforce.clientId);

  const auth = await getAuthorizationStatus();

  // Probing only makes sense once there is a token to probe with.
  const mcp: Probe =
    auth.authorized && mcpConfigured ? await probeMcp() : { reachable: false, toolCount: null, detail: '' };

  const body: HealthResponse = {
    status:
      geminiConfigured && mcp.reachable && (mcp.toolCount ?? 0) > 0
        ? 'connected'
        : !geminiConfigured || !mcpConfigured || !auth.authorized
          ? 'configuration_required'
          : 'connection_failed',

    checks: {
      gemini: {
        configured: geminiConfigured,
        model: geminiConfigured ? config.gemini.model : null,
        detail: geminiConfigured
          ? `API key present. Model: ${config.gemini.model}.`
          : 'GEMINI_API_KEY is not set in .env.local.',
      },
      salesforceOAuth: {
        authorized: auth.authorized,
        detail: auth.authorized
          ? `Authorized${auth.hasRefreshToken ? ' with a refresh token' : ' without a refresh token (it will expire)'}.`
          : config.salesforce.clientId
            ? 'Not authorized yet. Run the one-time setup at /api/auth/salesforce?secret=...'
            : 'SALESFORCE_CLIENT_ID is not set in .env.local.',
      },
      salesforceMcp: {
        configured: mcpConfigured,
        reachable: mcp.reachable,
        toolCount: mcp.toolCount,
        detail:
          mcp.detail ||
          (mcpConfigured
            ? 'Not probed: complete the Salesforce authorization first.'
            : 'SALESFORCE_MCP_URLS or SALESFORCE_CLIENT_ID is not configured.'),
        ...(mcp.endpoints ? { endpoints: mcp.endpoints } : {}),
      },
    },
  };

  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
