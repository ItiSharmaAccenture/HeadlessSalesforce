/**
 * GET /api/auth/salesforce?secret=...
 *
 * One-time, operator-run start of the dedicated user's OAuth authorization.
 * Not reachable by sales reps: localhost only, and gated by SETUP_SECRET.
 */

import { beginAuthorization, SalesforceAuthError } from '@/lib/salesforce-auth';
import { guardSetupRoute } from '@/lib/setup-guard';
import { log } from '@/lib/logger';
import { renderSetupPage } from '@/lib/setup-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = guardSetupRoute(request, { requireSecret: true });
  if (denied) {
    return renderSetupPage({
      status: denied.status,
      heading: 'Setup unavailable',
      tone: 'error',
      body: denied.message,
    });
  }

  try {
    const { authorizationUrl } = await beginAuthorization();
    log.info('auth-setup', 'Redirecting to Salesforce for authorization');

    // 302 so the operator's browser carries the login session to Salesforce.
    return new Response(null, { status: 302, headers: { Location: authorizationUrl } });
  } catch (error) {
    const message = error instanceof SalesforceAuthError ? error.message : 'Could not start the Salesforce authorization.';
    log.error('auth-setup', 'Failed to start authorization', {
      message: error instanceof Error ? error.message : String(error),
    });

    return renderSetupPage({ status: 500, heading: 'Could not start authorization', tone: 'error', body: message });
  }
}
