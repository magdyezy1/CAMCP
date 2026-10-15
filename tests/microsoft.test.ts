import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {CredentialProvider} from '../src/auth.js';
import {WebStore} from '../server/web-store.js';
import {PlatformOAuth, platform} from '../server/platform-oauth.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {createHttpApp} from '../server/http-app.js';
import {
  compileMicrosoft,
  microsoftGateway as gateway,
  microsoftScope,
  microsoftActions,
  assertMicrosoftWrite,
  microsoftSnapshots,
  validateMicrosoftResponse,
  microsoftContracts,
  microsoftSearchVerification,
  microsoftAdditionalFields,
  microsoftReturnFields,
} from '../src/microsoft-native.js';
import {campaignRecipe} from '../src/campaign-recipes.js';
import fs from 'node:fs';
import type {Connection, JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
const admin = {tenantId: 't', userId: 'u', role: 'admin' as const},
  operator = {...admin, role: 'operator' as const};
const key = Buffer.alloc(32, 56).toString('base64');
const connection: Connection = {
  id: 'ms',
  tenantId: 't',
  label: 'Synthetic Microsoft',
  gateway,
  accounts: ['123'],
  writeAccounts: ['123'],
  accountCustomers: {'123': '456'},
  scopes: [microsoftScope],
  enabled: true,
};
const policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};

test('Microsoft v13 catalog compiles exact native contracts, IDs and cross-account report scope', () => {
  const registry = new Registry();
  // 31 with the three campaign location-criterion operations (CMP-03).
  assert.equal(microsoftActions.length, 31);
  assert.ok(registry.listTools({mode: 'strict', flags: {}}).some(t => t.name === gateway));
  for (const input of [
    {action: 'GetCampaignsByAccountId', account_id: '123', payload: {AccountId: '999'}},
    {action: 'GetCampaignsByAccountId', account_id: '123', payload: {CustomerId: '999'}},
    {action: 'GetCampaignsByAccountId', account_id: 123},
    {action: 'GetCampaignsByIds', account_id: '123', payload: {CampaignIds: ['1', '1']}},
  ])
    assert.throws(() => compileMicrosoft(input));
  const p = compileMicrosoft({action: 'GetCampaignsByAccountId', account_id: '123'});
  assert.equal(p.method, 'POST');
  assert.equal(p.path, '/CampaignManagement/v13/Campaigns/QueryByAccountId');
  assert.deepEqual(p.body, {AccountId: '123'});
  assert.equal(p.readOnly, true);
  assert.equal(
    registry
      .help({gateway, operation: 'AddCampaigns'}, {mode: 'strict', flags: {}})
      .raw.payload_fields.includes('Campaigns'),
    true,
  );
  assert.throws(() => registry.help({gateway, operation: 'Unknown'}, {mode: 'strict', flags: {}}), /Unknown Microsoft/);
  assert.throws(
    () =>
      compileMicrosoft({
        action: 'SubmitGenerateReport',
        account_id: '123',
        payload: {ReportRequest: {Type: 'CampaignPerformanceReportRequest', Scope: {AccountIds: ['999']}}},
      }),
    /Scope/,
  );
});

test('Microsoft Search write qualification checks exact parent campaigns and rejects unsupported types or invalid budgets', () => {
  for (const row of [
    {CampaignType: 'PerformanceMax', DailyBudget: 20},
    {DailyBudget: 0},
    {DailyBudget: -1},
    {BudgetId: 123},
  ]) {
    const plan = compileMicrosoft({
      action: 'AddCampaigns',
      account_id: '123',
      payload: {Campaigns: [{Name: 'Example', Status: 'Paused', ...row}]},
    });
    assert.throws(() => assertMicrosoftWrite(plan));
  }
  const plan = compileMicrosoft({
    action: 'AddKeywords',
    account_id: '123',
    campaign_id: '100',
    payload: {AdGroupId: '200', Keywords: [{Text: 'example', MatchType: 'Exact', Status: 'Paused'}]},
  });
  const reads = microsoftSnapshots(plan),
    campaign = reads.find(r => r.action === 'GetCampaignsByIds')!;
  assert.deepEqual(campaign.body, {AccountId: '123', CampaignIds: ['100'], CampaignType: 'Search'});
  assert.throws(
    () =>
      validateMicrosoftResponse(
        campaign,
        {status: 200, headers: {}, data: {Campaigns: [{Id: '100', CampaignType: 'Shopping'}]}},
        true,
      ),
    /Only Search/,
  );
  assert.throws(
    () => validateMicrosoftResponse(campaign, {status: 200, headers: {}, data: {Campaigns: [null]}}, true),
    /every exact/,
  );
});

