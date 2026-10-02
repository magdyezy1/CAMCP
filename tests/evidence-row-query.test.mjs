import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

function fixture(t, count = 151) {
  const actor = {tenantId: 'row-query', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 107).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'row-query-login',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const rows = Array.from({length: count}, (_, i) => ({
    entity_id: String(9007199254740993n + BigInt(i)),
    entity_name: i % 2 ? 'بيت الرياض' : 'Home <img> ' + i,
    date: i % 2 ? '2026-09-02' : '2026-09-01',
    search_term: i % 2 ? 'سفر' : 'Mixed CASE',
    spend: '9007199254.740993',
    clicks: '0',
    conversions: null,
  }));
  const report = {
    gateway: connection.gateway,
    account_id: '123',
    connection_id: connection.id,
    source: 'provider_read',
    source_hash: 'a'.repeat(64),
    semantics: {currency: 'USD', timezone: 'UTC', source_name: 'Full report'},
    mapping: {entity_id: '/id', entity_name: '/name', date: '/day', search_term: '/term', spend: '/amount'},
    totals: {spend: '1355583487465.890943', conversions: null},
    rows,
    source_request: {query: 'PRIVATE-CANARY'},
    captured_at: 1,
  };
  store.putDocument(actor.tenantId, 'decision_report', 'report', report);
  let egress = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      egress++;
      throw Error('Retained row search must not collect');
    }),
  );
  return {
    actor,
    store,
    connection,
    report,
    rows,
    egress: () => egress,
    call: (args, who = actor) => service.call('amcp_reporting', {action: 'get', id: 'report', ...args}, who),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('retained row search filters before pagination and preserves exact native values, original totals and source identity', async t => {
  const f = fixture(t),
    before = f.store.document(f.actor.tenantId, 'decision_report', 'report');
  const first = ok(await f.call({row_query: ' hOmE ', offset: 0, limit: 50}));
  assert.equal(first.row_count, 151);
  assert.equal(first.matched_row_count, 76);
  assert.equal(first.row_query, 'hOmE');
  assert.equal(first.has_more, true);
  assert.equal(first.rows[1].entity_id, f.rows[2].entity_id);
  assert.equal(first.rows[0].spend, '9007199254.740993');
  assert.equal(first.rows[0].conversions, null);
  const last = ok(await f.call({row_query: 'hOmE', offset: 50, limit: 50}));
  assert.equal(last.rows.length, 26);
  assert.equal(last.rows.at(-1).entity_id, f.rows[150].entity_id);
  assert.equal(last.has_more, false);
  assert.deepEqual(first.totals, f.report.totals);
  assert.equal(first.source_hash, f.report.source_hash);
  assert.equal(first.xlsx_path, '/api/reporting-evidence/report.xlsx');
  assert.deepEqual(f.store.document(f.actor.tenantId, 'decision_report', 'report'), before);
  assert.equal(f.egress(), 0);
});
test('retained search matches Arabic, exact large IDs, dates and literal terms without searching metrics or source metadata', async t => {
  const f = fixture(t);
  for (const [query, count] of [
    ['الرياض', 75],
    ['9007199254741143', 1],
    ['2026-09-02', 75],
    ['mixed case', 76],
    ['<img>', 76],
    ['.*', 0],
    ['PRIVATE-CANARY', 0],
    ['9007199254.740993', 0],
  ]) {
    const out = ok(await f.call({row_query: query}));
    assert.equal(out.matched_row_count, count, query);
    assert.equal(out.row_count, 151);
  }
  const none = ok(await f.call({row_query: 'no match'}));
  assert.equal(none.rows.length, 0);
  assert.equal(none.has_more, false);
  assert.deepEqual(none.totals, f.report.totals);
  const clear = ok(await f.call({row_query: '   '}));
  assert.equal(clear.row_query, '');
  assert.equal(clear.matched_row_count, 151);
  assert.equal(clear.rows.length, 50);
});
test('retained row search validates bounded plain text, original account access and tenant before returning matches', async t => {
  const f = fixture(t);
  for (const query of [null, {}, 42, 'x'.repeat(151), 'home\nprivate'])
    assert.equal((await f.call({row_query: query})).success, false);
  assert.equal((await f.call({action: 'capture', row_query: 'home'})).success, false);
  assert.equal((await f.call({row_query: 'home'}, {...f.actor, tenantId: 'different-tenant'})).success, false);
  f.store.putConnection(f.actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
  const revoked = await f.call({row_query: 'home'});
  assert.equal(revoked.success, false);
  assert.equal(revoked.data, undefined);
  assert.equal(f.egress(), 0);
});
test('retained row search scans the bounded full report before slicing and unfiltered reads retain original paging', async t => {
  const f = fixture(t, 10000),
    id = f.rows.at(-1).entity_id;
  const last = ok(await f.call({row_query: id}));
  assert.equal(last.row_count, 10000);
  assert.equal(last.matched_row_count, 1);
  assert.equal(last.rows[0].entity_id, id);
  const page = ok(await f.call({offset: 9950, limit: 50}));
  assert.equal(page.matched_row_count, 10000);
  assert.equal(page.rows.length, 50);
  assert.equal(page.rows.at(-1).entity_id, id);
  assert.equal(page.has_more, false);
});
