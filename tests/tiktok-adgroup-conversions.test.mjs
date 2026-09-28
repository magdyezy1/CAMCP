import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * TikTok ad groups that optimize for a pixel custom conversion (API for Business v1.3 "Create an ad group",
 * checked 2026-09-26): the conversion must belong to the ad group's pixel, share its optimization_event, and be
 * ACTIVE or NO_RECENT_ACTIVITY. "Update an ad group" does not accept custom_conversion_id.
 */
const TIKTOK = '15151515-1515-4151-8151-151515151515',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-adgroup-conversions', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 72).toString('base64');
const adgroup = (extra = {}) => ({
  campaign_id: '70',
  adgroup_name: 'Signup conversions',
  promotion_type: 'WEBSITE',
  placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
  location_ids: ['6252001'],
  budget_mode: 'BUDGET_MODE_DAY',
  budget: 50,
  schedule_type: 'SCHEDULE_FROM_NOW',
  schedule_start_time: '2026-10-01 00:00:00',
  optimization_goal: 'CONVERT',
  pixel_id: '7001',
  optimization_event: 'ON_WEB_REGISTER',
  custom_conversion_id: '8800001',
  billing_event: 'OCPM',
  bid_type: 'BID_TYPE_NO_BID',
  operation_status: 'DISABLE',
  ...extra,
});
function fixture() {
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
  const conversions = new Map([
    [
      '8800001',
      {
        custom_conversion_id: '8800001',
        name: 'Signup thank you',
        description: '',
        event_source_type: 'PIXEL',
        event_source_id: '7001',
        optimization_event: 'ON_WEB_REGISTER',
        rules: [{parameter: 'URL', operator: 'CONTAIN', values: ['/thank-you']}],
        activity_status: 'ACTIVE',
        create_time: '2026-09-01 00:00:00',
        update_time: '2026-09-01 00:00:00',
      },
    ],
  ]);
  const groups = new Map(),
    requests = [],
    writes = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => url.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({
        list: [
          {
            advertiser_id: account,
            name: 'Synthetic advertiser',
            currency: 'USD',
            timezone: 'Etc/GMT',
            status: 'STATUS_ENABLE',
          },
        ],
      });
    if (method === 'GET' && path === '/v1.3/campaign/get/')
      return ok({
        list: [
          {
            campaign_id: '70',
            advertiser_id: account,
            campaign_name: 'Signups',
            objective_type: 'WEB_CONVERSIONS',
            budget_mode: 'BUDGET_MODE_INFINITE',
            operation_status: 'DISABLE',
          },
        ],
        page_info: {page: 1, page_size: 100, total_number: 1, total_page: 1},
      });
    if (method === 'GET' && path === '/v1.3/custom_conversion/get/') {
      const c = conversions.get(q('custom_conversion_id'));
      if (!c || (c.event_source_id !== q('event_source_id') && !c.foreign))
        return Response.json({code: 40001, message: 'Custom conversion not found', request_id: 'r' + ++n, data: {}});
      const {foreign, ...row} = c;
      return ok(structuredClone(row));
    }
    if (method === 'POST' && path === '/v1.3/adgroup/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      groups.set('900', {...b, adgroup_id: '900'});
      return ok({adgroup_id: '900'});
    }
    if (method === 'GET' && path === '/v1.3/adgroup/get/') {
      const ids = JSON.parse(q('filtering')).adgroup_ids;
      const list = ids.filter(id => groups.has(id)).map(id => groups.get(id));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (payload, action = 'tiktok_adgroup_create') =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action, account_id: account, payload},
    });
  const execute = id =>
    call('amcp_write', {
      action: 'execute',
      review_id: id,
      idempotency_key: id,
      confirmed: true,
      spend_change_confirmed: true,
    });
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, conversions, requests, writes, prepare, execute, verify};
}

test('an ad group that uses an eligible custom conversion on its pixel is read, created once and verified', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(adgroup());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.ok(
      p.data.state_reads.some(r => r.path === '/v1.3/custom_conversion/get/'),
      JSON.stringify(p.data.state_reads),
    );
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].custom_conversion_id, '8800001');
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
  } finally {
    f.store.close();
  }
});

test('ad groups without a custom conversion read nothing extra', async () => {
  const f = fixture();
  try {
    const {custom_conversion_id, ...plain} = adgroup();
    const p = await f.prepare(plain);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(
      p.data.state_reads.some(r => r.path === '/v1.3/custom_conversion/get/'),
      false,
    );
  } finally {
    f.store.close();
  }
});

test('request shapes TikTok does not document are refused before any request', async () => {
  const f = fixture();
  try {
    const {pixel_id, ...noPixel} = adgroup();
    for (const [name, payload, action] of [
      ['no pixel', noPixel],
      ['app source', adgroup({app_id: '555'})],
      ['wrong goal', adgroup({optimization_goal: 'CLICK'})],
      ['non-numeric ID', adgroup({custom_conversion_id: 'cc-1'})],
      ['update', {adgroup_id: '900', custom_conversion_id: '8800001'}, 'tiktok_adgroup_update'],
    ]) {
      const r = await f.prepare(payload, action);
      assert.equal(r.error?.code, 'INVALID_TIKTOK_CUSTOM_CONVERSION', name + ' ' + JSON.stringify(r).slice(0, 300));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a mismatched event, another pixel, an inactive or unknown conversion is refused before any write', async () => {
  const f = fixture();
  try {
    f.conversions.set('8800002', {
      ...f.conversions.get('8800001'),
      custom_conversion_id: '8800002',
      activity_status: 'WAITING_FOR_ACTIVITY',
    });
    f.conversions.set('8800003', {
      ...f.conversions.get('8800001'),
      custom_conversion_id: '8800003',
      event_source_id: '7009',
      foreign: true,
    });
    for (const [name, payload, code, pattern] of [
      ['event', adgroup({optimization_event: 'SHOPPING'}), 'INVALID_TIKTOK_CUSTOM_CONVERSION', /ON_WEB_REGISTER/],
      [
        'waiting',
        adgroup({custom_conversion_id: '8800002'}),
        'INVALID_TIKTOK_CUSTOM_CONVERSION',
        /ACTIVE or NO_RECENT_ACTIVITY/,
      ],
      [
        'other pixel',
        adgroup({custom_conversion_id: '8800003'}),
        'INVALID_TIKTOK_CUSTOM_CONVERSION',
        /belongs to pixel 7009/,
      ],
      ['unknown', adgroup({custom_conversion_id: '8800999'}), 'PLATFORM_ERROR', /./],
    ]) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, name + ' ' + JSON.stringify(r).slice(0, 300));
      assert.match(r.error.message, pattern, name);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('activity between ACTIVE and NO_RECENT_ACTIVITY keeps the review valid; losing eligibility stops the write', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(adgroup());
    f.conversions.get('8800001').activity_status = 'NO_RECENT_ACTIVITY';
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare(adgroup());
    g.conversions.get('8800001').activity_status = 'WAITING_FOR_ACTIVITY';
    const r = await g.execute(p.data.review_id);
    assert.equal(r.error?.code, 'INVALID_TIKTOK_CUSTOM_CONVERSION', JSON.stringify(r));
    assert.match(r.error.message, /ACTIVE or NO_RECENT_ACTIVITY/);
    assert.equal(g.writes.length, 0);
  } finally {
    g.store.close();
  }
});
