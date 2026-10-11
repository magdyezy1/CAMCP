import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

// MSR-03 slice B: GA4 Admin configuration reads of one property. The synthetic transport serves only fixed GET routes
// of the pinned Admin API v1beta; it has no event, Data API, mutation or other-property route.
const property = '123',
  readonly = 'https://www.googleapis.com/auth/analytics.readonly';
function admin(overrides = {}) {
  const base = `properties/${property}`;
  return {
    keyEvents: [
      {
        keyEvents: [
          {
            name: base + '/keyEvents/1',
            eventName: 'purchase',
            countingMethod: 'ONCE_PER_EVENT',
            custom: true,
            deletable: true,
            createTime: '2026-01-01T00:00:00Z',
            defaultValue: {numericValue: 7.5, currencyCode: 'SAR'},
          },
        ],
        nextPageToken: 'page-2',
      },
      {keyEvents: [{name: base + '/keyEvents/2', eventName: 'generate_lead', countingMethod: 'ONCE_PER_SESSION'}]},
    ],
    customDimensions: [
      {
        customDimensions: [
          {
            name: base + '/customDimensions/10',
            parameterName: 'amcp_test_id',
            displayName: 'AMCP test',
            scope: 'EVENT',
          },
          {name: base + '/customDimensions/11', parameterName: 'plan', scope: 'USER', disallowAdsPersonalization: true},
        ],
      },
    ],
    customMetrics: [
      {
        customMetrics: [
          {
            name: base + '/customMetrics/20',
            parameterName: 'margin',
            measurementUnit: 'CURRENCY',
            scope: 'EVENT',
            restrictedMetricType: ['REVENUE_DATA'],
          },
        ],
      },
    ],
    dataStreams: [
      {
        dataStreams: [
          {
            name: base + '/dataStreams/900',
            type: 'WEB_DATA_STREAM',
            displayName: 'Web',
            webStreamData: {measurementId: 'G-ABC123', defaultUri: 'https://example.test'},
          },
          {
            name: base + '/dataStreams/901',
            type: 'ANDROID_APP_DATA_STREAM',
            displayName: 'Android',
            androidAppStreamData: {packageName: 'test.example.app', firebaseAppId: '1:2:android:3'},
          },
        ],
      },
    ],
    googleAdsLinks: [
      {
        googleAdsLinks: [
          {
            name: base + '/googleAdsLinks/5',
            customerId: '1234567890',
            adsPersonalizationEnabled: true,
            canManageClients: false,
            creatorEmailAddress: 'creator@example.test',
          },
        ],
      },
    ],
    dataRetentionSettings: {
      name: base + '/dataRetentionSettings',
      eventDataRetention: 'FOURTEEN_MONTHS',
      userDataRetention: 'FOURTEEN_MONTHS',
      resetUserDataOnNewActivity: true,
    },
    ...overrides,
  };
}
function fixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  t.after(() => store.close());
  const actor = {tenantId: 'synthetic-ga4-config', userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'admin', role: 'admin'},
    connection = {
      id: 'ga4-login',
      tenantId: actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: [property],
      writeAccounts: [],
      enabled: true,
      label: 'GA4',
      scopes: options.scopes ?? [readonly],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const data = admin(options.data),
    requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (input, init) => {
      const url = new URL(String(input));
      requests.push({method: init?.method ?? 'GET', origin: url.origin, path: url.pathname, query: url.search});
      options.beforeResponse?.({store, owner, connection, requests});
      assert.equal(url.origin, 'https://analyticsadmin.googleapis.com');
      assert.equal(init?.method ?? 'GET', 'GET');
      const match = /^\/v1beta\/properties\/(\d+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (!match || match[1] !== property) throw Error('Unexpected synthetic route ' + url.pathname);
      const value = data[match[2]];
      if (value === undefined) throw Error('Unexpected synthetic collection ' + match[2]);
      if (!Array.isArray(value)) return Response.json(value);
      const page = url.searchParams.get('pageToken') ? 1 : 0;
      return Response.json(value[page] ?? {});
    }),
    undefined,
    {allowWrites: false},
  );
  return {
    store,
    actor,
    owner,
    connection,
    requests,
    read: (input = {}, as = actor) =>
      service.call(
        'amcp_workspace',
        {
          action: 'measurement_ga4_config',
          gateway: 'ga4_native_action',
          connection_id: connection.id,
          account_id: property,
          ...input,
        },
        as,
      ),
  };
}
const documents = f =>
  f.store.db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND kind <> 'service_timings'")
    .get(f.actor.tenantId).n;

