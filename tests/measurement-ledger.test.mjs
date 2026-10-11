import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {measurementLedgerLayers} from '../dist/src/measurement-ledger.js';
import {googleRecipeGoalsData, googleConversionBrief} from './fixtures/google-recipe-goals-data.mjs';

// MSR-03 slice C: the provider-neutral measurement evidence ledger. Synthetic transports serve only the selected
// asset's read routes (GAQL searches of one customer; GA4 Admin GETs and one realtime report of one property). There is
// no event sender, mutation, other-customer or other-property route, so any attempt fails the test.
const documents = (store, tenant) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND kind <> 'service_timings'").get(tenant).n;
const states = d => Object.fromEntries(d.layers.map(l => [l.layer, l.state]));
const reasons = d => Object.fromEntries(d.layers.map(l => [l.layer, l.reason]));
const layerOf = (d, name) => d.layers.find(l => l.layer === name);

// ---------- Google Ads ----------
const account = googleConversionBrief.account_id;
const upload = (overrides = {}) => ({
  resourceName: `customers/${account}/offlineConversionUploadClientSummaries/GOOGLE_ADS_API`,
  client: 'GOOGLE_ADS_API',
  status: 'NEEDS_ATTENTION',
  totalEventCount: '120',
  successfulEventCount: '100',
  pendingEventCount: '5',
  successRate: 0.83,
  pendingRate: 0.04,
  lastUploadDateTime: '2026-10-09 08:15:00',
  alerts: [{error: {conversionUploadError: 'EXPIRED_EVENT'}, errorPercentage: 0.1}],
  ...overrides,
});
const attributionRow = (id, overrides = {}) => ({
  resourceName: `customers/${account}/conversionActions/${id}`,
  name: 'Synthetic action ' + id,
  status: 'ENABLED',
  primaryForGoal: id === '1',
  countingType: 'ONE_PER_CLICK',
  clickThroughLookbackWindowDays: '30',
  viewThroughLookbackWindowDays: '1',
  attributionModelSettings: {
    attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
    dataDrivenModelStatus: 'AVAILABLE',
  },
  ...overrides,
});
function googleFixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: 'synthetic-ledger-google', userId: 'operator', role: 'operator'},
    admin = {...actor, userId: 'admin', role: 'admin'},
    connection = {
      id: googleConversionBrief.connection_id,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [account],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const data = googleRecipeGoalsData({
    ...options.data,
    transform({body, envelope}) {
      if (!body.query.includes('metrics.conversion_last_conversion_date')) return envelope;
      return {
        ...envelope,
        results: envelope.results.map(({conversionAction}) => ({
          conversionAction: {resourceName: conversionAction.resourceName},
          ...(options.activity === false
            ? {}
            : {
                metrics: {
                  conversionLastConversionDate: '2026-10-01',
                  conversionLastReceivedRequestDateTime: '2026-10-02 13:14:15',
                },
              }),
        })),
      };
    },
  });
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(String(url)),
          body = JSON.parse(init.body);
        assert.equal(init.method, 'POST');
        assert.ok(u.pathname.endsWith('/customers/' + account + '/googleAds:search'), u.pathname);
        const kind = body.query.includes('FROM offline_conversion_upload_client_summary')
          ? 'uploads'
          : body.query.includes('attribution_model_settings')
            ? 'attribution'
            : 'goals';
        requests.push({kind, query: body.query, pageToken: body.pageToken ?? null});
        options.beforeResponse?.({store, actor, admin, connection, kind, requests});
        if (kind === 'uploads') {
          const value = options.uploads
            ? options.uploads(body)
            : {results: [{offlineConversionUploadClientSummary: upload()}]};
          return value instanceof Response ? value : Response.json(value);
        }
        if (kind === 'attribution') {
          const value = options.attribution
            ? options.attribution(body)
            : {
                results: [attributionRow('1'), attributionRow('2', {countingType: 'MANY_PER_CLICK'})].map(r => ({
                  conversionAction: r,
                })),
              };
          return value instanceof Response ? value : Response.json(value);
        }
        return Response.json(data.response(url, init));
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  return {
    store,
    actor,
    admin,
    connection,
    requests,
    read: (input = {}, as = actor) =>
      service.call(
        'amcp_workspace',
        {
          action: 'measurement_ledger',
          gateway: 'google_ads_native_action',
          connection_id: connection.id,
          account_id: account,
          ...input,
        },
        as,
      ),
  };
}

