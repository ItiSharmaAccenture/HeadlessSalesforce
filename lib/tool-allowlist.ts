/**
 * Server-side policy for Salesforce Hosted MCP tools.
 *
 * By default this module imposes no access restriction of its own: which
 * objects can be read, and which tools can be run, is decided by Salesforce
 * through the dedicated user's profile, permission sets and sharing rules.
 * The org is the control plane, not this application.
 *
 * What it still does, unconditionally:
 *   - validates arguments against the schema the server published, so a
 *     malformed call fails here rather than at Salesforce;
 *   - caps row counts, so one query cannot return an unbounded payload into
 *     Gemini's context window.
 *
 * What it does only when configured to:
 *   - restricts objects, relationships and tool names. Set
 *     SALESFORCE_ALLOWED_OBJECTS / SALESFORCE_TOOL_ALLOWLIST to something other
 *     than `*` and every check below re-engages, fail-closed, as before.
 */

import { config, isUnrestricted } from './config';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

/** A tool as returned by MCP `tools/list`. */
export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

export interface ApprovedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when the server flagged the tool as mutating. Surfaced, not blocked. */
  mutating?: boolean;
}

export interface RejectedTool {
  name: string;
  reason: string;
}

export interface ToolApprovalResult {
  approved: ApprovedTool[];
  rejected: RejectedTool[];
}

export type ValidationResult =
  | { ok: true; args: Record<string, unknown>; notes: string[] }
  | { ok: false; reason: string };

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

export interface Policy {
  allowlist: readonly string[];
  blocklist: readonly string[];
  allowedObjects: readonly string[];
  allowedRelationships: readonly string[];
  maxRecords: number;
}

export function defaultPolicy(): Policy {
  return {
    allowlist: config.toolAllowlist,
    blocklist: config.toolBlocklist,
    allowedObjects: config.allowedObjects,
    allowedRelationships: config.allowedRelationships,
    maxRecords: config.limits.maxRecords,
  };
}

/** True when the policy leaves object access entirely to Salesforce. */
function objectsUnrestricted(policy: Policy): boolean {
  return isUnrestricted(policy.allowedObjects);
}

/**
 * Verbs that indicate a tool mutates data. No longer used to block anything —
 * it labels tools so the operator can see in the log which of them can write.
 */
const MUTATION_NAME_PATTERN =
  /(create|update|delete|insert|upsert|write|modify|remove|destroy|execute|apex|dml|merge|convert|undelete|assign|publish|send|patch|put|post)/i;

/** Best-effort classification for logging and for the health endpoint. */
export function looksMutating(tool: DiscoveredTool): boolean {
  if (tool.annotations?.destructiveHint === true) return true;
  if (tool.annotations?.readOnlyHint === true) return false;
  if (tool.annotations?.readOnlyHint === false) return true;
  return MUTATION_NAME_PATTERN.test(tool.name ?? '');
}

/* ------------------------------------------------------------------ */
/* Gate 1: approval                                                    */
/* ------------------------------------------------------------------ */

/**
 * Filters dynamically discovered tools down to the ones to expose to Gemini.
 *
 * Tool names and schemas are never assumed — they come from `tools/list`. With
 * the default `*` allowlist this admits everything the server offers, which is
 * what lets custom MCP servers work without being enumerated here first.
 */
export function approveTools(discovered: DiscoveredTool[], policy: Policy = defaultPolicy()): ToolApprovalResult {
  const approved: ApprovedTool[] = [];
  const rejected: RejectedTool[] = [];

  for (const tool of discovered) {
    const reason = rejectionReason(tool, policy);
    if (reason) {
      rejected.push({ name: tool.name ?? '(unnamed)', reason });
      continue;
    }

    approved.push({
      name: tool.name,
      description: tool.description?.trim() ?? '',
      inputSchema: normaliseSchema(tool.inputSchema),
      mutating: looksMutating(tool),
    });
  }

  return { approved, rejected };
}

function rejectionReason(tool: DiscoveredTool, policy: Policy): string | null {
  if (!tool.name) return 'tool has no name';

  if (policy.blocklist.some((entry) => entry.toLowerCase() === tool.name.toLowerCase())) {
    return 'blocked by SALESFORCE_TOOL_BLOCKLIST';
  }

  if (!isUnrestricted(policy.allowlist) && !policy.allowlist.includes(tool.name)) {
    return 'not in SALESFORCE_TOOL_ALLOWLIST';
  }

  // Gemini function declarations need object-shaped parameters. A tool that
  // publishes a scalar schema cannot be represented, so it is skipped.
  const schema = tool.inputSchema;
  if (schema && typeof schema === 'object' && schema.type && schema.type !== 'object') {
    return `unsupported input schema type "${schema.type}"`;
  }

  return null;
}