test('MSR-03 GA4 configuration lists every section completely with fixed read-only GETs', async t => {
  const f = fixture(t),
    before = documents(f),
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out));
  const d = out.data;
  assert.equal(d.record_kind, 'measurement_ga4_config');
  assert.equal(d.complete, true);
  assert.equal(d.provider_mutations, 0);
  assert.equal(d.snapshot_saved, false);
  assert.deepEqual(d.scope.sections, [
    'key_events',
    'custom_dimensions',
    'custom_metrics',
    'data_streams',
    'google_ads_links',
    'data_retention',
  ]);
  assert.deepEqual(
    d.key_events.map(k => [k.event_name, k.counting_method]),
    [
      ['purchase', 'ONCE_PER_EVENT'],
      ['generate_lead', 'ONCE_PER_SESSION'],
    ],
  );
  assert.deepEqual(d.key_events[0].default_value, {numeric_value: 7.5, currency_code: 'SAR'});
  assert.equal(d.key_events[1].default_value, null);
  assert.deepEqual(
    d.data_streams.map(s => [s.stream_id, s.type, s.measurement_id]),
    [
      ['900', 'WEB_DATA_STREAM', 'G-ABC123'],
      ['901', 'ANDROID_APP_DATA_STREAM', null],
    ],
  );
  assert.equal(d.custom_metrics[0].restricted_metric_types[0], 'REVENUE_DATA');
  assert.deepEqual(d.google_ads_links[0], {
    name: 'properties/123/googleAdsLinks/5',
    customer_id: '1234567890',
    can_manage_clients: false,
    ads_personalization_enabled: true,
  });
  assert.doesNotMatch(JSON.stringify(out), /creator@example\.test|creatorEmail/, 'personal data is never returned');
  assert.deepEqual(d.data_retention, {
    event_data_retention: 'FOURTEEN_MONTHS',
    user_data_retention: 'FOURTEEN_MONTHS',
    reset_user_data_on_new_activity: true,
  });
  assert.equal(d.checks.test_identifier_dimension, 'registered');
  assert.equal(d.checks.web_streams, 1);
  for (const key of ['event_delivery', 'deduplication', 'consent', 'attribution'])
    assert.equal(d.checks[key], 'unverified');
  // Seven GETs: two key-event pages (the second carries the page token) and one per other section.
  assert.equal(f.requests.length, 7);
  assert.equal(d.network_requests, 7);
  assert.ok(f.requests.some(r => r.path.endsWith('/keyEvents') && r.query.includes('pageToken=page-2')));
  assert.ok(f.requests.every(r => r.method === 'GET' && r.path.startsWith('/v1beta/properties/123/')));
  assert.equal(d.source_references.length, 6);
  assert.equal(documents(f), before, 'nothing is saved');
  assert.match(out.meta.workflow.website_path, /^\/measurement\?ga4_config=1&connection_id=ga4-login&account_id=123$/);
});

test('MSR-03 GA4 configuration reads only the chosen sections and reports a missing test dimension', async t => {
  const f = fixture(t, {
      data: {
        customDimensions: [
          {
            customDimensions: [
              {name: 'properties/123/customDimensions/10', parameterName: 'amcp_test_id', scope: 'USER'},
            ],
          },
        ],
      },
    }),
    out = await f.read({requirements: {sections: ['custom_dimensions']}});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(f.requests.length, 1);
  assert.equal(out.data.checks.test_identifier_dimension, 'other_scope');
  assert.equal(out.data.checks.web_streams, null);
  assert.equal(out.data.data_streams, undefined);
  const g = fixture(t, {data: {customDimensions: [{}]}}),
    empty = await g.read({requirements: {sections: ['custom_dimensions', 'data_streams']}});
  assert.equal(empty.data.checks.test_identifier_dimension, 'not_registered');
  assert.deepEqual(empty.data.custom_dimensions, []);
});

