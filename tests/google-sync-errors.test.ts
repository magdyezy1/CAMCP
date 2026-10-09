import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {createHttpApp} from '../server/http-app.js';
import {assetSyncDiagnostic} from '../src/report-errors.js';
import {MirrorError} from '../src/errors.js';
import type {Actor, Connection, JsonObject, CompiledRequest} from '../src/types.js';

const key = Buffer.alloc(32, 48).toString('base64');
const actor: Actor = {tenantId: 'local', userId: 'owner', role: 'admin'};
const connection: Connection = {
  id: 'google-sync',
  tenantId: 'local',
  gateway: 'google_ads_native_action',
  accounts: ['300'],
  enabled: true,
  label: 'Synthetic Google',
  scopes: ['https://www.googleapis.com/auth/adwords'],
  writeAccounts: [],
};
const credentials = {accessToken: 'synthetic-secret-token', loginCustomerId: '999'};
const failure = (reason: string, message = 'Access denied') => ({
  error: {
    code: 403,
    status: 'PERMISSION_DENIED',
    message: 'The caller does not have permission',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        requestId: 'synthetic-body-trace',
        errors: [
          {
            errorCode: {authorizationError: reason},
            message,
            trigger: {stringValue: 'private-trigger'},
            access_token: 'private-access-token',
          },
        ],
      },
    ],
  },
  refresh_token: 'private-refresh-token',
});
const denied = (reason: string) =>
  Response.json(failure(reason, 'Access denied access_token=private-inline-token'), {
    status: 403,
    headers: {'request-id': 'synthetic-header-trace'},
  });
const account = {
  id: '300',
  descriptiveName: 'Synthetic manager',
  manager: true,
  status: 'ENABLED',
  currencyCode: 'USD',
  timeZone: 'UTC',
};
function fixture() {
  const calls: JsonObject[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      headers = new Headers(init?.headers),
      body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({path, headers, body});
    if (path.endsWith(':listAccessibleCustomers')) {
      assert.equal(headers.get('login-customer-id'), null);
      return Response.json({resourceNames: ['customers/300', 'customers/400', 'customers/500']});
    }
    assert.equal(init?.method, 'POST');
    assert.match(body.query, /^SELECT .* FROM customer(?:_client)?$/);
    if (path.includes('/400/')) return denied('USER_PERMISSION_DENIED');
    if (path.includes('/500/')) return denied('ACTION_NOT_PERMITTED');
    if (body.query.includes('FROM customer_client'))
      return Response.json({
        results: [
          {
            customerClient: {
              id: '301',
              clientCustomer: 'customers/301',
              descriptiveName: 'Cancelled account',
              status: 'CANCELED',
              manager: false,
              currencyCode: 'USD',
              timeZone: 'UTC',
            },
          },
        ],
      });
    return Response.json({results: [{customer: account}]});
  };
  return {calls, fetcher};
}

test('Google partial sync retains provider reasons and request context, without retrying 403 or losing successful accounts', async () => {
  const store = new Store(':memory:', key),
    f = fixture();
  try {
    store.putConnection(actor, connection, credentials);
    const group = (await new AssetDiscovery(store, f.fetcher).sync(connection)).groups[0]!;
    assert.equal(group.complete, false);
    assert.deepEqual(group.assets.map(a => a.id).sort(), ['300', '301', '400', '500']);
    assert.equal(group.assets.find(a => a.id === '301')!.status, 'CANCELED');
    assert.equal(group.diagnostics!.length, 2);
    const deniedAccount = group.diagnostics![0]!;
    assert.equal(deniedAccount.account_id, '400');
    assert.equal(deniedAccount.operation, 'account_sync');
    assert.equal(deniedAccount.provider.code, 'USER_PERMISSION_DENIED');
    assert.equal(deniedAccount.http_status, 403);
    assert.equal(deniedAccount.request.stage, 'account_lookup');
    assert.equal(deniedAccount.request.path, '/v25/customers/400/googleAds:search');
    assert.equal(deniedAccount.login_customer_id, '400');
    assert.equal(deniedAccount.provider.request_id, 'synthetic-header-trace');
    assert.match(group.error!, /400: USER_PERMISSION_DENIED/);
    assert.match(group.error!, /500: ACTION_NOT_PERMITTED/);
    assert.equal(f.calls.filter(c => c.path.includes('/400/')).length, 1);
    assert.equal(f.calls.filter(c => c.path.includes('/500/')).length, 1);
    assert.ok(!JSON.stringify(group).includes('private-'));
    assert.ok(!JSON.stringify(group).includes(credentials.accessToken));
    assert.deepEqual(store.listConnections('local')[0]!.accounts, ['300']);
    assert.deepEqual(store.listConnections('local')[0]!.writeAccounts, []);
  } finally {
    store.close();
  }
});

