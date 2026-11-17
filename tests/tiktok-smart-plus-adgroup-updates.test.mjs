import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Upgraded Smart+ ad group edits (API for Business v1.3, checked 2026-09-26). A bid change on one ad group changes the
 * bid of every ad group in the same campaign, which the fixture reproduces.
 */
const TIKTOK = '25252525-2525-4252-8252-252525252525',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-adgroup-updates', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 82).toString('base64');
const always = '1'.repeat(336),
  weekdays = '1'.repeat(48).repeat(5) + '0'.repeat(96);
const group = (id, campaign, extra = {}) => ({
  adgroup_id: id,
  campaign_id: campaign,
  adgroup_name: 'Group ' + id,
  operation_status: 'ENABLE',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CONVERT',
  bid_type: 'BID_TYPE_CUSTOM',
  conversion_bid_price: 12,
  budget_mode: 'BUDGET_MODE_INFINITE',
  schedule_type: 'SCHEDULE_START_END',
  schedule_start_time: '2026-09-01 00:00:00',
  schedule_end_time: '2026-12-31 00:00:00',
  dayparting: always,
  comment_disabled: false,
  share_disabled: false,
  targeting_spec: {location_ids: ['6252001']},
  placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
  ...extra,
});
function fixture({readBack} = {}) {
  const store = new Store(':memory:', key),
    connection = {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  const groups = {
    300: group('300', '80'),
    301: group('301', '80', {adgroup_name: 'Sibling'}),
    302: group('302', '81', {
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_end_time: undefined,
      bid_type: 'BID_TYPE_NO_BID',
      conversion_bid_price: undefined,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 100,
    }),
    303: group('303', '82', {
      optimization_goal: 'CLICK',
      conversion_bid_price: undefined,
      bid_price: 1.5,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 50,
      operation_status: 'DISABLE',
    }),
  };
  const requests = [],
    writes = [];
  let n = 0,
    mode = '';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(
      method + ' ' + path + (u.searchParams.get('filtering')?.includes('campaign_ids') ? ' (campaign)' : ''),
    );
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      const f = JSON.parse(u.searchParams.get('filtering')),
        rows = Object.values(groups)
          .filter(g => (f.adgroup_ids ? f.adgroup_ids.includes(g.adgroup_id) : f.campaign_ids.includes(g.campaign_id)))
          .map(g => (readBack && f.adgroup_ids ? readBack(structuredClone(g)) : structuredClone(g)));
      return ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const {advertiser_id, adgroup_id, ...changes} = b,
        g = groups[adgroup_id];
      Object.assign(g, changes);
      // As documented, a bid change applies to every ad group in the campaign.
      for (const k of ['conversion_bid_price', 'bid_price'])
        if (changes[k] !== undefined)
          for (const other of Object.values(groups)) if (other.campaign_id === g.campaign_id) other[k] = changes[k];
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Bid is lower than the minimum', request_id: 'r' + ++n, data: {}})
        : ok(structuredClone(g));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = (payload, action = 'tiktok_smart_plus_adgroup_update') => ({action, account_id: account, payload});
  const prepare = (payload, action) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    groups,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    mode: v => {
      mode = v;
    },
    restart: () => {
      service = start();
    },
  };
}

