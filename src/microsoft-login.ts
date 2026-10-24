import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {microsoftCustomerOrigin, microsoftGateway} from './microsoft-native.js';

/**
 * Microsoft Advertising's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the
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
  discovery: Object.freeze({kind: microsoftDiscovery}),
});