test('Microsoft scope, account grant and operator checks prevent egress', async () => {
  const store = new Store(':memory:', key);
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('Unexpected request');
    }),
    undefined,
    policy,
  );
  const args = {
    action: 'prepare',
    gateway,
    arguments: {
      action: 'AddCampaigns',
      account_id: '123',
      payload: {Campaigns: [{Name: 'Example', Status: 'Paused', DailyBudget: 10}]},
    },
  };
  try {
    store.putConnection(
      admin,
      {...connection, writeAccounts: []},
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    assert.equal((await service.call('amcp_write', args, operator)).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    store.putConnection(admin, {...connection, scopes: []}, {accessToken: 'synthetic', developerToken: 'synthetic'});
    assert.equal((await service.call('amcp_write', args, operator)).error.code, 'INSUFFICIENT_SCOPE');
    store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
    assert.equal((await service.call('amcp_write', args, {...operator, role: 'reader'})).success, false);
    assert.equal((await service.call(gateway, {action: 'GetAccount', account_id: '999'}, operator)).success, false);
    store.putConnection(
      admin,
      {...connection, accountCustomers: {}},
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    assert.equal(
      (await service.call(gateway, {action: 'GetAccount', account_id: '123'}, operator)).error.code,
      'MICROSOFT_CUSTOMER_REQUIRED',
    );
    assert.equal(requests, 0);
  } finally {
    store.close();
  }
});

test('Microsoft report submission does not retry job creation on a lost response', async () => {
  const plan = compileMicrosoft({
    action: 'SubmitGenerateReport',
    account_id: '123',
    payload: {
      ReportRequest: {
        Type: 'AccountPerformanceReportRequest',
        Scope: {AccountIds: ['123']},
        Columns: ['Clicks'],
        Aggregation: 'Summary',
        Time: {PredefinedTime: 'Yesterday'},
      },
    },
  });
  let calls = 0;
  const transport = new NativeTransport(
    async () => {
      calls++;
      throw Error('Synthetic lost response');
    },
    async () => {},
  );
  await assert.rejects(() =>
    transport.request(plan, connection, {accessToken: 'synthetic', developerToken: 'synthetic'}),
  );
  assert.equal(calls, 1);
  assert.throws(
    () => validateMicrosoftResponse(plan, {status: 200, headers: {}, data: {}}),
    e => e instanceof Error && 'code' in e && e.code === 'UPSTREAM_RESPONSE_INVALID',
  );
});

test('Microsoft OAuth uses S256, separate developer token and durable refresh rotation', async () => {
  const store = new Store(':memory:', key),
    web = new WebStore(store, {
      origin: 'https://amcp.shop',
      masterKey: key,
      adminPassword: 'synthetic-microsoft-password',
    }),
    session = await web.signIn('synthetic-microsoft-password', 'test');
  try {
    const env = {
      AMCP_MICROSOFT_CLIENT_ID: 'synthetic-client',
      AMCP_MICROSOFT_CLIENT_SECRET: 'synthetic-secret',
      AMCP_MICROSOFT_DEVELOPER_TOKEN: 'synthetic-developer',
    };
    const auth = new PlatformOAuth(
      web,
      env,
      async (url, init) => {
        assert.equal(String(url), platform('microsoft').token);
        const b = new URLSearchParams(String(init?.body));
        assert.ok(b.get('code_verifier'));
        assert.equal(b.get('redirect_uri'), 'https://amcp.shop/api/auth/microsoft/callback');
        assert.equal(b.get('scope'), microsoftScope + ' offline_access');
        return Response.json({access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600});
      },
      true,
    );
    const start = await auth.start(session, 'microsoft'),
      url = new URL(start.url);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), microsoftScope + ' offline_access');
    const pending = web.consumeOAuth(session, 'microsoft', url.searchParams.get('state')!),
      result = await auth.exchange('microsoft', pending, {code: 'synthetic-code'});
    assert.equal(result.credentials.developerToken, 'synthetic-developer');
    assert.ok(result.scopes.includes(microsoftScope));
    store.putConnection(admin, connection, {...result.credentials, expiresAt: Date.now() - 1});
    let refreshed = 0;
    const provider = new CredentialProvider(store, async (url, init) => {
      refreshed++;
      assert.equal(String(url), platform('microsoft').token);
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'synthetic-refresh');
      return Response.json({access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', expires_in: 3600});
    });
    await Promise.all([provider.get(connection), provider.get(connection)]);
    assert.equal(refreshed, 1);
    assert.equal(store.credentials('t', 'ms').refreshToken, 'synthetic-rotated');
    assert.equal(
      new PlatformOAuth(web, {...env, AMCP_MICROSOFT_DEVELOPER_TOKEN: ''}).config(platform('microsoft')).configured,
      false,
    );
  } finally {
    store.close();
  }
});

test('Microsoft paginated discovery binds each advertiser to its own parent customer', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  let searches = 0;
  try {
    const discovery = new AssetDiscovery(store, async (url, init) => {
      assert.equal(new URL(String(url)).origin, 'https://clientcenter.api.bingads.microsoft.com');
      const h = new Headers(init?.headers);
      assert.equal(h.get('authorization'), 'Bearer synthetic');
      assert.equal(h.get('developertoken'), 'synthetic-developer');
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/User/Query')) {
        assert.equal(body.UserId, null);
        return Response.json({User: {Id: '789'}});
      }
      assert.deepEqual(body.Predicates, [{Field: 'UserId', Operator: 'Equals', Value: '789'}]);
      assert.equal(body.PageInfo.Index, searches++);
      return Response.json({
        Accounts:
          body.PageInfo.Index === 0
            ? Array.from({length: 100}, (_, i) => ({
                Id: String(i + 1000),
                ParentCustomerId: i % 2 ? '456' : '457',
                Name: 'Synthetic',
                CurrencyCode: 'EUR',
                TimeZone: 'Paris',
              }))
            : [{Id: '2000', ParentCustomerId: '458', Name: 'Last'}],
      });
    });
    const result = await discovery.sync(connection);
    assert.equal(result.groups[0]!.complete, true, result.groups[0]!.error);
    assert.equal(result.groups[0]!.assets.length, 101);
    assert.equal(result.groups[0]!.assets.at(-1)!.parentId, '458');
    assert.equal(searches, 2);
  } finally {
    store.close();
  }
});

