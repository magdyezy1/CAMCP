import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Meta offline conversions through the Conversions API, under the personal-data policy the owner approved on
 * 2026-09-30 (conversions after customer lists). Meta's references (read 2026-09-30): "Using the Conversions API" (POST
 * /{pixel_id}/events with data; "up to 1,000 events"; "If any event you send in a batch is invalid, we reject the entire
 * batch"; event_time up to 7 days old, physical_store within 62 days), "Server Event Parameters" (event_name,
 * event_time, user_data, custom_data, event_id, action_source), "Customer Information Parameters" (em and ph hashed
 * after normalization), "Custom Data Parameters" (value and currency "Required for purchase events") and the Meta
 * Pixel reference (the standard events).
 */
const gateway = 'meta_native_action',
  registry = new Registry(),
  tenantId = 'meta-offline-conversions',
  operator = {tenantId, userId: 'operator', role: 'operator'},
  owner = {tenantId, userId: 'owner', role: 'admin'};
const sha = v => createHash('sha256').update(v).digest('hex');
const mary = sha('mary@example.com'),
  maryPhone = sha('966501234567'),
  bob = sha('bob@example.org');
const now = Math.floor(Date.now() / 1000),
  hours = h => now - h * 3600;
const saudi = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
const events = (rows = []) => ({
  schema: ['EMAIL', 'PHONE'],
  rows: [
    {
      EMAIL: ' Mary@Example.com ',
      PHONE: '+966 50 123 4567',
      event_name: 'Purchase',
      event_time: hours(5),
      action_source: 'physical_store',
      value: 120.5,
      currency: 'SAR',
      event_id: 'order-1001',
    },
    {EMAIL: 'bob@example.org', event_name: 'Lead', event_time: hours(30), action_source: 'phone_call'},
    {EMAIL: 'bob@example.org', event_name: 'Lead', event_time: hours(30), action_source: 'phone_call'},
    ...rows,
  ],
});

function fixture({pixels = [{id: '700', name: 'Store pixel'}]} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 52).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const calls = [];
  let writes = 0,
    reply;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      const raw = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      const b = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => {
          try {
            return [k, JSON.parse(v)];
          } catch {
            return [k, v];
          }
        }),
      );
      calls.push({method, path, query: Object.fromEntries(u.searchParams), body: b});
      if (method === 'GET') {
        if (path === '/v26.0/act_123/adspixels') return Response.json({data: pixels, paging: {}});
        return Response.json(
          {error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}},
          {status: 400},
        );
      }
      writes++;
      if (reply) return reply(b);
      const m = /^\/v26\.0\/(\d+)\/events$/.exec(path);
      if (method === 'POST' && m && pixels.some(p => p.id === m[1]))
        return Response.json({events_received: b.data.length, messages: [], fbtrace_id: 'AbCdEf123'});
      throw Error('Unexpected write ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const workspace = (action, extra, actor = owner) => service.call('amcp_workspace', {action, ...extra}, actor);
  const send = (
    people = events(),
    personal_data = saudi,
    pixel = '700',
    actor = operator,
    action = 'meta_pixel_id_events_create',
  ) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', params: {pixel_id: pixel}},
        ...(people !== undefined ? {people} : {}),
        ...(personal_data !== undefined ? {personal_data} : {}),
      },
      actor,
    );
  const execute = (p, people, actor = owner) =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, confirmed: true, ...(people ? {people} : {})},
      actor,
    );
  const verify = (p, actor = owner) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  const kept = () =>
    JSON.stringify([
      store.db.prepare('SELECT data FROM documents').all(),
      store.db.prepare('SELECT event FROM audit').all(),
      store.db.prepare('SELECT result FROM idempotency').all(),
      store.db.prepare('SELECT input,result,error FROM jobs').all(),
    ]);
  return {
    store,
    service,
    calls,
    workspace,
    send,
    execute,
    verify,
    kept,
    writes: () => writes,
    reply: fn => (reply = fn),
  };
}
const ok = r => {
  assert.equal(r.success ?? true, true, JSON.stringify(r).slice(0, 1500));
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 1500));
  return r;
};
const refused = (r, code, pattern) => {
  assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 1200));
  if (pattern) assert.match(r.error.message, pattern);
};
const noPeople = (text, label) => {
  for (const v of ['mary@example.com', 'Mary@Example.com', 'bob@example.org', '966501234567', mary, maryPhone, bob])
    assert.equal(text.includes(v), false, label + ' holds ' + v);
};
async function enable(f) {
  return ok(await f.workspace('enable_personal_data', {connection_id: 'm', account_id: '123', confirmed: true}));
}

