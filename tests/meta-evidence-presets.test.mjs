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
  let response = {data: rows},
    edit = (_u, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests.push({url: String(url), method: init.method});
      const u = new URL(url);
      const data = u.pathname.endsWith('/insights')
        ? structuredClone(response)
        : {id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC', private: 'PRIVATE-BILLING'};
      return Response.json(edit(u, data, requests.length));
    }),
  );
  return {
    store,
    requests,
    connection,
    edit: fn => {
      edit = fn;
    },
    call: (args = input) => service.call('amcp_reporting', args, actor),
    respond: v => {
      response = v;
    },
  };
}
test('Meta detailed preset retains exact ad IDs and explicit action/window semantics without adding overlapping actions', async () => {
  const f = fixture([
    nativeRow(),
    nativeRow({ad_id: '31', actions: [], action_values: []}),
    nativeRow({ad_id: '32', impressions: '0', actions: [], action_values: []}),
  ]);
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.rows[0].entity_id, '30');
    assert.equal(out.data.rows[0].conversions, '2');
    assert.equal(out.data.rows[0].conversion_value, '42.51');
    // RPT-04 (owner policy P6): a delivered row without the selected action counts 0 with the qualifier; this test
    // previously expected null, which is the defect RPT-04 fixes. A row without delivery stays unknown.
    assert.equal(out.data.rows[1].conversions, '0');
    assert.deepEqual(out.data.rows[1].omitted_as_zero, ['conversions', 'conversion_value']);
    assert.equal(out.data.rows[2].conversions, null);
    assert.equal(out.data.coverage.conversions, 'partial');
    assert.deepEqual(out.data.omitted_as_zero, {conversions: 1, conversion_value: 1});
    assert.equal(out.data.totals.spend, '30.375');
    assert.equal(out.data.totals.conversions, null);
    assert.equal(out.data.totals.reach, null);
    assert.equal(out.data.grain, 'ad × day');
    assert.match(out.data.semantics.attribution, /7d_click.*1d_view.*impression/);
    assert.equal(out.data.semantics.conversion_definition, input.result_action_type);
    assert.ok(f.requests.every(r => r.method === 'GET'));
    const q = new URL(f.requests.find(r => new URL(r.url).pathname.endsWith('/insights')).url).searchParams;
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

test('Meta guided evidence verifies account settings before and after complete pages and retains bounded source lineage', async t => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const f = fixture();
    t.after(() => f.store.close());
    const out = await f.call({...input, preset: 'meta_' + level});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.native_account_evidence.checks.length, 2);
    assert.equal(out.data.native_account_evidence.timezone, 'UTC');
    assert.equal(out.data.source_collection, 'meta_insights_pages');
    assert.equal(out.data.source_pages.length, 1);
    assert.equal(out.data.source_pages[0].row_count, 1);
    assert.match(out.data.source_pages[0].source_hash, /^[a-f0-9]{64}$/);
    assert.equal(out.data.collection_usage.requests, 3);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE|accessToken/);
    assert.deepEqual(
      f.requests.map(r => new URL(r.url).pathname),
      ['/v26.0/act_100', '/v26.0/act_100/insights', '/v26.0/act_100'],
    );
    assert.equal(new URL(f.requests[0].url).searchParams.get('fields'), 'id,account_id,currency,timezone_name');
  }
});

test('Meta guided evidence rejects account identity, currency or timezone mismatch even when report rows are empty', async t => {
  for (const n of [1, 3])
    for (const change of [
      {id: 'act_999'},
      {account_id: '999'},
      {currency: 'EUR'},
      {timezone_name: 'Europe/Paris'},
      {timezone_name: null},
    ]) {
      const f = fixture([]);
      t.after(() => f.store.close());
      f.edit((_u, d, count) => {
        if (count === n) Object.assign(d, change);
        return d;
      });
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(change));
      assert.equal(f.requests.length, n);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    }
});

test('Meta guided capture binds every account and page read to unchanged login, scopes and grants', async t => {
  for (const n of [1, 2, 3])
    for (const change of ['disable', 'credentials', 'scopes']) {
      const f = fixture();
      t.after(() => f.store.close());
      f.edit((_u, d, count) => {
        if (count === n)
          f.store.putConnection(
            actor,
            {
              ...f.connection,
              ...(change === 'disable' ? {enabled: false} : {}),
              ...(change === 'scopes' ? {scopes: ['changed']} : {}),
            },
            change === 'credentials' ? {accessToken: 'different'} : {accessToken: 'synthetic'},
          );
        return d;
      });
      const out = await f.call();
      assert.equal(out.success, false);
      assert.equal(f.requests.length, n);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    }
});