test('Google failures at the account-list and hierarchy stages retain their distinct request paths', async () => {
  for (const hierarchy of [false, true]) {
    const store = new Store(':memory:', key);
    try {
      store.putConnection(actor, connection, credentials);
      const group = (
        await new AssetDiscovery(store, async (url, init) => {
          if (String(url).endsWith(':listAccessibleCustomers'))
            return hierarchy ? Response.json({resourceNames: ['customers/300']}) : denied('SERVICE_DISABLED');
          return String(init?.body).includes('FROM customer_client')
            ? denied('CUSTOMER_NOT_ENABLED')
            : Response.json({results: [{customer: account}]});
        }).sync(connection)
      ).groups[0]!;
      assert.equal(group.complete, false);
      assert.equal(group.diagnostics![0]!.request.stage, hierarchy ? 'manager_hierarchy' : 'account_list');
      assert.equal(
        group.diagnostics![0]!.request.path,
        hierarchy ? '/v25/customers/300/googleAds:search' : '/v25/customers:listAccessibleCustomers',
      );
      assert.equal(group.assets.length, hierarchy ? 1 : 0);
    } finally {
      store.close();
    }
  }
});

test('expired credentials are reported as an incomplete sync without discarding account grants or making vendor requests', async () => {
  const store = new Store(':memory:', key);
  let calls = 0;
  try {
    store.putConnection(actor, connection, {...credentials, expiresAt: Date.now() - 1000});
    const group = (
      await new AssetDiscovery(store, async () => {
        calls++;
        throw Error('Unexpected vendor request');
      }).sync(connection)
    ).groups[0]!;
    assert.equal(group.complete, false);
    assert.equal(group.diagnostics![0]!.code, 'REAUTHORIZATION_REQUIRED');
    assert.match(group.diagnostics![0]!.next_action, /Reconnect/);
    assert.equal(calls, 0);
    assert.deepEqual(store.listConnections('local')[0]!.accounts, ['300']);
  } finally {
    store.close();
  }
});

test('Google project access works without a legacy developer token while OAuth and Microsoft developer-token checks remain enforced', async () => {
  const calls: Headers[] = [];
  const transport = new NativeTransport(async (_url, init) => {
    calls.push(new Headers(init?.headers));
    return Response.json({results: []});
  });
  const plan: CompiledRequest = {
    gateway: connection.gateway,
    action: 'report',
    accountId: '300',
    path: '/v25/customers/300/googleAds:search',
    method: 'POST',
    query: {},
    body: {query: 'SELECT customer.id FROM customer'},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'TEST',
    warnings: [],
  };
  await transport.request(plan, connection, credentials);
  assert.equal(calls[0]!.get('developer-token'), null);
  assert.equal(calls[0]!.get('Authorization'), 'Bearer ' + credentials.accessToken);
  await transport.request(plan, connection, {...credentials, developerToken: 'synthetic-legacy-token'});
  // PRV-04: Google sunset developer tokens on 2026-09-09 and will reject the header, so a configured legacy token is
  // no longer sent (this assertion previously required it to be sent).
  assert.equal(calls[1]!.get('developer-token'), null);
  await assert.rejects(
    () => transport.request(plan, connection, {}),
    (e: MirrorError) => e.code === 'CREDENTIALS_REQUIRED',
  );
  await assert.rejects(
    () =>
      transport.request(
        {
          ...plan,
          gateway: 'microsoft_ads_native_action',
          origin: 'https://campaign.api.bingads.microsoft.com',
          path: '/CampaignManagement/v13/Campaigns/Query',
        },
        {...connection, gateway: 'microsoft_ads_native_action'},
        credentials,
      ),
    (e: MirrorError) => e.code === 'DEVELOPER_TOKEN_REQUIRED',
  );
  assert.equal(calls.length, 2);
});

