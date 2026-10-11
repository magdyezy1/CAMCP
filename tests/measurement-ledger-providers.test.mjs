import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {measurementLedgerLayers} from '../dist/src/measurement-ledger.js';

// MSR-03 under owner direction P8 (2026-10-11): the measurement ledger is the multi-provider conversion-health hub.
// Synthetic transports serve only the selected asset's read routes. There is no event sender, Conversions API,
// test-event, validate or mutation route, so any attempt fails the test; every request is recorded and checked.
const registry = new Registry();
const documents = (store, tenant) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND kind <> 'service_timings'").get(tenant).n;
const states = d => Object.fromEntries(d.layers.map(l => [l.layer, l.state]));
const reasons = d => Object.fromEntries(d.layers.map(l => [l.layer, l.reason]));
const layerOf = (d, name) => d.layers.find(l => l.layer === name);
function base(t, tenant, gateway, account, scopes, credentials = {accessToken: 'synthetic'}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    admin = {...actor, userId: 'admin', role: 'admin'},
    connection = {
      id: 'cccccccc-3333-4333-8333-' + tenant.length.toString().padStart(12, '0'),
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic ' + gateway,
      scopes,
    };
  store.putConnection(admin, connection, credentials);
  return {store, actor, admin, connection};
}
function service(f, respond) {
  f.requests = [];
  return new MirrorService(
    registry,
    f.store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          method = init?.method ?? 'GET',
          request = {method, origin: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams)};
        if (init?.body !== undefined && init.body !== null) request.body = JSON.parse(String(init.body));
        f.requests.push(request);
        f.beforeResponse?.(f, request);
        const value = await respond(request);
        return value instanceof Response ? value : Response.json(value);
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
}
const ledger = (f, gateway, input = {}, as = f.actor) =>
  f.service.call(
    'amcp_workspace',
    {action: 'measurement_ledger', gateway, connection_id: f.connection.id, account_id: f.account, ...input},
    as,
  );
function assertReadOnly(f, out, allowedPosts = []) {
  for (const r of f.requests)
    assert.ok(r.method === 'GET' || allowedPosts.some(p => r.path.endsWith(p)), r.method + ' ' + r.path);
  assert.doesNotMatch(
    JSON.stringify(f.requests.map(r => r.path)),
    /\/events(?:\/validate)?$|test_event|\/conversion|\/track/,
    'no event, validate or conversion route',
  );
  if (out?.success) {
    assert.equal(out.data.provider_mutations, 0);
    assert.equal(out.data.snapshot_saved, false);
    assert.equal(out.data.network_requests, f.requests.length, 'every request is counted');
    assert.deepEqual(
      out.data.layers.map(l => l.layer),
      [...measurementLedgerLayers],
    );
  }
}