/** A missing or partial schema becomes an empty object schema, not a rejection. */
function normaliseSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return schema;
}

/* ------------------------------------------------------------------ */
/* Gate 2: argument validation                                         */
/* ------------------------------------------------------------------ */

/** Argument names that name a Salesforce object. */
function isObjectKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '');
  if (['object', 'entity', 'sobject', 'sobjects', 'objects'].includes(normalised)) return true;
  return /(sobject|objectapi|objectname|objecttype|entityname|entitytype|objectapiname)/.test(normalised);
}

function isRelationshipKey(key: string): boolean {
  return /relationship/i.test(key);
}

const SOQL_PATTERN = /\bSELECT\b[\s\S]*\bFROM\b/i;
const SOSL_PATTERN = /^\s*FIND\b/i;

/**
 * Validates and rewrites the arguments Gemini produced for an approved tool.
 *
 * Under the default policy this checks the arguments against the published
 * schema and caps row counts; it does not second-guess which records the
 * dedicated user is entitled to. When an object restriction is configured, the
 * call must additionally be *scoped* — something in the arguments must name a
 * permitted object — or it is refused rather than run org-wide.
 */
export function validateToolArguments(
  tool: ApprovedTool,
  rawArgs: unknown,
  policy: Policy = defaultPolicy(),
): ValidationResult {
  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    return { ok: false, reason: 'Tool arguments must be a JSON object.' };
  }

  const input = (rawArgs ?? {}) as Record<string, unknown>;
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  const knownKeys = Object.keys(properties);
  const notes: string[] = [];

  // Drop anything the published schema does not declare, unless the schema
  // explicitly opts into extra properties.
  const allowsExtra = schema.additionalProperties === true;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (knownKeys.length > 0 && !knownKeys.includes(key) && !allowsExtra) {
      notes.push(`ignored unknown argument "${key}"`);
      continue;
    }
    args[key] = value;
  }

  for (const key of schema.required ?? []) {
    if (!(key in args)) return { ok: false, reason: `Missing required argument "${key}".` };
  }

  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (expected && !matchesType(value, expected)) {
      return { ok: false, reason: `Argument "${key}" must be of type ${expected}.` };
    }
  }

  // Walk the arguments, validating and rewriting every object reference,
  // SOQL statement and SOSL search we find.
  let scoped = false;

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const outcome = inspectString(key, value, policy);
      if (!outcome.ok) return outcome;
      if (outcome.rewritten !== undefined) {
        if (outcome.rewritten !== value) notes.push(`capped results for "${key}" at ${policy.maxRecords} records`);
        args[key] = outcome.rewritten;
      }
      scoped ||= outcome.scoped;
      continue;
    }

    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      const rewritten: string[] = [];
      let changed = false;
      for (const entry of value as string[]) {
        const outcome = inspectString(key, entry, policy);
        if (!outcome.ok) return outcome;
        rewritten.push(outcome.rewritten ?? entry);
        if (outcome.rewritten !== undefined && outcome.rewritten !== entry) changed = true;
        scoped ||= outcome.scoped;
      }
      if (changed) {
        args[key] = rewritten;
        notes.push(`capped results for "${key}" at ${policy.maxRecords} records`);
      }
    }
  }

  // Only meaningful while an object restriction is in force; with `*` there is
  // no narrower set to insist on.
  if (!scoped && !objectsUnrestricted(policy)) {
    return {
      ok: false,
      reason:
        `This assistant may only access ${formatList(policy.allowedObjects)} records. ` +
        `The call to "${tool.name}" did not identify one of those objects, so it was not executed. ` +
        'Name the object explicitly, or use a SOQL query against it.',
    };
  }

  return { ok: true, args, notes };
}

type StringOutcome = { ok: true; scoped: boolean; rewritten?: string } | { ok: false; reason: string };

