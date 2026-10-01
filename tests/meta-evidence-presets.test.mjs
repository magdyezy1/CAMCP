import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {reportPreset} from '../dist/src/report-presets.js';
import {readFileSync} from 'node:fs';
const actor = {tenantId: 'meta-evidence', userId: 'owner', role: 'admin'};
test('guided Meta fields and query parameters match the pinned official Insights SDK model and GET method', () => {
  const read = JSON.parse(readFileSync('tests/fixtures/meta-website-recipe-sdk-v26.json', 'utf8')).insights_read;
  const model = JSON.parse(readFileSync('tests/fixtures/meta-insights-sdk-v26.json', 'utf8')).models.adsinsights;
  assert.equal(read.method, 'GET');
  assert.equal(read.edge, '/insights');
  for (const level of ['campaign', 'adset', 'ad']) {
    const query = reportPreset({...input, preset: 'meta_' + level}).arguments.query;
    for (const k of Object.keys(query)) assert.ok(k in read.params, k);
    for (const k of query.fields.split(',')) assert.ok(k in model, k);
  }
});
const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
const input = {
  action: 'capture_preset',
  preset: 'meta_ad',
  account_id: '100',
  connection_id: connectionId,
  result_action_type: 'offsite_conversion.fb_pixel_purchase',
  attribution_windows: ['7d_click', '1d_view'],
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    source_name: 'Synthetic ad evidence',
    complete: true,
  },
};
const nativeRow = (extra = {}) => ({
  account_id: '100',
  account_currency: 'USD',
  campaign_id: '10',
  adset_id: '20',
  ad_id: '30',
  ad_name: 'Ad A',
  date_start: '2026-09-01',
  date_stop: '2026-09-01',
  spend: '10.125',
  impressions: '100',
  clicks: '12',
  reach: '80',
  frequency: '1.25',
  actions: [
    {action_type: 'purchase', value: '999'},
    {action_type: 'offsite_conversion.fb_pixel_purchase', value: '2'},
  ],
  action_values: [{action_type: 'offsite_conversion.fb_pixel_purchase', value: '42.51'}],
  ...extra,
});
function fixture(rows = [nativeRow()]) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64')),
    requests = [];
  const connection = {
    id: connectionId,
    tenantId: actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['ads_read'],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  let response = {data: rows};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init.method});
      return Response.json(response);
    }),
  );
  return {
    store,
    requests,
    connection,
    call: (args = input) => service.call('amcp_reporting', args, actor),
    respond: v => {
      response = v;
    },
  };
}
test('Meta detailed preset retains exact ad IDs and explicit action/window semantics without adding overlapping actions', async () => {
  const f = fixture([nativeRow(), nativeRow({ad_id: '31', actions: [], action_values: []})]);
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.rows[0].entity_id, '30');
    assert.equal(out.data.rows[0].conversions, '2');
    assert.equal(out.data.rows[0].conversion_value, '42.51');
    assert.equal(out.data.rows[1].conversions, null);
    assert.equal(out.data.totals.spend, '20.25');
    assert.equal(out.data.totals.conversions, null);
    assert.equal(out.data.totals.reach, null);
    assert.equal(out.data.grain, 'ad × day');
    assert.match(out.data.semantics.attribution, /7d_click.*1d_view.*impression/);
    assert.equal(out.data.semantics.conversion_definition, input.result_action_type);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    const q = new URL(f.requests[0].url).searchParams;
    assert.equal(q.get('level'), 'ad');
    assert.equal(q.get('time_increment'), '1');
    assert.equal(q.get('action_report_time'), 'impression');
    assert.equal(q.get('use_unified_attribution_setting'), 'false');
    assert.equal(q.get('use_account_attribution_setting'), 'false');
    const saved = await f.call({action: 'get', id: out.data.id});
    assert.equal(saved.data.preset, 'meta_ad');
  } finally {
    f.store.close();
  }
});
test('Meta presets refuse mismatched scope/currency/dates, duplicate grain, ambiguous actions and partial reads without retaining evidence', async () => {
  for (const rows of [
    [nativeRow({account_id: '999'})],
    [nativeRow({account_currency: 'SAR'})],
    [nativeRow({date_start: '2026-08-31'})],
    [nativeRow({date_stop: '2026-09-02'})],
    [nativeRow({ad_id: undefined})],
    [nativeRow(), nativeRow()],
    [nativeRow({actions: [...nativeRow().actions, {action_type: input.result_action_type, value: '3'}]})],
  ]) {
    const f = fixture(rows);
    try {
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.respond({data: [nativeRow()], paging: {next: 'https://graph.facebook.com/v26.0/act_100/insights?after=same'}});
    const out = await f.call();
    assert.equal(out.success, false);
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
  } finally {
    f.store.close();
  }
});
test('Meta presets validate measurement inputs before egress and preserve current revocation', async () => {
  const f = fixture();
  try {
    for (const bad of [
      {result_action_type: undefined},
      {result_action_type: 'purchase/other'},
      {attribution_windows: []},
      {attribution_windows: ['28d_click']},
      {attribution_windows: ['1d_click', '7d_click']},
    ]) {
      const out = await f.call({...input, ...bad});
      assert.equal(out.success, false);
    }
    assert.equal(f.requests.length, 0);
    f.store.putConnection(actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 0);
    for (const level of ['campaign', 'adset', 'ad'])
      assert.equal(reportPreset({...input, preset: 'meta_' + level}).arguments.query.level, level);
  } finally {
    f.store.close();
  }
});