// ---------- Meta ----------
const metaAccount = '123';
const metaHour = hoursAgo => {
  const end = Math.floor(Date.now() / 3600000) * 3600;
  return new Date((end - hoursAgo * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
};
const metaPixel = (id, extra = {}) => ({
  id,
  name: 'Store pixel ' + id,
  owner_business: {id: '1001', name: 'Brand'},
  creation_time: '2026-01-01T00:00:00+0000',
  last_fired_time: '2026-10-11T08:00:00+0000',
  is_unavailable: false,
  ...extra,
});
const metaStats = () => ({
  data: [
    {
      aggregation: 'event',
      start_time: metaHour(2),
      data: [
        {value: 'PageView', count: 40},
        {value: 'Purchase', count: 3},
      ],
    },
    {
      aggregation: 'event',
      start_time: metaHour(1),
      data: [{value: 'Purchase', count: 2, event: 'Purchase'}],
    },
  ],
});
const metaQuality = () => ({
  web: [
    {
      event_name: 'Purchase',
      event_match_quality: {
        composite_score: 7.2,
        match_key_feedback: [
          {identifier: 'email', coverage: {percentage: 85}},
          {identifier: 'ip_address', coverage: {percentage: 100}},
        ],
      },
      event_coverage: {percentage: 60, goal_percentage: 75, description: 'Native text that is not kept'},
      dedupe_key_feedback: [
        {
          dedupe_key: 'event_id',
          browser_events_with_dedupe_key: {percentage: 100},
          server_events_with_dedupe_key: {percentage: 90},
          overall_browser_coverage_from_dedupe_key: {percentage: 80},
        },
      ],
      data_freshness: {upload_frequency: 'real_time', description: 'Native text that is not kept'},
      acr: {percentage: 12},
    },
  ],
});
function metaFixture(t, options = {}) {
  const f = base(t, 'synthetic-ledger-meta', 'meta_native_action', metaAccount, options.scopes ?? ['ads_management']);
  f.account = metaAccount;
  const pixels = options.pixels ?? [metaPixel('701')];
  f.service = service(f, request => {
    assert.equal(request.method, 'GET', 'Meta ledger reads only');
    assert.equal(request.origin, 'https://graph.facebook.com');
    assert.equal(request.query.access_token, undefined, 'credentials never travel in the URL');
    if (request.path === metaPrefix + 'act_' + metaAccount + '/adspixels')
      return options.list ? options.list(request) : {data: pixels, paging: {cursors: {before: 'a', after: 'b'}}};
    const stats = new RegExp('^' + metaPrefix.replaceAll('.', '\\.') + '(\\d+)/stats$').exec(request.path);
    if (stats) {
      assert.ok(
        pixels.some(p => p.id === stats[1]),
        'only a listed pixel is read',
      );
      assert.equal(request.query.aggregation, 'event');
      return options.stats ? options.stats(request) : metaStats();
    }
    if (request.path === metaPrefix + 'dataset_quality') {
      assert.ok(pixels.some(p => p.id === request.query.dataset_id));
      assert.match(request.query.fields, /^web\{/);
      return options.quality ? options.quality(request) : metaQuality();
    }
    throw Error('Unexpected synthetic Meta route ' + request.path);
  });
  f.beforeResponse = options.beforeResponse;
  return f;
}
const metaPaths = f => f.requests.map(r => r.path.slice(metaPrefix.length));

test('MSR-03 Meta ledger lists the account pixels, then reads one pixel’s stats and dataset quality, saving nothing', async t => {
  const f = metaFixture(t),
    before = documents(f.store, f.actor.tenantId),
    out = await ledger(f, 'meta_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.deepEqual(states(d), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'observed',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'not_applicable',
  });
  assert.deepEqual(reasons(d), {
    configuration: 'pixels_listed',
    provider_observed_activity: 'pixel_events_reported',
    provider_diagnostics: 'dataset_quality',
    supplied_runtime_trace: 'browser_only',
    consent: 'no_provider_source',
    attribution_settings: 'not_pixel_setting',
  });
  assert.deepEqual(d.scope, {
    gateway: 'meta_native_action',
    connection_id: f.connection.id,
    account_id: metaAccount,
    pixel_id: '701',
  });
  assert.equal(layerOf(d, 'configuration').evidence.pixels[0].owner_business, '1001');
  const activity = layerOf(d, 'provider_observed_activity').evidence;
  assert.deepEqual(activity.events, [
    {event_name: 'PageView', count: '40'},
    {event_name: 'Purchase', count: '5'},
  ]);
  assert.equal(activity.hours_reported, 2);
  assert.equal(activity.last_fired_time, '2026-10-11T08:00:00+0000');
  const quality = layerOf(d, 'provider_diagnostics').evidence.events[0];
  assert.equal(quality.composite_score, 7.2);
  assert.equal(quality.event_coverage_percentage, 60);
  assert.equal(quality.upload_frequency, 'real_time');
  assert.deepEqual(quality.dedupe_keys[0], {
    dedupe_key: 'event_id',
    browser_percentage: 100,
    server_percentage: 90,
    overall_browser_coverage_percentage: 80,
  });
  assert.doesNotMatch(JSON.stringify(d), /Native text that is not kept/, 'Meta descriptions are never returned');
  assert.deepEqual(metaPaths(f), ['act_123/adspixels', '701/stats', 'dataset_quality']);
  assertReadOnly(f, out);
  assert.equal(documents(f.store, f.actor.tenantId), before, 'nothing is saved');
  assert.equal(
    out.meta.workflow.website_path,
    '/measurement?ledger=1&gateway=meta_native_action&connection_id=' +
      encodeURIComponent(f.connection.id) +
      '&account_id=123&pixel_id=701',
  );
});

test('MSR-03 Meta pixel selection: several pixels, an unlisted pixel or none are never read and stay unknown', async t => {
  for (const [name, pixels, input, state, reason] of [
    ['several pixels', [metaPixel('701'), metaPixel('702')], {}, 'unknown', 'pixel_not_selected'],
    ['unlisted pixel', [metaPixel('701')], {requirements: {pixel_id: '999'}}, 'unknown', 'pixel_not_listed'],
    ['no pixel', [], {}, 'not_applicable', 'no_pixels'],
  ]) {
    const f = metaFixture(t, {pixels}),
      out = await ledger(f, 'meta_native_action', input);
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    assert.equal(states(out.data).provider_observed_activity, state, name);
    assert.equal(reasons(out.data).provider_observed_activity, reason, name);
    assert.equal(reasons(out.data).provider_diagnostics, reason, name);
    assert.deepEqual(metaPaths(f), ['act_123/adspixels'], name + ': no pixel read');
    assertReadOnly(f, out);
  }
  const chosen = metaFixture(t, {pixels: [metaPixel('701'), metaPixel('702')]}),
    out = await ledger(chosen, 'meta_native_action', {requirements: {pixel_id: '702'}});
  assert.equal(out.data.scope.pixel_id, '702');
  assert.deepEqual(metaPaths(chosen), ['act_123/adspixels', '702/stats', 'dataset_quality']);
});

test('MSR-03 partial, foreign or out-of-contract Meta evidence leaves its layer unknown and never upgrades it', async t => {
  const cases = [
    [
      'stats hour outside the window',
      {
        stats: () => ({
          data: [{aggregation: 'event', start_time: metaHour(48), data: [{value: 'Purchase', count: 1}]}],
        }),
      },
      'provider_observed_activity',
    ],
    [
      'stats of another aggregation',
      {stats: () => ({data: [{aggregation: 'url', start_time: metaHour(1), data: [{value: 'x', count: 1}]}]})},
      'provider_observed_activity',
    ],
    [
      'unrequested stats entry field',
      {stats: () => ({data: [{aggregation: 'event', start_time: metaHour(1), data: [{value: 'P', count: 1, x: 1}]}]})},
      'provider_observed_activity',
    ],
    [
      'repeated stats cursor',
      {
        stats: () => ({
          data: metaStats().data,
          paging: {cursors: {after: 'same'}, next: 'https://graph.facebook.com/next'},
        }),
      },
      'provider_observed_activity',
    ],
    [
      'score out of range',
      {quality: () => ({web: [{event_name: 'Purchase', event_match_quality: {composite_score: 11}}]})},
      'provider_diagnostics',
    ],
    [
      'unrequested diagnostics text',
      {
        quality: () => ({
          web: [{event_name: 'Purchase', event_match_quality: {composite_score: 5, diagnostics: [{name: 'x'}]}}],
        }),
      },
      'provider_diagnostics',
    ],
    [
      'repeated quality event',
      {quality: () => ({web: [{event_name: 'Purchase'}, {event_name: 'Purchase'}]})},
      'provider_diagnostics',
    ],
    [
      'provider refusal',
      {quality: () => new Response(JSON.stringify({error: {code: 200, message: 'Permissions error'}}), {status: 403})},
      'provider_diagnostics',
    ],
  ];
  for (const [name, options, failed] of cases) {
    const f = metaFixture(t, options),
      out = await ledger(f, 'meta_native_action');
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    const l = layerOf(out.data, failed);
    assert.equal(l.state, 'unknown', name);
    assert.equal(l.reason, 'read_failed', name);
    assert.deepEqual(Object.keys(l.evidence), ['error'], name + ': only the error code, never partial rows');
    assert.equal(states(out.data).configuration, 'observed', name);
    const other = failed === 'provider_diagnostics' ? 'provider_observed_activity' : 'provider_diagnostics';
    assert.equal(states(out.data)[other], 'observed', name + ': the other layer is still read');
    assertReadOnly(f, out);
  }
  for (const [name, options, layer, reason] of [
    ['no events', {stats: () => ({data: []})}, 'provider_observed_activity', 'no_recent_events'],
    ['no quality data', {quality: () => ({web: []})}, 'provider_diagnostics', 'no_quality_data'],
  ]) {
    const f = metaFixture(t, options),
      out = await ledger(f, 'meta_native_action');
    assert.equal(states(out.data)[layer], 'unknown', name);
    assert.equal(reasons(out.data)[layer], reason, name);
  }
  // A foreign or malformed pixel list leaves every pixel layer unknown and reads no pixel.
  for (const [name, list] of [
    ['malformed id', () => ({data: [{id: 'act_9'}]})],
    ['repeated pixel', () => ({data: [metaPixel('701'), metaPixel('701')]})],
    ['unrequested field', () => ({data: [{...metaPixel('701'), code: '<script>'}]})],
  ]) {
    const f = metaFixture(t, {list}),
      out = await ledger(f, 'meta_native_action');
    assert.equal(out.success, true, name);
    assert.equal(reasons(out.data).configuration, 'read_failed', name);
    assert.equal(reasons(out.data).provider_observed_activity, 'configuration_unknown', name);
    assert.equal(reasons(out.data).provider_diagnostics, 'configuration_unknown', name);
    assert.equal(f.requests.length, 1, name + ': no pixel is read');
  }
});

test('MSR-03 Meta dataset quality needs ads_management or business_management; ads_read alone leaves it unknown', async t => {
  const f = metaFixture(t, {scopes: ['ads_read']}),
    out = await ledger(f, 'meta_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(states(out.data).provider_observed_activity, 'observed');
  assert.equal(states(out.data).provider_diagnostics, 'unknown');
  assert.equal(reasons(out.data).provider_diagnostics, 'quality_permission_missing');
  assert.deepEqual(metaPaths(f), ['act_123/adspixels', '701/stats'], 'no dataset quality request without access');
  const business = metaFixture(t, {scopes: ['ads_read', 'business_management']}),
    allowed = await ledger(business, 'meta_native_action');
  assert.equal(states(allowed.data).provider_diagnostics, 'observed');
  const none = metaFixture(t, {scopes: ['pages_show_list']}),
    refused = await ledger(none, 'meta_native_action');
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(none.requests.length, 0);
});

test('MSR-03 Meta pixel ownership opens only the two aggregate reads of a pixel the account listed', async t => {
  const f = metaFixture(t),
    guard = new ScopeGuard(registry, f.store),
    read = (path, query = {}) => ({
      gateway: 'meta_native_action',
      accountId: metaAccount,
      action: 'AMCP_MEASUREMENT_LEDGER',
      method: 'GET',
      path: metaPrefix + path,
      query,
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'synthetic',
      warnings: [],
    }),
    refused = plan => {
      try {
        guard.authorize(plan, f.connection);
      } catch (error) {
        return error.code;
      }
      return 'allowed';
    };
  // Before the list: a pixel's stats are refused and the refusal names the ledger as the ownership read.
  let error;
  try {
    guard.authorize(read('701/stats', {aggregation: 'event'}), f.connection);
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(error.details.next_call.arguments.action, 'measurement_ledger');
  assert.equal(
    refused(read('dataset_quality', {dataset_id: '701', fields: 'web{event_name}'})),
    'RESOURCE_SCOPE_REQUIRED',
  );
  const out = await ledger(f, 'meta_native_action');
  assert.equal(out.success, true);
  assert.equal(refused(read('701/stats', {aggregation: 'event'})), 'allowed');
  assert.equal(refused(read('dataset_quality', {dataset_id: '701', fields: 'web{event_name}'})), 'allowed');
  // The pixel node, its other edges, an unlisted pixel, other query parameters and any write stay refused.
  assert.equal(refused(read('701')), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused(read('701/da_checks')), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused(read('702/stats', {aggregation: 'event'})), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused(read('701/stats', {aggregation: 'event', fields: 'x'})), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused(read('dataset_quality', {dataset_id: '702'})), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused({...read('701/stats'), method: 'POST', readOnly: false}), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(refused({...read('701/events'), method: 'POST', readOnly: false}), 'RESOURCE_SCOPE_REQUIRED');
});

test('MSR-03 a Meta login or access change mid-ledger refuses the whole ledger', async t => {
  for (const [name, change, code] of [
    [
      'credential rotation',
      ({store, admin, connection}) => store.putConnection(admin, connection, {accessToken: 'rotated'}),
      'CONNECTION_AUTHORITY_CHANGED',
    ],
    [
      'access withdrawal',
      ({store, admin, connection}) =>
        store.putConnection(admin, {...connection, accounts: ['999']}, {accessToken: 'synthetic'}),
      'CONNECTION_REQUIRED',
    ],
  ]) {
    let changed = false;
    const f = metaFixture(t, {
        beforeResponse: (fixture, request) => {
          if (request.path.endsWith('/stats') && !changed) {
            changed = true;
            change(fixture);
          }
        },
      }),
      out = await ledger(f, 'meta_native_action');
    assert.equal(out.success, false, name);
    assert.equal(out.error.code, code, name);
    assert.equal(out.data, undefined, name);
    assert.equal(
      f.requests.filter(r => r.path.endsWith('dataset_quality')).length,
      0,
      name + ': no further read starts',
    );
  }
});

// ---------- Snapchat ----------
const snapAccount = '8f1c4a52-0b6e-4d1f-9a27-3c5d7e9f1a20',
  snapPixelId = '2b7c9d14-5e3f-4a81-b6c2-9d0e1f2a3b4c';
const snapPixel = (id = snapPixelId, extra = {}) => ({
  sub_request_status: 'SUCCESS',
  pixel: {
    id,
    name: 'Store pixel',
    ad_account_id: snapAccount,
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    pixel_javascript: '<script>synthetic snippet that is never kept</script>',
    ...extra,
  },
});
const snapDomains = (id = snapPixelId, domains = [{domain_name: 'shop.example.test', total_events: 120}]) => ({
  request_status: 'SUCCESS',
  request_id: 'r1',
  timeseries_stats: [
    {
      sub_request_status: 'SUCCESS',
      timeseries_stat: {
        id,
        type: 'PIXEL',
        start_time: '2026-10-05T00:00:00.000-07:00',
        end_time: '2026-10-12T00:00:00.000-07:00',
        domains,
      },
    },
  ],
});
const snapScores = (score = {}) => ({
  request_status: 'SUCCESS',
  request_id: 'r2',
  event_quality_scores: [
    {
      sub_request_status: 'SUCCESS',
      event_quality_score: {
        action_source: 'WEB',
        event_source: 'API',
        event_type: 'PURCHASE',
        recommendations: [
          {
            title: 'Send more customer information',
            description: 'Native description that is not kept',
            recommendation_code: 'PII_COVERAGE_CAPI',
            priority: 'P0',
            score: 'BAD',
          },
        ],
        ...score,
      },
    },
  ],
});
function snapFixture(t, options = {}) {
  const f = base(t, 'synthetic-ledger-snap', 'snapchat_native_action', snapAccount, ['snapchat-marketing-api']);
  f.account = snapAccount;
  const pixels = options.pixels ?? [snapPixel()];
  f.service = service(f, request => {
    assert.equal(request.method, 'GET', 'Snapchat ledger reads only');
    assert.equal(request.origin, 'https://adsapi.snapchat.com');
    if (request.path === '/v1/adaccounts/' + snapAccount + '/pixels')
      return options.list ? options.list() : {request_status: 'SUCCESS', request_id: 'r0', pixels};
    const m = /^\/v1\/pixels\/([\w-]+)\/(domains\/stats|event_quality_scores)$/.exec(request.path);
    assert.ok(m, 'Unexpected synthetic Snapchat route ' + request.path);
    assert.ok(
      pixels.some(p => p.pixel.id === m[1]),
      'only a listed pixel is read',
    );
    if (m[2] === 'domains/stats') return options.domains ? options.domains(m[1]) : snapDomains(m[1]);
    return options.scores ? options.scores(m[1]) : snapScores();
  });
  f.beforeResponse = options.beforeResponse;
  return f;
}
const snapPaths = f => f.requests.map(r => r.path.replace(snapAccount, '{account}').replace(snapPixelId, '{pixel}'));

test('MSR-03 Snapchat ledger reads the account pixels, the pixel’s domains and its signal readiness, saving nothing', async t => {
  const f = snapFixture(t),
    before = documents(f.store, f.actor.tenantId),
    out = await ledger(f, 'snapchat_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.deepEqual(states(d), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'observed',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'not_applicable',
  });
  assert.equal(reasons(d).provider_observed_activity, 'pixel_domains_reported');
  assert.equal(reasons(d).provider_diagnostics, 'signal_readiness');
  assert.equal(d.scope.pixel_id, snapPixelId);
  assert.deepEqual(layerOf(d, 'provider_observed_activity').evidence.domains, [
    {domain_name: 'shop.example.test', total_events: 120},
  ]);
  assert.deepEqual(layerOf(d, 'provider_diagnostics').evidence.scores[0].recommendations, [
    {recommendation_code: 'PII_COVERAGE_CAPI', priority: 'P0', score: 'BAD', title: 'Send more customer information'},
  ]);
  assert.doesNotMatch(
    JSON.stringify(d),
    /synthetic snippet|Native description/,
    'snippets and descriptions are not kept',
  );
  assert.deepEqual(snapPaths(f), [
    '/v1/adaccounts/{account}/pixels',
    '/v1/pixels/{pixel}/domains/stats',
    '/v1/pixels/{pixel}/event_quality_scores',
  ]);
  assertReadOnly(f, out);
  assert.equal(documents(f.store, f.actor.tenantId), before, 'nothing is saved');
});

test('MSR-03 foreign, partial or unpinned Snapchat evidence stays unknown and is never upgraded', async t => {
  for (const [name, options, failed] of [
    [
      'partial domain stats',
      {domains: id => ({...snapDomains(id), request_status: 'PARTIAL'})},
      'provider_observed_activity',
    ],
    [
      'foreign domain stats',
      {domains: () => snapDomains('ffffffff-0000-4000-8000-000000000000')},
      'provider_observed_activity',
    ],
    [
      'repeated domain',
      {
        domains: id =>
          snapDomains(id, [
            {domain_name: 'a.example.test', total_events: 1},
            {domain_name: 'A.example.test', total_events: 2},
          ]),
      },
      'provider_observed_activity',
    ],
    [
      'paged answer',
      {domains: id => ({...snapDomains(id), paging: {next_link: 'https://adsapi.snapchat.com/next'}})},
      'provider_observed_activity',
    ],
    ['unpinned score', {scores: () => snapScores({event_source: 'PIGEON'})}, 'provider_diagnostics'],
    [
      'failed item',
      {
        scores: () => ({
          ...snapScores(),
          event_quality_scores: [{sub_request_status: 'ERROR', event_quality_score: {}}],
        }),
      },
      'provider_diagnostics',
    ],
  ]) {
    const f = snapFixture(t, options),
      out = await ledger(f, 'snapchat_native_action');
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    assert.equal(states(out.data)[failed], 'unknown', name);
    assert.equal(reasons(out.data)[failed], 'read_failed', name);
    assert.deepEqual(Object.keys(layerOf(out.data, failed).evidence), ['error'], name);
    const other = failed === 'provider_diagnostics' ? 'provider_observed_activity' : 'provider_diagnostics';
    assert.equal(states(out.data)[other], 'observed', name);
    assertReadOnly(f, out);
  }
  for (const [name, options, layer, state, reason] of [
    [
      'no events in 7 days',
      {domains: id => snapDomains(id, [])},
      'provider_observed_activity',
      'unknown',
      'no_recent_events',
    ],
    [
      'no scores',
      {scores: () => ({request_status: 'SUCCESS', event_quality_scores: []})},
      'provider_diagnostics',
      'unknown',
      'no_quality_data',
    ],
  ]) {
    const f = snapFixture(t, options),
      out = await ledger(f, 'snapchat_native_action');
    assert.equal(states(out.data)[layer], state, name);
    assert.equal(reasons(out.data)[layer], reason, name);
  }
  // A pixel of another ad account in the list refuses the list; no pixel is read.
  const foreign = snapFixture(t, {pixels: [snapPixel(snapPixelId, {ad_account_id: 'another-account'})]}),
    out = await ledger(foreign, 'snapchat_native_action');
  assert.equal(reasons(out.data).configuration, 'read_failed');
  assert.equal(reasons(out.data).provider_observed_activity, 'configuration_unknown');
  assert.equal(foreign.requests.length, 1);
  // Several pixels need an explicit choice; an unlisted pixel is never read.
  const several = snapFixture(t, {pixels: [snapPixel(), snapPixel('3c8d0e25-6f40-4b92-87d3-ae1f20314c5d')]}),
    unselected = await ledger(several, 'snapchat_native_action'),
    unlisted = await ledger(several, 'snapchat_native_action', {
      requirements: {pixel_id: 'ffffffff-0000-4000-8000-000000000000'},
    });
  assert.equal(reasons(unselected.data).provider_observed_activity, 'pixel_not_selected');
  assert.equal(reasons(unlisted.data).provider_diagnostics, 'pixel_not_listed');
  assert.equal(several.requests.length, 2, 'only the two pixel lists were read');
});

test('MSR-03 Snapchat ledger requires the marketing permission and refuses a mid-ledger login change', async t => {
  const f = snapFixture(t);
  f.store.putConnection(f.admin, {...f.connection, scopes: []}, {accessToken: 'synthetic'});
  const refused = await ledger(f, 'snapchat_native_action');
  assert.equal(refused.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(f.requests.length, 0);
  let changed = false;
  const g = snapFixture(t, {
      beforeResponse: (fixture, request) => {
        if (request.path.endsWith('/domains/stats') && !changed) {
          changed = true;
          fixture.store.putConnection(fixture.admin, fixture.connection, {accessToken: 'rotated'});
        }
      },
    }),
    out = await ledger(g, 'snapchat_native_action');
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'CONNECTION_AUTHORITY_CHANGED');
  assert.equal(g.requests.filter(r => r.path.endsWith('event_quality_scores')).length, 0);
});

// ---------- TikTok ----------
const tiktokAccount = '7000000000000000001';
const tiktokPage = (pixels, info = {}) => ({
  code: 0,
  message: 'OK',
  request_id: 'synthetic',
  data: {pixels, page_info: {page: 1, page_size: 20, total_number: pixels.length, total_page: 1, ...info}},
});
const tiktokPixel = (id, extra = {}) => ({
  pixel_id: id,
  pixel_name: 'Store pixel ' + id,
  pixel_code: 'CABCDEF' + id.slice(-4),
  asset_ownership: {ownership_status: true, asset_relation_status: 'OWNER_BC'},
  pixel_script: '<script>synthetic snippet that is never kept</script>',
  ...extra,
});
function tiktokFixture(t, options = {}) {
  const f = base(t, 'synthetic-ledger-tiktok', 'tiktok_native_action', tiktokAccount, []);
  f.account = tiktokAccount;
  f.service = service(f, request => {
    assert.equal(request.method, 'GET', 'TikTok ledger reads only');
    assert.ok(request.path.endsWith('/v1.3/pixel/list/'), 'Unexpected synthetic TikTok route ' + request.path);
    assert.equal(request.query.advertiser_id, tiktokAccount);
    return options.list ? options.list(request) : tiktokPage([tiktokPixel('7100000000000000001')]);
  });
  return f;
}

test('MSR-03 TikTok ledger lists the advertiser’s pixels and leaves unpinned pixel statistics unavailable', async t => {
  const f = tiktokFixture(t),
    out = await ledger(f, 'tiktok_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(states(out.data), {
    configuration: 'observed',
    provider_observed_activity: 'unavailable',
    provider_diagnostics: 'unavailable',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'not_applicable',
  });
  assert.equal(reasons(out.data).provider_observed_activity, 'unpinned_contract');
  assert.deepEqual(layerOf(out.data, 'configuration').evidence.pixels, [
    {
      pixel_id: '7100000000000000001',
      pixel_name: 'Store pixel 7100000000000000001',
      pixel_code: 'CABCDEF0001',
      owned: true,
    },
  ]);
  assert.equal(out.data.scope.pixel_id, '7100000000000000001');
  assert.doesNotMatch(JSON.stringify(out.data), /synthetic snippet/);
  assert.equal(f.requests.length, 1, 'no pixel statistics request is sent');
  assertReadOnly(f, out);
});

test('MSR-03 partial, changing or unsafe TikTok pixel lists are refused, never mapped', async t => {
  for (const [name, list] of [
    ['provider error', () => ({code: 40001, message: 'No permission', data: {}})],
    ['count mismatch', () => tiktokPage([tiktokPixel('7100000000000000001')], {total_number: 3})],
    ['unsafe numeric id', () => tiktokPage([tiktokPixel(7100000000000000001)])],
    ['repeated pixel', () => tiktokPage([tiktokPixel('7100000000000000001'), tiktokPixel('7100000000000000001')])],
    [
      'changing page count',
      request =>
        request.query.page === '1'
          ? tiktokPage([tiktokPixel('7100000000000000001')], {total_page: 2, total_number: 2})
          : tiktokPage([tiktokPixel('7100000000000000002')], {page: 2, total_page: 3, total_number: 2}),
    ],
  ]) {
    const f = tiktokFixture(t, {list}),
      out = await ledger(f, 'tiktok_native_action');
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    assert.equal(states(out.data).configuration, 'unknown', name);
    assert.equal(reasons(out.data).configuration, 'read_failed', name);
    assert.equal(out.data.scope.pixel_id, null, name);
    assertReadOnly(f, out);
  }
  const shared = tiktokFixture(t, {
      list: () =>
        tiktokPage([
          tiktokPixel('7100000000000000001', {
            asset_ownership: {ownership_status: true, asset_relation_status: 'SHARED'},
          }),
          tiktokPixel('7100000000000000002'),
        ]),
    }),
    out = await ledger(shared, 'tiktok_native_action');
  assert.deepEqual(
    layerOf(out.data, 'configuration').evidence.pixels.map(p => p.owned),
    [false, true],
  );
  assert.equal(layerOf(out.data, 'configuration').evidence.selection, 'pixel_not_selected');
  const none = tiktokFixture(t, {list: () => tiktokPage([])}),
    empty = await ledger(none, 'tiktok_native_action');
  assert.equal(states(empty.data).configuration, 'not_applicable');
  const bad = tiktokFixture(t),
    refused = await ledger(bad, 'tiktok_native_action', {requirements: {pixel_id: 'abc'}});
  assert.equal(refused.error.code, 'INVALID_ARGUMENT');
  assert.equal(bad.requests.length, 0);
});

// ---------- Search Console ----------
const gscSite = 'sc-domain:example.test';
const pacific = daysAgo => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(today + 'T00:00:00Z') - daysAgo * 86400000).toISOString().slice(0, 10);
};
const gscRow = (daysAgo, clicks = 4, impressions = 100) => ({
  keys: [pacific(daysAgo)],
  clicks,
  impressions,
  ctr: clicks / impressions,
  position: 7.5,
});
function gscFixture(t, options = {}) {
  const f = base(t, 'synthetic-ledger-gsc', 'google_search_console_native_action', gscSite, [
    'https://www.googleapis.com/auth/webmasters.readonly',
  ]);
  f.account = gscSite;
  const prefix = '/webmasters/v3/sites/' + encodeURIComponent(gscSite);
  f.service = service(f, request => {
    assert.equal(request.origin, 'https://searchconsole.googleapis.com');
    if (request.method === 'GET' && request.path === prefix)
      return options.site ? options.site() : {siteUrl: gscSite, permissionLevel: 'siteFullUser'};
    if (request.method === 'POST' && request.path === prefix + '/searchAnalytics/query') {
      assert.equal(request.body.dataState, 'final');
      assert.equal(request.body.aggregationType, 'byProperty');
      assert.deepEqual(request.body.dimensions, ['date']);
      return options.analytics
        ? options.analytics(request)
        : {rows: [gscRow(5), gscRow(4, 6, 120)], responseAggregationType: 'byProperty'};
    }
    if (request.method === 'GET' && request.path === prefix + '/sitemaps')
      return options.sitemaps
        ? options.sitemaps()
        : {
            sitemap: [
              {
                path: 'https://example.test/sitemap.xml',
                type: 'sitemap',
                isPending: false,
                isSitemapsIndex: false,
                lastSubmitted: '2026-10-01T00:00:00.000Z',
                lastDownloaded: '2026-10-10T00:00:00.000Z',
                errors: '2',
                warnings: '0',
                contents: [{type: 'web', submitted: '120', indexed: '100'}],
              },
            ],
          };
    throw Error('Unexpected synthetic Search Console route ' + request.method + ' ' + request.path);
  });
  return f;
}

test('MSR-03 Search Console ledger reads the site, final daily search totals and sitemaps, saving nothing', async t => {
  const f = gscFixture(t),
    before = documents(f.store, f.actor.tenantId),
    out = await ledger(f, 'google_search_console_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(states(out.data), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'observed',
    supplied_runtime_trace: 'unavailable',
    consent: 'not_applicable',
    attribution_settings: 'not_applicable',
  });
  const activity = layerOf(out.data, 'provider_observed_activity').evidence;
  assert.equal(activity.clicks, 10);
  assert.equal(activity.impressions, 220);
  assert.equal(activity.days_reported, 2);
  assert.equal(activity.end_date, pacific(1));
  const diagnostics = layerOf(out.data, 'provider_diagnostics').evidence;
  assert.equal(diagnostics.with_errors, 1);
  assert.equal(diagnostics.sitemaps[0].errors, '2', 'int64 counts stay exact strings');
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['GET', 'POST', 'GET'],
  );
  assertReadOnly(f, out, ['/searchAnalytics/query']);
  assert.equal(documents(f.store, f.actor.tenantId), before);
});

