/**
 * The contract every token backend implements.
 *
 * Two things are persisted: the Salesforce tokens themselves, and the pending
 * authorization (the OAuth `state` and the PKCE verifier) that lives for the few
 * seconds between starting the flow and Salesforce redirecting back.
 *
 * The one-shot semantics of the pending record — read, delete, then compare —
 * live in the facade, not in the backends, so both behave identically.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
  /** Epoch ms. Undefined when Salesforce did not return `expires_in`. */
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
}

export interface PendingAuth {
  state: string;
  codeVerifier: string;
  createdAt: number;
}

export interface TokenBackend {
  /** Reported by /api/health so an operator can see where tokens are kept. */
  readonly kind: 'file' | 'redis';
  readonly location: string;

  readTokens(): Promise<StoredTokens | null>;
  writeTokens(tokens: StoredTokens): Promise<void>;
  clearTokens(): Promise<void>;

  savePending(pending: PendingAuth): Promise<void>;
  /** Must remove the record before returning it: a replayed callback gets nothing. */
  takePending(): Promise<PendingAuth | null>;
}

/** Authorization requests expire quickly; a stale `state` must not be redeemable. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
