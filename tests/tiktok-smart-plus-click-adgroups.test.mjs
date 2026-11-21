import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M4, package r25-m4-smartweb: Upgraded Smart+ website ad groups that optimize for clicks or for landing page views
 * (promotion_type WEBSITE, optimization_goal CLICK or TRAFFIC_LANDING_PAGE_VIEW), beside the conversion ones. API for Business
 * v1.3 "Create a regular Upgraded Smart+ Web Campaign" and "Create an Upgraded Smart+ Ad Group", read in a browser on 2026-11-20
 * (the lead's documentation session, impl/r25-m4-DOCS-EVIDENCE.md, row 2): the goals of a regular Smart+ web campaign are CLICK,
 * CONVERT, TRAFFIC_LANDING_PAGE_VIEW and VALUE; a CLICK ad group bills with CPC and every other goal with OCPM; the custom bid
 * (BID_TYPE_CUSTOM) is bid_price for CLICK and conversion_bid_price for the other goals; pixel_id is not supported for CLICK or
 * TRAFFIC_LANDING_PAGE_VIEW; and no attribution window is documented for either (the page that lists them covers CONVERT, VALUE,
 * INSTALL and IN_APP_EVENT only). So a click or landing page view ad group reads no pixel, sends no pixel, event, custom
 * conversion or attribution field, and each is refused naming its field.
 */
const TIKTOK = '31313131-3131-4313-8313-313131313131',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-click', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 81).toString('base64');
/** A click ad group as TikTok documents it: no pixel, CPC billing, maximum delivery. */
const click = (extra = {}, spec) => ({
  request_id: '810200300401',
  campaign_id: '90',
  operation_status: 'DISABLE',
  adgroup_name: 'Smart+ KSA visits',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CLICK',
  bid_type: 'BID_TYPE_NO_BID',
  billing_event: 'CPC',
  targeting_optimization_mode: 'AUTOMATIC',
  targeting_spec: spec ?? {location_ids: ['102358'], spc_audience_age: 'OVER_EIGHTEEN', languages: ['ar']},
  schedule_type: 'SCHEDULE_FROM_NOW',
  schedule_start_time: '2026-12-01 00:00:00',
  ...extra,
});
/** A landing page view ad group as TikTok documents it: no pixel, OCPM billing (every goal but CLICK), maximum delivery. */
const landing = (extra = {}) => ({
  ...click(),
  optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW',
  billing_event: 'OCPM',
  ...extra,
});
/** The conversion ad group of the existing suites, for the negatives that keep its rules. */
const convert = (extra = {}) => ({
  ...click(),
  optimization_goal: 'CONVERT',
  pixel_id: '7001',
  optimization_event: 'ON_WEB_ORDER',
  billing_event: 'OCPM',
  ...extra,
});
const without = (body, ...drop) => {
  const out = {...body};
  for (const k of drop) delete out[k];
  return out;
};
const campaigns = {
  90: {
    campaign_id: '90',
    campaign_name: 'CBO web',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 500,
    operation_status: 'DISABLE',
    catalog_enabled: false,
    is_search_campaign: false,
  },
  91: {
    campaign_id: '91',
    campaign_name: 'Leads',
    objective_type: 'LEAD_GENERATION',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 300,
    operation_status: 'DISABLE',
  },
  92: {
    campaign_id: '92',
    campaign_name: 'Search web',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 300,
    operation_status: 'DISABLE',
    catalog_enabled: false,
    is_search_campaign: true,
  },
  93: {
    campaign_id: '93',
    campaign_name: 'Catalog web',
    objective_type: 'WEB_CONVERSIONS',
    sales_destination: 'WEBSITE',
    catalog_enabled: true,
    budget_optimize_on: true,
    budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
    budget: 300,
    operation_status: 'DISABLE',
  },
};
const pixels = {
  7001: {pixel_id: '7001', pixel_code: 'C7001', pixel_name: 'Site pixel', asset_ownership: {ownership_status: true}},
  7006: {
    pixel_id: '7006',
    pixel_code: 'C7006',
    pixel_name: 'Old pixel',
    asset_ownership: {ownership_status: false, asset_relation_status: 'UNBOUND'},
  },
};
function fixture({readDrift} = {}) {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
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
        list: [{advertiser_id: account, name: 'Synthetic advertiser', currency: 'SAR', timezone: 'Asia/Riyadh'}],
      });
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/') {
      const list = JSON.parse(q('filtering'))
        .campaign_ids.filter(id => campaigns[id])
        .map(id => structuredClone(campaigns[id]));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'GET' && path === '/v1.3/pixel/list/') {
      const p = pixels[q('pixel_id')];
      return ok({
        pixels: p ? [structuredClone(p)] : [],
        page_info: {page: 1, page_size: 10, total_number: p ? 1 : 0, total_page: 1},
      });
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const {advertiser_id, request_id, ...stored} = b;
      const read = {
        ...stored,
        adgroup_id: '9100000000000101',
        targeting_spec: {
          brand_safety_type: 'STANDARD_INVENTORY',
          spending_power: 'ALL',
          ...structuredClone(b.targeting_spec),
        },
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
        placements: ['PLACEMENT_TIKTOK'],
        pacing: 'PACING_MODE_SMOOTH',
        create_time: '2026-11-20 14:00:00',
        modify_time: '2026-11-20 14:00:00',
      };
      groups.set(read.adgroup_id, read);
      return ok(structuredClone(read));
    }
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      const list = JSON.parse(q('filtering'))
        .adgroup_ids.filter(id => groups.has(id))
        .map(id => (readDrift ? readDrift(structuredClone(groups.get(id))) : structuredClone(groups.get(id))));
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
  const args = payload => ({action: 'tiktok_smart_plus_adgroup_create', account_id: account, payload});
  const prepare = payload =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, groups, requests, writes, call, prepare, execute, verify};
}