test('MSR-03 Google Ads ledger fills six fixed layers from complete reads and saves nothing', async t => {
  const f = googleFixture(t),
    before = documents(f.store, f.actor.tenantId),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.equal(d.record_kind, 'measurement_ledger');
  assert.deepEqual(
    d.layers.map(l => l.layer),
    [...measurementLedgerLayers],
  );
  assert.deepEqual(states(d), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'observed',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'observed',
  });
  assert.deepEqual(d.summary, {observed: 4, unknown: 0, unavailable: 2, not_applicable: 0});
  assert.deepEqual(d.scope, {gateway: 'google_ads_native_action', connection_id: f.connection.id, account_id: account});
  const diagnostics = layerOf(d, 'provider_diagnostics').evidence.upload_summaries[0];
  assert.equal(diagnostics.status, 'NEEDS_ATTENTION');
  assert.equal(diagnostics.total_event_count, '120', 'int64 counts stay exact strings');
  assert.deepEqual(diagnostics.alerts, [
    {error_type: 'conversionUploadError', error_code: 'EXPIRED_EVENT', error_percentage: 0.1},
  ]);
  const actions = layerOf(d, 'attribution_settings').evidence.actions;
  assert.equal(actions[0].primary_for_goal, true, 'primary actions are listed first');
  assert.equal(actions[0].attribution_model, 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN');
  assert.equal(actions[0].click_through_lookback_window_days, 30);
  assert.equal(layerOf(d, 'provider_observed_activity').evidence.primary_actions[0].last_conversion_date, '2026-10-01');
  for (const key of ['event_delivery', 'deduplication', 'consent', 'attribution'])
    assert.equal(d.checks[key], 'unverified');
  assert.equal(d.provider_mutations, 0);
  assert.equal(d.snapshot_saved, false);
  // Every request is a selected-customer search and every one is counted.
  assert.equal(d.network_requests, f.requests.length);
  assert.equal(f.requests.filter(r => r.kind === 'uploads').length, 1);
  assert.equal(f.requests.filter(r => r.kind === 'attribution').length, 1);
  assert.equal(documents(f.store, f.actor.tenantId), before, 'nothing is saved');
  assert.equal(
    out.meta.workflow.website_path,
    '/measurement?ledger=1&gateway=google_ads_native_action&connection_id=' +
      encodeURIComponent(f.connection.id) +
      '&account_id=' +
      account,
  );
});

test('MSR-03 foreign, unpinned or failed Google Ads diagnostics stay unknown and never change other layers', async t => {
  const cases = [
    [
      'foreign upload summary',
      () => ({
        results: [
          {
            offlineConversionUploadClientSummary: upload({
              resourceName: 'customers/999/offlineConversionUploadClientSummaries/GOOGLE_ADS_API',
            }),
          },
        ],
      }),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'unpinned status',
      () => ({results: [{offlineConversionUploadClientSummary: upload({status: 'HEALTHY'})}]}),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'malformed count',
      () => ({results: [{offlineConversionUploadClientSummary: upload({totalEventCount: 120})}]}),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'unpinned alert code',
      () => ({
        results: [{offlineConversionUploadClientSummary: upload({alerts: [{error: {conversionUploadError: 'X'}}]})}],
      }),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'unselected field',
      () => ({results: [{offlineConversionUploadClientSummary: upload({dailySummaries: []})}]}),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'partial count',
      () => ({results: [{offlineConversionUploadClientSummary: upload()}], totalResultsCount: '2'}),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'repeated page token',
      body => ({
        results: [
          {
            offlineConversionUploadClientSummary: upload({
              resourceName: upload().resourceName + (body.pageToken ? 'X' : ''),
            }),
          },
        ],
        nextPageToken: 'same',
      }),
      'MEASUREMENT_LEDGER_INVALID',
    ],
    [
      'provider refusal',
      () => new Response(JSON.stringify({error: {code: 403, status: 'PERMISSION_DENIED'}}), {status: 403}),
      null,
    ],
  ];
  for (const [name, uploads, code] of cases) {
    const f = googleFixture(t, {uploads}),
      out = await f.read();
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    const d = out.data,
      diagnostics = layerOf(d, 'provider_diagnostics');
    assert.equal(diagnostics.state, 'unknown', name);
    assert.equal(diagnostics.reason, 'read_failed', name);
    if (code) assert.equal(diagnostics.evidence.error, code, name);
    else assert.match(diagnostics.evidence.error, /^[A-Z_]+$/, name);
    assert.equal(states(d).configuration, 'observed', name);
    assert.equal(states(d).attribution_settings, 'observed', name + ': the next layer is still read');
    assert.equal(d.summary.unknown, 1, name);
    assert.equal(d.provider_mutations, 0, name);
    assert.doesNotMatch(JSON.stringify(diagnostics), /customers\/999|HEALTHY/, name + ': refused rows never appear');
  }
});

