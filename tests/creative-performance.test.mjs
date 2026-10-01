import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
const actor = {tenantId: 'creative-performance', userId: 'operator', role: 'operator'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 74).toString('base64'));
  const connection = {
    id: 'meta',
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100', '200'],
    writeAccounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const scope = {gateway: 'meta_native_action', account_id: '100', connection_id: 'meta'},
    put = (kind, id, d) => store.putDocument(actor.tenantId, kind, id, d);
  put('workspace_asset', 'asset', {
    platform: 'meta',
    account_id: '100',
    connection_id: 'meta',
    media_id: 'hash',
    name: 'Synthetic image',
  });
  const steps = [
    {
      ...scope,
      id: 'image',
      kind: 'media',
      arguments: {platform: 'meta'},
      status: 'verified',
      review_id: 'asset',
      result: {media_id: 'hash'},
    },
    {
      ...scope,
      id: 'creative',
      kind: 'write',
      arguments: {action: 'meta_creative_create', payload: {image_hash: {$ref: 'image#/image_hash'}}},
      status: 'verified',
      result: {created_id: '20'},
    },
    {
      ...scope,
      id: 'ad',
      kind: 'write',
      arguments: {action: 'meta_ad_create', payload: {creative_id: {$ref: 'creative#/data/id'}}},
      status: 'verified',
      result: {created_id: '30'},
    },
    {
      ...scope,
      id: 'unrelated',
      kind: 'write',
      arguments: {action: 'meta_ad_create'},
      depends_on: ['creative'],
      status: 'verified',
      result: {created_id: '31'},
    },
  ];
  put('campaign_run', 'plan', {user_id: actor.userId, name: 'Original launch', steps});
  const report = {
    ...scope,
    preset: 'meta_ad',
    grain: 'ad × day',
    source: 'provider_read',
    source_hash: 'source-hash',
    captured_at: Date.now(),
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      conversion_definition: 'offsite_conversion.fb_pixel_purchase',
      attribution: 'Meta 7d_click; impression time',
      complete: true,
      source_name: 'Synthetic ad performance',
    },
    rows: [
      {entity_id: '30', entity_name: 'Linked ad', date: '2026-09-01', spend: '12.5', clicks: '10', conversions: null},
      {entity_id: '31', date: '2026-09-01', spend: '999'},
    ],
  };
  put('decision_report', 'report', report);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider call in retained performance join');
    }),
  );
  return {store, connection, put, steps, report, call: (args, as = actor) => service.call('amcp_media', args, as)};
}
test('creative performance joins only verified ad IDs in an exact plan and retains measurement provenance', async () => {
  const f = fixture();
  try {
    const choices = await f.call({action: 'asset_performance', asset_id: 'asset'});
    assert.equal(choices.success, true, JSON.stringify(choices));
    assert.deepEqual(
      choices.data.reports.map(r => r.id),
      ['report'],
    );
    assert.ok(!('rows' in choices.data.reports[0]));
    const out = await f.call({action: 'asset_performance', asset_id: 'asset', plan_id: 'plan', report_id: 'report'});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.rows.length, 1);
    assert.equal(out.data.rows[0].entity_id, '30');
    assert.equal(out.data.rows[0].spend, '12.5');
    assert.equal(out.data.rows[0].conversions, null);
    assert.equal(out.data.source_hash, 'source-hash');
    assert.equal(out.data.network_requests, 0);
    assert.equal(out.data.historical_creative_assignment, 'not_established');
    assert.match(out.data.limitations.join(' '), /entire reporting window/);
    assert.equal(out.data.semantics.currency, 'USD');
  } finally {
    f.store.close();
  }
});
test('performance rejects other account/login/grain, unverified usage, foreign plans and current revocation', async () => {
  const f = fixture();
  const args = {action: 'asset_performance', asset_id: 'asset', plan_id: 'plan', report_id: 'report'};
  try {
    for (const override of [
      {account_id: '200'},
      {connection_id: 'other'},
      {preset: 'meta_campaign'},
      {source: 'manual'},
      {grain: 'campaign × day'},
    ]) {
      f.put('decision_report', 'report', {...f.report, ...override});
      assert.equal((await f.call(args)).success, false);
    }
    f.put('decision_report', 'report', f.report);
    f.put('campaign_run', 'plan', {user_id: 'someone-else', name: 'Foreign', steps: f.steps});
    assert.equal((await f.call(args)).success, false);
    f.put('campaign_run', 'plan', {
      user_id: actor.userId,
      name: 'Unverified',
      steps: f.steps.map(s => ({...s, status: s.id === 'ad' ? 'uncertain' : s.status})),
    });
    assert.equal((await f.call(args)).success, false);
    f.put('campaign_run', 'plan', {user_id: actor.userId, name: 'Original', steps: f.steps});
    f.store.putConnection(
      {...actor, role: 'admin'},
      {...f.connection, accounts: ['200'], writeAccounts: []},
      {accessToken: 'synthetic'},
    );
    assert.equal((await f.call(args)).success, false);
    assert.equal((await f.call({action: 'asset_performance', asset_id: 'asset'})).success, false);
  } finally {
    f.store.close();
  }
});
test('performance report choices and daily rows page with current scope and stable metadata', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 34; i++)
      f.put('decision_report', 'a-' + String(i).padStart(2, '0'), {
        ...f.report,
        rows: [...f.report.rows, {entity_id: '30', date: '2026-09-02', spend: '3'}],
      });
    const args = {action: 'asset_performance', asset_id: 'asset'};
    const first = (await f.call({...args, limit: 10})).data;
    assert.equal(first.reports.length, 10);
    assert.ok(first.next_cursor);
    const next = (await f.call({...args, limit: 10, cursor: first.next_cursor})).data;
    assert.equal(next.reports.length, 10);
    assert.notEqual(first.reports[0].id, next.reports[0].id);
    assert.equal((await f.call({...args, cursor: first.next_cursor}, {...actor, userId: 'another'})).success, false);
    const joined = {...args, plan_id: 'plan', report_id: 'a-00', limit: 1};
    const page = (await f.call(joined)).data;
    assert.equal(page.rows.length, 1);
    assert.equal(page.next_offset, 1);
    assert.equal((await f.call({...joined, offset: page.next_offset})).data.rows[0].date, '2026-09-02');
  } finally {
    f.store.close();
  }
});
