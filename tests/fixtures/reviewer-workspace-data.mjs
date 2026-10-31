import {createHash, randomBytes} from 'node:crypto';
import {hashUserPassword} from '../../dist/server/user-accounts.js';

// The reviewer's own workspace (OWNER-REVIEWER-QA). Meta's app reviewers sign in with an invited test account, as
// POST /api/owner/accounts/test-invite and its email setup create one (server/user-accounts.ts): approved, with an
// email, their own password and amcp_users.test_account = 1, in a workspace of their own that holds nothing of the
// deployment's. The workspace holds what a reviewer has after connecting Meta: one synthetic Meta login with a selected
// ad account, the connection result the provider returned them to (/oauth/result?attempt=), and, for each consent
// case, a fresh pending AI-client authorization (/oauth/consent?request=). No credential here reaches a provider: the
// browser fixture refuses every request that leaves it.

export const reviewerConnectionId = 'reviewer-meta-login';
export const reviewerAccountId = '1200000000000001';
export const reviewerAttemptId = 'reviewer-meta-attempt';
const clientRedirect = 'https://claude.ai/api/mcp/auth_callback';

/** Creates the invited test account and seeds its workspace; `mcpOAuth` is the fixture website's (createWebsite). */
export async function reviewerWorkspace({accounts, store, mcpOAuth}) {
  const user = accounts.newUser(
      'Synthetic reviewer',
      'reviewer@example.test',
      // A random password nobody types: the browser signs in with the fixture's session cookie.
      await hashUserPassword(randomBytes(24).toString('base64url'), false),
      true,
      true,
    ),
    tenantId = user.tenant_id,
    now = Date.now();
  store.putConnection(
    {tenantId, userId: user.id, role: 'admin'},
    {
      id: reviewerConnectionId,
      tenantId,
      gateway: 'meta_native_action',
      accounts: [reviewerAccountId],
      writeAccounts: [],
      enabled: true,
      label: 'Meta · Synthetic Reviewer',
      scopes: ['ads_read', 'business_management'],
    },
    {accessToken: 'synthetic-browser-reviewer-meta'},
  );
  store.putDocument(tenantId, 'website_connection', reviewerConnectionId, {
    platform: 'meta',
    expiresAt: now + 60 * 86400000,
    providerId: 'synthetic-reviewer-meta-user',
    displayName: 'Synthetic Reviewer',
    createdAt: now,
  });
  store.putDocument(tenantId, 'website_assets', reviewerConnectionId, {
    groups: [
      {
        kind: 'ad_accounts',
        complete: true,
        checkedAt: now,
        assets: [{id: reviewerAccountId, kind: 'ad_accounts', name: 'Synthetic reviewer ad account', source: 'vendor'}],
      },
    ],
    selected: ['ad_accounts:' + reviewerAccountId],
    lastSync: now,
    error: null,
  });
  // The progress record the provider callback leaves (server/platform-routes.ts) once the first sync completed.
  store.putDocument(tenantId, 'oauth_progress', reviewerAttemptId, {
    platform: 'meta',
    state: 'complete',
    authorization: true,
    exchange: true,
    sync: true,
    connectionId: reviewerConnectionId,
    createdAt: now,
    message: 'Connection secured. Choose the assets AMCP can use.',
  });
  const client = await mcpOAuth.clientsStore.registerClient({
    client_name: 'Claude',
    redirect_uris: [clientRedirect],
    token_endpoint_auth_method: 'none',
  });
  /** A pending authorization as an AI client's /authorize leaves it; each lasts ten minutes, so each case asks anew. */
  const consentRequest = async () => {
    let location;
    await mcpOAuth.authorize(
      client,
      {
        redirectUri: clientRedirect,
        codeChallenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
        scopes: ['mcp:read'],
        state: 'reviewer-consent',
      },
      {redirect: (_status, url) => (location = url)},
    );
    return new URL(location).searchParams.get('request');
  };
  return {user, tenantId, attemptId: reviewerAttemptId, consentRequest};
}