test('a click ad group is prepared without reading a pixel, created once and verified with its CPC billing', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(click());
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/smart_plus/campaign/get/'],
      'no pixel is read for a click ad group',
    );
    assert.ok(!f.requests.some(r => r.includes('/pixel/')), 'no pixel request: ' + f.requests.join(' | '));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'smart_plus_adgroups');
    assert.equal(impact.may_affect_serving, false);
    assert.equal(impact.adgroup.pixel, null);
    assert.match(impact.adgroup.optimization, /click/i);
    assert.match(impact.effect, /click/i);
    assert.equal(impact.adgroup.bidding, 'maximum delivery');
    // Q14 (owner, 2026-11-15): a create under a paused campaign names no spend.
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.deepEqual(sent, click());
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.checks[0].resource_id, '9100000000000101');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1, 'a replay sends nothing');
  } finally {
    f.store.close();
  }
});

test('the read-back of a click ad group is compared with its CPC billing: a different billing event is inconclusive', async () => {
  const f = fixture({readDrift: r => ({...r, billing_event: 'OCPM'})});
  try {
    const p = await f.prepare(click());
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/billing_event']);
  } finally {
    f.store.close();
  }
});

test('a click ad group with a custom bid sends bid_price, and the read-back compares it', async () => {
  const f = fixture();
  try {
    const body = click({bid_type: 'BID_TYPE_CUSTOM', bid_price: 0.35});
    const p = await f.prepare(body);
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.deepEqual(p.data.creative_impact.adgroup.bidding, {cpc_bid: 0.35});
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.deepEqual(sent, body);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  // A bid TikTok did not keep is a difference, not a pass.
  const g = fixture({readDrift: r => ({...r, bid_price: 0.2})});
  try {
    const p = await g.prepare(click({bid_type: 'BID_TYPE_CUSTOM', bid_price: 0.35}));
    assert.equal((await g.execute(p.data.review_id)).success, true);
    const v = await g.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/bid_price']);
  } finally {
    g.store.close();
  }
});

test('a landing page view ad group is prepared without reading a pixel, created once and verified with its OCPM billing', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(landing());
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/advertiser/info/', '/v1.3/smart_plus/campaign/get/'],
      'no pixel is read for a landing page view ad group',
    );
    assert.ok(!f.requests.some(r => r.includes('/pixel/')), 'no pixel request: ' + f.requests.join(' | '));
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false);
    assert.equal(impact.adgroup.pixel, null);
    assert.match(impact.adgroup.optimization, /landing page view/i);
    assert.match(impact.effect, /landing page view/i);
    assert.equal(impact.adgroup.bidding, 'maximum delivery');
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    const done = await f.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.deepEqual(sent, landing());
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1, 'a replay sends nothing');
  } finally {
    f.store.close();
  }
  // The billing event is compared: CPC read back for an OCPM ad group is a difference.
  const g = fixture({readDrift: r => ({...r, billing_event: 'CPC'})});
  try {
    const p = await g.prepare(landing());
    assert.equal((await g.execute(p.data.review_id)).success, true);
    const v = await g.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/billing_event']);
  } finally {
    g.store.close();
  }
});