test('Microsoft reviewed hierarchy creates campaign → ad group → RSA → keyword with no list calls', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  let writes = 0,
    reads = 0;
  const sent: JsonObject[] = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async (url, init) => {
        const path = new URL(String(url)).pathname,
          body = JSON.parse(String(init?.body)),
          headers = new Headers(init?.headers);
        assert.equal(headers.get('CustomerAccountId'), '123');
        assert.equal(headers.get('CustomerId'), '456');
        const reply = (data: JsonObject) =>
          Response.json({...data, TrackingId: String(++reads), futureEnvelopeTelemetry: {cost: reads}});
        if (path.endsWith('/Account/Query'))
          return reply({Account: {Id: '123', ParentCustomerId: '456', CurrencyCode: 'USD'}});
        if (path.endsWith('/Campaigns/QueryByIds'))
          return reply({Campaigns: [{Id: '100', Name: 'Campaign', Status: 'Paused', DailyBudget: 50}]});
        if (path.endsWith('/AdGroups/QueryByIds')) {
          assert.equal(body.CampaignId, '100');
          return reply({AdGroups: [{Id: '200', Name: 'Ad group', Status: 'Paused'}]});
        }
        writes++;
        sent.push(body);
        const kind = path.split('/').at(-1)!,
          ids: Record<string, string> = {Campaigns: '100', AdGroups: '200', Ads: '300', Keywords: '400'};
        return Response.json({[kind.slice(0, -1) + 'Ids']: [ids[kind]], PartialErrors: null});
      }),
      undefined,
      policy,
    );
  async function create(action: string, payload: JsonObject, campaign_id?: string) {
    const p = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', payload, ...(campaign_id ? {campaign_id} : {})},
      },
      operator,
    );
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(typeof p.data.state_hash, 'string');
    const r = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      operator,
    );
    assert.equal(r.success, true, JSON.stringify(r));
    return r;
  }
  try {
    await create('AddCampaigns', {
      Campaigns: [
        {
          Name: 'Campaign',
          CampaignType: 'Search',
          DailyBudget: 50,
          BudgetType: 'DailyBudgetStandard',
          Status: 'Paused',
        },
      ],
    });
    await create('AddAdGroups', {
      CampaignId: '100',
      AdGroups: [{Name: 'Ad group', Status: 'Paused', CpcBid: {Amount: 1.25}}],
    });
    await create(
      'AddAds',
      {
        AdGroupId: '200',
        Ads: [
          {
            Type: 'ResponsiveSearch',
            Status: 'Paused',
            FinalUrls: ['https://example.com'],
            Headlines: [
              {Asset: {Type: 'TextAsset', Text: 'First headline'}},
              {Asset: {Type: 'TextAsset', Text: 'Second headline'}},
              {Asset: {Type: 'TextAsset', Text: 'Third headline'}},
            ],
            Descriptions: [
              {Asset: {Type: 'TextAsset', Text: 'First description'}},
              {Asset: {Type: 'TextAsset', Text: 'Second description'}},
            ],
          },
        ],
      },
      '100',
    );
    await create(
      'AddKeywords',
      {AdGroupId: '200', Keywords: [{Text: 'example', MatchType: 'Exact', Status: 'Paused', Bid: {Amount: 1.25}}]},
      '100',
    );
    assert.equal(writes, 4);
    assert.equal(sent[0]!.Campaigns[0].DailyBudget, 50);
    assert.equal(sent[2]!.CampaignId, undefined);
    assert.equal(store.verifyAudit(), true);
  } finally {
    store.close();
  }
});

test('Microsoft budget changes invalidate review and partial mutation results are retained without retry', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  let budget = 10,
    writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/Account/Query')) return Response.json({Account: {Id: '123'}});
      if (path.includes('/QueryByIds'))
        return Response.json({Campaigns: [{Id: '100', DailyBudget: budget, Status: 'Paused'}]});
      writes++;
      return Response.json({PartialErrors: [{Index: 0, Code: 1, Message: 'Synthetic failure'}]});
    }),
    undefined,
    policy,
  );
  const prepare = () =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action: 'UpdateCampaigns', account_id: '123', payload: {Campaigns: [{Id: '100', DailyBudget: 30}]}},
      },
      operator,
    );
  try {
    const p = await prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    budget = 20;
    const e = {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    };
    const stale = await service.call('amcp_write', e, operator);
    assert.equal(stale.error.code, 'STATE_CHANGED');
    assert.ok(JSON.stringify(stale.error.details).includes('DailyBudget'));
    assert.equal(writes, 0);
    const next = await prepare(),
      execute = {...e, review_id: next.data.review_id, idempotency_key: next.data.idempotency_key};
    assert.equal((await service.call('amcp_write', execute, operator)).success, false);
    assert.equal((await service.call('amcp_write', execute, operator)).success, false);
    assert.equal(writes, 1);
  } finally {
    store.close();
  }
});

test('Microsoft report submission and polling stay bound to original connection and selected account', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  let calls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async url => {
      calls++;
      return Response.json(
        String(url).endsWith('/Submit')
          ? {ReportRequestId: 'report-1'}
          : {
              ReportRequestStatus: {
                Status: 'Success',
                ReportDownloadUrl: 'https://reports.example.invalid/synthetic.zip',
              },
            },
      );
    }),
    undefined,
    policy,
  );
  const args = {
    action: 'SubmitGenerateReport',
    account_id: '123',
    payload: {
      ReportRequest: {
        Type: 'CampaignPerformanceReportRequest',
        Scope: {AccountIds: ['123']},
        Columns: ['CampaignId', 'Clicks', 'Spend'],
        Aggregation: 'Summary',
        Format: 'Csv',
        Time: {PredefinedTime: 'Yesterday'},
      },
    },
  };
  try {
    assert.equal((await service.call(gateway, {...args, dry_run: true}, operator)).success, true);
    assert.equal(calls, 0);
    assert.equal(
      (
        await service.call(
          gateway,
          {action: 'PollGenerateReport', account_id: '123', payload: {ReportRequestId: 'report-1'}},
          operator,
        )
      ).error.code,
      'RESOURCE_SCOPE_REQUIRED',
    );
    assert.equal((await service.call(gateway, args, operator)).success, true);
    assert.equal(
      (
        await service.call(
          gateway,
          {action: 'PollGenerateReport', account_id: '123', payload: {ReportRequestId: 'report-1'}},
          operator,
        )
      ).success,
      true,
    );
    store.putConnection(
      admin,
      {...connection, id: 'other'},
      {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
    );
    assert.equal(
      (
        await service.call(
          gateway,
          {
            action: 'PollGenerateReport',
            connection_id: 'other',
            account_id: '123',
            payload: {ReportRequestId: 'report-1'},
          },
          operator,
        )
      ).error.code,
      'RESOURCE_SCOPE_REQUIRED',
    );
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});