test('Google diagnostics distinguish project approval, ambiguous v23 authorization and inactive accounts', () => {
  const diagnostic = (reason: string) =>
    assetSyncDiagnostic(
      new MirrorError('INSUFFICIENT_SCOPE', 'Platform returned HTTP 403', {upstream: failure(reason)}, 403),
      'google',
      connection.id,
      'ad_accounts',
      '400',
    );
  assert.match(diagnostic('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION').next_action, /project that owns AMCP/);
  assert.match(diagnostic('ACTION_NOT_PERMITTED').next_action, /does not prove that a higher tier/);
  assert.match(diagnostic('CUSTOMER_NOT_ENABLED').next_action, /does not reactivate/);
  assert.match(diagnostic('USER_PERMISSION_DENIED').next_action, /Google identity/);
});

test('Connections and Activity expose safe Google sync diagnostics behind authentication and preserve prior selection', async () => {
  const store = new Store(':memory:', key),
    f = fixture(),
    origin = 'https://amcp.shop';
  store.putConnection(actor, connection, credentials);
  const service = new MirrorService(new Registry(), store),
    app = createHttpApp(service, store, {
      website: {origin, masterKey: key, adminPassword: 'synthetic-sync-password', fetcher: f.fetcher},
    }),
    server = await listenForFetch(app);
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  try {
    assert.equal((await fetch(base + '/api/activity')).status, 401);
    const login = await fetch(base + '/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-sync-password'}),
    });
    const data = (await login.json()) as JsonObject,
      headers = {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: login.headers.get('set-cookie')!.split(';')[0]!,
        'X-AMCP-CSRF': data.csrf,
      };
    const response = await fetch(base + '/api/connections/' + connection.id + '/sync', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as JsonObject;
    assert.equal(result.status, 'attention');
    assert.deepEqual(result.accounts, ['300']);
    assert.equal(result.groups[0].diagnostics.length, 2);
    const activity = (await (await fetch(base + '/api/activity', {headers})).json()) as JsonObject;
    const event = activity.events.find((e: JsonObject) => e.event.event === 'website_asset_sync');
    assert.equal(event.event.complete, false);
    assert.equal(event.event.error.code, 'ASSET_SYNC_INCOMPLETE');
    assert.equal(event.diagnostics[0].provider.code, 'USER_PERMISSION_DENIED');
    assert.equal(event.diagnostics[1].provider.code, 'ACTION_NOT_PERMITTED');
    assert.equal(event.event.vendor_writes, 0);
    assert.ok(!JSON.stringify({result, activity}).includes('private-'));
    assert.ok(!JSON.stringify({result, activity}).includes(credentials.accessToken));
    const anonymous = (await (await fetch(base + '/api/platforms')).json()) as JsonObject;
    assert.ok(anonymous.platforms.every((p: JsonObject) => !p.connections.length));
  } finally {
    await new Promise<void>(r => {
      server.close(() => r());
      server.closeAllConnections();
    });
    store.close();
  }
});

test('the connection manager displays provider-specific failures and escapes untrusted provider messages', () => {
  const esc = (value: unknown) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  const context = createContext({esc, document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  const app = readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('function renderAssetSyncDiagnostics('),
    end = app.indexOf('\n}', start) + 2;
  new Script(app.slice(start, end)).runInContext(context);
  context.group = {
    diagnostics: [
      {
        account_id: '400',
        code: 'INSUFFICIENT_SCOPE',
        provider: {code: 'USER_PERMISSION_DENIED', message: '<img src=x onerror=alert(1)>'},
        request: {stage: 'manager_hierarchy', method: 'POST', path: '/v25/customers/400/googleAds:search'},
        next_action: 'Check the connected Google identity',
      },
    ],
  };
  const html = new Script('renderAssetSyncDiagnostics(group)').runInContext(context) as string;
  assert.match(html, /400 · USER_PERMISSION_DENIED/);
  assert.match(html, /Manager account hierarchy/);
  assert.match(html, /Check the connected Google identity/);
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<img'));
});
