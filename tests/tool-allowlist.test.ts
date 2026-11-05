/**
 * Two policies are exercised here.
 *
 * `open` is the shipped default: access is delegated to Salesforce, so the only
 * things that must still hold are schema validation and the row cap.
 *
 * `restricted` is what you get by setting SALESFORCE_ALLOWED_OBJECTS and
 * SALESFORCE_TOOL_ALLOWLIST explicitly. Every one of the original fail-closed
 * checks has to keep working in that mode, so those tests are kept in full.
 */

import { describe, expect, it } from 'vitest';

import {
  approveTools,
  looksMutating,
  validateSoql,
  validateSosl,
  validateToolArguments,
  type ApprovedTool,
  type DiscoveredTool,
  type Policy,
} from '@/lib/tool-allowlist';

const restricted: Policy = {
  allowlist: ['getObjectSchema', 'soqlQuery', 'find', 'listRecentSobjectRecords', 'getRelatedRecords'],
  blocklist: [],
  allowedObjects: ['Account', 'Opportunity'],
  allowedRelationships: ['Account', 'Opportunity', 'Opportunities'],
  maxRecords: 50,
};

const open: Policy = {
  allowlist: ['*'],
  blocklist: [],
  allowedObjects: ['*'],
  allowedRelationships: ['*'],
  maxRecords: 50,
};

const objectSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };

function tool(name: string, overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return { name, description: `${name} tool`, inputSchema: objectSchema, ...overrides };
}

function approved(name: string, schema: Record<string, unknown> = objectSchema): ApprovedTool {
  return { name, description: `${name} tool`, inputSchema: schema };
}

/* ------------------------------------------------------------------ */
/* Default policy: Salesforce decides                                  */
/* ------------------------------------------------------------------ */