test('website Microsoft OAuth account selection persists customer mapping and default reviewed write grants', async () => {
  const keys = ['AMCP_MICROSOFT_CLIENT_ID', 'AMCP_MICROSOFT_CLIENT_SECRET', 'AMCP_MICROSOFT_DEVELOPER_TOKEN'],
    previous = keys.map(k => process.env[k]);
  keys.forEach(k => (process.env[k] = 'synthetic'));
  const store = new Store(':memory:', key),
    origin = 'https://amcp.shop',
    password = 'synthetic-ms-website-password';
  const fake: typeof fetch = async url => {
    const path = new URL(String(url)).pathname;
    return Response.json(
      path.endsWith('/token')
        ? {access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_in: 3600}
        : path.endsWith('/User/Query')
          ? {User: {Id: '789'}}
          : {Accounts: [{Id: '123', ParentCustomerId: '456', Name: 'Synthetic', CurrencyCode: 'USD'}]},
    );
  };
  const listener = await listenForFetch(
    createHttpApp(new MirrorService(new Registry(), store, undefined, undefined, policy), store, {
      website: {origin, masterKey: key, adminPassword: password, fetcher: fake},
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, 'Content-Type': 'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const login = await request('/api/session', 'POST', {password}),
      session = await login.json(),
      headers = {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': session.csrf};
    const started = await (await request('/api/auth/microsoft/start', 'POST', {}, headers)).json(),
      state = new URL(started.url).searchParams.get('state');
    assert.ok(state);
    assert.equal(
      (await request('/api/auth/microsoft/callback?state=' + state + '&code=synthetic', 'GET', undefined, headers))
        .status,
      303,
    );
    const c = store.listConnections('local')[0]!;
    assert.equal(c.enabled, false);
    assert.deepEqual(c.accounts, []);
    assert.equal(
      (await request('/api/connections/' + c.id + '/assets', 'PATCH', {selected: ['ad_accounts:999']}, headers)).status,
      409,
    );
    // The default reviewed write grant now needs explicit confirmation (owner decision D19, CON-05); this test used to
    // expect the grant without it.
    assert.equal(
      (await request('/api/connections/' + c.id + '/assets', 'PATCH', {selected: ['ad_accounts:123']}, headers)).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/api/connections/' + c.id + '/assets',
          'PATCH',
          {selected: ['ad_accounts:123'], confirmed: true},
          headers,
        )
      ).status,
      200,
    );
    let saved = store.listConnections('local')[0]!;
    assert.deepEqual(saved.accountCustomers, {'123': '456'});
    assert.deepEqual(saved.writeAccounts, ['123']);
    const config = await (await request('/api/platforms')).json();
    assert.equal(JSON.stringify(config).includes('synthetic-refresh'), false);
    assert.equal((await request('/api/connections/' + c.id + '/assets', 'PATCH', {selected: []}, headers)).status, 200);
    saved = store.listConnections('local')[0]!;
    assert.deepEqual(saved.accountCustomers, {});
    assert.deepEqual(saved.writeAccounts, []);
    assert.equal(saved.enabled, false);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    store.close();
    keys.forEach((k, i) => (previous[i] === undefined ? delete process.env[k] : (process.env[k] = previous[i])));
  }
});

test('write inspection reports contract support with no credential, state or provider access', async () => {
  const store = new Store(':memory:'),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('Unexpected egress');
      }),
      undefined,
      policy,
    );
  try {
    const supported = await service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway,
        arguments: {action: 'UpdateCampaigns', account_id: '123', payload: {Campaigns: [{Id: '100', DailyBudget: 25}]}},
      },
      operator,
    );
    assert.equal(supported.success, true);
    assert.equal(supported.data.review_contract_supported, true);
    assert.equal(supported.data.network_requests, 0);
    assert.equal(supported.data.live_permissions_verified, false);
    const unsupported = await service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'meta_native_action',
        arguments: {
          action: 'meta_business_id_business_users_create',
          account_id: '123',
          path_params: {business_id: '999'},
          payload: {name: 'Example'},
        },
      },
      operator,
    );
    assert.equal(unsupported.success, true, JSON.stringify(unsupported));
    assert.equal(unsupported.data.review_contract_supported, false);
    assert.equal(unsupported.data.network_requests, 0);
    const before = store.documents('t', 'write_review');
    assert.equal(before.length, 0);
  } finally {
    store.close();
  }
});

