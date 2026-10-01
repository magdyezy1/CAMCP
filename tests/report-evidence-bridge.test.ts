import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import type {Actor, JsonObject} from '../src/types.js';
const actor: Actor = {tenantId: 'evidence-bridge', userId: 'owner', role: 'admin'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100', '200'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_read'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('Bridge must not collect again');
    }),
  );
  const sources = ['100', '200'].map(account_id => ({platform: 'meta', connection_id: 'meta', account_id}));
  const config = {name: 'September', sources, date_range: {since: '2026-09-01', until: '2026-09-30'}};
  const row = (id: string, account_id = '100', currency = 'USD', definition = 'Purchases') => ({
    row_key: id,
    campaign_id: id,
    campaign_name: 'Campaign ' + id,
    platform: 'meta',
    account_id,
    connection_id: 'meta',
    currency,
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-30',
    attribution: '7-day click',
    result_definition: definition,
    complete: true,
    captured_at: Date.parse('2026-09-30T00:00:00Z'),
    metrics: {spend: '10.01', impressions: 100, clicks: 10, conversions: null, reach: 80},
    query_fingerprint: 'query-' + id,
  });
  const snapshot = {
    state: 'complete',
    config,
    rows: [row('a'), row('b'), row('c', '200', 'SAR'), row('d', '100', 'USD', 'Leads')],
    created_at: 1,
  };
  store.putDocument(actor.tenantId, 'overview_report', 'snapshot', snapshot);
  return {store, service, config, snapshot, connection};
}
test('Overview evidence splits currencies, accounts and conversion definitions and retains original freshness', async () => {
  const f = fixture();
  try {
    const choices = await f.service.call('amcp_reporting', {action: 'overview_sources', id: 'snapshot'}, actor);
    assert.equal(choices.success, true, JSON.stringify(choices));
    assert.equal(choices.data.groups.length, 3);
    const group = choices.data.groups.find((g: JsonObject) => g.row_count === 2);
    const capture = await f.service.call(
      'amcp_reporting',
      {action: 'capture_overview', id: 'snapshot', group_id: group.id},
      actor,
    );
    assert.equal(capture.success, true, JSON.stringify(capture));
    assert.equal(capture.data.totals.spend, '20.02');
    assert.equal(capture.data.totals.conversions, null);
    assert.equal(capture.data.totals.reach, null);
    assert.equal(capture.data.captured_at, Date.parse('2026-09-30T00:00:00Z'));
    assert.equal(capture.data.source_lineage.overview_id, 'snapshot');
    assert.deepEqual(capture.data.source_lineage.row_keys, ['a', 'b']);
    const repeated = await f.service.call(
      'amcp_reporting',
      {action: 'capture_overview', id: 'snapshot', group_id: group.id},
      actor,
    );
    assert.equal(repeated.data.id, capture.data.id);
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 1);
  } finally {
    f.store.close();
  }
});
test('revoked accounts, foreign tenants and an unselected evidence group cannot disclose or capture snapshots', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.service.call('amcp_reporting', {action: 'capture_overview', id: 'snapshot', group_id: 'unknown'}, actor))
        .success,
      false,
    );
    assert.equal(
      (
        await f.service.call(
          'amcp_reporting',
          {action: 'overview_sources', id: 'snapshot'},
          {...actor, tenantId: 'other'},
        )
      ).success,
      false,
    );
    f.store.putConnection(actor, {...f.connection, accounts: ['100']}, {accessToken: 'synthetic'});
    assert.equal(
      (await f.service.call('amcp_reporting', {action: 'overview_sources', id: 'snapshot'}, actor)).success,
      false,
    );
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
  } finally {
    f.store.close();
  }
});
test('snapshot pagination reaches older than 200 records without returning rows or private checkpoints', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 219; i++)
      f.store.putDocument(actor.tenantId, 'overview_report', 'record-' + i, {
        ...f.snapshot,
        created_at: i + 2,
        checkpoints: {secret: 'withheld'},
      });
    const overview = new ReportingOverview(f.service),
      ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await overview.handle({action: 'list', offset, limit: 40}, actor);
      ids.push(...page.reports.map((r: JsonObject) => r.id));
      assert.ok(page.reports.every((r: JsonObject) => !('rows' in r) && !('checkpoints' in r) && r.row_count === 4));
      offset = page.next_offset;
    }
    assert.equal(ids.length, 220);
    assert.equal(new Set(ids).size, 220);
    assert.equal(ids.at(-1), 'snapshot');
  } finally {
    f.store.close();
  }
});
