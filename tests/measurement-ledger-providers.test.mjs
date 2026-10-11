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