for (const kind of ['Campaigns', 'AdGroups', 'Ads', 'Keywords'])
  for (const verb of ['Update', 'Delete'])
    test('Microsoft ' + verb + kind + ' uses exact target snapshots and one native mutation', async () => {
      const store = new Store(':memory:', key);
      store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
      let writes = 0;
      const service = new MirrorService(
        new Registry(),
        store,
        new NativeTransport(async (url, init) => {
          const path = new URL(String(url)).pathname,
            b = JSON.parse(String(init?.body));
          if (path.endsWith('/Account/Query')) return Response.json({Account: {Id: '123'}});
          if (path.endsWith('/QueryByIds')) {
            const entity = path.split('/').at(-2)!,
              ids = b[entity.slice(0, -1) + 'Ids'];
            return Response.json({
              [entity]: ids.map((Id: string) => ({
                Id,
                Name: 'Existing',
                Status: 'Paused',
                ...(entity === 'Campaigns' ? {DailyBudget: 10} : {}),
              })),
            });
          }
          writes++;
          assert.equal(init?.method, verb === 'Update' ? 'PUT' : 'DELETE');
          assert.equal(path, '/CampaignManagement/v13/' + kind);
          assert.equal(new Headers(init?.headers).get('CustomerAccountId'), '123');
          return Response.json({PartialErrors: null});
        }),
        undefined,
        policy,
      );
      try {
        const parent =
            kind === 'Campaigns' ? {AccountId: '123'} : kind === 'AdGroups' ? {CampaignId: '100'} : {AdGroupId: '200'},
          payload = {
            ...parent,
            ...(verb === 'Update' ? {[kind]: [{Id: '300', Status: 'Paused'}]} : {[kind.slice(0, -1) + 'Ids']: ['300']}),
          };
        const p = await service.call(
          'amcp_write',
          {
            action: 'prepare',
            gateway,
            arguments: {action: verb + kind, account_id: '123', campaign_id: '100', payload},
          },
          operator,
        );
        assert.equal(p.success, true, JSON.stringify(p));
        const e = await service.call(
          'amcp_write',
          {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
          operator,
        );
        assert.equal(e.success, true, JSON.stringify(e));
        assert.equal(writes, 1);
      } finally {
        store.close();
      }
    });

/**
 * A synthetic Microsoft campaign-management API that keeps what was written and reads it back by exact ID. Like the
 * provider, it returns AdScheduleUseSearcherTimeZone and MaxConversionsBiddingScheme.TargetCpa only when
 * ReturnAdditionalFields names them, and it refuses a GetAdsByIds without AdTypes.
 */
function statefulMicrosoft() {
  const records = new Map<string, JsonObject>(),
    reads: {kind: string; body: JsonObject}[] = [],
    writes: {kind: string; method: string; body: JsonObject}[] = [];
  let next = 100;
  const transport = new NativeTransport(async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body ?? '{}'));
    if (path.endsWith('/Account/Query'))
      return Response.json({Account: {Id: '123', ParentCustomerId: '456', CurrencyCode: 'USD'}});
    // Location criteria (CMP-03): the microsoft_search pack adds the brief's locations after its campaign.
    if (path.endsWith('/CampaignCriterions/QueryByIds')) {
      reads.push({kind: 'CampaignCriterions', body});
      const own = [...records.entries()]
        .filter(([k, r]) => k.startsWith('CampaignCriterions:') && r.CampaignId === body.CampaignId)
        .map(([, r]) => structuredClone(r));
      return Response.json({
        CampaignCriterions:
          body.CampaignCriterionIds === null
            ? own
            : body.CampaignCriterionIds.map((id: string) => own.find(r => r.Id === id) ?? null),
        PartialErrors: null,
      });
    }
    if (path.endsWith('/CampaignCriterions') && init?.method === 'POST') {
      writes.push({kind: 'CampaignCriterions', method: 'POST', body});
      return Response.json({
        CampaignCriterionIds: body.CampaignCriterions.map((r: JsonObject) => {
          const Id = String(next++);
          // Like the provider: Status Active, a 0 bid multiplier when none was sent, and the location's name.
          records.set('CampaignCriterions:' + Id, {
            ...structuredClone(r),
            Id,
            Status: 'Active',
            CriterionBid: {Type: 'BidMultiplier', Multiplier: 0},
            Criterion: {...r.Criterion, DisplayName: 'Synthetic location ' + r.Criterion.LocationId},
          });
          return Id;
        }),
        NestedPartialErrors: [],
      });
    }
    const kind = /\/CampaignManagement\/v13\/(Campaigns|AdGroups|Ads|Keywords)(?:\/QueryByIds)?$/.exec(path)?.[1];
    assert.ok(kind, path);
    if (path.endsWith('/QueryByIds')) {
      reads.push({kind, body});
      if (kind === 'Ads' && !Array.isArray(body.AdTypes))
        return Response.json({Errors: [{Code: 1, Message: 'AdTypes required'}]}, {status: 400});
      const asked = String(body.ReturnAdditionalFields ?? '').split(',');
      return Response.json({
        [kind]: body[kind.slice(0, -1) + 'Ids'].map((Id: string) => {
          const r = structuredClone(records.get(kind + ':' + Id));
          if (!r) return null;
          if (!asked.includes('AdScheduleUseSearcherTimeZone')) delete r.AdScheduleUseSearcherTimeZone;
          if (r.BiddingScheme?.Type === 'MaxConversionsBiddingScheme' && !asked.includes('TargetCpaInMaxConversion'))
            delete r.BiddingScheme.TargetCpa;
          return r;
        }),
      });
    }
    writes.push({kind, method: String(init?.method), body});
    if (init?.method === 'POST')
      return Response.json({
        [kind.slice(0, -1) + 'Ids']: body[kind].map((r: JsonObject) => {
          const Id = String(next++);
          records.set(kind + ':' + Id, {...structuredClone(r), Id});
          return Id;
        }),
        PartialErrors: null,
      });
    for (const r of body[kind] ?? []) records.set(kind + ':' + r.Id, {...records.get(kind + ':' + r.Id), ...r});
    return Response.json({PartialErrors: null});
  });
  return {records, reads, writes, transport};
}
const rsa = (overrides: JsonObject = {}) => ({
  Type: 'ResponsiveSearch',
  Status: 'Paused',
  FinalUrls: ['https://example.com'],
  Headlines: ['First headline', 'Second headline', 'Third headline'].map(Text => ({Asset: {Type: 'TextAsset', Text}})),
  Descriptions: ['First description', 'Second description'].map(Text => ({Asset: {Type: 'TextAsset', Text}})),
  ...overrides,
});
async function reviewedWrite(
  service: MirrorService,
  ms: ReturnType<typeof statefulMicrosoft>,
  action: string,
  payload: JsonObject,
  campaign_id?: string,
) {
  const p = await service.call(
    'amcp_write',
    {
      action: 'prepare',
      gateway,
      arguments: {action, account_id: '123', payload, ...(campaign_id ? {campaign_id} : {})},
    },
    operator,
  );
  assert.equal(p.success, true, JSON.stringify(p));
  const r = await service.call(
    'amcp_write',
    {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    },
    operator,
  );
  assert.equal(r.success, true, JSON.stringify(r));
  const before = ms.reads.length,
    v = await service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, operator);
  assert.equal(v.success, true, JSON.stringify(v));
  return {ids: r.data.data as JsonObject, verification: v.data as JsonObject, reads: ms.reads.slice(before)};
}