test('a landing page view ad group with a custom bid sends conversion_bid_price, as every non-click goal does, and the read-back compares it', async () => {
  const f = fixture();
  try {
    const body = landing({bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 4.5});
    const p = await f.prepare(body);
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.deepEqual(p.data.creative_impact.adgroup.bidding, {cost_cap: 4.5});
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const {advertiser_id, ...sent} = f.writes[0];
    assert.deepEqual(sent, body);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture({readDrift: r => ({...r, conversion_bid_price: 3})});
  try {
    const p = await g.prepare(landing({bid_type: 'BID_TYPE_CUSTOM', conversion_bid_price: 4.5}));
    assert.equal((await g.execute(p.data.review_id)).success, true);
    const v = await g.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/conversion_bid_price']);
  } finally {
    g.store.close();
  }
});

test('a click or landing page view ad group breaks no rule of its goal: each wrong field is refused on its own field, before any request', async () => {
  const f = fixture();
  try {
    const custom = {bid_type: 'BID_TYPE_CUSTOM'};
    // The fields no pixel-free goal takes: TikTok documents no pixel for CLICK or TRAFFIC_LANDING_PAGE_VIEW, and no attribution window
    // for either (impl/r25-m4-DOCS-EVIDENCE.md, row 2), so each is refused on its own field, for each goal.
    const notTaken = [
      ['a pixel', {pixel_id: '7001'}, 'pixel_id'],
      ['a pixel event', {optimization_event: 'ON_WEB_ORDER'}, 'optimization_event'],
      ['a custom conversion', {custom_conversion_id: '8800001'}, 'custom_conversion_id'],
      [
        'a click window',
        {click_attribution_window: 'SEVEN_DAYS', view_attribution_window: 'ONE_DAY'},
        'click_attribution_window',
      ],
      ['a view window', {view_attribution_window: 'ONE_DAY'}, 'view_attribution_window'],
      ['an engaged-view window', {engaged_view_attribution_window: 'ONE_DAY'}, 'engaged_view_attribution_window'],
      ['an attribution event count', {attribution_event_count: 'EVERY'}, 'attribution_event_count'],
    ];
    const cases = [
      ...notTaken.flatMap(([name, extra, field]) => [
        [name + ' on a click ad group', click(extra), field],
        [name + ' on a landing page view ad group', landing(extra), field],
      ]),
      // The bid field of a landing page view ad group is conversion_bid_price, as the conversion goal's; bid_price is the click goal's.
      [
        'a click bid on a landing page view ad group',
        landing({...custom, bid_price: 0.35, conversion_bid_price: 4}),
        'bid_price',
      ],
      ['a click bid on a landing page view ad group with no bid', landing({bid_price: 0.35}), 'bid_price'],
      ['a custom bid with no price on a landing page view ad group', landing(custom), 'conversion_bid_price'],
      [
        'a maximum-delivery landing page view ad group that names a price',
        landing({conversion_bid_price: 4}),
        'conversion_bid_price',
      ],
      ['a landing page view bid of zero', landing({...custom, conversion_bid_price: 0}), 'conversion_bid_price'],
      ['CPC billing on a landing page view ad group', landing({billing_event: 'CPC'}), 'billing_event'],
      ['no billing event on a landing page view ad group', without(landing(), 'billing_event'), 'billing_event'],
      ['a conversion bid on a click ad group', click({...custom, conversion_bid_price: 0.35}), 'conversion_bid_price'],
      [
        'a click bid on a conversion ad group',
        convert({...custom, bid_price: 0.35, conversion_bid_price: 4}),
        'bid_price',
      ],
      ['a click bid on a conversion ad group with no bid', convert({bid_price: 0.35}), 'bid_price'],
      ['a custom bid with no price', click(custom), 'bid_price'],
      ['a maximum-delivery ad group that names a price', click({bid_price: 0.35}), 'bid_price'],
      ['a click bid with a third decimal', click({...custom, bid_price: 0.355}), 'bid_price'],
      ['a click bid of zero', click({...custom, bid_price: 0}), 'bid_price'],
      ['a click bid as text', click({...custom, bid_price: '0.35'}), 'bid_price'],
      ['OCPM billing on a click ad group', click({billing_event: 'OCPM'}), 'billing_event'],
      ['no billing event on a click ad group', without(click(), 'billing_event'), 'billing_event'],
      ['CPC billing on a conversion ad group', convert({billing_event: 'CPC'}), 'billing_event'],
    ];
    for (const [name, payload, field] of cases) {
      const r = await f.prepare(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
    }
    assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
  } finally {
    f.store.close();
  }
});

test('the goals that are not qualified are refused naming the qualified ones', async () => {
  const f = fixture();
  try {
    for (const [name, payload] of [
      ['value', click({optimization_goal: 'VALUE', billing_event: 'OCPM'})],
      ['install', click({promotion_type: 'APP_ANDROID', optimization_goal: 'INSTALL', billing_event: 'OCPM'})],
      ['no goal', without(click(), 'optimization_goal')],
      ['an inherited property as the goal', click({optimization_goal: 'constructor'})],
      ['a number as the goal', click({optimization_goal: 7})],
      ['a goal in lower case', click({optimization_goal: 'click'})],
    ]) {
      const r = await f.prepare(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'optimization_goal', name);
      assert.match(r.error.message, /CONVERT, CLICK or TRAFFIC_LANDING_PAGE_VIEW/, name);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});
test('a click or landing page view ad group is accepted only in a website sales campaign: lead, search, catalog and missing campaigns are refused at prepare', async () => {
  const f = fixture();
  try {
    for (const make of [click, landing])
      for (const [name, id, code] of [
        ['a lead generation campaign', '91', 'INVALID_TIKTOK_SMART_PLUS_ADGROUP'],
        ['a search campaign', '92', 'INVALID_TIKTOK_SMART_PLUS_ADGROUP'],
        ['a catalog campaign', '93', 'INVALID_TIKTOK_SMART_PLUS_ADGROUP'],
        ['a campaign TikTok does not return', '99', 'STATE_TARGET_MISMATCH'],
      ]) {
        const r = await f.prepare(make({campaign_id: id}));
        assertRefused(r, code, {writes: () => f.writes.length});
        if (code === 'INVALID_TIKTOK_SMART_PLUS_ADGROUP') assert.equal(r.error.details.field, 'campaign_id', name);
      }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a conversion ad group still reads its pixel and refuses an unbound or missing one', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(convert());
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.ok(
      p.data.state_reads.some(r => r.path === '/v1.3/pixel/list/'),
      'a conversion ad group reads its pixel',
    );
    assert.equal(p.data.creative_impact.adgroup.optimization, 'ON_WEB_ORDER');
    assertRefused(await f.prepare(convert({pixel_id: '7006'})), 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {
      writes: () => f.writes.length,
    });
    assertRefused(await f.prepare(convert({pixel_id: '7009'})), 'STATE_TARGET_MISMATCH', {
      writes: () => f.writes.length,
    });
    assertRefused(await f.prepare(without(convert(), 'pixel_id')), 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {
      writes: () => f.writes.length,
    });
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});
