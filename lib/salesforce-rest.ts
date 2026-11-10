/**
 * Read-only Salesforce REST client for the My Day dashboard.
 *
 * Reuses the existing OAuth token manager (lib/salesforce-auth.ts) and token
 * store, so there is still exactly one Salesforce grant. Tokens never leave the
 * server and are never logged.
 *
 * Only GET is implemented: dashboard loading must never write to Salesforce.
 */

import 'server-only';

import { log } from './logger';
import { getAccessToken, SalesforceAuthError } from './salesforce-auth';
import { readTokens } from './token-store';

export const API_VERSION = (process.env.SALESFORCE_API_VERSION ?? '68.0').replace(/^v/, '');
const TIMEOUT_MS = Number(process.env.SALESFORCE_REST_TIMEOUT_MS) || 15_000;

export type SalesforceRestErrorCode =
  | 'missing_api_scope'
  | 'not_authorized'
  | 'not_found'
  | 'forbidden'
  | 'timeout'
  | 'salesforce_error';

export class SalesforceRestError extends Error {
  constructor(
    message: string,
    readonly code: SalesforceRestErrorCode,
    readonly httpStatus: number | null = null,
    /** Salesforce's own errorCode, e.g. INVALID_SCOPES. Safe to surface. */
    readonly sfErrorCode: string | null = null,
  ) {
    super(message);
    this.name = 'SalesforceRestError';
  }
}

interface SalesforceErrorItem {
  message?: string;
  errorCode?: string;
}

function parseError(text: string): SalesforceErrorItem {
  try {
    const body = JSON.parse(text) as SalesforceErrorItem[] | SalesforceErrorItem;
    return Array.isArray(body) ? (body[0] ?? {}) : body;
  } catch {
    return {};
  }
}

async function instanceUrl(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens?.instanceUrl) {
    throw new SalesforceRestError(
      'Salesforce authorization has not been completed, so the instance URL is unknown.',
      'not_authorized',
    );
  }
  return tokens.instanceUrl.replace(/\/+$/, '');
}

/**
 * GET a path under the instance URL, e.g. `/services/data/v68.0/query?q=...`.
 * Retries once with a refreshed token on a 401 that a refresh can fix.
 */
export async function sfGet<T>(path: string): Promise<T> {
  if (!path.startsWith('/services/')) throw new Error('sfGet only accepts /services/ paths');
  const base = await instanceUrl();

  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getAccessToken(attempt > 0);
    } catch (error) {
      if (error instanceof SalesforceAuthError) {
        throw new SalesforceRestError(error.message, 'not_authorized');
      }
      throw error;
    }

    let response: Response;
    try {
      response = await fetch(base + path, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new SalesforceRestError(
        timedOut ? `Salesforce did not respond within ${TIMEOUT_MS / 1000}s.` : 'Salesforce could not be reached.',
        timedOut ? 'timeout' : 'salesforce_error',
      );
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SalesforceRestError('Salesforce returned a response that was not JSON.', 'salesforce_error', response.status);
      }
    }

    const err = parseError(text);
    const sfCode = err.errorCode ?? null;
    const sfMessage = err.message ?? `HTTP ${response.status}`;

    if (response.status === 401) {
      // A refresh cannot add a scope the grant never had.
      if (/INVALID_SCOPES/i.test(sfMessage) || /INVALID_SCOPES/i.test(sfCode ?? '')) {
        throw new SalesforceRestError(
          'The Salesforce OAuth grant does not include REST API access (Salesforce replied INVALID_SCOPES).',
          'missing_api_scope',
          401,
          'INVALID_SCOPES',
        );
      }
      if (attempt === 0) continue;
      throw new SalesforceRestError(`Salesforce rejected the access token: ${sfMessage}`, 'not_authorized', 401, sfCode);
    }

    log.warn('salesforce-rest', 'Salesforce REST error', { status: response.status, errorCode: sfCode });
    if (response.status === 404) throw new SalesforceRestError(sfMessage, 'not_found', 404, sfCode);
    if (response.status === 403) throw new SalesforceRestError(sfMessage, 'forbidden', 403, sfCode);
    throw new SalesforceRestError(sfMessage, 'salesforce_error', response.status, sfCode);
  }

  // Unreachable: the loop either returns or throws.
  throw new SalesforceRestError('Salesforce request failed.', 'salesforce_error');
}

export interface QueryResult<T> {
  totalSize: number;
  done: boolean;
  records: T[];
  nextRecordsUrl?: string;
}

/** Runs one bounded SOQL query. Callers must include their own LIMIT. */
export async function soql<T>(query: string): Promise<QueryResult<T>> {
  return sfGet<QueryResult<T>>(`/services/data/v${API_VERSION}/query?q=${encodeURIComponent(query)}`);
}

/** Salesforce record id: 15 or 18 alphanumerics. */
export function isSalesforceId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(value)) return false;
  return prefix ? value.startsWith(prefix) : true;
}

/** Quotes a value for a SOQL string literal. Ids are validated before use, but this is still applied. */
export function soqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const describeCache = new Map<string, { at: number; fields: Set<string> }>();
const DESCRIBE_TTL_MS = 30 * 60 * 1000;

/**
 * The field names an object exposes to the connected user. Used to build
 * queries from fields that actually exist instead of assuming an org's schema.
 */
export async function describeFields(objectName: string): Promise<Set<string>> {
  const cached = describeCache.get(objectName);
  if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.fields;

  const body = await sfGet<{ fields?: Array<{ name: string }> }>(
    `/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(objectName)}/describe`,
  );
  const fields = new Set((body.fields ?? []).map((field) => field.name));
  describeCache.set(objectName, { at: Date.now(), fields });
  return fields;
}

/** Keeps only the fields present on the object; relationship paths are checked by their id field. */
export function pickFields(available: Set<string>, wanted: string[]): string[] {
  return wanted.filter((field) => {
    const [head] = field.split('.');
    if (field === head) return available.has(field);
    // Account.Name is present when AccountId is; ParentRecord.Name when ParentRecordId is.
    return available.has(`${head}Id`);
  });
}