test('MSR-03 Google Ads attribution settings refuse foreign or unpinned rows and report no actions as not applicable', async t => {
  for (const [name, attribution, state, reason] of [
    [
      'foreign action',
      () => ({results: [{conversionAction: attributionRow('1', {resourceName: 'customers/999/conversionActions/1'})}]}),
      'unknown',
      'read_failed',
    ],
    [
      'unpinned model',
      () => ({
        results: [{conversionAction: attributionRow('1', {attributionModelSettings: {attributionModel: 'MAGIC'}})}],
      }),
      'unknown',
      'read_failed',
    ],
    [
      'removed action',
      () => ({results: [{conversionAction: attributionRow('1', {status: 'REMOVED'})}]}),
      'unknown',
      'read_failed',
    ],
    ['no enabled action', () => ({}), 'not_applicable', 'no_enabled_actions'],
  ]) {
    const f = googleFixture(t, {attribution}),
      out = await f.read();
    assert.equal(out.success, true, name);
    assert.equal(states(out.data).attribution_settings, state, name);
    assert.equal(reasons(out.data).attribution_settings, reason, name);
    assert.equal(states(out.data).provider_diagnostics, 'observed', name);
  }
  const none = googleFixture(t, {uploads: () => ({results: []})}),
    empty = await none.read();
  assert.equal(states(empty.data).provider_diagnostics, 'not_applicable');
  assert.equal(reasons(empty.data).provider_diagnostics, 'no_uploads');
});

test('MSR-03 Google Ads activity stays unknown unless every primary action reports it', async t => {
  const f = googleFixture(t, {activity: false}),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  const activity = layerOf(out.data, 'provider_observed_activity');
  assert.equal(activity.state, 'unknown');
  assert.equal(activity.reason, 'activity_incomplete');
  assert.equal(activity.evidence.primary_last_conversion_known, 0);
  assert.equal(states(out.data).configuration, 'observed');
});

test('MSR-03 a manager customer leaves every Google Ads layer unknown and reads nothing else', async t => {
  const f = googleFixture(t, {data: {customer: {manager: true}}}),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.deepEqual(states(out.data), {
    configuration: 'unknown',
    provider_observed_activity: 'unknown',
    provider_diagnostics: 'unknown',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'unknown',
  });
  assert.equal(reasons(out.data).configuration, 'manager_account');
  assert.equal(f.requests.length, 1, 'only the customer row was read');
  assert.equal(out.data.network_requests, 1);
});

test('MSR-03 a write pause, credential rotation or access withdrawal mid-ledger refuses the whole ledger', async t => {
  const changes = [
    [
      'write pause',
      ({store, actor}) =>
        store.putDocument(actor.tenantId, 'write_pause', 'workspace', {
          paused: true,
          reason: 'synthetic',
          paused_at: 1,
        }),
    ],
    [
      'credential rotation',
      ({store, admin, connection}) =>
        store.putConnection(admin, connection, {accessToken: 'rotated', developerToken: 'synthetic'}),
    ],
    [
      'access withdrawal',
      ({store, admin, connection}) =>
        store.putConnection(
          admin,
          {...connection, accounts: ['999']},
          {accessToken: 'synthetic', developerToken: 'synthetic'},
        ),
    ],
  ];
  for (const [name, change] of changes) {
    let changed = false;
    const f = googleFixture(t, {
        beforeResponse: ctx => {
          if (ctx.kind === 'uploads' && !changed) {
            changed = true;
            change(ctx);
          }
        },
      }),
      out = await f.read();
    assert.equal(out.success, false, name + ': ' + JSON.stringify(out.data ?? null));
    assert.equal(
      out.error.code,
      {
        'write pause': 'STATE_CHANGED',
        'credential rotation': 'STATE_CHANGED',
        'access withdrawal': 'CONNECTION_REQUIRED',
      }[name],
      name,
    );
    assert.equal(out.data, undefined, name);
    assert.equal(f.requests.filter(r => r.kind === 'attribution').length, 0, name + ': no further read starts');
  }
});

