import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B1 (the owner's field report of 2026-11-21, issue 2; lead's decision D5): meta_pixel_id_get of a pixel was refused
// RESOURCE_SCOPE_REQUIRED even after the account's own pixel list was read, because that list opened only the pixel's /stats and
// /dataset_quality routes, and the refusal hinted five lists that can never list a pixel. Now the list also opens the node itself, for
// the six fields Meta documents on it (the ones the measurement ledger reads) and nothing else.
// Synthetic IDs: ad account 123 (and 124), pixels 456 and 457.

const login = {a: 'cccccccc-6666-4666-8666-00000000000a', b: 'cccccccc-6666-4666-8666-00000000000b'},
  registry = new Registry(),
  node = metaPrefix + '456',
  fields = ['id', 'name', 'owner_business', 'creation_time', 'last_fired_time', 'is_unavailable'],
  actor = {tenantId: 'meta-pixel-node', userId: 'operator', role: 'operator'},
  ledgerCall = connection => ({
    tool: 'amcp_workspace',
    arguments: {
      action: 'measurement_ledger',
      gateway: 'meta_native_action',
      account_id: '123',
      connection_id: connection,
    },
  });
const pixel = (id, extra = {}) => ({
  id,
  name: 'Store pixel ' + id,
  owner_business: {id: '1001', name: 'Brand'},
  creation_time: '2026-01-01T00:00:00+0000',
  last_fired_time: '2026-10-11T08:00:00+0000',
  is_unavailable: false,
  ...extra,
});
const hour = ago => {
  const end = Math.floor(Date.now() / 3600000) * 3600;
  return new Date((end - ago * 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
};
function fixture(t, {accounts = ['123'], pixels = [pixel('456')], second = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 64).toString('base64')),
    requests = [],
    admin = {...actor, userId: 'admin', role: 'admin'};
  t.after(() => store.close());
  const connection = id => ({
    id,
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts,
    writeAccounts: [],
    enabled: true,
    label: 'Synthetic Meta ' + id.slice(-4),
    scopes: ['ads_management'],
  });
  store.putConnection(admin, connection(login.a), {accessToken: 'synthetic'});
  if (second) store.putConnection(admin, connection(login.b), {accessToken: 'synthetic'});
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          request = {method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams)};
        requests.push(request);
        for (const account of accounts)
          if (url.pathname === metaPrefix + 'act_' + account + '/adspixels')
            return Response.json({data: pixels, paging: {cursors: {before: 'a', after: 'b'}}});
        const id = /^\/v[0-9.]+\/(\d+)$/.exec(url.pathname)?.[1],
          row = pixels.find(p => p.id === id);
        if (row)
          return Response.json(
            Object.fromEntries((url.searchParams.get('fields') ?? '').split(',').map(name => [name, row[name]])),
          );
        if (/\/stats$/.test(url.pathname))
          return Response.json({
            data: [{aggregation: 'event', start_time: hour(1), data: [{value: 'PageView', count: 40}]}],
          });
        if (/\/dataset_quality$/.test(url.pathname))
          return Response.json({
            web: [
              {
                event_name: 'Purchase',
                event_match_quality: {composite_score: 7.2, match_key_feedback: []},
                event_coverage: {percentage: 60, goal_percentage: 75},
                dedupe_key_feedback: [],
                data_freshness: {upload_frequency: 'real_time'},
                acr: {percentage: 12},
              },
            ],
          });
        throw Error('Unexpected synthetic Meta route ' + url.pathname);
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  const guard = new ScopeGuard(registry, store),
    stored = id => store.connectionsFor(actor).find(c => c.id === id);
  // The account's pixel list as the ledger and the pixel family read it: GET act_{id}/adspixels, observed by the guard.
  const listed = (account = accounts[0], id = login.a, rows = pixels) =>
    guard.observe(
      {
        gateway: 'meta_native_action',
        accountId: account,
        action: 'AMCP_MEASUREMENT_LEDGER',
        method: 'GET',
        path: metaPrefix + 'act_' + account + '/adspixels',
        query: {fields: 'id', limit: 100},
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'synthetic',
        warnings: [],
      },
      stored(id),
      {data: rows},
    );
  const read = (input = {}, connection = login.a, account = accounts[0]) =>
    service.call(
      'meta_native_action',
      {
        action: 'meta_pixel_id_get',
        account_id: account,
        connection_id: connection,
        path_params: {pixel_id: '456'},
        query: {fields: 'id,name,is_unavailable'},
        ...input,
      },
      actor,
    );
  return {store, service, guard, requests, listed, read, stored};
}

test('after the account lists its pixels, the node read of a listed pixel sends one request and returns it', async t => {
  const f = fixture(t);
  f.listed();
  const out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(out.data.data, {id: '456', name: 'Store pixel 456', is_unavailable: false});
  assert.deepEqual(f.requests, [{method: 'GET', path: node, query: {fields: 'id,name,is_unavailable'}}]);
  // Each pinned field, singly and together (the order is the caller's).
  for (const names of [['id'], ['is_unavailable', 'id'], fields]) {
    const answered = await f.read({query: {fields: names.join(',')}});
    assert.equal(answered.success, true, names.join() + ': ' + JSON.stringify(answered.error));
    assert.deepEqual(Object.keys(answered.data.data), names);
  }
});