test('MSR-03 foreign, unverified or differently aggregated Search Console evidence stays unknown', async t => {
  const other = gscFixture(t, {site: () => ({siteUrl: 'sc-domain:other.test', permissionLevel: 'siteOwner'})}),
    foreign = await ledger(other, 'google_search_console_native_action');
  assert.equal(reasons(foreign.data).configuration, 'read_failed');
  assert.equal(reasons(foreign.data).provider_observed_activity, 'configuration_unknown');
  assert.equal(other.requests.length, 1, 'nothing else is read');
  const unverified = gscFixture(t, {site: () => ({siteUrl: gscSite, permissionLevel: 'siteUnverifiedUser'})}),
    blocked = await ledger(unverified, 'google_search_console_native_action');
  assert.equal(states(blocked.data).configuration, 'observed');
  assert.equal(reasons(blocked.data).provider_observed_activity, 'site_unverified');
  assert.equal(reasons(blocked.data).provider_diagnostics, 'site_unverified');
  assert.equal(unverified.requests.length, 1);
  for (const [name, options, failed] of [
    [
      'by page',
      {analytics: () => ({rows: [gscRow(3)], responseAggregationType: 'byPage'})},
      'provider_observed_activity',
    ],
    ['day outside window', {analytics: () => ({rows: [gscRow(30)]})}, 'provider_observed_activity'],
    ['repeated day', {analytics: () => ({rows: [gscRow(3), gscRow(3)]})}, 'provider_observed_activity'],
    ['clicks above impressions', {analytics: () => ({rows: [gscRow(3, 9, 2)]})}, 'provider_observed_activity'],
    [
      'unpinned sitemap type',
      {sitemaps: () => ({sitemap: [{path: 'https://example.test/s.xml', type: 'magic'}]})},
      'provider_diagnostics',
    ],
    [
      'numeric error count',
      {sitemaps: () => ({sitemap: [{path: 'https://example.test/s.xml', errors: 2}]})},
      'provider_diagnostics',
    ],
  ]) {
    const f = gscFixture(t, options),
      out = await ledger(f, 'google_search_console_native_action');
    assert.equal(out.success, true, name);
    assert.equal(states(out.data)[failed], 'unknown', name);
    assert.equal(reasons(out.data)[failed], 'read_failed', name);
    assertReadOnly(f, out, ['/searchAnalytics/query']);
  }
  const quiet = gscFixture(t, {analytics: () => ({}), sitemaps: () => ({})}),
    out = await ledger(quiet, 'google_search_console_native_action');
  assert.equal(reasons(out.data).provider_observed_activity, 'no_search_activity');
  assert.equal(states(out.data).provider_observed_activity, 'unknown', 'absent final data is not zero activity');
  assert.equal(reasons(out.data).provider_diagnostics, 'no_sitemaps');
  const scopeless = gscFixture(t);
  scopeless.store.putConnection(scopeless.admin, {...scopeless.connection, scopes: []}, {accessToken: 'synthetic'});
  const refused = await ledger(scopeless, 'google_search_console_native_action');
  assert.equal(refused.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(scopeless.requests.length, 0);
});

// ---------- Adjust ----------
const adjustApp = 'abcdefghijkl';
const utc = daysAgo => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
function adjustFixture(t, options = {}) {
  const f = base(t, 'synthetic-ledger-adjust', 'adjust_native_action', adjustApp, [], {
    accessToken: 'synthetic-adjust-token',
  });
  f.account = adjustApp;
  f.service = service(f, request => {
    assert.equal(request.method, 'GET', 'Adjust ledger reads only');
    assert.equal(request.origin, 'https://automate.adjust.com');
    if (request.path === '/reports-service/events')
      return options.events
        ? options.events()
        : [{id: 'purchase', name: 'Purchase', app_token: [adjustApp], tokens: ['event12']}];
    if (request.path === '/reports-service/report') {
      assert.equal(request.query.app_token__in, adjustApp);
      assert.equal(request.query.date_period, utc(7) + ':' + utc(1));
      return options.report
        ? options.report()
        : {
            rows: [{app_token: adjustApp, day: utc(2), installs: '10', events: '42'}],
            totals: {installs: '10', events: '42'},
            warnings: [],
          };
    }
    throw Error('Unexpected synthetic Adjust route ' + request.path);
  });
  return f;
}

test('MSR-03 Adjust ledger reuses the qualified event catalog and daily report reads, saving no report', async t => {
  const f = adjustFixture(t),
    out = await ledger(f, 'adjust_native_action');
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(states(out.data), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'unavailable',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'unavailable',
  });
  assert.deepEqual(layerOf(out.data, 'configuration').evidence.events, [{id: 'purchase', name: 'Purchase'}]);
  const activity = layerOf(out.data, 'provider_observed_activity').evidence;
  assert.deepEqual(activity.days, [{day: utc(2), installs: '10', events: '42'}]);
  assert.deepEqual(activity.totals, {installs: '10', events: '42'});
  assert.equal(f.requests.length, 2);
  assertReadOnly(f, out);
});

