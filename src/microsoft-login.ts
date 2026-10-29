import type {DiscoveryContext, OAuthTokenRequest, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {Credentials, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {microsoftCustomerOrigin, microsoftGateway, microsoftScope} from './microsoft-native.js';

/**
 * Microsoft Advertising's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). OAuth: the
 * Microsoft identity platform's endpoints; the platform needs the deployment's developer token, its token request asks
 * for the Advertising scope with offline access, and its login must be renewable, with a lifetime. Discovery: the
 * authenticated user, whose name names the login (CON-05), and the accounts it can reach, 100 per page in ID order,
 * each with its parent customer; the two Customer Management reads are the only Microsoft requests sent without a
 * selected account (its wire profile's headers, src/microsoft-adapter.ts).
 */
async function microsoftDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  const assets: WorkspaceAsset[] = [];
  const read = async (path: string, body: JsonObject) => {
    const plan = {
      ...c.plan(path, {}, 'POST', body),
      action: 'AMCP_MICROSOFT_DISCOVERY',
      origin: microsoftCustomerOrigin,
    };
    const {data} = await c.request(plan);
    const d = data as JsonObject;
    if (d.Errors?.length || d.OperationErrors?.length)
      throw new MirrorError('ASSET_RESPONSE_INVALID', 'Microsoft account discovery failed.', {}, 502);
    return d;
  };
  const user = (await read('/CustomerManagement/v13/User/Query', {UserId: null})).User;
  if (typeof user?.Id !== 'string' || !/^[1-9][0-9]*$/.test(user.Id))
    throw new MirrorError('ASSET_RESPONSE_INVALID', 'Microsoft did not return an authenticated user ID.', {}, 502);
  c.found.identity = user.Id;
  // The authenticated user's own name names the login (CON-05); the website bounds and checks it.
  const userName = [user.Name?.FirstName, user.Name?.LastName].filter(n => typeof n === 'string').join(' ');
  if (userName) c.found.label = userName;
  const seen = new Set<string>();
  let complete = false;
  for (let page = 0; page < 25; page++) {
    const rows = (
      await read('/CustomerManagement/v13/Accounts/Search', {
        Predicates: [{Field: 'UserId', Operator: 'Equals', Value: user.Id}],
        Ordering: [{Field: 'Id', Order: 'Ascending'}],
        PageInfo: {Index: page, Size: 100},
      })
    ).Accounts;
    if (!Array.isArray(rows))
      throw new MirrorError('ASSET_RESPONSE_INVALID', 'Microsoft did not return Accounts.', {}, 502);
    for (const r of rows) {
      if (
        typeof r?.Id !== 'string' ||
        !/^[1-9][0-9]*$/.test(r.Id) ||
        typeof r.ParentCustomerId !== 'string' ||
        !/^[1-9][0-9]*$/.test(r.ParentCustomerId) ||
        seen.has(r.Id)
      )
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'Microsoft returned an invalid or repeated account.', {}, 502);
      seen.add(r.Id);
      assets.push(
        c.asset(
          {
            id: r.Id,
            name: r.Name,
            currency: r.CurrencyCode,
            timezone: r.TimeZone,
            status: r.AccountLifeCycleStatus,
          },
          kind,
          r.ParentCustomerId,
        ),
      );
    }
    if (rows.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new MirrorError(
      'ASSET_SYNC_LIMIT',
      'Microsoft account discovery reached its page limit; narrow the login.',
      {},
      409,
    );
  return assets;
}

export const microsoftLogin: ProviderLogin = Object.freeze({
  gateway: microsoftGateway,
  oauth: Object.freeze({
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    requiredSetting: 'AMCP_MICROSOFT_DEVELOPER_TOKEN',
    tokenRequest(request: OAuthTokenRequest) {
      (request.body as URLSearchParams).set('scope', microsoftScope + ' offline_access');
      return request;
    },
    credentials(credentials: Credentials, {env, expires}: {env: NodeJS.ProcessEnv; expires: number | undefined}) {
      credentials.developerToken = env.AMCP_MICROSOFT_DEVELOPER_TOKEN;
      if (!credentials.refreshToken || !expires)
        throw new MirrorError(
          'OAUTH_RESPONSE_INVALID',
          'Microsoft authorization must return offline access and a valid lifetime. Reconnect with offline_access.',
          {},
          502,
        );
    },
  }),
  discovery: Object.freeze({kind: microsoftDiscovery}),
  // Each selected account's parent customer, as its discovery found it (accountCustomers).
  routes: (assets: readonly WorkspaceAsset[], accounts: readonly string[]) =>
    Object.fromEntries(assets.filter(a => accounts.includes(a.id)).map(a => [a.id, a.parentId!])),
});