test('MSR-03 foreign, malformed, repeated and unpinned GA4 rows are refused, never partially returned', async t => {
  const cases = [
    ['foreign key event', {keyEvents: [{keyEvents: [{name: 'properties/999/keyEvents/1', eventName: 'purchase'}]}]}],
    [
      'unpinned field',
      {keyEvents: [{keyEvents: [{name: 'properties/123/keyEvents/1', eventName: 'purchase', extra: 1}]}]},
    ],
    [
      'unknown enum',
      {
        customDimensions: [
          {customDimensions: [{name: 'properties/123/customDimensions/1', parameterName: 'x', scope: 'SESSION'}]},
        ],
      },
    ],
    [
      'repeated token',
      {
        keyEvents: [
          {keyEvents: [{name: 'properties/123/keyEvents/1', eventName: 'a'}], nextPageToken: 't'},
          {keyEvents: [{name: 'properties/123/keyEvents/2', eventName: 'b'}], nextPageToken: 't'},
        ],
      },
    ],
    [
      'duplicate resource',
      {
        keyEvents: [
          {
            keyEvents: [
              {name: 'properties/123/keyEvents/1', eventName: 'a'},
              {name: 'properties/123/keyEvents/1', eventName: 'a'},
            ],
          },
        ],
      },
    ],
    [
      'stream data of another type',
      {
        dataStreams: [
          {
            dataStreams: [
              {
                name: 'properties/123/dataStreams/9',
                type: 'ANDROID_APP_DATA_STREAM',
                webStreamData: {measurementId: 'G-ABC123'},
              },
            ],
          },
        ],
      },
    ],
    [
      'malformed measurement ID',
      {
        dataStreams: [
          {
            dataStreams: [
              {name: 'properties/123/dataStreams/9', type: 'WEB_DATA_STREAM', webStreamData: {measurementId: 'UA-1'}},
            ],
          },
        ],
      },
    ],
    ['foreign retention', {dataRetentionSettings: {name: 'properties/999/dataRetentionSettings'}}],
    // The transport already classifies a 200 error envelope as a provider failure.
    ['error envelope', {googleAdsLinks: [{error: {code: 403}}]}, 'PLATFORM_ERROR'],
    ['malformed list', {customMetrics: [{customMetrics: {}}]}],
  ];
  for (const [name, data, code = 'GA4_CONFIG_INVALID'] of cases) {
    const f = fixture(t, {data}),
      out = await f.read();
    assert.equal(out.success, false, name + ': ' + JSON.stringify(out.data ?? null));
    assert.equal(out.error.code, code, name + ': ' + JSON.stringify(out.error));
    assert.equal(out.data, undefined, name);
  }
});

test('MSR-03 GA4 configuration refusals happen before any provider request', async t => {
  const cases = [
    [{gateway: 'google_ads_native_action'}, 'MEASUREMENT_CONFIG_UNQUALIFIED'],
    [{account_id: 'properties/123'}, 'INVALID_ARGUMENT'],
    [{requirements: {sections: ['key_events', 'key_events']}}, 'INVALID_ARGUMENT'],
    [{requirements: {sections: ['audiences']}}, 'INVALID_ARGUMENT'],
    [{requirements: {sections: []}}, 'INVALID_ARGUMENT'],
    [{requirements: {event_names: ['purchase']}}, 'INVALID_ARGUMENT'],
  ];
  for (const [input, code] of cases) {
    const f = fixture(t),
      out = await f.read(input);
    assert.equal(out.success, false, JSON.stringify(input));
    assert.equal(out.error.code, code, JSON.stringify(out.error));
    assert.equal(f.requests.length, 0);
  }
  const unscoped = fixture(t, {scopes: ['https://www.googleapis.com/auth/webmasters.readonly']}),
    refused = await unscoped.read();
  assert.equal(refused.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(unscoped.requests.length, 0);
  const foreign = fixture(t),
    other = await foreign.read({account_id: '999'});
  assert.equal(other.success, false);
  assert.equal(other.error.code, 'CONNECTION_REQUIRED');
  assert.equal(foreign.requests.length, 0, 'a property not granted to the login is never read');
});

test('MSR-03 a login replaced or withdrawn during the read refuses the response', async t => {
  for (const [name, change] of [
    [
      'credential rotation',
      ({store, owner, connection}) => store.putConnection(owner, connection, {accessToken: 'rotated'}),
    ],
    [
      'property withdrawal',
      ({store, owner, connection}) =>
        store.putConnection(owner, {...connection, accounts: ['999']}, {accessToken: 'synthetic'}),
    ],
  ]) {
    const f = fixture(t, {
        beforeResponse: ctx => {
          if (ctx.requests.length === 2) change(ctx);
        },
      }),
      out = await f.read();
    assert.equal(out.success, false, name + ': ' + JSON.stringify(out.data ?? null));
    assert.equal(
      out.error.code,
      {'credential rotation': 'CONNECTION_AUTHORITY_CHANGED', 'property withdrawal': 'CONNECTION_REQUIRED'}[name],
      name,
    );
    assert.equal(out.data, undefined, name);
    assert.ok(f.requests.length <= 2, name + ': no further read starts');
  }
});