test('PRV-03: Microsoft AddAds and UpdateAds verify by exact read-back with AdTypes (was unverified: Missing AdTypes)', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  const ms = statefulMicrosoft(),
    service = new MirrorService(new Registry(), store, ms.transport, undefined, policy),
    write = (action: string, payload: JsonObject, campaign_id?: string) =>
      reviewedWrite(service, ms, action, payload, campaign_id);
  try {
    const campaign = await write('AddCampaigns', {
      Campaigns: [
        {
          Name: 'Campaign',
          CampaignType: 'Search',
          DailyBudget: 50,
          BudgetType: 'DailyBudgetStandard',
          Status: 'Paused',
        },
      ],
    });
    assert.equal(campaign.verification.status, 'verified', JSON.stringify(campaign.verification));
    const campaignId = campaign.ids.CampaignIds[0];
    const group = await write('AddAdGroups', {
      CampaignId: campaignId,
      AdGroups: [{Name: 'Ad group', Status: 'Paused', CpcBid: {Amount: 1.25}}],
    });
    assert.equal(group.verification.status, 'verified', JSON.stringify(group.verification));
    const adGroupId = group.ids.AdGroupIds[0];
    const ad = await write('AddAds', {AdGroupId: adGroupId, Ads: [rsa()]}, campaignId);
    // Before PRV-03 the verification read omitted AdTypes, compileMicrosoft threw "Missing AdTypes" and the
    // receipt stayed unverified, so a microsoft_search plan never completed.
    assert.equal(ad.verification.status, 'verified', JSON.stringify(ad.verification));
    assert.equal(
      ad.verification.checks.some((c: JsonObject) => c.code === 'INVALID_MICROSOFT_REQUEST'),
      false,
    );
    assert.deepEqual(
      ad.reads.map(r => [r.kind, r.body.AdTypes, r.body.AdGroupId]),
      [['Ads', ['ResponsiveSearch'], adGroupId]],
    );
    const adId = ad.ids.AdIds[0];
    const keyword = await write(
      'AddKeywords',
      {AdGroupId: adGroupId, Keywords: [{Text: 'example', MatchType: 'Exact', Status: 'Paused', Bid: {Amount: 1.25}}]},
      campaignId,
    );
    assert.equal(keyword.verification.status, 'verified', JSON.stringify(keyword.verification));
    const updated = await write(
      'UpdateAds',
      {AdGroupId: adGroupId, Ads: [{Id: adId, Type: 'ResponsiveSearch', FinalUrls: ['https://example.com/new']}]},
      campaignId,
    );
    assert.equal(updated.verification.status, 'verified', JSON.stringify(updated.verification));
    assert.deepEqual(updated.reads.at(-1)!.body.AdTypes, ['ResponsiveSearch']);
    assert.deepEqual(ms.records.get('Ads:' + adId)!.FinalUrls, ['https://example.com/new']);
    // Verification only reads; it never repeats a mutation.
    assert.equal(ms.writes.length, 5);
  } finally {
    store.close();
  }
});

test('PRV-03: a written field Microsoft omits by default is requested on read-back so verification can compare it', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  const ms = statefulMicrosoft(),
    service = new MirrorService(new Registry(), store, ms.transport, undefined, policy);
  try {
    const campaign = await reviewedWrite(service, ms, 'AddCampaigns', {
      Campaigns: [
        {
          Name: 'Campaign',
          CampaignType: 'Search',
          DailyBudget: 50,
          BudgetType: 'DailyBudgetStandard',
          Status: 'Paused',
          AdScheduleUseSearcherTimeZone: true,
          BiddingScheme: {Type: 'MaxConversionsBiddingScheme', TargetCpa: 12.5},
        },
      ],
    });
    assert.equal(campaign.verification.status, 'verified', JSON.stringify(campaign.verification));
    assert.equal(
      campaign.reads.at(-1)!.body.ReturnAdditionalFields,
      'AdScheduleUseSearcherTimeZone,TargetCpaInMaxConversion',
    );
    assert.equal(campaign.reads.at(-1)!.body.CampaignType, 'Search');
  } finally {
    store.close();
  }
});

test('PRV-03 conformance: every Microsoft Get*ByIds snapshot and verification payload satisfies its contract', () => {
  const parents: Record<string, JsonObject> = {
      Campaigns: {AccountId: '123'},
      AdGroups: {CampaignId: '100'},
      Ads: {AdGroupId: '200'},
      Keywords: {AdGroupId: '200'},
    },
    records: Record<string, JsonObject> = {
      Campaigns: {Name: 'C', CampaignType: 'Search', DailyBudget: 5, Status: 'Paused'},
      AdGroups: {Name: 'G', Status: 'Paused'},
      Ads: rsa(),
      Keywords: {Text: 'k', MatchType: 'Exact', Status: 'Paused'},
    };
  let checked = 0;
  for (const kind of Object.keys(parents))
    for (const verb of ['Add', 'Update', 'Delete']) {
      const idsKey = kind.slice(0, -1) + 'Ids',
        payload = {
          ...parents[kind],
          ...(verb === 'Delete' ? {[idsKey]: ['300']} : {[kind]: [verb === 'Add' ? records[kind] : {Id: '300'}]}),
        },
        plan = compileMicrosoft({action: verb + kind, account_id: '123', campaign_id: '100', payload}),
        verification = microsoftSearchVerification(plan, {data: {[idsKey]: ['300']}}).map(v => v.read),
        reads = [...microsoftSnapshots(plan), ...verification];
      if (verb !== 'Delete')
        assert.deepEqual(
          verification.map(r => r.action),
          ['Get' + kind + 'ByIds'],
        );
      for (const read of reads.filter(r => /^Get(Campaigns|AdGroups|Ads|Keywords)ByIds$/.test(r.action))) {
        const body = read.body as JsonObject;
        for (const field of microsoftContracts.get(read.action)!.required)
          assert.notEqual(body[field], undefined, verb + kind + ' → ' + read.action + ' needs ' + field);
        if (read.action === 'GetAdsByIds') assert.deepEqual(body.AdTypes, ['ResponsiveSearch']);
        if (read.action === 'GetCampaignsByIds') assert.equal(body.CampaignType, 'Search');
        checked++;
      }
    }
  assert.ok(checked >= 16, String(checked));
});

