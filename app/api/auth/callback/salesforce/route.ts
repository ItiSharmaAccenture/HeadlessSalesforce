/**
 * GET /api/auth/callback/salesforce
 *
 * Completes the authorization started by /api/auth/salesforce. The setup secret
 * is not required here — Salesforce redirects the operator's browser straight to
 * this URL — so the control is the one-shot `state` recorded by the setup route.
 */

import { completeAuthorization, SalesforceAuthError } from '@/lib/salesforce-auth';
import { resetDiscoveryCache } from '@/lib/gemini';
import { guardSetupRoute } from '@/lib/setup-guard';
import { log } from '@/lib/logger';
import { renderSetupPage } from '@/lib/setup-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = guardSetupRoute(request, { requireSecret: false });
  if (denied) {
    return renderSetupPage({ status: denied.status, heading: 'Callback refused', tone: 'error', body: denied.message });
  }

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) {
    // Salesforce reports a denied consent or a misconfigured app this way.
    const description = url.searchParams.get('error_description') ?? 'No further detail was provided.';
    log.warn('auth-callback', 'Salesforce returned an authorization error', { error, description });

    return renderSetupPage({
      status: 400,
      heading: 'Salesforce declined the authorization',
      tone: 'error',
      body: `${error}: ${description}`,
      details: [
        'Confirm the callback URL on the External Client App matches SALESFORCE_REDIRECT_URI exactly.',
        'Confirm the mcp_api and refresh_token scopes are selected.',
        'A newly created External Client App can take up to 30 minutes to become usable.',
      ],
    });
  }

  if (!code || !state) {
    return renderSetupPage({
      status: 400,
      heading: 'Incomplete callback',
      tone: 'error',
      body: 'Salesforce did not return both an authorization code and a state value.',
    });
  }

  try {
    await completeAuthorization(code, state);
    // Approved tools may differ under the newly authorized user.
    resetDiscoveryCache();

    log.info('auth-callback', 'Salesforce authorization completed');

    return renderSetupPage({
      status: 200,
      heading: 'Salesforce authorization complete',
      tone: 'success',
      body: 'The dedicated Salesforce user is now authorized. Tokens are stored server-side and are never sent to the browser.',
      details: [
        'Check GET /api/health to confirm the MCP connection succeeds.',
        'Re-run this flow only if the refresh token is revoked or expires.',
      ],
    });
  } catch (caught) {
    const message =
      caught instanceof SalesforceAuthError ? caught.message : 'The authorization could not be completed.';

    log.error('auth-callback', 'Authorization failed', {
      message: caught instanceof Error ? caught.message : String(caught),
    });

    return renderSetupPage({
      status: 400,
      heading: 'Authorization failed',
      tone: 'error',
      body: message,
      details: [
        'Start the flow again from /api/auth/salesforce?secret=... rather than reloading this page.',
        'If the token exchange was rejected, confirm whether your External Client App is a public PKCE client (no secret) or a confidential one (secret required).',
      ],
    });
  }
}
