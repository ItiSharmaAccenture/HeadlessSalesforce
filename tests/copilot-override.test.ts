/**
 * The COPILOT_TOOL_* escape hatch.
 *
 * Inference from schemas covers the orgs seen so far, but an org whose actions
 * publish too little can name the tools explicitly. Config is read at import
 * time, so each case re-imports with its own environment.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovedTool } from '@/lib/tool-allowlist';

function tool(name: string, properties: Record<string, unknown>): ApprovedTool {
  return {
    name,
    description: `The ${name} action.`,
    inputSchema: {
      type: 'object',
      properties: { inputs: { type: 'array', items: { type: 'object', properties: properties as never } } },
    },
  };
}

// Publishes nothing to infer from: no technician key, no status enum.
const opaque = tool('AcmeOpaqueapex_AcmeOpaque', { payload: { type: 'string' } });
const alsoOpaque = tool('AcmeOtherapex_AcmeOther', { payload: { type: 'string' } });

async function resolveWith(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { resolveCapabilities } = await import('@/lib/copilot-capabilities');
  return resolveCapabilities([opaque, alsoOpaque]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('capability overrides', () => {
  it('infers nothing from schemas that say nothing', async () => {
    const capabilities = await resolveWith({});

    expect(capabilities.schedule).toBeUndefined();
    expect(capabilities.status).toBeUndefined();
    expect(capabilities.close).toBeUndefined();
  });

  it('names the schedule tool when inference cannot', async () => {
    const capabilities = await resolveWith({ COPILOT_TOOL_SCHEDULE: 'AcmeOpaque' });
    expect(capabilities.schedule?.name).toBe(opaque.name);
  });

  it('matches on a case-insensitive substring of the tool name', async () => {
    const capabilities = await resolveWith({ COPILOT_TOOL_SCHEDULE: 'acmeother' });
    expect(capabilities.schedule?.name).toBe(alsoOpaque.name);
  });

  it('leaves the capability unresolved when the override matches nothing', async () => {
    // A typo degrades honestly rather than silently picking some other tool.
    const capabilities = await resolveWith({ COPILOT_TOOL_SCHEDULE: 'does-not-exist' });
    expect(capabilities.schedule).toBeUndefined();
  });

  it('overrides inference when both would resolve', async () => {
    vi.resetModules();
    vi.stubEnv('COPILOT_TOOL_SCHEDULE', 'AcmeOther');
    const { resolveCapabilities } = await import('@/lib/copilot-capabilities');

    const inferable = tool('RealScheduleapex_RealSchedule', { technicianName: { type: 'string' } });
    expect(resolveCapabilities([inferable, alsoOpaque]).schedule?.name).toBe(alsoOpaque.name);
  });
});
