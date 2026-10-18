// CON-06: Business Profile had reviewed write families but no website connection: the platform list had no Business
// Profile entry, no provider requested business.manage, discovery had no branch for it and readiness could not read a
// location, so an operator provisioned raw tokens through the CLI. A project Google has not approved answers with a
// quota of 0 requests per minute, which read as an ordinary rate limit. Amazon Ads (owner decision, option b) has no
// website login or profile discovery: its gateway was listed in tools/list and on website pages anyway.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {readOnlyPolicy} from '../dist/src/preflight.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {readinessPlan} from '../dist/src/workspace.js';
import {classifyProviderError} from '../dist/src/provider-error-taxonomy.js';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';
import {businessScope} from '../dist/src/google-business-assets.js';
import {gatewayOffered} from '../dist/src/provider-offering.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {PlatformOAuth, businessProfileApproved, platform} from '../dist/server/platform-oauth.js';
import {WebStore} from '../dist/server/web-store.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const key = Buffer.alloc(32, 67).toString('base64'),
  origin = 'https://amcp.shop',
  password = 'synthetic-business-profile-owner',
  owner = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'},
  registry = new Registry(),
  notApprovedMessage =
    'Google has not approved this AMCP project for the Business Profile APIs yet (a quota of 0 requests per minute). The AMCP owner must request access; reconnecting will not help.';

/** Google's answer for a Cloud project with a Business Profile quota of 0 requests per minute (not approved). */
const zeroQuota = () =>
  Response.json(
    {
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'.",
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED',
            domain: 'googleapis.com',
            metadata: {quota_limit_value: '0', service: 'mybusinessaccountmanagement.googleapis.com'},
          },
        ],
      },
    },
    {status: 429},
  );

/** Two business accounts; locations/3002 belongs to both, as Google lists a shared location under each parent. */
const locationsOf = {
  1001: [
    {name: 'locations/3001', title: 'Downtown bakery', storeCode: 'DT-1'},
    {name: 'locations/3002', title: 'Harbor bakery'},
  ],
  1002: [{name: 'locations/3002', title: 'Harbor bakery'}],
};

async function site({env = {}, quotaZero = false} = {}) {
  const store = new Store(':memory:', key),
    control = {quotaZero},
    calls = [],
    authEnv = {
      AMCP_GOOGLE_CLIENT_ID: 'synthetic-google-client',
      AMCP_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
      ...env,
    };
  const fetcher = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    calls.push({method, url: url.href, authorization: new Headers(init?.headers).get('authorization')});
    if (url.origin === 'https://oauth2.googleapis.com') {
      assert.equal(method, 'POST');
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('client_id'), 'synthetic-google-client', 'the shared Google client');
      assert.ok(body.get('code_verifier'), 'PKCE');
      return Response.json({
        access_token: 'synthetic-business-access',
        refresh_token: 'synthetic-business-refresh',
        expires_in: 3600,
        scope: businessScope,
      });
    }
    assert.equal(method, 'GET', 'Business Profile discovery and readiness only read');
    if (url.origin === 'https://mybusinessaccountmanagement.googleapis.com') {
      if (control.quotaZero) return zeroQuota();
      if (url.pathname === '/v1/accounts')
        return Response.json({
          accounts: [
            {name: 'accounts/1001', accountName: 'Synthetic Bakery Group', type: 'ORGANIZATION', role: 'OWNER'},
            {name: 'accounts/1002', accountName: 'Harbor partners', type: 'LOCATION_GROUP', role: 'MANAGER'},
          ],
        });
      if (url.pathname === '/v1/accounts/1001')
        return Response.json({name: 'accounts/1001', accountName: 'Synthetic Bakery Group'});
    }
    if (url.origin === 'https://mybusinessbusinessinformation.googleapis.com') {
      if (control.quotaZero) return zeroQuota();
      const listed = /^\/v1\/accounts\/(\d+)\/locations$/.exec(url.pathname)?.[1];
      if (listed) {
        assert.equal(url.searchParams.get('readMask'), 'name,title,storeCode');
        return Response.json({locations: locationsOf[listed] ?? []});
      }
      const read = /^\/v1\/(locations\/\d+)$/.exec(url.pathname)?.[1];
      if (read) {
        assert.equal(url.searchParams.get('readMask'), 'name,title,storeCode');
        return Response.json(
          [...locationsOf[1001], ...locationsOf[1002]].find(l => l.name === read) ?? {name: 'locations/0'},
        );
      }
    }
    throw Error('Unexpected synthetic provider route: ' + method + ' ' + url.origin + url.pathname);
  };
  const options = {origin, masterKey: key, adminPassword: password, fetcher, authEnv},
    web = new WebStore(store, options),
    service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, readOnlyPolicy),
    listener = await listenForFetch(createHttpApp(service, store, {website: options})),
    base = 'http://127.0.0.1:' + listener.address().port;
  const request = async (path, method = 'GET', body, extra = {}) => {
    const r = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extra},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return new Response([204, 304].includes(r.status) ? null : await r.arrayBuffer(), {
      status: r.status,
      headers: r.headers,
    });
  };
  const login = await request('/api/session', 'POST', {password}),
    session = {Cookie: login.headers.get('set-cookie').split(';')[0], 'X-AMCP-CSRF': (await login.json()).csrf};
  const platforms = async () => (await (await request('/api/platforms', 'GET', undefined, session)).json()).platforms;
  const authorize = async route => {
    const started = await request(route, 'POST', {}, session);
    assert.equal(started.status, 200, await started.clone().text());
    const {url, attemptId} = await started.json(),
      state = new URL(url).searchParams.get('state'),
      back = await request(
        '/api/auth/google_business/callback?' + new URLSearchParams({state, code: 'synthetic-code'}),
        'GET',
        undefined,
        session,
      );
    assert.equal(back.status, 303);
    return {
      url: new URL(url),
      progress: await (await request('/api/oauth/progress/' + attemptId, 'GET', undefined, session)).json(),
    };
  };
  return {
    store,
    web,
    service,
    control,
    calls,
    request,
    session,
    platforms,
    authorize,
    close: async () => {
      const end = new Promise(r => listener.close(() => r()));
      listener.closeAllConnections();
      await end;
      store.close();
    },
  };
}

