import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const row = (event, minute, stream, count) => ({
  dimensionValues: [event, minute, stream].map(value => ({value})),
  metricValues: [{value: count}],
  private: 'PRIVATE-ROW',
});
const page = (rows = [row('purchase', '00', '900', '9007199254740993'), row('purchase', '01', '900', '2')]) => ({
  kind: 'analyticsData#runRealtimeReport',
  dimensionHeaders: [{name: 'eventName'}, {name: 'minutesAgo'}, {name: 'streamId'}],
  metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
  rows,
  rowCount: rows.length,
  private: 'PRIVATE-RESPONSE',
});
function fixture(t) {
  const actor = {tenantId: 'event-observation', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 99).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'ga4_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic GA4',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const requests = [];
  let respond = () => page();
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        requests.push({url: String(url), init, body: JSON.parse(init.body)});
        return Response.json(respond());
      },
      async () => {},
    ),
  );
  const call = (extra = {}) =>
    service.call(
      'amcp_workspace',
      {
        action: 'measurement_events',
        gateway: 'ga4_native_action',
        account_id: '123',
        connection_id: connection.id,
        requirements: {event_names: ['purchase', 'generate_lead'], minutes: 5},
        ...extra,
      },
      actor,
    );
  return {
    actor,
    store,
    connection,
    requests,
    call,
    respond: f => {
      respond = f;
    },
  };
}
function ok(r) {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}

test('GA4 observation uses a bounded native realtime read and exact integer aggregates without reporting tracking health', async t => {
  const f = fixture(t),
    r = ok(await f.call());
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123:runRealtimeReport');
  assert.equal(f.requests[0].init.method, 'POST');
  assert.deepEqual(f.requests[0].body.minuteRanges, [{startMinutesAgo: 4, endMinutesAgo: 0}]);
  assert.deepEqual(f.requests[0].body.dimensionFilter, {
    filter: {fieldName: 'eventName', inListFilter: {values: ['purchase', 'generate_lead'], caseSensitive: true}},
  });
  assert.equal(f.requests[0].body.limit, '1000');
  assert.equal(r.events[0].reported_count, '9007199254740995');
  assert.equal(r.events[0].state, 'observed');
  assert.equal(r.events[1].reported_count, null);
  assert.equal(r.events[1].state, 'not_observed');
  assert.equal(r.checks.deduplication, 'unverified');
  assert.equal(r.checks.consent, 'unverified');
  assert.equal(r.checks.attribution, 'unverified');
  assert.equal(r.record_kind, 'measurement_events');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|accessToken|"healthy"/);
});

test('GA4 stream selection stays exact and minute rows reconcile to each selected event', async t => {
  const f = fixture(t),
    r = ok(await f.call({requirements: {event_names: ['purchase'], minutes: 30, stream_id: '900'}}));
  assert.deepEqual(f.requests[0].body.dimensionFilter.andGroup.expressions[1], {
    filter: {fieldName: 'streamId', stringFilter: {matchType: 'EXACT', value: '900', caseSensitive: true}},
  });
  assert.equal(r.scope.stream_id, '900');
  assert.equal(r.rows.length, 2);
  assert.equal(r.events[0].reported_count, '9007199254740995');
});

test('valid empty realtime output and omitted ProtoJSON defaults mean no returned event rows, not a broken tag diagnosis', async t => {
  const f = fixture(t);
  f.respond(() => {
    const r = page([]);
    delete r.rows;
    delete r.rowCount;
    return r;
  });
  const r = ok(await f.call());
  assert.equal(r.rows.length, 0);
  assert.equal(r.state, 'not_observed');
  assert.ok(r.events.every(e => e.reported_count === null && e.state === 'not_observed'));
});

test('GA4 observations preserve documented non-English event names and never normalize case or spelling', async t => {
  const f = fixture(t);
  f.respond(() => page([row('شراء', '00', '900', '4'), row('購入', '01', '900', '7')]));
  const r = ok(await f.call({requirements: {event_names: ['شراء', '購入', 'Purchase'], minutes: 5}}));
  assert.deepEqual(f.requests[0].body.dimensionFilter.filter.inListFilter.values, ['شراء', '購入', 'Purchase']);
  assert.deepEqual(
    r.events.map(e => e.reported_count),
    ['4', '7', null],
  );
  assert.deepEqual(
    r.events.map(e => e.event_name),
    ['شراء', '購入', 'Purchase'],
  );
});

test('GA4 observation rejects invalid names, unsupported providers, unknown fields and oversized windows before requests', async t => {
  const f = fixture(t);
  for (const input of [
    {gateway: 'meta_native_action'},
    {account_id: 'properties/123'},
    {requirements: {event_names: [], minutes: 5}},
    {requirements: {event_names: ['purchase', 'purchase'], minutes: 5}},
    {requirements: {event_names: [' purchase'], minutes: 5}},
    {requirements: {event_names: ['x'.repeat(41)], minutes: 5}},
    {requirements: {event_names: ['purchase'], minutes: 31}},
    {requirements: {event_names: ['purchase'], minutes: 0}},
    {requirements: {event_names: ['purchase'], minutes: 5, user_id: 'private'}},
  ])
    assert.equal((await f.call(input)).success, false, JSON.stringify(input));
  assert.equal(f.requests.length, 0);
});

test('realtime evidence refuses changed headers, dimensions, stream/window, duplicate grain and inexact counts', async t => {
  for (const edit of [
    p => {
      p.dimensionHeaders.reverse();
    },
    p => {
      p.metricHeaders[0].type = 'TYPE_FLOAT';
    },
    p => {
      p.rows[0].dimensionValues[0].value = 'other_event';
    },
    p => {
      p.rows[0].dimensionValues[1].value = '05';
    },
    p => {
      p.rows[0].dimensionValues[2].value = '901';
    },
    p => {
      p.rows[1] = p.rows[0];
    },
    p => {
      p.rows[0].metricValues[0].value = '0.5';
    },
    p => {
      p.rows[0].metricValues = [];
    },
    p => {
      p.rows[0].metricValues[0].value = 9007199254740992;
    },
    p => {
      p.rows[0].dimensionValues.push({value: 'private'});
    },
  ]) {
    const f = fixture(t);
    f.respond(() => {
      const p = page();
      edit(p);
      return p;
    });
    assert.equal(
      (await f.call({requirements: {event_names: ['purchase'], minutes: 5, stream_id: '900'}})).success,
      false,
    );
  }
});

test('realtime collection refuses partial, oversized, unknown or error envelopes', async t => {
  for (const response of [
    {},
    {...page(), rowCount: 3},
    {...page(), rowCount: 1001},
    {...page(), nextPageToken: 'unexpected'},
    {...page(), metadata: {subjectToThresholding: true}},
    {...page(), error: {code: 400, message: 'Provider failure'}},
  ]) {
    const f = fixture(t);
    f.respond(() => response);
    assert.equal((await f.call()).success, false);
  }
});

test('realtime data is withheld when the login is disabled or replaced during the native read', async t => {
  for (const mode of ['disabled', 'replaced']) {
    const f = fixture(t);
    f.respond(() => {
      f.store.putConnection(
        {...f.actor, role: 'admin'},
        {...f.connection, enabled: mode !== 'disabled'},
        {accessToken: mode === 'replaced' ? 'new-token' : 'synthetic'},
      );
      return page();
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 1);
  }
});