test('MSR-03 ledger refusals happen before any provider request', async t => {
  const cases = [
    // Owner direction P8 qualified Meta, Snapchat, TikTok, Search Console and Adjust; other gateways stay refused.
    [{gateway: 'reddit_native_action'}, 'MEASUREMENT_LEDGER_UNQUALIFIED'],
    [{gateway: 'linkedin_native_action'}, 'MEASUREMENT_LEDGER_UNQUALIFIED'],
    [{requirements: {sections: ['key_events']}}, 'INVALID_ARGUMENT'],
    [{account_id: 'customers/1'}, 'INVALID_ARGUMENT'],
  ];
  for (const [input, code] of cases) {
    const f = googleFixture(t),
      out = await f.read(input);
    assert.equal(out.success, false, JSON.stringify(input));
    assert.equal(out.error.code, code, JSON.stringify(out.error));
    assert.equal(f.requests.length, 0);
  }
  const f = googleFixture(t),
    out = await f.read({account_id: '9999999999'});
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'CONNECTION_REQUIRED');
  assert.equal(f.requests.length, 0, 'a customer not granted to the login is never read');
});

// ---------- GA4 ----------
const property = '123',
  readonly = 'https://www.googleapis.com/auth/analytics.readonly';
const adminData = (overrides = {}) => ({
  keyEvents: [
    {
      keyEvents: [
        {name: `properties/${property}/keyEvents/1`, eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT'},
        {name: `properties/${property}/keyEvents/2`, eventName: 'generate_lead', countingMethod: 'ONCE_PER_SESSION'},
      ],
    },
  ],
  customDimensions: [{}],
  customMetrics: [{}],
  dataStreams: [
    {
      dataStreams: [
        {
          name: `properties/${property}/dataStreams/900`,
          type: 'WEB_DATA_STREAM',
          displayName: 'Web',
          webStreamData: {measurementId: 'G-ABC123', defaultUri: 'https://example.test'},
        },
      ],
    },
  ],
  googleAdsLinks: [
    {
      googleAdsLinks: [
        {
          name: `properties/${property}/googleAdsLinks/5`,
          customerId: '1234567890',
          adsPersonalizationEnabled: true,
          creatorEmailAddress: 'creator@example.test',
        },
      ],
    },
  ],
  dataRetentionSettings: {
    name: `properties/${property}/dataRetentionSettings`,
    eventDataRetention: 'FOURTEEN_MONTHS',
    userDataRetention: 'FOURTEEN_MONTHS',
  },
  ...overrides,
});
const realtimeRow = (event, minute, count) => ({
  dimensionValues: [event, minute, '900'].map(value => ({value})),
  metricValues: [{value: count}],
});
const realtime = (rows = [realtimeRow('purchase', '03', '4')], extra = {}) => ({
  kind: 'analyticsData#runRealtimeReport',
  dimensionHeaders: [{name: 'eventName'}, {name: 'minutesAgo'}, {name: 'streamId'}],
  metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
  rows,
  rowCount: rows.length,
  ...extra,
});
function ga4Fixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: 'synthetic-ledger-ga4', userId: 'operator', role: 'operator'},
    admin = {...actor, userId: 'admin', role: 'admin'},
    connection = {
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      tenantId: actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: [property],
      writeAccounts: [],
      enabled: true,
      label: 'GA4',
      scopes: options.scopes ?? [readonly],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const data = adminData(options.data),
    requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          method = init?.method ?? 'GET';
        requests.push({method, origin: url.origin, path: url.pathname});
        options.beforeResponse?.({store, admin, connection, requests});
        if (url.origin === 'https://analyticsdata.googleapis.com') {
          assert.equal(method, 'POST');
          assert.equal(url.pathname, `/v1beta/properties/${property}:runRealtimeReport`);
          const body = JSON.parse(init.body);
          assert.deepEqual(body.minuteRanges, [{startMinutesAgo: 29, endMinutesAgo: 0}]);
          return Response.json(options.realtime ? options.realtime(body) : realtime());
        }
        assert.equal(url.origin, 'https://analyticsadmin.googleapis.com');
        assert.equal(method, 'GET');
        const match = /^\/v1beta\/properties\/(\d+)\/([A-Za-z]+)$/.exec(url.pathname);
        if (!match || match[1] !== property) throw Error('Unexpected synthetic route ' + url.pathname);
        const value = data[match[2]];
        if (value === undefined) throw Error('Unexpected synthetic collection ' + match[2]);
        return Response.json(Array.isArray(value) ? (value[url.searchParams.get('pageToken') ? 1 : 0] ?? {}) : value);
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  return {
    store,
    actor,
    connection,
    requests,
    read: (input = {}) =>
      service.call(
        'amcp_workspace',
        {
          action: 'measurement_ledger',
          gateway: 'ga4_native_action',
          connection_id: connection.id,
          account_id: property,
          ...input,
        },
        actor,
      ),
  };
}