describe('approveTools under the default open policy', () => {
  it('admits every discovered tool, including ones that write', () => {
    const { approved: ok, rejected } = approveTools(
      [tool('soqlQuery'), tool('createSobjectRecord'), tool('deleteSobjectRecord'), tool('executeFlow')],
      open,
    );

    expect(ok.map((entry) => entry.name)).toEqual([
      'soqlQuery',
      'createSobjectRecord',
      'deleteSobjectRecord',
      'executeFlow',
    ]);
    expect(rejected).toEqual([]);
  });

  it('admits a custom tool whose name and schema were never anticipated', () => {
    const custom = tool('AcmeQuoteApproval__c_submit', {
      inputSchema: { type: 'object', properties: { quoteId: { type: 'string' } }, required: ['quoteId'] },
    });

    const { approved: ok } = approveTools([custom], open);
    expect(ok.map((entry) => entry.name)).toEqual(['AcmeQuoteApproval__c_submit']);
  });

  it('labels which tools can modify data without blocking them', () => {
    const { approved: ok } = approveTools([tool('soqlQuery'), tool('deleteSobjectRecord')], open);

    expect(ok.find((entry) => entry.name === 'soqlQuery')?.mutating).toBe(false);
    expect(ok.find((entry) => entry.name === 'deleteSobjectRecord')?.mutating).toBe(true);
  });

  it('trusts the server annotation over the tool name when classifying', () => {
    expect(looksMutating({ name: 'sendSummary', annotations: { readOnlyHint: true } })).toBe(false);
    expect(looksMutating({ name: 'lookupRecord', annotations: { destructiveHint: true } })).toBe(true);
  });

  it('accepts a tool that published no input schema, treating it as taking none', () => {
    const { approved: ok, rejected } = approveTools([{ name: 'getOrgLimits', description: 'x' }], open);

    expect(rejected).toEqual([]);
    expect(ok[0].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('still rejects a schema that is not object-shaped, which Gemini cannot represent', () => {
    const { rejected } = approveTools([tool('weird', { inputSchema: { type: 'string' } })], open);
    expect(rejected[0].reason).toMatch(/unsupported input schema type/i);
  });

  it('still rejects an unnamed tool', () => {
    const { rejected } = approveTools([{ name: '' } as DiscoveredTool], open);
    expect(rejected[0].reason).toMatch(/no name/i);
  });

  it('honours the blocklist, so a single tool can be pinned off', () => {
    const policy: Policy = { ...open, blocklist: ['deleteSobjectRecord'] };
    const { approved: ok, rejected } = approveTools([tool('soqlQuery'), tool('deleteSobjectRecord')], policy);

    expect(ok.map((entry) => entry.name)).toEqual(['soqlQuery']);
    expect(rejected[0].reason).toMatch(/blocklist/i);
  });

  it('matches the blocklist case-insensitively', () => {
    const policy: Policy = { ...open, blocklist: ['DELETESOBJECTRECORD'] };
    const { approved: ok } = approveTools([tool('deleteSobjectRecord')], policy);
    expect(ok).toHaveLength(0);
  });
});

describe('argument validation under the default open policy', () => {
  it('permits a query against any object and still caps the row count', () => {
    const result = validateSoql('SELECT Id, Subject FROM Case', open);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('SELECT Id, Subject FROM Case LIMIT 50');
  });

  it('permits a custom object', () => {
    expect(validateSoql('SELECT Id FROM Invoice__c', open).ok).toBe(true);
  });

  it('permits a traversal that the restricted policy refuses', () => {
    expect(validateSoql('SELECT Id, Owner.Email FROM Opportunity', open).ok).toBe(true);
    expect(validateSoql('SELECT Id, Owner.Email FROM Opportunity', restricted).ok).toBe(false);
  });

  it('permits TYPEOF, since there is no longer a narrower set to protect', () => {
    expect(validateSoql('SELECT TYPEOF What WHEN Account THEN Name END FROM Event', open).ok).toBe(true);
  });

  it('permits an unscoped SOSL search but still caps it', () => {
    const result = validateSosl('FIND {Acme}', open);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('FIND {Acme} LIMIT 50');
  });

  it('permits a call that names no object at all', () => {
    const schema = { type: 'object', properties: { limit: { type: 'number' } } };
    const result = validateToolArguments(approved('listRecentSobjectRecords', schema), { limit: 5 }, open);

    expect(result.ok).toBe(true);
  });

  it('permits arguments naming any object', () => {
    const schema = { type: 'object', properties: { sobjectName: { type: 'string' } } };
    expect(validateToolArguments(approved('getObjectSchema', schema), { sobjectName: 'Contact' }, open).ok).toBe(true);
  });

  it('keeps rejecting stacked statements, which are never a legitimate single call', () => {
    const result = validateSoql('SELECT Id FROM Account; DELETE FROM Account', open);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/single SOQL statement/i);
  });

  it('keeps enforcing the published schema', () => {
    expect(validateToolArguments(approved('soqlQuery'), {}, open).ok).toBe(false);
    expect(validateToolArguments(approved('soqlQuery'), { query: 42 }, open).ok).toBe(false);
    expect(validateToolArguments(approved('soqlQuery'), 'not an object', open).ok).toBe(false);
  });

  it('still drops arguments the published schema does not declare', () => {
    const result = validateToolArguments(approved('soqlQuery'), { query: 'SELECT Id FROM Case', extra: true }, open);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args).not.toHaveProperty('extra');
  });

  it('caps every entry of a string array argument', () => {
    const schema = { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } };
    const result = validateToolArguments(
      approved('multiQuery', schema),
      { queries: ['SELECT Id FROM Case LIMIT 900', 'SELECT Id FROM Lead'] },
      open,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.queries).toEqual(['SELECT Id FROM Case LIMIT 50', 'SELECT Id FROM Lead LIMIT 50']);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Restricted policy: the application enforces a narrower set          */
/* ------------------------------------------------------------------ */

describe('approveTools under an explicit allowlist', () => {
  it('approves only allowlisted tools from the discovered set', () => {
    const { approved: ok, rejected } = approveTools(
      [tool('soqlQuery'), tool('getObjectSchema'), tool('createSobjectRecord'), tool('deleteSobjectRecord')],
      restricted,
    );

    expect(ok.map((entry) => entry.name)).toEqual(['soqlQuery', 'getObjectSchema']);
    expect(rejected.map((entry) => entry.name)).toEqual(['createSobjectRecord', 'deleteSobjectRecord']);
  });

  it('rejects a tool that is not in the allowlist even when it looks read-only', () => {
    const { approved: ok, rejected } = approveTools([tool('getUserInfo')], restricted);

    expect(ok).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/allowlist/i);
  });
});

describe('validateSoql under a restricted policy', () => {
  it('permits a query against an allowed object and caps the row count', () => {
    const result = validateSoql('SELECT Id, Name FROM Account', restricted);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('SELECT Id, Name FROM Account LIMIT 50');
  });

  it('lowers a LIMIT that exceeds the cap', () => {
    const result = validateSoql('SELECT Id FROM Opportunity ORDER BY Amount DESC LIMIT 5000', restricted);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('SELECT Id FROM Opportunity ORDER BY Amount DESC LIMIT 50');
  });

  it('leaves a LIMIT below the cap alone', () => {
    const result = validateSoql('SELECT Id FROM Opportunity LIMIT 5', restricted);
    if (result.ok) expect(result.query).toBe('SELECT Id FROM Opportunity LIMIT 5');
  });

  it('inserts LIMIT before an existing OFFSET, which SOQL requires', () => {
    const result = validateSoql('SELECT Id FROM Account OFFSET 10', restricted);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('SELECT Id FROM Account LIMIT 50 OFFSET 10');
  });

  it('rejects a query against an object outside the allowed set', () => {
    const result = validateSoql('SELECT Id, Email FROM Contact', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only query Account and Opportunity/i);
  });

  it('rejects a semi-join subquery on a disallowed object', () => {
    const result = validateSoql(
      'SELECT Id FROM Opportunity WHERE AccountId IN (SELECT AccountId FROM Contact)',
      restricted,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subquery on "Contact"/i);
  });

  it('permits a child subquery on an allowed relationship', () => {
    const result = validateSoql('SELECT Id, (SELECT Id, Amount FROM Opportunities) FROM Account', restricted);
    expect(result.ok).toBe(true);
  });

  it('permits a parent traversal to an allowed relationship', () => {
    const result = validateSoql('SELECT Id, Account.Name FROM Opportunity', restricted);
    expect(result.ok).toBe(true);
  });

  it('rejects a traversal into an object outside the allowed set', () => {
    const result = validateSoql('SELECT Id, Owner.Email FROM Opportunity', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/traverses the "Owner" relationship/i);
  });

  it('does not treat a decimal number in a filter as a relationship traversal', () => {
    const result = validateSoql('SELECT Id FROM Opportunity WHERE Amount > 1000.50', restricted);
    expect(result.ok).toBe(true);
  });

  it('ignores a disallowed object name that only appears inside a string literal', () => {
    const result = validateSoql("SELECT Id FROM Account WHERE Name = 'Contact Industries'", restricted);
    expect(result.ok).toBe(true);
  });

  it('is not fooled by a disallowed FROM hidden after an escaped quote', () => {
    const result = validateSoql(
      "SELECT Id FROM Account WHERE Name = 'O\\'Brien' AND Id IN (SELECT Id FROM User)",
      restricted,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subquery on "User"/i);
  });

  it('rejects stacked statements', () => {
    const result = validateSoql('SELECT Id FROM Account; SELECT Id FROM User', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/single SOQL statement/i);
  });

  it('rejects TYPEOF, which can return unlisted objects', () => {
    const result = validateSoql('SELECT TYPEOF What WHEN Account THEN Name END FROM Opportunity', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/TYPEOF/);
  });

  it('rejects an empty query', () => {
    expect(validateSoql('   ', restricted).ok).toBe(false);
  });
});

describe('validateSosl under a restricted policy', () => {
  it('permits a search scoped with RETURNING', () => {
    const result = validateSosl('FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)', restricted);
    expect(result.ok).toBe(true);
  });

  it('rejects a search with no RETURNING clause, which would span the whole org', () => {
    const result = validateSosl('FIND {Acme}', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/RETURNING/);
  });

  it('rejects a search returning a disallowed object', () => {
    const result = validateSosl('FIND {Acme} RETURNING Account(Id), Lead(Id)', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/returns "Lead"/i);
  });

  it('caps the row count on a search', () => {
    const result = validateSosl('FIND {Acme} RETURNING Opportunity(Id) LIMIT 900', restricted);
    if (result.ok) expect(result.query).toMatch(/LIMIT 50$/);
  });
});

describe('validateToolArguments under a restricted policy', () => {
  it('accepts a scoped SOQL argument and returns the capped query', () => {
    const result = validateToolArguments(approved('soqlQuery'), { query: 'SELECT Id FROM Account' }, restricted);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.query).toBe('SELECT Id FROM Account LIMIT 50');
  });

  it('refuses a call that identifies no permitted object', () => {
    const schema = { type: 'object', properties: { limit: { type: 'number' } } };
    const result = validateToolArguments(approved('listRecentSobjectRecords', schema), { limit: 5 }, restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/did not identify one of those objects/i);
  });

  it('accepts an object named through a schema property', () => {
    const schema = { type: 'object', properties: { sobjectType: { type: 'string' } }, required: ['sobjectType'] };
    const result = validateToolArguments(
      approved('listRecentSobjectRecords', schema),
      { sobjectType: 'Opportunity' },
      restricted,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects an object outside the allowed set', () => {
    const schema = { type: 'object', properties: { sobjectName: { type: 'string' } } };
    const result = validateToolArguments(approved('getObjectSchema', schema), { sobjectName: 'Contact' }, restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not "Contact"/);
  });

  it('rejects a relationship outside the allowed set', () => {
    const schema = {
      type: 'object',
      properties: { sobjectType: { type: 'string' }, relationshipName: { type: 'string' } },
    };
    const result = validateToolArguments(
      approved('getRelatedRecords', schema),
      { sobjectType: 'Account', relationshipName: 'Contacts' },
      restricted,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Relationship "Contacts"/);
  });

  it('validates every entry of a string array argument', () => {
    const schema = { type: 'object', properties: { sobjects: { type: 'array', items: { type: 'string' } } } };
    const result = validateToolArguments(
      approved('getObjectSchema', schema),
      { sobjects: ['Account', 'Contact'] },
      restricted,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not "Contact"/);
  });

  it('drops arguments the published schema does not declare', () => {
    const result = validateToolArguments(
      approved('soqlQuery'),
      { query: 'SELECT Id FROM Account', allOrNone: true },
      restricted,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).not.toHaveProperty('allOrNone');
      expect(result.notes.join(' ')).toMatch(/allOrNone/);
    }
  });

  it('reports a missing required argument', () => {
    const result = validateToolArguments(approved('soqlQuery'), {}, restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Missing required argument "query"/);
  });

  it('reports an argument of the wrong type', () => {
    const result = validateToolArguments(approved('soqlQuery'), { query: 42 }, restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must be of type string/);
  });

  it('refuses non-object arguments outright', () => {
    const result = validateToolArguments(approved('soqlQuery'), 'SELECT Id FROM Account', restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must be a JSON object/);
  });

  it('blocks a disallowed query even when the tool itself is approved', () => {
    const result = validateToolArguments(approved('soqlQuery'), { query: 'SELECT Id FROM User' }, restricted);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only query Account and Opportunity/i);
  });
});