/** Classifies one string argument and validates it against the policy. */
function inspectString(key: string, value: string, policy: Policy): StringOutcome {
  if (SOSL_PATTERN.test(value)) {
    const result = validateSosl(value, policy);
    return result.ok ? { ok: true, scoped: true, rewritten: result.query } : result;
  }

  if (SOQL_PATTERN.test(value)) {
    const result = validateSoql(value, policy);
    return result.ok ? { ok: true, scoped: true, rewritten: result.query } : result;
  }

  if (objectsUnrestricted(policy)) return { ok: true, scoped: true };

  if (isRelationshipKey(key)) {
    if (
      !isUnrestricted(policy.allowedRelationships) &&
      !includesIgnoreCase(policy.allowedRelationships, value)
    ) {
      return {
        ok: false,
        reason: `Relationship "${value}" is outside the permitted set (${formatList(policy.allowedRelationships)}).`,
      };
    }
    return { ok: true, scoped: true };
  }

  if (isObjectKey(key)) {
    if (!includesIgnoreCase(policy.allowedObjects, value)) {
      return {
        ok: false,
        reason: `This assistant may only access ${formatList(policy.allowedObjects)} records, not "${value}".`,
      };
    }
    return { ok: true, scoped: true };
  }

  return { ok: true, scoped: false };
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* SOQL                                                                */
/* ------------------------------------------------------------------ */

export type QueryResult = { ok: true; query: string } | { ok: false; reason: string };

/**
 * Replaces every single-quoted literal with same-length padding.
 *
 * Offsets stay aligned with the original string, so the rewrite step can splice
 * a LIMIT into the real query using positions found in the masked copy.
 */
function maskLiterals(query: string): string {
  let out = '';
  let inLiteral = false;

  for (let i = 0; i < query.length; i += 1) {
    const char = query[i];

    if (inLiteral) {
      if (char === '\\') {
        // Escape sequence: blank out both characters.
        out += '  ';
        i += 1;
        continue;
      }
      if (char === "'") {
        inLiteral = false;
        out += "'";
        continue;
      }
      out += ' ';
      continue;
    }

    if (char === "'") {
      inLiteral = true;
      out += "'";
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * Checks a SOQL statement and caps its row count.
 *
 * The object checks apply only when SALESFORCE_ALLOWED_OBJECTS is restricted.
 * The row cap always applies: it protects Gemini's context window, not the org.
 */
export function validateSoql(query: string, policy: Policy = defaultPolicy()): QueryResult {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, reason: 'The SOQL query was empty.' };

  const masked = maskLiterals(trimmed);

  if (masked.includes(';')) {
    return { ok: false, reason: 'Only a single SOQL statement may be executed.' };
  }

  const froms = findFromClauses(masked);
  if (froms.length === 0) return { ok: false, reason: 'The SOQL query has no FROM clause.' };

  const rootFrom = froms.find((entry) => entry.depth === 0);
  if (!rootFrom) return { ok: false, reason: 'The SOQL query has no top-level FROM clause.' };

  if (!objectsUnrestricted(policy)) {
    // Polymorphic lookups can return objects the FROM clause never names.
    if (/\bTYPEOF\b/i.test(masked)) {
      return { ok: false, reason: 'TYPEOF is not permitted, because it can return objects outside the allowed set.' };
    }

    if (!includesIgnoreCase(policy.allowedObjects, rootFrom.name)) {
      return {
        ok: false,
        reason:
          `This assistant may only query ${formatList(policy.allowedObjects)}. ` +
          `The query targets "${rootFrom.name}", so it was not executed.`,
      };
    }

    // Nested FROM clauses are either child relationships or semi-join objects.
    for (const nested of froms) {
      if (nested.depth === 0) continue;
      const permitted =
        includesIgnoreCase(policy.allowedObjects, nested.name) ||
        isUnrestricted(policy.allowedRelationships) ||
        includesIgnoreCase(policy.allowedRelationships, nested.name);
      if (!permitted) {
        return {
          ok: false,
          reason:
            `The subquery on "${nested.name}" is outside the permitted set ` +
            `(${formatList([...policy.allowedObjects, ...policy.allowedRelationships])}).`,
        };
      }
    }

    if (!isUnrestricted(policy.allowedRelationships)) {
      const aliases = froms.map((entry) => entry.alias).filter((alias): alias is string => Boolean(alias));
      const traversal = checkTraversals(masked, policy, [...aliases, rootFrom.name]);
      if (traversal) return { ok: false, reason: traversal };
    }
  }

  return { ok: true, query: clampLimit(trimmed, masked, policy.maxRecords) };
}

interface FromClause {
  name: string;
  alias?: string;
  depth: number;
}

/** Finds every FROM target with the parenthesis depth it sits at. */
function findFromClauses(masked: string): FromClause[] {
  const clauses: FromClause[] = [];
  const pattern = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;

  // Reserved words that may follow FROM's object and are not aliases.
  const notAnAlias = /^(WHERE|LIMIT|OFFSET|ORDER|GROUP|HAVING|WITH|FOR|USING|UPDATE)$/i;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const depth = parenDepthAt(masked, match.index);
    const alias = match[2] && !notAnAlias.test(match[2]) ? match[2] : undefined;
    clauses.push({ name: match[1], alias, depth });
  }

  return clauses;
}

function parenDepthAt(masked: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') depth -= 1;
  }
  return depth;
}

/**
 * Rejects relationship traversals such as `Owner.Name` that would surface
 * fields from an object outside the allowed set.
 */
function checkTraversals(masked: string, policy: Policy, extraRoots: string[]): string | null {
  const pattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\./g;
  const permitted = [...policy.allowedObjects, ...policy.allowedRelationships, ...extraRoots];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const root = match[1];

    // `Account__r` style custom relationships resolve to their base name.
    const base = root.replace(/__r$/i, '');
    if (includesIgnoreCase(permitted, root) || includesIgnoreCase(permitted, base)) continue;

    return (
      `The query traverses the "${root}" relationship, which is outside the permitted set ` +
      `(${formatList(policy.allowedRelationships)}). ` +
      'Add it to SALESFORCE_ALLOWED_RELATIONSHIPS to permit it.'
    );
  }

  return null;
}