test('PRV-03 conformance: every ReturnAdditionalFields value AMCP requests is in the pinned v13 WSDL enumeration', () => {
  const schemas = JSON.parse(fs.readFileSync('.mirror/VENDOR/microsoft-campaign-management-v13.json', 'utf8')).document
    .schemas;
  const enumeration = (name: string): string[] => {
    const found: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (String(node.kind).endsWith('}enumeration')) found.push(node.attributes.value);
      for (const child of node.children ?? []) walk(child);
    };
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node))
        if (k === 'simpleType:{https://bingads.microsoft.com/CampaignManagement/v13}' + name) walk(v);
        else if (v && typeof v === 'object') visit(v);
    };
    visit(schemas);
    return found;
  };
  const enumName: Record<string, string> = {
    Campaigns: 'CampaignAdditionalField',
    AdGroups: 'AdGroupAdditionalField',
    Ads: 'AdAdditionalField',
    Keywords: 'KeywordAdditionalField',
  };
  for (const [kind, table] of Object.entries(microsoftAdditionalFields)) {
    const allowed = enumeration(enumName[kind]!);
    assert.ok(allowed.length, kind);
    for (const field of [...table.fields, ...(table.settings ?? []), ...(table.schemes ?? [])])
      assert.ok(allowed.includes(field), kind + ' ' + field);
    if (kind === 'Campaigns') assert.ok(allowed.includes('TargetCpaInMaxConversion'));
  }
  assert.deepEqual(microsoftReturnFields('Ads', rsa()), []);
  assert.deepEqual(
    microsoftReturnFields('Campaigns', {
      Settings: [{Type: 'TargetSetting'}, {Type: 'ShoppingSetting'}],
      BiddingScheme: {Type: 'MaxConversionValueBiddingScheme', TargetRoas: 2},
    }),
    ['TargetSetting', 'MaxConversionValueBiddingScheme'],
  );
});

