// MSR-04: realtime test identity. GA4's Realtime API filters only user-scoped custom dimensions, so this mode reads
// customUser:amcp_test_id, and only on a GA4 property the workspace owner explicitly marked as a test property (owner
// direction P4). Results stay aggregate and synthetic and are labelled user-level, never event-level proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const identity = 'amcp-test-12345678-abcd',
  connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const metadata = (dimensions = [{apiName: 'customUser:amcp_test_id', customDefinition: true}]) => ({
  name: 'properties/123/metadata',
  dimensions: [{apiName: 'eventName'}, {apiName: 'streamId'}, ...dimensions],
  metrics: [{apiName: 'eventCount', type: 'TYPE_INTEGER'}],
  private: 'PRIVATE-NATIVE-METADATA',
});
const row = (count = '2', stream = '900') => ({
  dimensionValues: ['purchase', identity, stream].map(value => ({value})),
  metricValues: [{value: count}],
  private: 'PRIVATE-NATIVE-ROW',
});
const realtime = (rows = [row()], extra = {}) => ({
  kind: 'analyticsData#runRealtimeReport',
  dimensionHeaders: [{name: 'eventName'}, {name: 'customUser:amcp_test_id'}, {name: 'streamId'}],
  metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
  rows,
  rowCount: rows.length,
  private: 'PRIVATE-NATIVE-REPORT',
  ...extra,
});
function fixture(t) {
  const reader = {tenantId: 'identity-realtime', userId: 'reader', role: 'reader'},
    owner = {...reader, userId: 'owner', role: 'admin'},
    operator = {...reader, userId: 'operator', role: 'operator'},
    store = new Store(':memory:', Buffer.alloc(32, 98).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: reader.tenantId,
      gateway: 'ga4_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic GA4 test property',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  let respond = () => undefined;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw));
      assert.equal(url.hostname, 'analyticsdata.googleapis.com');
      assert.ok(['/v1beta/properties/123/metadata', '/v1beta/properties/123:runRealtimeReport'].includes(url.pathname));
      requests.push({url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null});
      return Response.json(
        respond(url, requests.length) ?? (url.pathname.endsWith('/metadata') ? metadata() : realtime()),
      );
    }),
  );
  const input = {
    action: 'measurement_event_identity',
    gateway: 'ga4_native_action',
    account_id: '123',
    connection_id: connectionId,
    requirements: {
      mode: 'realtime_user_scope',
      event_name: 'purchase',
      test_id: identity,
      minutes: 10,
      expected_count: 2,
    },
  };
  const workspace = (args, actor = owner) => service.call('amcp_workspace', args, actor);
  return {
    reader,
    owner,
    operator,
    store,
    requests,
    input,
    respond: fn => (respond = fn),
    workspace,
    read: (requirements = {}, actor = reader) =>
      workspace({...input, requirements: {...input.requirements, ...requirements}}, actor),
    mark: (enabled = true, actor = owner, extra = {}) =>
      workspace(
        {
          action: 'save_ga4_test_property',
          connection_id: connectionId,
          account_id: '123',
          enabled,
          confirmed: true,
          ...extra,
        },
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r));
  assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r.error;
};

test('only the workspace owner marks a GA4 test property; marking is audited and sends nothing to GA4', async t => {
  const f = fixture(t);
  refused(await f.mark(true, f.operator), 'OWNER_REQUIRED');
  refused(await f.mark(true, f.reader), 'OWNER_REQUIRED');
  refused(await f.mark(true, f.owner, {confirmed: false}), 'INVALID_ARGUMENT');
  refused(await f.mark(true, f.owner, {account_id: '456'}), 'ACCOUNT_SCOPE_MISMATCH');
  refused(await f.mark(true, f.owner, {connection_id: 'bbbbbbbb-1111-4111-8111-111111111111'}), 'CONNECTION_NOT_FOUND');
  const marked = ok(await f.mark());
  assert.equal(marked.test_property, true);
  assert.equal(marked.provider_mutations, 0);
  assert.deepEqual(
    marked.test_properties.map(p => p.property_id),
    ['123'],
  );
  assert.match(marked.effect, /persists on the synthetic test user/);
  const unmarked = ok(await f.mark(false));
  assert.equal(unmarked.test_property, false);
  assert.deepEqual(unmarked.test_properties, []);
  const audit = f.store.db.prepare('SELECT event FROM audit WHERE tenant_id=?').all(f.reader.tenantId);
  assert.ok(audit.some(a => /ga4_test_property_marked/.test(a.event)));
  assert.ok(audit.some(a => /ga4_test_property_unmarked/.test(a.event)));
  assert.equal(f.requests.length, 0);
  const health = ok(await f.workspace({action: 'health'}));
  assert.deepEqual(health.ga4_test_properties, []);
});

test('the realtime mode is refused on a property the owner has not marked, before any GA4 request', async t => {
  const f = fixture(t),
    error = refused(await f.read(), 'MEASUREMENT_TEST_PROPERTY_REQUIRED');
  assert.match(error.message, /marked as a test property/);
  assert.equal(f.requests.length, 0);
});