/**
 * Applies the row cap.
 *
 * SOQL requires LIMIT before OFFSET, so an existing OFFSET decides where a new
 * LIMIT has to be spliced in.
 */
export function clampLimit(query: string, masked: string, maxRecords: number): string {
  const limitMatch = /\bLIMIT\s+(\d+)/i.exec(masked);

  if (limitMatch) {
    const requested = Number(limitMatch[1]);
    if (requested <= maxRecords) return query;

    const start = limitMatch.index;
    const end = start + limitMatch[0].length;
    return `${query.slice(0, start)}LIMIT ${maxRecords}${query.slice(end)}`;
  }

  const offsetMatch = /\bOFFSET\s+\d+/i.exec(masked);
  if (offsetMatch) {
    return `${query.slice(0, offsetMatch.index)}LIMIT ${maxRecords} ${query.slice(offsetMatch.index)}`;
  }

  // A trailing FOR VIEW / FOR REFERENCE clause must also stay last.
  const forMatch = /\bFOR\s+(VIEW|REFERENCE|UPDATE)\b/i.exec(masked);
  if (forMatch) {
    return `${query.slice(0, forMatch.index)}LIMIT ${maxRecords} ${query.slice(forMatch.index)}`;
  }

  return `${query.replace(/\s+$/, '')} LIMIT ${maxRecords}`;
}

/* ------------------------------------------------------------------ */
/* SOSL                                                                */
/* ------------------------------------------------------------------ */

/**
 * Checks a SOSL search and caps its row count.
 *
 * While an object restriction is in force a RETURNING clause is mandatory,
 * because a search without one covers every object in the org. With `*` the
 * search is left to Salesforce and only the row cap is applied.
 */
export function validateSosl(query: string, policy: Policy = defaultPolicy()): QueryResult {
  const trimmed = query.trim();
  const masked = maskLiterals(trimmed);

  if (masked.includes(';')) return { ok: false, reason: 'Only a single SOSL search may be executed.' };

  const returningIndex = masked.search(/\bRETURNING\b/i);

  if (returningIndex === -1) {
    if (objectsUnrestricted(policy)) return { ok: true, query: clampLimit(trimmed, masked, policy.maxRecords) };

    return {
      ok: false,
      reason:
        'A SOSL search must declare a RETURNING clause naming ' +
        `${formatList(policy.allowedObjects)}; an unscoped search would cover every object in the org.`,
    };
  }

  if (objectsUnrestricted(policy)) return { ok: true, query: clampLimit(trimmed, masked, policy.maxRecords) };

  const returning = masked.slice(returningIndex + 'RETURNING'.length);

  // Object names are the identifiers at depth 0 of the RETURNING clause.
  const objects: string[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(\(|,|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(returning)) !== null) {
    if (parenDepthAt(returning, match.index) === 0) objects.push(match[1]);
  }

  if (objects.length === 0) {
    return { ok: false, reason: 'The RETURNING clause did not name any object.' };
  }

  for (const object of objects) {
    if (!includesIgnoreCase(policy.allowedObjects, object)) {
      return {
        ok: false,
        reason:
          `This assistant may only search ${formatList(policy.allowedObjects)}. ` +
          `The search returns "${object}", so it was not executed.`,
      };
    }
  }

  return { ok: true, query: clampLimit(trimmed, masked, policy.maxRecords) };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function includesIgnoreCase(haystack: readonly string[], needle: string): boolean {
  return haystack.some((entry) => entry.toLowerCase() === needle.toLowerCase());
}

function formatList(values: readonly string[]): string {
  const unique = [...new Set(values)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}