test('Smart+ ad group edits are a reviewed TikTok family under both action names', async () => {
  const f = fixture();
  try {
    for (const action of ['tiktok_smart_plus_adgroup_update', 'tiktok_smart_adset_update']) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args({adgroup_id: '300', adgroup_name: 'Renamed'}, action),
      });
      assert.equal(r.data.review_contract_supported, true, action + ' ' + JSON.stringify(r));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only documented name, schedule, dayparting, comment, share and bid edits are accepted, before any request', async () => {
  const f = fixture();
  try {
    const g = extra => ({adgroup_id: '300', ...extra});
    const cases = {
      'nothing to change': [g(), 'adgroup_name'],
      'budget': [g({budget: 200}), 'budget'],
      'targeting': [g({targeting_spec: {location_ids: ['6252001']}}), 'targeting_spec'],
      'status': [g({operation_status: 'DISABLE'}), 'operation_status'],
      'long name': [g({adgroup_name: 'x'.repeat(513)}), 'adgroup_name'],
      'ISO end time': [g({schedule_end_time: '2026-12-31T00:00:00Z'}), 'schedule_end_time'],
      'end after 2038': [g({schedule_end_time: '2038-06-01 00:00:00'}), 'schedule_end_time'],
      'short dayparting': [g({dayparting: '1'.repeat(48)}), 'dayparting'],
      'text comment toggle': [g({comment_disabled: 'true'}), 'comment_disabled'],
      'two bid fields': [g({conversion_bid_price: 10, bid_price: 1}), 'bid_price'],
      'zero bid': [g({conversion_bid_price: 0}), 'conversion_bid_price'],
      'three decimals': [g({conversion_bid_price: 10.005}), 'conversion_bid_price'],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.equal(
      (await f.prepare({advertiser_id: '999', adgroup_id: '300', adgroup_name: 'x'})).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a rename and comment setting need no spending confirmation, read only the ad group and verify', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({adgroup_id: '300', adgroup_name: 'Web CBO Q4', comment_disabled: true});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(p.data.creative_impact.changes.comment_disabled, {before: false, after: true});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(
      f.requests.filter(r => r.startsWith('GET')),
      ['GET /v1.3/smart_plus/adgroup/get/', 'GET /v1.3/smart_plus/adgroup/get/'],
    );
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('a bid edit reads the campaign ad groups, shows every bid it changes and needs spending confirmation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({adgroup_id: '300', conversion_bid_price: 15});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.ok(f.requests.includes('GET /v1.3/smart_plus/adgroup/get/ (campaign)'), 'campaign ad groups read');
    assert.deepEqual(p.data.creative_impact.campaign_bid_changes, [
      {adgroup_id: '301', adgroup_name: 'Sibling', conversion_bid_price: {before: 12, after: 15}},
    ]);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.writes.length, 0);
    assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).success, true);
    assert.equal(f.groups[301].conversion_bid_price, 15, 'the sibling moved with it');
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    const alone = await f.prepare({adgroup_id: '303', bid_price: 2});
    assert.equal(alone.success, true, JSON.stringify(alone));
    assert.deepEqual(alone.data.creative_impact.campaign_bid_changes, []);
  } finally {
    f.store.close();
  }
});

test('end time and dayparting edits need spending confirmation and a schedule they apply to', async () => {
  const f = fixture();
  try {
    const p = await f.prepare({adgroup_id: '300', schedule_end_time: '2030-01-31 00:00:00', dayparting: weekdays});
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    for (const [payload, message] of [
      [{adgroup_id: '302', schedule_end_time: '2030-01-31 00:00:00'}, /runs continuously/],
      [{adgroup_id: '300', schedule_end_time: '2020-01-31 00:00:00'}, /in the future/],
    ]) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', JSON.stringify(r.error));
      assert.match(r.error.message, message);
    }
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('bids that the ad group cannot take are refused before any write', async () => {
  const f = fixture();
  try {
    for (const [payload, message] of [
      [{adgroup_id: '302', conversion_bid_price: 15}, /BID_TYPE_NO_BID/],
      [{adgroup_id: '303', conversion_bid_price: 15}, /applies only to a custom bid with CONVERT/],
      [{adgroup_id: '303', bid_price: 60}, /lower than the ad group budget \(50\)/],
      [{adgroup_id: '399', adgroup_name: 'Missing'}, /./],
    ]) {
      const r = await f.prepare(payload);
      assert.ok(
        ['INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE', 'STATE_TARGET_MISMATCH'].includes(r.error?.code),
        JSON.stringify(r.error),
      );
      assert.match(r.error.message, message);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a drifted read-back is inconclusive; rejected or lost edits are never resubmitted; concurrent executions submit once', async () => {
  const d = fixture({readBack: g => (g.adgroup_name === 'Web Q4' ? {...g, adgroup_name: 'Web q4'} : g)});
  try {
    const p = await d.prepare({adgroup_id: '300', adgroup_name: 'Web Q4'});
    await d.execute(p.data.review_id);
    const v = await d.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/adgroup_name']);
  } finally {
    d.store.close();
  }
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare({adgroup_id: '300', conversion_bid_price: 14});
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id, {spend_change_confirmed: true})).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare({adgroup_id: '300', adgroup_name: 'Parallel'});
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});