test('a marked test property reads the user-scoped identifier through bounded realtime and labels it user-level', async t => {
  const f = fixture(t);
  ok(await f.mark());
  const response = await f.read({stream_id: '900'}),
    out = ok(response);
  assert.equal(out.record_kind, 'measurement_event_identity');
  assert.equal(out.mode, 'realtime_user_scope');
  assert.equal(out.latency, 'realtime');
  assert.equal(out.state, 'observed');
  assert.equal(out.scope.identity_dimension, 'customUser:amcp_test_id');
  assert.equal(out.scope.minutes, 10);
  assert.equal(out.period, undefined);
  assert.deepEqual(out.relative_window, {
    start_minutes_ago: 9,
    end_minutes_ago: 0,
    reference: 'provider request processing time',
  });
  assert.equal(out.observation.reported_count, '2');
  assert.equal(out.observation.comparison, 'matches_declared');
  assert.equal(out.checks.identity_scope, 'user');
  assert.equal(out.checks.test_event_identity, 'user_scope_matched');
  assert.equal(out.checks.event_level_proof, 'not_established');
  assert.equal(out.checks.test_property, 'marked_by_owner');
  for (const key of ['deduplication', 'consent', 'attribution']) assert.equal(out.checks[key], 'unverified');
  assert.equal(out.test_property.marked_by, 'owner');
  assert.match(out.cleanup, /persists on the synthetic test user/);
  assert.match(out.meaning, /not event-level proof/);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.retained_snapshot, false);
  assert.deepEqual(
    f.requests.map(r => [r.method, r.url.pathname]),
    [
      ['GET', '/v1beta/properties/123/metadata'],
      ['POST', '/v1beta/properties/123:runRealtimeReport'],
      ['GET', '/v1beta/properties/123/metadata'],
    ],
  );
  const body = f.requests[1].body;
  assert.deepEqual(body.minuteRanges, [{startMinutesAgo: 9, endMinutesAgo: 0}]);
  assert.equal(body.dateRanges, undefined);
  assert.deepEqual(
    body.dimensions.map(d => d.name),
    ['eventName', 'customUser:amcp_test_id', 'streamId'],
  );
  assert.deepEqual(body.dimensionFilter.andGroup.expressions[1], {
    filter: {
      fieldName: 'customUser:amcp_test_id',
      stringFilter: {matchType: 'EXACT', value: identity, caseSensitive: true},
    },
  });
  assert.equal(body.dimensionFilter.andGroup.expressions[2].filter.stringFilter.value, '900');
  assert.equal(body.limit, '1000');
  assert.equal(out.source_references.length, 3);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-NATIVE|accessToken/);
  // The website link reopens the same realtime scope instead of calendar dates.
  const path = response.meta.workflow.website_path;
  assert.match(path, /^\/measurement\?event_identity=1&/);
  assert.match(path, /mode=realtime_user_scope/);
  assert.match(path, /minutes=10/);
  assert.doesNotMatch(path, /date_from|date_to/);
});

test('no realtime row stays unknown, not a broken tag', async t => {
  const f = fixture(t);
  ok(await f.mark());
  f.respond(u => (u.pathname.endsWith('/metadata') ? undefined : {...realtime([]), rowCount: undefined}));
  const out = ok(await f.read());
  assert.equal(out.state, 'not_observed');
  assert.equal(out.observation.reported_count, null);
  assert.equal(out.checks.test_event_identity, 'not_observed');
});

test('the realtime mode requires the exact user-scoped dimension; an event-scoped one is not enough', async t => {
  const f = fixture(t);
  ok(await f.mark());
  f.respond(u =>
    u.pathname.endsWith('/metadata')
      ? metadata([{apiName: 'customEvent:amcp_test_id', customDefinition: true}])
      : realtime(),
  );
  const error = refused(await f.read(), 'MEASUREMENT_IDENTITY_INVALID');
  assert.match(error.message, /user-scoped amcp_test_id dimension is not uniquely registered/);
  assert.equal(f.requests.length, 1);
});

test('realtime inputs are bounded: no calendar dates, 1–30 minutes, known modes only', async t => {
  const f = fixture(t);
  ok(await f.mark());
  for (const requirements of [
    {date_from: '2026-10-01', date_to: '2026-10-02'},
    {minutes: 0},
    {minutes: 31},
    {minutes: 2.5},
    {mode: 'event_trace'},
  ])
    refused(await f.read(requirements), 'INVALID_ARGUMENT');
  // The core mode refuses a minute window rather than ignoring it.
  refused(
    await f.workspace(
      {
        ...f.input,
        requirements: {
          event_name: 'purchase',
          test_id: identity,
          date_from: '2026-10-01',
          date_to: '2026-10-02',
          minutes: 5,
        },
      },
      f.reader,
    ),
    'INVALID_ARGUMENT',
  );
  assert.equal(f.requests.length, 0);
});

test('unmarking the test property during an inspection refuses its result', async t => {
  const f = fixture(t);
  ok(await f.mark());
  f.respond((u, count) => {
    if (count === 2) f.store.db.prepare("DELETE FROM documents WHERE kind='ga4_test_property'").run();
    return undefined;
  });
  refused(await f.read(), 'MEASUREMENT_TEST_PROPERTY_REQUIRED');
});

test('thresholded, foreign or duplicate realtime evidence is refused', async t => {
  const f = fixture(t);
  ok(await f.mark());
  for (const report of [
    realtime([row()], {metadata: {subjectToThresholding: true}}),
    realtime([row('1', '900'), row('1', '900')]),
    realtime([{...row(), dimensionValues: ['purchase', 'amcp-test-other12345', '900'].map(value => ({value}))}]),
    {...realtime(), dimensionHeaders: [{name: 'eventName'}, {name: 'customEvent:amcp_test_id'}, {name: 'streamId'}]},
    {...realtime(), kind: 'analyticsData#runReport'},
  ]) {
    f.respond(u => (u.pathname.endsWith('/metadata') ? undefined : report));
    refused(await f.read(), 'MEASUREMENT_IDENTITY_INVALID');
  }
});