test('MSR-03 incomplete or foreign Adjust evidence stays unknown', async t => {
  const warned = adjustFixture(t, {
      report: () => ({rows: [], totals: {}, warnings: ['Data for some networks is delayed']}),
    }),
    incomplete = await ledger(warned, 'adjust_native_action');
  assert.equal(states(incomplete.data).provider_observed_activity, 'unknown');
  assert.equal(reasons(incomplete.data).provider_observed_activity, 'report_incomplete');
  assert.doesNotMatch(JSON.stringify(incomplete.data.layers), /delayed/, 'native warnings are counted, not repeated');
  const foreign = adjustFixture(t, {
      events: () => [{id: 'purchase', name: 'Purchase', app_token: ['otherapp1234']}],
      report: () => ({
        rows: [{app_token: 'otherapp1234', day: utc(2), installs: '1', events: '1'}],
        totals: {},
        warnings: [],
      }),
    }),
    out = await ledger(foreign, 'adjust_native_action');
  assert.equal(reasons(out.data).configuration, 'read_failed');
  assert.equal(reasons(out.data).provider_observed_activity, 'read_failed');
  assert.doesNotMatch(JSON.stringify(out.data.layers), /otherapp1234/);
  const quiet = adjustFixture(t, {report: () => ({rows: [], totals: {}, warnings: []})}),
    none = await ledger(quiet, 'adjust_native_action');
  assert.equal(reasons(none.data).provider_observed_activity, 'no_recent_activity');
  const unbound = adjustFixture(t),
    refused = await ledger(unbound, 'adjust_native_action', {account_id: 'zzzzzzzzzzzz'});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'CONNECTION_REQUIRED');
  assert.equal(unbound.requests.length, 0);
});

