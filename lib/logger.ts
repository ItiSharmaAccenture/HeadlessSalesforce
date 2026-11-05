/**
 * Server-side logging with redaction.
 *
 * Diagnostics are valuable for a POC that talks to three moving parts, but
 * access tokens, refresh tokens, authorization codes, client secrets and API
 * keys must never reach a log line. Every value passes through `redact` first.
 */

import 'server-only';

const SENSITIVE_KEY = /(token|secret|password|authorization|api_?key|code_verifier|client_id|^code$)/i;

/** Patterns for secrets that appear inside free-form strings. */
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[\w\-._~+/]+=*/gi, 'Bearer [redacted]'],
  // Salesforce session ids look like 00D...!AQ...
  [/\b00D[A-Za-z0-9]{12,15}![\w.\-+/=]+/g, '[redacted-sf-token]'],
  // JWT
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]'],
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';

  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SENSITIVE_PATTERNS) out = out.replace(pattern, replacement);
    return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
  }

  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }

  return value;
}

function emit(level: 'info' | 'warn' | 'error', scope: string, message: string, detail?: unknown) {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;
  if (detail === undefined) console[level](line);
  else console[level](line, redact(detail));
}

export const log = {
  info: (scope: string, message: string, detail?: unknown) => emit('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown) => emit('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: unknown) => emit('error', scope, message, detail),
};