test('offline events are hashed in memory, shown in aggregate, sent by the owner and verified by Meta’s count', async () => {
  const f = fixture();
  await enable(f);
  const p = ok(await f.send());
  const record = p.data.request.personalData;
  assert.deepEqual(record.counts, {rows: 3, sent: 2, duplicates: 1, refused: {}});
  assert.deepEqual(record.summary.events, {Lead: 1, Purchase: 1});
  assert.deepEqual(record.summary.value, {SAR: 120.5});
  assert.deepEqual(record.summary.action_sources, {phone_call: 1, physical_store: 1});
  assert.equal(record.summary.earliest, new Date(hours(30) * 1000).toISOString());
  assert.deepEqual(p.data.request.body, {data: []});
  const impact = JSON.stringify(p.data.creative_impact);
  assert.match(impact, /cannot be recalled/);
  assert.match(impact, /Store pixel/);
  noPeople(JSON.stringify(p), 'the prepare response');
  noPeople(f.kept(), 'the store after prepare');
  refused(await f.execute(p, events(), operator), 'OWNER_REQUIRED');
  const done = ok(await f.execute(p, events()));
  const sent = f.calls.find(c => c.method === 'POST' && c.path === '/v26.0/700/events');
  const purchase = sent.body.data.find(e => e.event_name === 'Purchase'),
    lead = sent.body.data.find(e => e.event_name === 'Lead');
  assert.deepEqual(purchase, {
    event_name: 'Purchase',
    event_time: hours(5),
    action_source: 'physical_store',
    event_id: 'order-1001',
    user_data: {em: [mary], ph: [maryPhone]},
    custom_data: {value: 120.5, currency: 'SAR'},
  });
  assert.deepEqual(lead, {
    event_name: 'Lead',
    event_time: hours(30),
    action_source: 'phone_call',
    user_data: {em: [bob]},
  });
  assert.deepEqual(done.data.data, {events_received: 2, fbtrace_id: 'AbCdEf123'});
  const v = ok(await f.verify(p));
  assert.equal(v.data.status, 'verified');
  assert.equal(v.data.checks[0].received, 2);
  noPeople(JSON.stringify(done) + JSON.stringify(v), 'the execution and verification');
  noPeople(f.kept(), 'the store after execution');
});

