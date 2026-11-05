/**
 * Salesforce OAuth 2.0 for one dedicated user.
 *
 * Authorization Code + PKCE is run once, by an operator, through the protected
 * setup route. Every later request reuses the stored refresh token. Sales reps
 * never authenticate: the application has no concept of who is chatting.
 */

import 'server-only';

import { config, hasClientSecret } from './config';
import { log } from './logger';
import { createPkce, createState } from './pkce';
import {
  clearTokens,
  consumePendingAuth,
  readTokens,
  savePendingAuth,
  writeTokens,
  type StoredTokens,
} from './token-store';

/** Refresh this far ahead of expiry so a long request cannot straddle it. */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

/**
 * Salesforce does not always return `expires_in`. When it is absent we assume a
 * conservative lifetime and additionally refresh reactively on any 401.
 */
const ASSUMED_LIFETIME_MS = 60 * 60 * 1000;

export type SalesforceAuthErrorCode =
  | 'not_configured'
  | 'not_authorized'
  | 'refresh_failed'
  | 'exchange_failed'
  | 'invalid_state';

export class SalesforceAuthError extends Error {
  constructor(
    message: string,
    readonly code: SalesforceAuthErrorCode,
  ) {
    super(message);
    this.name = 'SalesforceAuthError';
  }
}

function requireClientConfig(): string {
  if (!config.salesforce.clientId) {
    throw new SalesforceAuthError(
      'SALESFORCE_CLIENT_ID is not set. Add the External Client App consumer key to .env.local.',
      'not_configured',
    );
  }
  return config.salesforce.clientId;
}

/* ------------------------------------------------------------------ */
/* Authorization request                                               */
/* ------------------------------------------------------------------ */

/**
 * Builds the Salesforce authorization URL and records the matching `state` and
 * code verifier so the callback can prove it is completing this flow.
 */
export async function beginAuthorization(): Promise<{ authorizationUrl: string }> {
  const clientId = requireClientConfig();
  const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkce();
  const state = createState();

  await savePendingAuth({ state, codeVerifier, createdAt: Date.now() });

  const url = new URL(`${config.salesforce.loginUrl}/services/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', config.salesforce.redirectUri);
  url.searchParams.set('scope', config.salesforce.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', codeChallengeMethod);

  log.info('salesforce-auth', 'Authorization request prepared', {
    loginUrl: config.salesforce.loginUrl,
    scopes: config.salesforce.scopes,
    confidentialClient: hasClientSecret(),
  });

  return { authorizationUrl: url.toString() };
}

/* ------------------------------------------------------------------ */
/* Token endpoint                                                      */
/* ------------------------------------------------------------------ */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: URLSearchParams): Promise<TokenResponse> {
  const clientId = requireClientConfig();
  params.set('client_id', clientId);
  // Only sent for confidential clients; a public PKCE app must not send one.
  if (config.salesforce.clientSecret) params.set('client_secret', config.salesforce.clientSecret);

  const response = await fetch(`${config.salesforce.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
  });

  const text = await response.text();
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Salesforce token endpoint returned HTTP ${response.status} with a non-JSON body.`);
  }

  if (!response.ok || body.error) {
    // error_description is safe to surface: it never contains the credential.
    const reason = body.error_description ?? 'token request failed';
    throw new Error(`${body.error ?? `HTTP ${response.status}`}: ${reason}`);
  }

  return body;
}

function toStoredTokens(body: TokenResponse, previous?: StoredTokens | null): StoredTokens {
  const expiresInMs = body.expires_in ? Number(body.expires_in) * 1000 : ASSUMED_LIFETIME_MS;

  return {
    accessToken: body.access_token as string,
    // Salesforce omits refresh_token on refresh unless rotation is enabled.
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    instanceUrl: body.instance_url ?? previous?.instanceUrl,
    expiresAt: Date.now() + expiresInMs,
    scope: body.scope ?? previous?.scope,
    obtainedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Callback                                                            */
/* ------------------------------------------------------------------ */

/** Completes the flow, but only for an authorization this server started. */
export async function completeAuthorization(code: string, state: string): Promise<StoredTokens> {
  const pending = await consumePendingAuth(state);
  if (!pending) {
    throw new SalesforceAuthError(
      'The OAuth state did not match a pending authorization request, or the request expired. Restart the flow from the setup route.',
      'invalid_state',
    );
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.salesforce.redirectUri,
    code_verifier: pending.codeVerifier,
  });

  let body: TokenResponse;
  try {
    body = await postToken(params);
  } catch (error) {
    log.error('salesforce-auth', 'Authorization code exchange failed', { message: (error as Error).message });
    throw new SalesforceAuthError((error as Error).message, 'exchange_failed');
  }

  if (!body.access_token) {
    throw new SalesforceAuthError('Salesforce did not return an access token.', 'exchange_failed');
  }
  if (!body.refresh_token) {
    log.warn(
      'salesforce-auth',
      'No refresh token returned. Add the refresh_token scope to the External Client App, or the assistant will stop working when the access token expires.',
    );
  }

  const tokens = toStoredTokens(body);
  await writeTokens(tokens);
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Access token retrieval                                              */
/* ------------------------------------------------------------------ */

/** De-duplicates concurrent refreshes so two chats cannot race the endpoint. */
let refreshInFlight: Promise<StoredTokens> | null = null;

async function refreshTokens(previous: StoredTokens): Promise<StoredTokens> {
  const refreshToken = previous.refreshToken;
  if (!refreshToken) {
    throw new SalesforceAuthError(
      'The stored Salesforce access token expired and no refresh token is available. Re-run the one-time authorization.',
      'not_authorized',
    );
  }

  refreshInFlight ??= (async () => {
    try {
      const body = await postToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
      if (!body.access_token) throw new Error('refresh response contained no access token');

      const tokens = toStoredTokens(body, previous);
      await writeTokens(tokens);
      log.info('salesforce-auth', 'Access token refreshed');
      return tokens;
    } catch (error) {
      const message = (error as Error).message;
      log.error('salesforce-auth', 'Token refresh failed', { message });

      // An invalid grant means the refresh token is revoked or expired; the
      // stored copy is useless, so drop it rather than retry forever.
      if (/invalid_grant/i.test(message)) {
        await clearTokens();
        throw new SalesforceAuthError(
          'The Salesforce refresh token is no longer valid. Re-run the one-time authorization.',
          'not_authorized',
        );
      }
      throw new SalesforceAuthError(`Could not refresh the Salesforce access token: ${message}`, 'refresh_failed');
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Returns a usable access token, refreshing proactively when it is close to
 * expiry. Pass `forceRefresh` after a 401 to recover from a token Salesforce
 * invalidated early.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) {
    throw new SalesforceAuthError(
      'Salesforce authorization has not been completed. Visit the setup route to authorize the dedicated user.',
      'not_authorized',
    );
  }

  const expired = tokens.expiresAt !== undefined && Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS;
  if (!forceRefresh && !expired) return tokens.accessToken;

  const refreshed = await refreshTokens(tokens);
  return refreshed.accessToken;
}

/** Sanitised authorization status for /api/health. Never returns token material. */
export async function getAuthorizationStatus(): Promise<{
  authorized: boolean;
  hasRefreshToken: boolean;
  expiresAt: string | null;
  scope: string | null;
}> {
  const tokens = await readTokens();
  return {
    authorized: Boolean(tokens),
    hasRefreshToken: Boolean(tokens?.refreshToken),
    expiresAt: tokens?.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
    scope: tokens?.scope ?? null,
  };
}

/** Test seam. */
export function resetAuthState(): void {
  refreshInFlight = null;
}