test('Business Profile is listed, and connects on the shared Google client only once the owner declares Google approval', async () => {
  // Without the declaration (or a dedicated client) the card reads setup required and Connect is refused.
  const unapproved = await site();
  try {
    const card = (await unapproved.platforms()).find(p => p.id === 'google_business');
    assert.ok(card, 'the fixture lists Business Profile');
    assert.equal(card.gateway, 'google_business_native_action');
    assert.equal(card.configured, false);
    assert.deepEqual(card.scopes, [businessScope]);
    assert.deepEqual(card.selectableKinds, ['locations', 'business_accounts']);
    assert.equal(card.callback, origin + '/api/auth/google_business/callback');
    assert.equal(card.accountRead, true, 'one exact location or account read checks a selection');
    const refused = await unapproved.request('/api/auth/google_business/start', 'POST', {}, unapproved.session);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error.code, 'PROVIDER_SETUP_REQUIRED');
    assert.equal(unapproved.calls.length, 0);
    assert.equal(businessProfileApproved({AMCP_GBP_API_APPROVED: '1'}), false, 'only the exact value declares it');
  } finally {
    await unapproved.close();
  }
  // A dedicated Business Profile client needs no declaration: the owner made that client for it.
  const dedicated = new PlatformOAuth(
    {origin, store: undefined},
    {AMCP_GBP_CLIENT_ID: 'gbp-client', AMCP_GBP_CLIENT_SECRET: 'gbp-secret'},
  ).config(platform('google_business'));
  assert.deepEqual([dedicated.configured, dedicated.clientId], [true, 'gbp-client']);
  const approved = await site({env: {AMCP_GBP_API_APPROVED: 'true'}});
  try {
    assert.equal((await approved.platforms()).find(p => p.id === 'google_business').configured, true);
  } finally {
    await approved.close();
  }
});