test('MSR-03 GA4 ledger reuses the configuration read and one realtime read of its key events', async t => {
  const f = ga4Fixture(t),
    before = documents(f.store, f.actor.tenantId),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.deepEqual(states(d), {
    configuration: 'observed',
    provider_observed_activity: 'observed',
    provider_diagnostics: 'unavailable',
    supplied_runtime_trace: 'unavailable',
    consent: 'unavailable',
    attribution_settings: 'unavailable',
  });
  assert.equal(reasons(d).attribution_settings, 'unpinned_api');
  const configuration = layerOf(d, 'configuration').evidence;
  assert.deepEqual(configuration.data_streams, [
    {stream_id: '900', type: 'WEB_DATA_STREAM', display_name: 'Web', measurement_id: 'G-ABC123'},
  ]);
  assert.equal(configuration.checks.test_identifier_dimension, 'not_registered');
  const events = layerOf(d, 'provider_observed_activity').evidence.events;
  assert.deepEqual(
    events.map(e => [e.event_name, e.reported_count]),
    [
      ['purchase', '4'],
      ['generate_lead', null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(out), /creator@example\.test/, 'Ads link creators are never returned');
  // Six Admin GETs and one realtime POST, all counted; nothing else.
  assert.equal(f.requests.length, 7);
  assert.equal(d.network_requests, 7);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(d.provider_mutations, 0);
  assert.equal(documents(f.store, f.actor.tenantId), before, 'nothing is saved');
  assert.equal(
    out.meta.workflow.website_path,
    '/measurement?ledger=1&gateway=ga4_native_action&connection_id=bbbbbbbb-2222-4222-8222-222222222222&account_id=123',
  );
});

test('MSR-03 thresholded, partial or empty GA4 activity is never reported observed', async t => {
  for (const [name, respond, reason] of [
    ['thresholded', () => realtime(undefined, {metadata: {subjectToThresholding: true}}), 'read_failed'],
    ['partial row count', () => realtime(undefined, {rowCount: 5}), 'read_failed'],
    ['foreign event', () => realtime([realtimeRow('page_view', '01', '9')]), 'read_failed'],
    ['no recent key event', () => realtime([]), 'no_recent_key_events'],
  ]) {
    const f = ga4Fixture(t, {realtime: respond}),
      out = await f.read();
    assert.equal(out.success, true, name + ': ' + JSON.stringify(out));
    const activity = layerOf(out.data, 'provider_observed_activity');
    assert.equal(activity.state, 'unknown', name);
    assert.equal(activity.reason, reason, name);
    assert.equal(states(out.data).configuration, 'observed', name);
    assert.doesNotMatch(JSON.stringify(activity), /page_view/, name);
  }
});

test('MSR-03 a refused GA4 configuration leaves configuration unknown and starts no realtime read', async t => {
  const f = ga4Fixture(t, {
      data: {keyEvents: [{keyEvents: [{name: 'properties/999/keyEvents/1', eventName: 'purchase'}]}]},
    }),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(states(out.data).configuration, 'unknown');
  assert.equal(layerOf(out.data, 'configuration').evidence.error, 'GA4_CONFIG_INVALID');
  assert.equal(states(out.data).provider_observed_activity, 'unknown');
  assert.equal(reasons(out.data).provider_observed_activity, 'configuration_unknown');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  assert.doesNotMatch(JSON.stringify(out.data.layers), /properties\/999/);
  const g = ga4Fixture(t, {data: {keyEvents: [{}]}}),
    none = await g.read();
  assert.equal(states(none.data).provider_observed_activity, 'not_applicable');
  assert.equal(reasons(none.data).provider_observed_activity, 'no_key_events');
  assert.equal(g.requests.filter(r => r.method === 'POST').length, 0);
});

test('MSR-03 a GA4 login change or missing analytics permission refuses the ledger', async t => {
  const f = ga4Fixture(t, {
      beforeResponse: ({store, admin, connection, requests}) => {
        if (requests.length === 2) store.putConnection(admin, connection, {accessToken: 'rotated'});
      },
    }),
    out = await f.read();
  assert.equal(out.success, false, JSON.stringify(out.data ?? null));
  assert.equal(out.error.code, 'CONNECTION_AUTHORITY_CHANGED');
  assert.equal(out.data, undefined);
  assert.ok(f.requests.length <= 2);
  const unscoped = ga4Fixture(t, {scopes: ['https://www.googleapis.com/auth/webmasters.readonly']}),
    refused = await unscoped.read();
  assert.equal(refused.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(unscoped.requests.length, 0);
  const foreign = ga4Fixture(t),
    other = await foreign.read({account_id: '999'});
  assert.equal(other.success, false);
  assert.equal(other.error.code, 'CONNECTION_REQUIRED');
  assert.equal(foreign.requests.length, 0);
});
