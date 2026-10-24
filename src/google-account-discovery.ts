import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import type {NativeTransport} from './transport.js';
import type {AssetGroup, WorkspaceAsset} from './provider-login.js';
import {assetSyncDiagnostic, assetSyncErrorMessage} from './report-errors.js';
import {googleAdsCustomers, googleAdsPath} from './google-version.js';

/**
 * Discover every status beneath each directly accessible root, without granting account access. Google Ads' asset
 * discovery step and its renewal step (its website login steps, src/google-ads-login.ts, ARC-01 phase B), which the
 * website's Google reauthorization (server/google-reauthorization.ts) runs, both read the hierarchy here; it moved
 * from server/google-account-discovery.ts, which re-exports it.
 */
export async function googleAccountDiscovery(
  transport: NativeTransport,
  connection: Connection,
  credentials: Credentials,
  assertActive: () => void = () => {},
): Promise<AssetGroup> {
  const plan = (path: string, body?: JsonObject): CompiledRequest => ({
    gateway: connection.gateway,
    action: 'AMCP_GOOGLE_DISCOVERY',
    path,
    query: {},
    method: body ? 'POST' : 'GET',
    body,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'INDEPENDENT_ACCOUNT_DISCOVERY',
    warnings: [],
  });
  const request = async (p: CompiledRequest, c: Credentials, stage: string) => {
    try {
      assertActive();
      const result = await transport.request(p, connection, c, undefined, {beforeAttempt: assertActive});
      assertActive();
      return result;
    } catch (e) {
      assertActive();
      if (e instanceof MirrorError)
        throw new MirrorError(
          e.code,
          e.message,
          {...e.details, report_request: {stage, method: p.method, path: p.path}},
          e.status,
          e.retryable,
        );
      throw e;
    }
  };
  const result = await request(
    plan(googleAdsPath('/customers:listAccessibleCustomers')),
    {...credentials, loginCustomerId: undefined},
    'account_list',
  );
  const names = (result.data as JsonObject).resourceNames;
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !/^customers\/\d+$/.test(n)))
    throw new MirrorError('ASSET_RESPONSE_INVALID', 'Google did not return a customer list.', {}, 502);
  const roots = [...new Set<string>(names.map(n => n.split('/')[1]))].sort();
  if (roots.length > 100)
    throw new MirrorError(
      'ASSET_SYNC_LIMIT',
      'This login has more than 100 directly accessible Google accounts. Narrow the login.',
      {},
      409,
    );
  const assets = new Map<string, WorkspaceAsset>(
    roots.map(id => [id, {id, kind: 'ad_accounts', name: 'Google Ads ' + id, loginCustomerId: id, source: 'vendor'}]),
  );
  const failures: JsonObject[] = [];
  // Sub-manager reads that place each client under its direct manager (CON-05), bounded per sync.
  let managerReads = 0,
    hierarchyComplete = true;
  const search = async (root: string, query: string, login = root) => {
    const rows: JsonObject[] = [],
      seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 25; page++) {
      const response = await request(
        plan(googleAdsCustomers + root + '/googleAds:search', {query, ...(token ? {pageToken: token} : {})}),
        {...credentials, loginCustomerId: login},
        query.includes('FROM customer_client') ? 'manager_hierarchy' : 'account_lookup',
      );
      const data = response.data as JsonObject,
        items = data.results ?? [];
      if (!Array.isArray(items) || items.some(r => !r || typeof r !== 'object' || Array.isArray(r)))
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'Google returned an invalid account hierarchy.', {}, 502);
      rows.push(...items);
      if (rows.length > 10000)
        throw new MirrorError('ASSET_SYNC_LIMIT', 'Google account discovery exceeded 10,000 accounts.', {}, 409);
      if (!data.nextPageToken) return rows;
      if (typeof data.nextPageToken !== 'string' || seen.has(data.nextPageToken))
        throw new MirrorError('PAGINATION_LOOP', 'Google repeated an account page token.', {}, 502);
      token = data.nextPageToken;
      seen.add(token);
    }
    throw new MirrorError('ASSET_SYNC_LIMIT', 'Google account discovery reached its page limit.', {}, 409);
  };
  const account = (row: JsonObject, root: string, client = false): WorkspaceAsset => {
    const id = String(row?.id ?? '');
    if (
      !/^\d+$/.test(id) ||
      (typeof row?.id === 'number' && !Number.isSafeInteger(row.id)) ||
      (client && row.clientCustomer !== undefined && row.clientCustomer !== 'customers/' + id)
    )
      throw new MirrorError('ASSET_ID_INVALID', 'Google returned an invalid customer identifier.', {}, 502);
    // customer_client.level: 0 is the manager itself, 1 its direct clients, 2 their clients, and so on.
    const level = Number(row.level);
    return {
      ...(client && Number.isSafeInteger(level) && level >= 0 && level <= 20 ? {level} : {}),
      id,
      kind: 'ad_accounts',
      name: row.descriptiveName || 'Google Ads ' + id,
      currency: row.currencyCode,
      timezone: row.timeZone,
      status: row.status,
      manager: row.manager === true,
      hidden: row.hidden === true,
      testAccount: row.testAccount === true,
      loginCustomerId: root,
      readVerified: !client,
      ...(id !== root ? {parentId: root} : {}),
      source: 'vendor',
    };
  };
  for (const root of roots)
    try {
      const self = (
        await search(
          root,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account FROM customer',
        )
      )[0]?.customer;
      if (!self || String(self.id) !== root)
        throw new MirrorError(
          'ASSET_RESPONSE_INVALID',
          'Google did not return the requested account details.',
          {},
          502,
        );
      assets.set(root, account(self, root));
      if (!self.manager) continue;
      // customer_client includes all descendant levels. No status or hidden filter excludes historical accounts.
      const rows = await search(
        root,
        'SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.manager, customer_client.hidden, customer_client.test_account, customer_client.level FROM customer_client',
      );
      for (const row of rows) {
        const asset = account(row.customerClient, root, true);
        if (!assets.has(asset.id) || assets.get(asset.id)!.status === undefined) assets.set(asset.id, asset);
      }
      if (assets.size > 10000)
        throw new MirrorError('ASSET_SYNC_LIMIT', 'Google account discovery exceeded 10,000 accounts.', {}, 409);
      // customer_client lists every level beneath the root without naming each client's own manager. Each sub-manager's
      // level-1 clients are its direct clients; requests still go through the root's login-customer-id (CON-05).
      const managers = [...assets.values()]
        .filter(a => a.loginCustomerId === root && a.id !== root && a.manager && a.level !== undefined)
        .sort((a, b) => a.level! - b.level! || a.id.localeCompare(b.id));
      for (const manager of managers) {
        if (managerReads >= 200) {
          hierarchyComplete = false;
          break;
        }
        managerReads++;
        try {
          for (const row of await search(
            manager.id,
            'SELECT customer_client.id, customer_client.level FROM customer_client WHERE customer_client.level = 1',
            root,
          )) {
            const child = assets.get(String(row.customerClient?.id ?? ''));
            if (
              child &&
              child.loginCustomerId === root &&
              child.id !== manager.id &&
              (child.level === undefined || child.level > manager.level!)
            )
              child.parentId = manager.id;
          }
        } catch (e) {
          assertActive();
          // The account list stays complete; only this sub-manager's clients keep the root as their shown manager.
          hierarchyComplete = false;
        }
      }
    } catch (e) {
      assertActive();
      failures.push(assetSyncDiagnostic(e, 'google', connection.id, 'ad_accounts', root));
    }
  assertActive();
  return {
    kind: 'ad_accounts',
    assets: [...assets.values()],
    complete: failures.length === 0,
    ...(hierarchyComplete ? {} : {hierarchyComplete: false}),
    ...(failures.length
      ? {
          error: 'Some Google account details could not be synced. ' + failures.map(assetSyncErrorMessage).join(' '),
          diagnostics: failures,
        }
      : {}),
  };
}

/**
 * The read that verifies one selected Google Ads account the hierarchy listed but did not read (a client beneath a
 * manager), before a renewal replaces a working login: its customer, currency, time zone and status. The renewal sends
 * it with the manager route discovery recorded for the account (its login customer).
 */
export function googleSelectedAccountRead(gateway: string, id: string): CompiledRequest {
  return {
    gateway,
    action: 'AMCP_GOOGLE_SELECTED_VERIFICATION',
    method: 'POST',
    path: googleAdsCustomers + id + '/googleAds:search',
    query: {},
    body: {
      query: 'SELECT customer.id, customer.currency_code, customer.time_zone, customer.status FROM customer',
    },
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'SELECTED_ACCOUNT_VERIFICATION',
    warnings: [],
  };
}