test('Meta guided pagination keeps its original account and query, records empty intermediate pages and ignores link credentials', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.edit((u, d) => {
    if (!u.pathname.endsWith('/insights')) return d;
    const cursor = u.searchParams.get('after');
    if (!cursor)
      return {
        data: [nativeRow()],
        paging: {
          cursors: {after: 'first'},
          next: 'https://graph.facebook.com/v26.0/act_100/insights?after=first&access_token=PRIVATE-TOKEN&fields=wrong',
        },
      };
    if (cursor === 'first')
      return {
        data: [],
        paging: {cursors: {after: 'second'}, next: 'https://graph.facebook.com/v26.0/act_100/insights?after=second'},
      };
    return {data: [nativeRow({ad_id: '31'})], paging: {cursors: {after: 'last'}}};
  });
  const out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(out.data.row_count, 2);
  assert.deepEqual(
    out.data.source_pages.map(p => p.row_count),
    [1, 0, 1],
  );
  assert.equal(f.requests.length, 5);
  const queries = f.requests
    .filter(r => new URL(r.url).pathname.endsWith('/insights'))
    .map(r => new URL(r.url).searchParams);
  for (const q of queries) {
    assert.equal(q.get('level'), 'ad');
    assert.equal(q.get('time_increment'), '1');
    assert.notEqual(q.get('fields'), 'wrong');
    assert.equal(q.get('access_token'), null);
  }
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-TOKEN/);
});

test('Meta guided pagination refuses foreign routes, malformed cursors, repeated tokens and unknown completion', async t => {
  for (const paging of [
    null,
    {},
    {next: 'https://example.invalid/insights', cursors: {after: 'a'}},
    {next: 'https://graph.facebook.com/v26.0/act_999/insights?after=a', cursors: {after: 'a'}},
    {next: 'https://graph.facebook.com/v26.0/act_100/insights?after=b', cursors: {after: 'a'}},
    {next: 'https://graph.facebook.com/v26.0/act_100/insights?after=a', cursors: {after: 1}},
    {next: 'https://graph.facebook.com/v26.0/act_100/insights?after=a', cursors: {after: 'a'}},
  ]) {
    const f = fixture();
    t.after(() => f.store.close());
    f.edit((u, d, n) => (u.pathname.endsWith('/insights') ? {data: [nativeRow({ad_id: String(n)})], paging} : d));
    const out = await f.call();
    if (paging && !Object.keys(paging).length) {
      assert.equal(out.success, true, JSON.stringify(out));
      continue;
    }
    assert.equal(out.success, false);
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
  }
  for (const extra of [{has_more: true}, {next_cursor: 'unknown'}, {truncated: true}, {error: {message: 'bad'}}]) {
    const f = fixture();
    t.after(() => f.store.close());
    f.edit((u, d) => (u.pathname.endsWith('/insights') ? {...d, ...extra} : d));
    assert.equal((await f.call()).success, false);
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
  }
});

test('Meta guided rows require their full selected parent chain and cannot change parent within one report', async t => {
  for (const rows of [
    [nativeRow({campaign_id: undefined})],
    [nativeRow({adset_id: undefined})],
    [nativeRow({campaign_id: 1})],
    [nativeRow(), nativeRow({date_start: '2026-09-02', date_stop: '2026-09-02', campaign_id: '11'})],
    [nativeRow(), nativeRow({date_start: '2026-09-02', date_stop: '2026-09-02', adset_id: '21'})],
  ]) {
    const f = fixture(rows);
    t.after(() => f.store.close());
    const out = await f.call();
    assert.equal(out.success, false);
    assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
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

test('Meta guided evidence retains the full 10000-row boundary and refuses a still-open 100th page', async t => {
  for (const total of [10000, 10100]) {
    const f = fixture([]);
    t.after(() => f.store.close());
    f.edit((u, d) => {
      if (!u.pathname.endsWith('/insights')) return d;
      const start = Number(u.searchParams.get('after') ?? '0');
      return {
        data: Array.from({length: 100}, (_, i) => nativeRow({ad_id: String(start + i + 1)})),
        ...(start + 100 < total
          ? {
              paging: {
                cursors: {after: String(start + 100)},
                next: 'https://graph.facebook.com/v26.0/act_100/insights?after=' + String(start + 100),
              },
            }
          : {}),
      };
    });
    const out = await f.call();
    if (total === 10000) {
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.row_count, 10000);
      assert.equal(out.data.source_pages.length, 100);
      assert.equal(out.data.collection_usage.requests, 102);
      assert.equal(out.data.totals.spend, '101250');
      const last = await f.call({action: 'get', id: out.data.id, offset: 9950, limit: 50});
      assert.equal(last.data.rows.at(-1).entity_id, '10000');
      assert.equal(last.data.has_more, false);
    } else {
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'REPORT_COLLECTION_LIMIT');
      assert.equal(f.requests.length, 101);
      assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
    }
  }
});
