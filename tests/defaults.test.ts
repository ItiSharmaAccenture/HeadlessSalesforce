/**
 * Guards the shipped defaults.
 *
 * The defaults now delegate access control to Salesforce, so what these tests
 * pin down is the opposite of before: that nothing is silently filtered out,
 * and that the limits which are *not* access control (row caps, tool rounds)
 * are still in force.
 */

import { describe, expect, it } from 'vitest';

import { config, isUnrestricted } from '@/lib/config';
import { approveTools, defaultPolicy, validateSoql, validateToolArguments } from '@/lib/tool-allowlist';
import { acquire, resetRateLimiter } from '@/lib/rate-limit';

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };

function discovered(names: string[]) {
  return names.map((name) => ({ name, description: `The ${name} tool.`, inputSchema: schema }));
}

describe('default policy', () => {
  it('delegates object access to Salesforce', () => {
    expect(isUnrestricted(config.allowedObjects)).toBe(true);
  });

  it('delegates tool selection to Salesforce', () => {
    expect(isUnrestricted(config.toolAllowlist)).toBe(true);
  });

  it('ships an empty blocklist, so nothing is filtered out unannounced', () => {
    expect(config.toolBlocklist).toEqual([]);
  });

  it('admits the full sobject-all tool set, writes included', () => {
    const names = [
      'soqlQuery',
      'find',
      'getObjectSchema',
      'getRelatedRecords',
      'listRecentSobjectRecords',
      'getUserInfo',
      'createSobjectRecord',
      'updateSobjectRecord',
      'updateRelatedRecord',
      'deleteSobjectRecord',
      'deleteRelatedRecord',
    ];

    const { approved, rejected } = approveTools(discovered(names), defaultPolicy());

    expect(rejected).toEqual([]);
    expect(approved.map((tool) => tool.name)).toEqual(names);
  });

  it('admits tools from a custom MCP server that this code has never seen', () => {
    const { approved, rejected } = approveTools(discovered(['submitInvoice__c', 'runCreditCheck']), defaultPolicy());

    expect(rejected).toEqual([]);
    expect(approved).toHaveLength(2);
  });

  it('flags the destructive tools so the operator and the model can see them', () => {
    const { approved } = approveTools(discovered(['soqlQuery', 'deleteSobjectRecord']), defaultPolicy());

    expect(approved.find((tool) => tool.name === 'soqlQuery')?.mutating).toBe(false);
    expect(approved.find((tool) => tool.name === 'deleteSobjectRecord')?.mutating).toBe(true);
  });

  it('caps tool rounds so the loop cannot run away', () => {
    expect(config.limits.maxToolRounds).toBeGreaterThan(0);
    expect(config.limits.maxToolRounds).toBeLessThanOrEqual(5);
  });

  it('caps rows on a query that asks for none, whatever the object', () => {
    const result = validateSoql('SELECT Id FROM Lead');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe(`SELECT Id FROM Lead LIMIT ${config.limits.maxRecords}`);
  });

  it('no longer refuses an object outside the old Account/Opportunity pair', () => {
    const result = validateToolArguments(
      { name: 'soqlQuery', description: 'x', inputSchema: schema },
      { query: 'SELECT Id FROM Lead' },
    );

    expect(result.ok).toBe(true);
  });
});

describe('rate limiting', () => {
  it('admits a request and releases the slot', () => {
    resetRateLimiter();
    const gate = acquire('test-client');

    expect(gate.ok).toBe(true);
    if (gate.ok) gate.release();
  });

  it('caps concurrent turns', () => {
    resetRateLimiter();

    const held = Array.from({ length: config.limits.maxConcurrentChats }, () => acquire('test-client'));
    expect(held.every((gate) => gate.ok)).toBe(true);

    const blocked = acquire('test-client');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/busy/i);

    for (const gate of held) if (gate.ok) gate.release();
    expect(acquire('test-client').ok).toBe(true);
  });

  it('does not charge quota for a request refused on concurrency', () => {
    resetRateLimiter();

    const held = Array.from({ length: config.limits.maxConcurrentChats }, () => acquire('quota-client'));
    // Refused while busy; these must not count against the window.
    for (let i = 0; i < 50; i += 1) expect(acquire('quota-client').ok).toBe(false);
    for (const gate of held) if (gate.ok) gate.release();

    expect(acquire('quota-client').ok).toBe(true);
  });

  it('enforces the fixed window once the request budget is spent', () => {
    resetRateLimiter();

    for (let i = 0; i < config.limits.rateLimitRequests; i += 1) {
      const gate = acquire('busy-client');
      expect(gate.ok).toBe(true);
      if (gate.ok) gate.release();
    }

    const blocked = acquire('busy-client');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/Too many requests/);
  });

  it('tracks each client independently', () => {
    resetRateLimiter();

    for (let i = 0; i < config.limits.rateLimitRequests; i += 1) {
      const gate = acquire('client-a');
      if (gate.ok) gate.release();
    }

    expect(acquire('client-a').ok).toBe(false);
    expect(acquire('client-b').ok).toBe(true);
  });

  it('releases idempotently, so a double release cannot free a phantom slot', () => {
    resetRateLimiter();

    const gate = acquire('test-client');
    if (gate.ok) {
      gate.release();
      gate.release();
    }

    const held = Array.from({ length: config.limits.maxConcurrentChats }, () => acquire('test-client'));
    expect(held.every((entry) => entry.ok)).toBe(true);
    expect(acquire('test-client').ok).toBe(false);
  });
});