test('the same read before the list is refused with the measurement ledger as the one read that opens it, and sends nothing', async t => {
  const f = fixture(t),
    out = await f.read();
  assertRefused(out, 'RESOURCE_SCOPE_REQUIRED');
  assert.deepEqual(out.error.details.next_call, ledgerCall(login.a));
  assert.deepEqual(out.error.details.ownership_reads, [ledgerCall(login.a)]);
  assert.doesNotMatch(
    JSON.stringify(out.error.details),
    /meta_campaign_list|meta_adset_list|meta_ad_list|meta_creative_list/,
  );
  assert.match(out.error.next_action, /details\.next_call/);
  assert.equal(f.requests.length, 0);
});

test('the ledger the refusal names opens the node read, as the field workflow runs it', async t => {
  const f = fixture(t),
    refused = await f.read();
  assertRefused(refused, 'RESOURCE_SCOPE_REQUIRED');
  const next = refused.error.details.next_call,
    ledger = await f.service.call(next.tool, next.arguments, actor);
  assert.equal(ledger.success, true, JSON.stringify(ledger.error));
  assert.ok(f.requests.some(r => r.path === metaPrefix + 'act_123/adspixels'));
  const before = f.requests.length,
    out = await f.read();
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(f.requests.length, before + 1, 'the node read is one request');
});

test('a pixel another account listed, another login’s list, an unlisted pixel and an expired list do not open the node', async t => {
  // Another ad account of the same login listed it.
  const other = fixture(t, {accounts: ['123', '124']});
  other.listed('124');
  assertRefused(await other.read({}, login.a, '123'), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await other.read({}, login.a, '124')).success, true);
  // Another login of the same account listed it.
  const logins = fixture(t, {second: true});
  logins.listed('123', login.b);
  assertRefused(await logins.read({}, login.a), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await logins.read({}, login.b)).success, true);
  // The account listed another pixel.
  const unlisted = fixture(t, {pixels: [pixel('457')]});
  unlisted.listed();
  assertRefused(await unlisted.read(), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(unlisted.requests.length, 0);
  // The list is evidence for five minutes only.
  const expired = fixture(t);
  expired.listed();
  expired.store.db.prepare('UPDATE resource_ownership SET expires_at=?').run(Date.now() - 1);
  assertRefused(await expired.read(), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(expired.requests.length, 0);
});

test('a read of anything but the six pinned fields is refused with the allowed fields before any request, owned or not', async t => {
  const f = fixture(t);
  for (const owned of [false, true]) {
    if (owned) f.listed();
    for (const query of [
      {fields: 'creator'},
      {fields: 'id,creator'},
      {fields: 'automatic_matching_fields'},
      {fields: 'enable_automatic_matching'},
      {fields: 'data_use_setting'},
      {fields: 'code'},
      {fields: 'owner_business{id,name}'},
      {fields: 'owner_business{id}'},
      {fields: '*'},
      {fields: ''},
      {fields: 'id, name'},
      {fields: ['id', 'creator']},
      {fields: 'ID'},
      {},
      {fields: 'id', summary: 'true'},
      {fields: 'id', metadata: '1'},
    ]) {
      const out = await f.read({query});
      assertRefused(out, 'INVALID_ARGUMENT');
      assert.deepEqual(out.error.details.allowed_fields, fields, JSON.stringify(query) + ' owned ' + owned);
    }
  }
  assert.equal(f.requests.length, 0, 'none of them was sent');
});

test('the pixel’s edges and its other nodes stay refused after the list, with the same read as before', async t => {
  const f = fixture(t);
  f.listed();
  for (const action of [
    'meta_pixel_id_assigned_users_get',
    'meta_pixel_id_raw_fires_get',
    'meta_pixel_id_recent_events_get',
    'meta_pixel_id_shared_accounts_get',
    'meta_pixel_id_da_checks_get',
  ])
    assertRefused(await f.read({action, query: {fields: 'id'}}), 'RESOURCE_SCOPE_REQUIRED');
  // A node of another type is not a pixel: the read of an ad the account never listed is refused as it always was, naming the ads list.
  const ad = await f.read({action: 'meta_ad_id_get', path_params: {ad_id: '456'}, query: {fields: 'id,name'}});
  assertRefused(ad, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(ad.error.details.next_call.arguments.action, 'meta_ad_list');
  assert.equal(f.requests.length, 0);
});

test('a write to the node, and a request that only borrows the read’s name or shape, is not the read: the guard asks for ownership', async t => {
  const f = fixture(t),
    connection = f.stored(login.a),
    base = {
      gateway: 'meta_native_action',
      accountId: '123',
      action: 'meta_pixel_id_get',
      method: 'GET',
      path: node,
      query: {fields: 'id'},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'synthetic',
      warnings: [],
    };
  f.listed();
  assert.equal(f.guard.authorize(base, connection), '123');
  for (const [name, plan] of Object.entries({
    'a POST of another action to the node': {
      ...base,
      method: 'POST',
      readOnly: false,
      requiresConfirmation: true,
      action: 'native',
      body: {name: 'x'},
    },
    'the read action sent as a POST': {
      ...base,
      method: 'POST',
      readOnly: false,
      requiresConfirmation: true,
      body: {name: 'x'},
    },
    'a read that carries a body': {...base, body: {name: 'x'}},
    'a read that is not read-only': {...base, readOnly: false},
    'a special transport': {...base, specialTransport: 'upload'},
    'another origin': {...base, origin: 'https://example.com'},
    'a leading zero': {...base, path: metaPrefix + '0456'},
    'another action on the same path': {...base, action: 'meta_ad_id_get'},
  }))
    assert.throws(
      () => f.guard.authorize(plan, connection),
      error => assertRefused(error, 'RESOURCE_SCOPE_REQUIRED', {status: 403}),
      name,
    );
});
