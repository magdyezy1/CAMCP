import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {linkedinVersion} from './linkedin-version.js';

/**
 * LinkedIn's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the accounts the
 * authenticated member can use, with the member's role on each; its requests carry the reviewed LinkedIn-Version and
 * Rest.li 2.0, and its listings page by start and count. Its authorization is OAuth 2.0 with the authorization code at
 * LinkedIn's own endpoints, without a step of its own (its token response states the login's lifetime).
 */

/** LinkedIn accounts named by their own read in one sync; the rest (rare) keep their ID as their name. */
const linkedinNamedAccounts = 200;
/**
 * adAccountUsers gives the account URN and the member's role only; each account's own read gives its name, currency
 * and status. An account whose read fails keeps its ID as its name, so no name is invented.
 */
async function linkedinDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  const rows = await c.pages('/rest/adAccountUsers', {q: 'authenticatedUser', count: 100, start: 0}, d => d.elements);
  const assets: WorkspaceAsset[] = [];
  for (const [index, r] of rows.entries()) {
    const id = String(r.account ?? '').replace(/^urn:li:sponsoredAccount:/, '');
    if (!/^\d+$/.test(id))
      throw new MirrorError('ASSET_ID_INVALID', 'LinkedIn returned an invalid account URN.', {}, 502);
    let account: JsonObject = {};
    if (index < linkedinNamedAccounts)
      try {
        const {data} = await c.request(c.plan('/rest/adAccounts/' + id));
        if (String((data as JsonObject)?.id) === id) account = data as JsonObject;
      } catch (e) {
        if (
          e instanceof MirrorError &&
          ['CONNECTION_CHANGED', 'CONNECTION_AUTHORITY_CHANGED', 'CONNECTION_NOT_FOUND'].includes(e.code)
        )
          throw e;
      }
    // The member's role is retained as observed metadata (a closed-set token, never free text). It is evidence for
    // the member_account_access prerequisite of LinkedIn programs; LinkedIn still decides each request.
    const role = typeof r.role === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(r.role) ? r.role : undefined;
    assets.push({
      ...c.asset(
        {
          id,
          name: typeof account.name === 'string' && account.name.trim() ? account.name : id,
          currency: typeof account.currency === 'string' ? account.currency : undefined,
          status: typeof account.status === 'string' ? account.status : r.role,
        },
        kind,
      ),
      ...(role ? {linkedinRole: role, linkedinRoleObservedAt: Date.now()} : {}),
    });
  }
  return assets;
}
/** The next page of a listing that pages by start and count, while its total (or a full page) says there is one. */
function linkedinNextStart(data: JsonObject, rows: readonly unknown[]): number | undefined {
  if (!(
    Number.isInteger(data.paging?.start) &&
    Number.isInteger(data.paging?.count) &&
    (typeof data.paging?.total === 'number'
      ? data.paging.start + rows.length < data.paging.total
      : rows.length === data.paging.count && rows.length > 0)
  ))
    return undefined;
  if (!rows.length || data.paging.count < 1)
    throw new MirrorError('ASSET_RESPONSE_INVALID', 'LinkedIn returned inconsistent pagination.', {}, 502);
  return data.paging.start + data.paging.count;
}

export const linkedinLogin: ProviderLogin = Object.freeze({
  gateway: 'linkedin_native_action',
  oauth: Object.freeze({
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
  discovery: Object.freeze({
    kind: linkedinDiscovery,
    headers: () => ({'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'}),
    nextStart: linkedinNextStart,
  }),
});