// ---------- Shared ----------
test('MSR-03 AMCP_MEASUREMENT_LEDGER_OFF withdraws one adapter before any request', async t => {
  const previous = process.env.AMCP_MEASUREMENT_LEDGER_OFF;
  process.env.AMCP_MEASUREMENT_LEDGER_OFF = 'meta_native_action, adjust_native_action';
  t.after(() => {
    if (previous === undefined) delete process.env.AMCP_MEASUREMENT_LEDGER_OFF;
    else process.env.AMCP_MEASUREMENT_LEDGER_OFF = previous;
  });
  const f = metaFixture(t),
    out = await ledger(f, 'meta_native_action');
  assert.equal(out.error.code, 'MEASUREMENT_LEDGER_UNQUALIFIED');
  assert.equal(out.error.details.qualified.includes('meta_native_action'), false);
  assert.equal(out.error.details.qualified.includes('snapchat_native_action'), true);
  assert.equal(f.requests.length, 0);
  const g = snapFixture(t),
    still = await ledger(g, 'snapchat_native_action');
  assert.equal(still.success, true);
});

test('MSR-03 pixel requirements are refused for gateways without pixels and malformed pixel IDs are never read', async t => {
  const f = gscFixture(t),
    out = await ledger(f, 'google_search_console_native_action', {requirements: {pixel_id: '701'}});
  assert.equal(out.error.code, 'INVALID_ARGUMENT');
  const g = metaFixture(t),
    bad = await ledger(g, 'meta_native_action', {requirements: {pixel_id: '70/1'}});
  assert.equal(bad.error.code, 'INVALID_ARGUMENT');
  assert.equal(f.requests.length + g.requests.length, 0);
});