test('the connect flow saves a disabled login, syncs synthetic accounts and locations, and a selection enables it', async () => {
  const s = await site({env: {AMCP_GBP_API_APPROVED: 'true'}});
  try {
    const {url, progress} = await s.authorize('/api/auth/google_business/start');
    // Consent asks for business.manage with PKCE and offline access on the shared Google client.
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'synthetic-google-client');
    assert.equal(url.searchParams.get('scope'), businessScope);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/google_business/callback');
    assert.equal(progress.state, 'complete', JSON.stringify(progress));
    const [c] = (await s.platforms()).find(p => p.id === 'google_business').connections;
    assert.equal(c.enabled, false, 'a new login is saved disabled until the owner selects');
    assert.equal(c.status, 'selection_required');
    assert.deepEqual(c.accounts, []);
    assert.equal(c.reauthorizeAvailable, true, 'renewal uses the shared Reauthorize');
    const group = kind => c.groups.find(g => g.kind === kind);
    assert.deepEqual(
      group('business_accounts').assets.map(a => [a.id, a.name, a.status]),
      [
        ['1001', 'Synthetic Bakery Group', 'OWNER'],
        ['1002', 'Harbor partners', 'MANAGER'],
      ],
    );
    // A location shared by two accounts is listed once, under its first parent.
    assert.deepEqual(
      group('locations').assets.map(a => [a.id, a.name, a.parentId]),
      [
        ['locations/3001', 'Downtown bakery', '1001'],
        ['locations/3002', 'Harbor bakery', '1001'],
      ],
    );
    assert.ok(group('locations').complete && group('business_accounts').complete);
    // Discovery only read, with the login's own token, and changed no grant.
    assert.ok(s.calls.filter(x => x.url.includes('mybusiness')).every(x => x.method === 'GET'));
    assert.ok(
      s.calls
        .filter(x => x.url.includes('mybusiness'))
        .every(x => x.authorization === 'Bearer synthetic-business-access'),
    );
    // A location and a business account (for account-level changes) are selectable; another kind is not.
    const save = async selected => s.request('/api/connections/' + c.id + '/assets', 'PATCH', {selected}, s.session);
    assert.equal((await save(['locations:locations/3001', 'business_accounts:1001'])).status, 200);
    const saved = s.store.listConnections('local').find(x => x.id === c.id);
    assert.deepEqual([saved.enabled, saved.accounts], [true, ['locations/3001', '1001']]);
    assert.deepEqual(saved.scopes, [businessScope]);
    assert.equal((await save(['sites:locations/3001'])).status, 409, 'only synced assets are selectable');
    // A resync keeps both selections: each complete listing still shows its own selected asset.
    const resynced = await (await s.request('/api/connections/' + c.id + '/sync', 'POST', {}, s.session)).json();
    assert.deepEqual(resynced.accounts, ['locations/3001', '1001']);
    assert.equal(resynced.error, null);
  } finally {
    await s.close();
  }
});

test('a selected location passes one exact readiness read; scope checks keep requests on selected locations', async () => {
  const s = await site({env: {AMCP_GBP_API_APPROVED: 'true'}});
  try {
    await s.authorize('/api/auth/google_business/start');
    const [c] = (await s.platforms()).find(p => p.id === 'google_business').connections;
    await s.request(
      '/api/connections/' + c.id + '/assets',
      'PATCH',
      {selected: ['locations:locations/3001']},
      s.session,
    );
    const connection = s.store.listConnections('local').find(x => x.id === c.id);
    const guard = new ScopeGuard(registry, s.store);
    // The readiness read names exactly the selected location, with the fixed read mask.
    const plan = readinessPlan('google_business_native_action', 'locations/3001');
    assert.deepEqual(
      [plan.origin, plan.path, plan.query.readMask, plan.method],
      ['https://mybusinessbusinessinformation.googleapis.com', '/v1/locations/3001', 'name,title,storeCode', 'GET'],
    );
    assert.equal(guard.authorize(plan, connection), 'locations/3001');
    // A location the login did not select is refused, as is a request that names another location in its path.
    assert.throws(
      () => guard.authorize(readinessPlan('google_business_native_action', 'locations/3002'), connection),
      e => e instanceof MirrorError && e.code === 'ACCOUNT_REQUIRED',
    );
    assert.throws(
      () => guard.authorize({...plan, path: '/v1/locations/3002'}, connection),
      e => e instanceof MirrorError && e.status === 403,
    );
    // An account-level read needs the business account itself to be selected.
    assert.throws(
      () => guard.authorize(readinessPlan('google_business_native_action', '1001'), connection),
      e => e instanceof MirrorError && e.code === 'ACCOUNT_REQUIRED',
    );
    assert.equal(
      guard.authorize(readinessPlan('google_business_native_action', '1001'), {...connection, accounts: ['1001']}),
      '1001',
    );
    assert.throws(
      () => readinessPlan('google_business_native_action', 'accounts/1001'),
      e => e instanceof MirrorError && e.code === 'ASSET_ID_INVALID',
    );
    // Save and check access: one exact provider read of the selected location passes and names it.
    const before = s.calls.length;
    const checked = await s.service.call(
      'amcp_workspace',
      {action: 'check', connection_id: c.id, account_id: 'locations/3001', live: true},
      owner,
    );
    assert.equal(checked.success, true, JSON.stringify(checked.error));
    assert.equal(checked.data.readiness, 'account_read');
    assert.equal(checked.data.checks.find(x => x.key === 'provider_read').status, 'passed');
    const reads = s.calls.slice(before);
    assert.deepEqual(
      reads.map(x => x.method + ' ' + new URL(x.url).pathname),
      ['GET /v1/locations/3001'],
    );
    const listed = await s.service.call('amcp_platform_workspace', {operation: 'list_accounts', arguments: {}}, owner);
    assert.equal(listed.data.find(a => a.connection_id === c.id && a.id === 'locations/3001').name, 'Downtown bakery');
  } finally {
    await s.close();
  }
});