test('PRV-03: a microsoft_search plan reaches complete with synthetic read-back (its ad step stayed verifying)', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  const ms = statefulMicrosoft(),
    service = new MirrorService(new Registry(), store, ms.transport, undefined, policy),
    call = (input: JsonObject) => service.call('amcp_campaign', input, operator);
  try {
    const saved = await call({
      action: 'create_from_recipe',
      recipe: 'microsoft_search',
      business: {
        name: 'Synthetic Microsoft demand',
        account_id: '123',
        connection_id: connection.id,
        currency: 'USD',
        daily_budget: '25.00',
        cpc_bid: '1.25',
        language: 'English',
        keywords: ['running shoes'],
        headlines: ['Explore the collection', 'Find your next pair', 'Built for every day'],
        descriptions: ['Discover our latest collection online today.', 'Explore styles and find a pair today.'],
        destination_url: 'https://example.test/',
        location_ids: ['190'],
      },
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    // Five steps since CMP-03: the pack sets the campaign's locations (targets) before its ad group.
    for (let i = 0; i < 5; i++) {
      const prepared = await call({action: 'prepare_next', id: saved.data.id});
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
      const executed = await call({
        action: 'execute_next',
        id: saved.data.id,
        review_id: prepared.data.review.review_id,
        idempotency_key: prepared.data.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      });
      assert.equal(executed.success, true, JSON.stringify(executed));
      assert.equal(executed.data.current.status, 'verified', JSON.stringify(executed.data.current));
    }
    assert.deepEqual(
      store.document(operator.tenantId, 'campaign_run', saved.data.id).steps.map((s: JsonObject) => [s.id, s.status]),
      [
        ['campaign', 'verified'],
        ['targets', 'verified'],
        ['adgroup', 'verified'],
        ['keywords', 'verified'],
        ['ad', 'verified'],
      ],
    );
    const run = store.document(operator.tenantId, 'campaign_run', saved.data.id);
    assert.equal(run.state, 'complete');
    assert.equal(ms.writes.length, 5);
    assert.ok(ms.writes.every(w => w.method === 'POST'));
    // Every serving entity stays paused; the location criterion targets the paused campaign.
    const entries = [...ms.records.entries()];
    assert.ok(entries.filter(([k]) => !k.startsWith('CampaignCriterions:')).every(([, r]) => r.Status === 'Paused'));
    assert.deepEqual(
      entries.filter(([k]) => k.startsWith('CampaignCriterions:')).map(([, r]) => r.Criterion),
      [{Type: 'LocationCriterion', LocationId: '190', DisplayName: 'Synthetic location 190'}],
    );
    // The targets step reads the criterion back by ID: a positive location of this campaign, with no bid adjustment.
    const targets = run.steps.find((s: JsonObject) => s.id === 'targets');
    assert.deepEqual(
      targets.verification.checks.map((c: JsonObject) => [c.status, c.checked_fields]),
      [['verified', ['present', 'positive', 'campaign_id', 'location_id', 'bid_multiplier']]],
    );
  } finally {
    store.close();
  }
});

const microsoftBrief = {
  name: 'Synthetic Microsoft demand',
  account_id: '123',
  connection_id: connection.id,
  currency: 'USD',
  daily_budget: '25.00',
  cpc_bid: '1.25',
  language: 'English',
  keywords: ['running shoes'],
  headlines: ['Explore the collection', 'Find your next pair', 'Built for every day'],
  descriptions: ['Discover our latest collection online today.', 'Explore styles and find a pair today.'],
  destination_url: 'https://example.test/',
  location_ids: ['190'],
};
/** Prepares and executes the next `count` steps of a plan, confirming each reviewed spending effect (all synthetic). */
async function runSteps(call: (input: JsonObject) => Promise<JsonObject>, id: string, count: number) {
  for (let i = 0; i < count; i++) {
    const prepared = await call({action: 'prepare_next', id});
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    assert.ok(prepared.data.review?.review_id, JSON.stringify(prepared));
    const executed = await call({
      action: 'execute_next',
      id,
      review_id: prepared.data.review.review_id,
      idempotency_key: prepared.data.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(executed.data.current.status, 'verified', JSON.stringify(executed.data.current));
  }
}

test('CMP-03: a completed microsoft_search launch is activated by its own plan only while a positive location is read', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  const ms = statefulMicrosoft(),
    service = new MirrorService(new Registry(), store, ms.transport, undefined, policy),
    call = (input: JsonObject) => service.call('amcp_campaign', input, operator);
  try {
    const saved = await call({action: 'create_from_recipe', recipe: 'microsoft_search', business: microsoftBrief});
    assert.equal(saved.success, true, JSON.stringify(saved));
    await runSteps(call, saved.data.id, 5);
    const launch = await call({action: 'get', id: saved.data.id});
    assert.equal(launch.data.state, 'complete');
    assert.deepEqual(launch.data.activation_call.arguments, {action: 'activation_plan', id: saved.data.id});
    const drafted = await call({action: 'activation_plan', id: saved.data.id, detail: 'full'});
    assert.equal(drafted.success, true, JSON.stringify(drafted));
    const activation = drafted.data.id;
    assert.deepEqual(
      drafted.data.steps.map((s: JsonObject) => s.id),
      ['activate_campaign', 'activate_adgroup', 'activate_keywords', 'activate_ad'],
    );
    const writes = ms.writes.length,
      criterion = [...ms.records.keys()].find(k => k.startsWith('CampaignCriterions:'))!,
      location = ms.records.get(criterion)!;
    // The location removed in Microsoft: the gate blocks preflight, with a remedy, and nothing is prepared or sent.
    ms.records.delete(criterion);
    const blocked = await call({action: 'preflight', id: activation});
    assert.equal(blocked.data.blocked, true, JSON.stringify(blocked));
    const gate = blocked.data.missing_requirements[0];
    assert.equal(gate.gate, 'microsoft_location_criteria');
    assert.equal(gate.step, 'activate_campaign');
    assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED');
    assert.match(gate.error.remedy.action, /Nothing was activated/);
    assert.deepEqual(blocked.data.next_call.arguments, {action: 'preflight', id: activation});
    assert.equal((await call({action: 'prepare_next', id: activation})).data.blocked, true);
    assert.equal(ms.writes.length, writes);
    // With the location back, the gate passes and lists the name Microsoft gives it, for the operator to confirm.
    ms.records.set(criterion, location);
    const ready = await call({action: 'preflight', id: activation, detail: 'full'});
    assert.equal(ready.data.preflight.status, 'ready', JSON.stringify(ready.data.preflight));
    assert.deepEqual(ready.data.preflight.activation_gates, [
      {
        gate: 'microsoft_location_criteria',
        step: 'activate_campaign',
        status: 'gate_passed',
        locations: [{location_id: '190', name: 'Synthetic location 190'}],
      },
    ]);
    // The campaign step's own review reads the campaign's location criteria again before anything is sent.
    const reads = ms.reads.length;
    const first = await call({action: 'prepare_next', id: activation});
    assert.equal(first.data.step_id, 'activate_campaign', JSON.stringify(first));
    assert.ok(
      ms.reads
        .slice(reads)
        .some(r => r.kind === 'CampaignCriterions' && r.body.CampaignCriterionIds === null && r.body.CampaignId),
      'the activation review read the location criteria',
    );
    // Removed after that review: execution reads again and refuses before sending anything. Nothing was sent, so the
    // step is recovered and prepared again once the location is back.
    ms.records.delete(criterion);
    const stale = await call({
      action: 'execute_next',
      id: activation,
      review_id: first.data.review.review_id,
      idempotency_key: first.data.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(stale.data.current.status, 'failed', JSON.stringify(stale.data));
    assert.equal(stale.data.current.error.code, 'LOCATION_CRITERIA_REQUIRED', JSON.stringify(stale.data.current));
    assert.match(stale.data.current.error.remedy.action, /AddCampaignCriterions/);
    assert.equal(ms.writes.length, writes);
    ms.records.set(criterion, location);
    const recovered = await call({
      action: 'recover_step',
      id: activation,
      step_id: 'activate_campaign',
      confirmed: true,
    });
    assert.equal(recovered.success, true, JSON.stringify(recovered));
    await runSteps(call, activation, 4);
    // Campaign, ad group, keywords and ad were set Active, in that order; the location criterion was not touched.
    assert.deepEqual(
      ms.writes.slice(writes).map(w => [w.kind, w.method]),
      [
        ['Campaigns', 'PUT'],
        ['AdGroups', 'PUT'],
        ['Keywords', 'PUT'],
        ['Ads', 'PUT'],
      ],
    );
    for (const [k, r] of ms.records) if (!k.startsWith('CampaignCriterions:')) assert.equal(r.Status, 'Active', k);
    assert.equal((await call({action: 'get', id: activation})).data.state, 'complete');
  } finally {
    store.close();
  }
});

test('CMP-03 compatibility: a microsoft_search draft compiled without location targets is refused, location_ids named', async () => {
  const store = new Store(':memory:', key);
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic-developer'});
  const ms = statefulMicrosoft(),
    service = new MirrorService(new Registry(), store, ms.transport, undefined, policy),
    call = (input: JsonObject) => service.call('amcp_campaign', input, operator);
  try {
    // The plan the pack compiled before CMP-03 (campaign, ad group, keywords, ad), with its recipe record.
    const compiled = campaignRecipe('microsoft_search', microsoftBrief),
      legacy = compiled.steps.filter((s: JsonObject) => s.id !== 'targets');
    const created = await call({action: 'create', name: 'Legacy Microsoft draft', brief: 'Synthetic.', steps: legacy});
    assert.equal(created.success, true, JSON.stringify(created));
    const id = created.data.id,
      saved = store.document(operator.tenantId, 'campaign_run', id);
    store.putDocument(
      operator.tenantId,
      'campaign_run',
      id,
      {...saved, recipe: {...compiled.recipe, location_ids: undefined, availability: 'draft_only'}},
      saved.revision,
    );
    for (const action of ['preflight', 'prepare_next', 'approve']) {
      const refused = await call({action, id});
      assertRefused(refused, 'RECIPE_INPUT_REQUIRED', {writes: () => ms.writes.length});
      assert.deepEqual(refused.error.details.missing_fields, ['location_ids'], action);
      assert.match(refused.error.remedy.action, /recipe_context/);
    }
    // The plan the recipe compiles now carries its targets step, and its preflight is not refused for it.
    const current = await call({action: 'create_from_recipe', recipe: 'microsoft_search', business: microsoftBrief});
    const checked = await call({action: 'preflight', id: current.data.id, detail: 'full'});
    assert.equal(checked.success, true, JSON.stringify(checked));
    assert.equal(checked.data.preflight.status, 'ready', JSON.stringify(checked.data.preflight));
    assert.equal(ms.writes.length, 0);
  } finally {
    store.close();
  }
});
