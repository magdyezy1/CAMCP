import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const identity = 'amcp-test-12345678-abcd';
const metadata = () => ({
  name: 'properties/123/metadata',
  dimensions: [
    {apiName: 'eventName'},
    {apiName: 'streamId'},
    {apiName: 'customEvent:amcp_test_id', customDefinition: true},
  ],
  metrics: [{apiName: 'eventCount', type: 'TYPE_INTEGER'}],
  private: 'PRIVATE-NATIVE-METADATA',
});
const row = (count = '1', stream = '900') => ({
  dimensionValues: ['purchase', identity, stream].map(value => ({value})),
  metricValues: [{value: count}],
  private: 'PRIVATE-NATIVE-ROW',
});
const report = (rows = [row()]) => ({
  kind: 'analyticsData#runReport',
  dimensionHeaders: [{name: 'eventName'}, {name: 'customEvent:amcp_test_id'}, {name: 'streamId'}],
  metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
  rows,
  rowCount: rows.length,
  metadata: {timeZone: 'Asia/Riyadh'},
  private: 'PRIVATE-NATIVE-REPORT',
});
function fixture(t) {
  const actor = {tenantId: 'identity-test', userId: 'reader', role: 'reader'},
    admin = {...actor, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'ga4_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic GA4 identity',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const requests = [];
  let respond = () => undefined;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw));
      assert.equal(url.hostname, 'analyticsdata.googleapis.com');
      assert.ok(['/v1beta/properties/123/metadata', '/v1beta/properties/123:runReport'].includes(url.pathname));
      requests.push({url: String(url), method: init.method, body: init.body ? JSON.parse(String(init.body)) : null});
      return Response.json(
        respond(url, requests.length) ?? (url.pathname.endsWith('/metadata') ? metadata() : report()),
      );
    }),
  );
  const input = {
    action: 'measurement_event_identity',
    gateway: connection.gateway,
    account_id: '123',
    connection_id: connection.id,
    requirements: {
      event_name: 'purchase',
      test_id: identity,
      date_from: '2026-10-01',
      date_to: '2026-10-02',
      stream_id: '900',
      expected_count: 1,
    },
  };
  return {
    actor,
    admin,
    store,
    connection,
    requests,
    service,
    input,
    respond: fn => (respond = fn),
    call: extra => service.call('amcp_workspace', {...input, ...extra}, actor),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('an exact GA4 synthetic test identifier is inspected through fresh property metadata and one complete native report', async t => {
  const f = fixture(t),
    out = ok(await f.call());
  assert.equal(out.record_kind, 'measurement_event_identity');
  assert.equal(out.state, 'observed');
  assert.equal(out.observation.reported_count, '1');
  assert.equal(out.observation.comparison, 'matches_declared');
  assert.equal(out.scope.test_id, identity);
  assert.equal(out.scope.property_id, '123');
  assert.equal(out.period.timezone, 'Asia/Riyadh');
  assert.equal(out.checks.test_event_identity, 'matched_in_report');
  for (const key of ['deduplication', 'consent', 'attribution']) assert.equal(out.checks[key], 'unverified');
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.retained_snapshot, false);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(
    f.requests.map(r => r.method),
    ['GET', 'POST', 'GET'],
  );
  assert.equal(f.requests[1].body.limit, '1000');
  assert.equal(f.requests[1].body.dimensionFilter.andGroup.expressions[1].filter.stringFilter.value, identity);
  assert.equal(f.requests[1].body.dimensionFilter.andGroup.expressions[1].filter.stringFilter.caseSensitive, true);
  assert.equal(out.source_references.length, 3);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-NATIVE/);
});
test('count comparison stays exact beyond safe integer precision and does not certify deduplication', async t => {
  const f = fixture(t);
  delete f.input.requirements.stream_id;
  f.respond(u =>
    u.pathname.endsWith('/metadata') ? metadata() : report([row('9007199254740993', '900'), row('2', '901')]),
  );
  const out = ok(await f.call());
  assert.equal(out.observation.reported_count, '9007199254740995');
  assert.equal(out.observation.comparison, 'above_declared');
  assert.equal(out.checks.deduplication, 'unverified');
});
test('no row remains unknown and an explicit zero remains zero without diagnosing a broken tag', async t => {
  const f = fixture(t);
  for (const [rows, count] of [
    [[], null],
    [[row('0')], '0'],
  ]) {
    f.respond(u => (u.pathname.endsWith('/metadata') ? metadata() : report(rows)));
    const out = ok(await f.call());
    assert.equal(out.observation.reported_count, count);
    assert.equal(out.state, 'not_observed');
    assert.equal(out.checks.test_event_identity, 'not_observed');
  }
});
test('missing, foreign or ambiguous custom dimension evidence prevents report submission', async t => {
  const f = fixture(t);
  for (const mutate of [
    d => (d.name = 'properties/999/metadata'),
    d => d.dimensions.pop(),
    d => d.dimensions.push(d.dimensions[2]),
    d => (d.dimensions[2].customDefinition = false),
    d => (d.metrics[0].type = 'TYPE_FLOAT'),
  ]) {
    const before = f.requests.length,
      m = metadata();
    mutate(m);
    f.respond(() => m);
    const out = await f.call();
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'MEASUREMENT_IDENTITY_INVALID');
    assert.equal(f.requests.length, before + 1);
  }
});
test('partial, sampled, restricted, malformed or foreign native rows cannot establish exact test identity', async t => {
  const f = fixture(t);
  for (const mutate of [
    d => (d.rowCount = 1001),
    d => (d.rowCount = 2),
    d => (d.nextPageToken = 'more'),
    d => (d.metadata.subjectToThresholding = true),
    d => (d.metadata.dataLossFromOtherRow = true),
    d => (d.metadata.samplingMetadatas = [{samplesReadCount: '1', samplingSpaceSize: '2'}]),
    d => (d.metadata.dataTruncationReasons = [{reason: 'OTHER'}]),
    d => (d.metadata.schemaRestrictionResponse = {activeMetricRestrictions: [{metricName: 'eventCount'}]}),
    d => delete d.metadata,
    d => (d.metadata.timeZone = 'unknown-zone'),
    d => (d.metadata.emptyReason = 'FILTERED'),
    d => (d.dimensionHeaders[1].name = 'customEvent:other'),
    d => (d.metricHeaders[0].type = 'TYPE_FLOAT'),
    d => (d.rows[0].dimensionValues[0].value = 'foreign'),
    d => (d.rows[0].dimensionValues[1].value = 'amcp-test-other'),
    d => (d.rows[0].dimensionValues[2].value = '901'),
    d => (d.rows[0].metricValues[0].value = 1),
    d => (d.rows[0].metricValues[0].value = '1.5'),
    d => {
      d.rows.push(row());
      d.rowCount = 2;
    },
  ]) {
    const native = report();
    mutate(native);
    f.respond(u => (u.pathname.endsWith('/metadata') ? metadata() : native));
    const out = await f.call();
    assert.equal(out.success, false, JSON.stringify(native));
    assert.equal(out.error.code, 'MEASUREMENT_IDENTITY_INVALID');
  }
});
test('changed registration or withdrawn current account authorization discards the whole observation', async t => {
  for (const mode of ['registration', 'account', 'credentials', 'scopes']) {
    const f = fixture(t);
    f.respond((u, n) => {
      if (n === 2 && mode !== 'registration') {
        const c = {...f.connection, ...(mode === 'account' ? {accounts: []} : mode === 'scopes' ? {scopes: []} : {})};
        f.store.putConnection(f.admin, c, {accessToken: mode === 'credentials' ? 'changed' : 'synthetic'});
      }
      if (n === 3 && mode === 'registration') {
        const m = metadata();
        m.dimensions.pop();
        return m;
      }
    });
    assert.equal((await f.call()).success, false, mode);
    assert.equal(f.requests.length, mode === 'registration' ? 3 : 2);
  }
});
test('invalid or personal identifiers and overbroad dates are rejected before native reads', async t => {
  const f = fixture(t);
  for (const patch of [
    {test_id: 'person@example.test'},
    {test_id: '12345'},
    {event_name: 'bad name'},
    {identity_dimension: 'customUser:email'},
    {date_from: '2026-02-30'},
    {date_from: '2026-09-01'},
    {date_to: '2026-09-30'},
    {expected_count: 0},
    {expected_count: 1.5},
    {stream_id: '0'},
    {extra: 'unrecognized'},
  ]) {
    const out = await f.call({requirements: {...f.input.requirements, ...patch}});
    assert.equal(out.success, false);
  }
  assert.equal(f.requests.length, 0);
});