test('a quota of 0 requests per minute is refused as a project Google has not approved, with an owner action', async () => {
  // The provider taxonomy: 429 with quota_limit_value "0", or 403 SERVICE_DISABLED, on the Business Profile gateway.
  const classify = (status, body, gateway = 'google_business_native_action') =>
    classifyProviderError({gateway, status, headers: new Headers(), body, readOnly: true, inBody: false});
  const zero = classify(429, await zeroQuota().json());
  assert.deepEqual(
    [zero.code, zero.layer, zero.retryable, zero.providerCode],
    ['BUSINESS_PROFILE_API_NOT_APPROVED', 'app_eligibility', false, 'RESOURCE_EXHAUSTED'],
  );
  const disabled = classify(403, {
    error: {
      code: 403,
      status: 'PERMISSION_DENIED',
      details: [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED'}],
    },
  });
  assert.equal(disabled.code, 'BUSINESS_PROFILE_API_NOT_APPROVED');
  // An ordinary throttle (a non-zero quota) stays a rate limit, and other gateways are untouched.
  const busy = await zeroQuota().json();
  busy.error.details[0].metadata.quota_limit_value = '300';
  assert.notEqual(classify(429, busy).code, 'BUSINESS_PROFILE_API_NOT_APPROVED');
  assert.notEqual(
    classify(429, await zeroQuota().json(), 'ga4_native_action').code,
    'BUSINESS_PROFILE_API_NOT_APPROVED',
  );
  const remedy = errorRemedy(new MirrorError('BUSINESS_PROFILE_API_NOT_APPROVED', 'x'));
  assert.deepEqual([remedy.owner, remedy.mutation_retry_safe], ['deployment_operator', false]);
  assert.match(remedy.action, /reconnecting or retrying does not help/);
  // The transport raises it from Google's reply, which the refusal carries as details.upstream, and the owner action
  // still applies. Regression (ARC-04 stage C): errorRemedy's shared rule for provider replies came before this code's
  // rule, so an MCP caller was told to inspect the native error and request ID instead.
  const raised = await new NativeTransport(async () => zeroQuota())
    .request(
      readinessPlan('google_business_native_action', 'locations/3001'),
      {
        id: 'gbp',
        tenantId: 'local',
        gateway: 'google_business_native_action',
        accounts: ['locations/3001'],
        enabled: true,
        label: 'Synthetic Business Profile',
        scopes: [businessScope],
      },
      {accessToken: 'synthetic-business-access'},
    )
    .then(
      () => assert.fail('a quota of 0 is refused'),
      e => e,
    );
  assert.equal(raised.code, 'BUSINESS_PROFILE_API_NOT_APPROVED');
  assert.ok(Object.hasOwn(raised.details, 'upstream'), 'Google’s reply rides along');
  const replied = errorResult(raised, 'business-profile-reference', 0);
  assert.deepEqual(
    [replied.error.category, replied.error.remedy.owner, replied.error.remedy.mutation_retry_safe],
    ['deployment', 'deployment_operator', false],
  );
  assert.match(replied.error.next_action, /reconnecting or retrying does not help/);

  // The website connect flow keeps the login and tells the owner why discovery failed; nothing offers a retry time.
  const s = await site({env: {AMCP_GBP_API_APPROVED: 'true'}, quotaZero: true});
  try {
    const {progress} = await s.authorize('/api/auth/google_business/start');
    assert.equal(progress.state, 'sync_attention');
    assert.equal(progress.message, notApprovedMessage, 'stated once although accounts and locations both failed');
    const [c] = (await s.platforms()).find(p => p.id === 'google_business').connections;
    assert.equal(c.error, notApprovedMessage);
    const diagnostics = c.groups.flatMap(g => g.diagnostics ?? []);
    assert.equal(diagnostics.length, 2);
    for (const d of diagnostics) {
      assert.equal(d.code, 'BUSINESS_PROFILE_API_NOT_APPROVED');
      assert.match(d.next_action, /request Business Profile API access/);
      assert.equal(d.retry_after_ms, undefined);
    }
    // Only the accounts listing was attempted; no location read followed a refusal.
    assert.deepEqual(
      s.calls.filter(x => x.url.includes('mybusiness')).map(x => new URL(x.url).pathname),
      ['/v1/accounts'],
    );
  } finally {
    await s.close();
  }
});

test('Amazon Ads is not offered: absent from tools/list and website pages, refused before anything is read', async () => {
  const s = await site();
  const previous = process.env.AMCP_PROVIDERS;
  delete process.env.AMCP_PROVIDERS;
  try {
    assert.equal(gatewayOffered('amazon_native_action'), false);
    assert.equal(gatewayOffered('meta_native_action'), true);
    const names = s.service.listTools().map(t => t.name);
    assert.ok(!names.includes('amazon_native_action'), 'not in tools/list');
    assert.ok(names.includes('google_business_native_action'));
    const before = s.calls.length;
    const call = await s.service.call('amazon_native_action', {action: 'amazon_list_sp_campaigns'}, owner);
    assert.equal(call.error.code, 'GATEWAY_NOT_OFFERED');
    for (const [tool, args] of [
      ['amcp_tool_help', {gateway: 'amazon_native_action'}],
      ['amcp_write', {action: 'inspect', gateway: 'amazon_native_action', arguments: {}}],
      ['amcp_workspace', {action: 'contracts', gateway: 'amazon_native_action'}],
    ])
      assert.equal((await s.service.call(tool, args, owner)).error?.code, 'GATEWAY_NOT_OFFERED', tool);
    assert.equal(s.calls.length, before, 'nothing was sent');
    // Website pages: Connections, the Capability Center contract reference and the provider evidence list.
    assert.ok(!(await s.platforms()).some(p => /amazon/i.test(p.id + p.gateway)));
    const contracts = await s.service.call('amcp_workspace', {action: 'contracts', limit: 100}, owner);
    assert.ok(!contracts.data.summary.some(x => x.gateway === 'amazon_native_action'));
    const search = await s.service.call('amcp_workspace', {action: 'contracts', search: 'amazon', limit: 100}, owner);
    assert.ok(!search.data.actions.some(a => a.gateway === 'amazon_native_action'));
    // The website Overview reads the full dashboard, whose provider evidence list names every offered provider.
    const dashboard = await s.service.call('amcp_workspace', {action: 'dashboard', view: 'full'}, owner),
      providers = dashboard.data.capabilities.providers;
    assert.ok(!providers.some(p => p.gateway === 'amazon_native_action'));
    assert.ok(providers.some(p => p.gateway === 'google_business_native_action' && p.website_connection === true));
    const graph = await s.service.call('amcp_workspace', {action: 'capabilities', view: 'graph'}, owner);
    assert.ok(!graph.data.contracts.some(x => x.gateway === 'amazon_native_action'));
    // AMCP_PROVIDERS offers it again for an operator-provisioned connection.
    process.env.AMCP_PROVIDERS = 'meta, amazon';
    assert.ok(s.service.listTools().some(t => t.name === 'amazon_native_action'));
    const offered = await s.service.call('amazon_native_action', {action: 'amazon_no_such_action'}, owner);
    assert.equal(offered.error.code, 'UNKNOWN_ACTION');
  } finally {
    if (previous === undefined) delete process.env.AMCP_PROVIDERS;
    else process.env.AMCP_PROVIDERS = previous;
    await s.close();
  }
});