test('events outside Meta’s rules are refused or counted before any request', async () => {
  const f = fixture();
  await enable(f);
  // Rows: website and app events need browser or device data AMCP does not send; a purchase needs its value and
  // currency; an unknown event name; a value without currency.
  const mixed = ok(
    await f.send(
      events([
        {
          EMAIL: 'a@example.com',
          event_name: 'Purchase',
          event_time: hours(1),
          action_source: 'website',
          value: 5,
          currency: 'SAR',
        },
        {EMAIL: 'b@example.com', event_name: 'Purchase', event_time: hours(1), action_source: 'email'},
        {EMAIL: 'c@example.com', event_name: 'Bought', event_time: hours(1), action_source: 'email'},
        {EMAIL: 'd@example.com', event_name: 'Lead', event_time: hours(1), action_source: 'chat', value: 3},
        {EMAIL: 'e@example.com', event_name: 'Lead', event_time: hours(1), action_source: 'chat', color: 'red'},
        {
          EMAIL: 'f@example.com',
          event_name: 'Lead',
          event_time: hours(1),
          action_source: 'chat',
          event_id: 'f@example.com',
        },
      ]),
    ),
  );
  assert.deepEqual(mixed.data.request.personalData.counts.refused, {
    invalid_action_source: 1,
    purchase_without_value: 1,
    invalid_event_name: 1,
    value_without_currency: 1,
    row_shape: 1,
    invalid_event_id: 1,
  });
  // Time: an event older than 7 days (62 for a store) or in the future stops the whole upload, as Meta would.
  refused(
    await f.send({
      schema: 'EMAIL',
      rows: [{EMAIL: 'a@example.com', event_name: 'Lead', event_time: hours(24 * 8), action_source: 'email'}],
    }),
    'PERSONAL_DATA_INVALID',
    /7 days/,
  );
  ok(
    await f.send({
      schema: 'EMAIL',
      rows: [
        {
          EMAIL: 'a@example.com',
          event_name: 'Purchase',
          event_time: hours(24 * 30),
          action_source: 'physical_store',
          value: 1,
          currency: 'SAR',
        },
      ],
    }),
  );
  refused(
    await f.send({
      schema: 'EMAIL',
      rows: [{EMAIL: 'a@example.com', event_name: 'Lead', event_time: now + 3600, action_source: 'email'}],
    }),
    'PERSONAL_DATA_INVALID',
    /future/,
  );
  refused(
    await f.send({
      schema: 'EMAIL',
      rows: Array.from({length: 1001}, (_, i) => ({
        EMAIL: 'p' + i + '@example.com',
        event_name: 'Lead',
        event_time: hours(1),
        action_source: 'email',
      })),
    }),
    'PERSONAL_DATA_INVALID',
    /at most 1000/,
  );
  // Inspect checks the contract locally; the time window is checked at prepare and execution.
  const stale = {
    schema: 'EMAIL',
    rows: [{EMAIL: 'a@example.com', event_name: 'Lead', event_time: hours(24 * 90), action_source: 'email'}],
  };
  const inspected = await f.service.call(
    'amcp_write',
    {
      action: 'inspect',
      gateway,
      arguments: {action: 'meta_pixel_id_events_create', account_id: '123', params: {pixel_id: '700'}},
      people: stale,
      personal_data: saudi,
    },
    operator,
  );
  assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected.data.error));
  noPeople(JSON.stringify(inspected), 'the inspection');
  refused(await f.send(stale), 'PERSONAL_DATA_INVALID', /older than Meta accepts/);
  refused(await f.send(events(), null), 'PERSONAL_DATA_CONFIRMATION_REQUIRED');
  refused(await f.send(events(), saudi, '701'), 'STATE_TARGET_MISMATCH', /pixel 701/);
  refused(await f.send({schema: 'EMAIL', rows: ['mary@example.com']}), 'PERSONAL_DATA_INVALID');
  assert.equal(f.writes(), 0);
  noPeople(f.kept(), 'the store after refusals');
});

test('the switch is the owner’s; a rejected batch keeps nothing of the people; the ledger records the family', async () => {
  const f = fixture();
  refused(await f.send(), 'PERSONAL_DATA_OFF');
  await enable(f);
  const p = ok(await f.send(events(), saudi, '700', operator, 'meta_pixel_events_create'));
  f.reply(b =>
    Response.json(
      {
        error: {
          message: 'Invalid parameter: user_data em ' + b.data[0].user_data.em[0],
          code: 100,
          error_subcode: 2804003,
        },
      },
      {status: 400},
    ),
  );
  const r = await f.execute(p, events());
  assert.equal(r.success, false);
  noPeople(JSON.stringify(r), 'the error');
  noPeople(f.kept(), 'the store after a rejected batch');
  const rows = actionContracts(registry);
  for (const action of ['meta_pixel_id_events_create', 'meta_pixel_events_create']) {
    const row = rows.find(x => x.gateway === gateway && x.action === action);
    assert.equal(row?.status, 'reviewed_write_family', action);
    assert.equal(row.family, 'meta_offline_conversions', action);
  }
});
