import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M4, package r25-m4-smartweb, L1-05 (Q14, owner 2026-11-15): an Upgraded Smart+ ad group or ad may be created ENABLE under a
 * parent the review reads DISABLE, as a standard TikTok ad group or ad already may. Nothing under a paused parent delivers, so the create
 * names no spend, and turning the campaign on is the one reviewed activation. A parent that serves, or whose status the review could not
 * read, still refuses the create (PARENT_SERVING), with or without the spend flag, at prepare and again at execute. The Smart+ campaign
 * stays DISABLE-only (Q1: campaigns are always created paused), and every ENABLE of an existing object still asks for the flag.
 *
 * R2.5 M4, package r25-m4-smartops (Q1, owner 2026-11-15): a parent that serves no longer refuses: the child may start ENABLE under it with
 * the spend flag, which the review's state asks for (tests/tiktok-serving-parent-children.test.mjs). An unread parent still refuses.
 */
const TIKTOK = '32323232-3232-4323-8323-323232323232',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-enable', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 82).toString('base64');
const adgroupBody = (status, extra = {}) => ({
  request_id: '810200300402',
  campaign_id: '80',
  operation_status: status,
  adgroup_name: 'Smart+ KSA visits',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CLICK',
  bid_type: 'BID_TYPE_NO_BID',
  billing_event: 'CPC',
  targeting_optimization_mode: 'AUTOMATIC',
  targeting_spec: {location_ids: ['102358'], spc_audience_age: 'OVER_EIGHTEEN', languages: ['ar']},
  schedule_type: 'SCHEDULE_FROM_NOW',
  schedule_start_time: '2026-12-01 00:00:00',
  ...extra,
});
const adBody = (status, extra = {}) => ({
  adgroup_id: '300',
  ad_name: 'Spark visit',
  operation_status: status,
  creative_list: [
    {creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: '9001', identity_type: 'TT_USER', identity_id: 'tt-1'}},
  ],
  landing_page_url_list: [{landing_page_url: 'https://shop.example.test/visit'}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  },
  ...extra,
});
const campaignBody = (status, extra = {}) => ({
  request_id: '810200300403',
  operation_status: status,
  objective_type: 'WEB_CONVERSIONS',
  sales_destination: 'WEBSITE',
  campaign_name: 'Smart+ visits',
  budget_optimize_on: true,
  budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
  budget: 100,
  ...extra,
});
/** The world TikTok answers from. A status is DISABLE, ENABLE, or undefined for a row whose status the review cannot read. */
function fixture() {
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
  const world = {
    campaigns: {
      80: {
        campaign_id: '80',
        campaign_name: 'Web',
        objective_type: 'WEB_CONVERSIONS',
        sales_destination: 'WEBSITE',
        budget_optimize_on: true,
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 500,
        operation_status: 'DISABLE',
        catalog_enabled: false,
        is_search_campaign: false,
      },
    },
    groups: {
      300: {
        adgroup_id: '300',
        campaign_id: '80',
        adgroup_name: 'Existing group',
        promotion_type: 'WEBSITE',
        optimization_goal: 'CLICK',
        billing_event: 'CPC',
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
        operation_status: 'DISABLE',
      },
    },
    // An ad that is ENABLE already sits in the group: its row names the same ad group and campaign as the group's own row does.
    ads: {
      4000: {
        smart_plus_ad_id: '4000',
        adgroup_id: '300',
        campaign_id: '80',
        ad_name: 'Existing ad',
        operation_status: 'ENABLE',
      },
    },
    campaignReadFails: false,
  };
  const requests = [],
    writes = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const list = rows => ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
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
      if (world.campaignReadFails)
        return Response.json({code: 50000, message: 'System error', request_id: 'r' + ++n, data: {}});
      return list(
        JSON.parse(q('filtering'))
          .campaign_ids.filter(id => world.campaigns[id])
          .map(id => structuredClone(world.campaigns[id])),
      );
    }
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/')
      return list(
        JSON.parse(q('filtering'))
          .adgroup_ids.filter(id => world.groups[id])
          .map(id => structuredClone(world.groups[id])),
      );
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/') {
      const f = JSON.parse(q('filtering'));
      return list(
        Object.values(world.ads)
          .filter(a =>
            f.smart_plus_ad_ids
              ? f.smart_plus_ad_ids.includes(a.smart_plus_ad_id)
              : f.adgroup_ids.includes(a.adgroup_id),
          )
          .map(a => structuredClone(a)),
      );
    }
    if (method === 'GET' && path === '/v1.3/identity/info/')
      return ok({
        identity_info: {
          identity_id: q('identity_id'),
          identity_type: q('identity_type'),
          display_name: 'Synthetic',
          available_status: 'AVAILABLE',
          can_pull_video: true,
          is_gpppa: false,
        },
      });
    if (method === 'GET' && path === '/v1.3/identity/video/info/')
      return ok({
        video_details: JSON.parse(q('item_ids')).map(id => ({item_id: id, item_type: 'VIDEO', status: 'PUBLIC'})),
      });
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/')
      return ok({portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]});
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/create/') {
      const b = JSON.parse(init.body);
      writes.push({path, body: b});
      const {advertiser_id, request_id, ...stored} = b;
      const row = {
        ...stored,
        adgroup_id: '9100000000000201',
        targeting_spec: {brand_safety_type: 'STANDARD_INVENTORY', spending_power: 'ALL', ...b.targeting_spec},
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
        placements: ['PLACEMENT_TIKTOK'],
        pacing: 'PACING_MODE_SMOOTH',
      };
      world.groups[row.adgroup_id] = row;
      return ok(structuredClone(row));
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push({path, body: b});
      const id = String(5000 + writes.length);
      world.ads[id] = {
        smart_plus_ad_id: id,
        campaign_id: world.groups[b.adgroup_id]?.campaign_id,
        adgroup_id: b.adgroup_id,
        ad_name: b.ad_name,
        operation_status: b.operation_status,
        creative_list: b.creative_list.map((c, i) => ({
          ad_material_id: 'm' + i,
          material_operation_status: 'ENABLE',
          creative_info: c.creative_info,
        })),
        landing_page_url_list: b.landing_page_url_list,
        ad_configuration: {...b.ad_configuration, product_specific_type: 'UNSET'},
      };
      return ok(structuredClone(world.ads[id]));
    }
    if (method === 'POST' && /\/v1\.3\/smart_plus\/(campaign|adgroup)\/status\/update\/$/.test(path)) {
      const b = JSON.parse(init.body),
        kind = /campaign/.test(path) ? 'campaign' : 'adgroup',
        ids = b[kind + '_ids'];
      writes.push({path, body: b});
      for (const id of ids)
        world[kind === 'campaign' ? 'campaigns' : 'groups'][id].operation_status = b.operation_status;
      return ok({[kind + '_list']: ids.map(id => ({[kind + '_id']: id, status: b.operation_status})), error_list: []});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (payload, action) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action, account_id: account, payload},
    });
  const prepareGroup = payload => prepare(payload, 'tiktok_smart_plus_adgroup_create'),
    prepareAd = payload => prepare(payload, 'tiktok_smart_plus_ad_create');
  const execute = (review, extra = {}) =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      idempotency_key: review.data.review_id,
      confirmed: true,
      ...extra,
    });
  const verify = review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  return {store, world, requests, writes, call, prepare, prepareGroup, prepareAd, execute, verify};
}
/** Runs a test body against a fresh world, and closes the store. */
const withWorld = async body => {
  const f = fixture();
  try {
    await body(f);
  } finally {
    f.store.close();
  }
};
const setStatus = (row, status) => {
  if (status === undefined) delete row.operation_status;
  else row.operation_status = status;
};

test('an ENABLE Smart+ ad group under a campaign the review reads DISABLE prepares with no spend flag, executes and verifies ENABLE', async () => {
  await withWorld(async f => {
    const p = await f.prepareGroup(adgroupBody('ENABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    // Q14: a create under a paused parent names no spend, so execute needs no spend_change_confirmed.
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false);
    assert.match(impact.effect, /enabled/i);
    assert.match(impact.effect, /paused/i);
    assert.match(impact.effect, /nothing delivers until the campaign is enabled/i);
    const done = await f.execute(p, {});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.operation_status, 'ENABLE');
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(f.world.groups['9100000000000201'].operation_status, 'ENABLE');
  });
});

test('a DISABLE Smart+ ad group still says it creates a paused one', async () => {
  await withWorld(async f => {
    const p = await f.prepareGroup(adgroupBody('DISABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.match(p.data.creative_impact.effect, /^Creates a paused Upgraded Smart\+/);
  });
});

// R2.5 M4, package r25-m4-smartops (Q1, owner 2026-11-15; the lead's design (b) of L5): this test refused the campaign that serves as well as
// the unread one. Q1 lets the ad group start ENABLE under a campaign the review reads serving, with the spend flag the review's state now asks
// for, so that case moved to the next test; the unread campaign is refused as before, and says so (`parent_unread`).
test('an ENABLE Smart+ ad group whose campaign status cannot be read is refused at prepare, flag or none', async () => {
  await withWorld(async f => {
    setStatus(f.world.campaigns[80], undefined);
    for (const flags of [{}, {spend_change_confirmed: true}]) {
      const r = await f.prepareGroup(adgroupBody('ENABLE'));
      assertRefused(r, 'PARENT_SERVING', {writes: () => f.writes.length});
      assert.equal(r.error.details.parent, 'Smart+ campaign');
      assert.equal(r.error.details.parent_status, null);
      assert.equal(r.error.details.parent_unread, true);
      assert.deepEqual(r.error.details.allowed, ['DISABLE']);
      // The flag is no key to it: a refused prepare has no review to execute.
      assert.equal(r.data, undefined, JSON.stringify(flags));
    }
  });
});

test('an ENABLE Smart+ ad group whose campaign serves asks for the spend flag, is not sent without it, and is sent once with it (Q1)', async () => {
  await withWorld(async f => {
    f.world.campaigns[80].operation_status = 'ENABLE';
    const p = await f.prepareGroup(adgroupBody('ENABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.match(p.data.creative_impact.effect, /reads as serving: it starts serving at once/);
    assertRefused(await f.execute(p, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    const done = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.operation_status, 'ENABLE');
  });
});

test('an ENABLE Smart+ ad group prepared under a paused campaign is not sent once the campaign serves, flag or none', async () => {
  for (const flags of [{}, {spend_change_confirmed: true}])
    await withWorld(async f => {
      const p = await f.prepareGroup(adgroupBody('ENABLE'));
      assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
      f.world.campaigns[80].operation_status = 'ENABLE';
      assertRefused(await f.execute(p, flags), ['STATE_CHANGED', 'PARENT_SERVING'], {writes: () => f.writes.length});
    });
});

test('an ENABLE Smart+ ad under an ad group the review reads DISABLE is allowed with no spend flag, and verifies ENABLE', async () => {
  await withWorld(async f => {
    const p = await f.prepareAd(adBody('ENABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    assert.match(p.data.creative_impact.effect, /enabled/i);
    // The ad group is paused: that is what the ad waits for (delivery then still waits for the campaign, a matter of its own).
    assert.match(p.data.creative_impact.effect, /nothing delivers until its ad group is enabled/i);
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    // The ad group is paused, so the review never asks about its campaign.
    assert.ok(!f.requests.includes('GET /v1.3/smart_plus/campaign/get/'), f.requests.join(' | '));
    const done = await f.execute(p, {});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.operation_status, 'ENABLE');
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
  });
});

test('a Smart+ ad read back DISABLE after it was sent ENABLE is a difference, not a pass', async () => {
  await withWorld(async f => {
    const p = await f.prepareAd(adBody('ENABLE'));
    assert.equal((await f.execute(p, {})).success, true);
    for (const ad of Object.values(f.world.ads)) if (ad.ad_name === 'Spark visit') ad.operation_status = 'DISABLE';
    const v = await f.verify(p);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/operation_status']);
  });
});

test('an ENABLE Smart+ ad in a serving ad group is allowed under a paused campaign, after exactly one Smart+ campaign read', async () => {
  await withWorld(async f => {
    f.world.groups[300].operation_status = 'ENABLE';
    f.world.campaigns[80].operation_status = 'DISABLE';
    const p = await f.prepareAd(adBody('ENABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.equal(p.data.execute_requirements.spend_change_confirmed, false);
    assert.match(p.data.creative_impact.effect, /nothing delivers until the campaign is enabled/i);
    assert.equal(
      f.requests.filter(r => r === 'GET /v1.3/smart_plus/campaign/get/').length,
      1,
      'one campaign follow-up: ' + f.requests.join(' | '),
    );
    assert.ok(
      !f.requests.some(r => r === 'GET /v1.3/campaign/get/'),
      'the Smart+ campaign is read from its own route, not the legacy one',
    );
    assert.equal((await f.execute(p, {})).success, true);
    assert.equal(f.writes.length, 1);
  });
});

// R2.5 M4, package r25-m4-smartops (Q1, owner 2026-11-15): this test refused the ad while its ad group and campaign both serve. Q1 lets it start
// ENABLE there with the spend flag, which the review's state asks for; a campaign whose status cannot be read, or whose read fails, still refuses.
test('an ENABLE Smart+ ad asks for the spend flag when the ad group and the campaign both serve, and is refused when the campaign is unread or its read fails', async () => {
  await withWorld(async f => {
    f.world.groups[300].operation_status = 'ENABLE';
    f.world.campaigns[80].operation_status = 'ENABLE';
    const p = await f.prepareAd(adBody('ENABLE'));
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    assert.equal(p.data.execute_requirements.spend_change_confirmed, true);
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assertRefused(await f.execute(p, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
    setStatus(f.world.campaigns[80], undefined);
    for (const flags of [{}, {spend_change_confirmed: true}]) {
      const r = await f.prepareAd(adBody('ENABLE'));
      assertRefused(r, 'PARENT_SERVING', {writes: () => f.writes.length});
      assert.equal(r.error.details.parent, 'Smart+ ad group');
      assert.equal(r.error.details.parent_status, 'ENABLE');
      assert.equal(r.error.details.campaign_status, null);
      assert.equal(r.error.details.parent_unread, true);
      assert.equal(r.data, undefined, JSON.stringify(flags));
    }
    // The campaign read fails: nothing is guessed, and nothing is prepared.
    f.world.campaigns[80].operation_status = 'DISABLE';
    f.world.campaignReadFails = true;
    const failed = await f.prepareAd(adBody('ENABLE'));
    assertRefused(failed, 'PLATFORM_ERROR', {writes: () => f.writes.length});
    assert.equal(failed.data, undefined);
  });
});

test('a Smart+ ad prepared under a paused ad group is not sent once the ad group serves and its campaign serves, flag or none', async () => {
  for (const flags of [{}, {spend_change_confirmed: true}])
    await withWorld(async f => {
      const p = await f.prepareAd(adBody('ENABLE'));
      assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
      f.world.groups[300].operation_status = 'ENABLE';
      f.world.campaigns[80].operation_status = 'ENABLE';
      assertRefused(await f.execute(p, flags), ['STATE_CHANGED', 'PARENT_SERVING'], {writes: () => f.writes.length});
    });
});

// R2.5 M4, package r25-m4-smartops (Q1, owner 2026-11-15): this test was "an ENABLE create is refused iff no parent reads DISABLE, and a
// create never asks for the spend flag". Under Q1 an ENABLE create whose parents all read ENABLE prepares and asks for the flag; one with a
// parent the review cannot read (and none read DISABLE) is still refused; every other create asks for nothing, as before.
test('across every parent state and child status, an ENABLE create is refused iff a parent is unread and none reads DISABLE, and asks for the spend flag iff every parent serves', async () => {
  const states = ['DISABLE', 'ENABLE', undefined];
  await withWorld(async f => {
    for (const parent of states)
      for (const child of ['DISABLE', 'ENABLE']) {
        setStatus(f.world.campaigns[80], parent);
        const r = await f.prepareGroup(adgroupBody(child));
        const label = 'ad group ' + child + ' under campaign ' + parent;
        if (child === 'ENABLE' && parent === undefined)
          assertRefused(r, 'PARENT_SERVING', {writes: () => f.writes.length});
        else {
          assert.equal(r.success, true, label + ': ' + JSON.stringify(r.error ?? r).slice(0, 300));
          assert.equal(
            r.data.execute_requirements.spend_change_confirmed,
            child === 'ENABLE' && parent === 'ENABLE',
            label,
          );
        }
      }
    for (const campaign of states)
      for (const group of states)
        for (const child of ['DISABLE', 'ENABLE']) {
          setStatus(f.world.campaigns[80], campaign);
          setStatus(f.world.groups[300], group);
          const r = await f.prepareAd(adBody(child));
          const label = 'ad ' + child + ' under ad group ' + group + ' and campaign ' + campaign;
          const covered = group === 'DISABLE' || campaign === 'DISABLE',
            serving = group === 'ENABLE' && campaign === 'ENABLE';
          if (child === 'ENABLE' && !covered && !serving)
            assertRefused(r, 'PARENT_SERVING', {writes: () => f.writes.length});
          else {
            assert.equal(r.success, true, label + ': ' + JSON.stringify(r.error ?? r).slice(0, 300));
            assert.equal(r.data.execute_requirements.spend_change_confirmed, child === 'ENABLE' && serving, label);
          }
        }
    assert.equal(f.writes.length, 0, 'preparing sends no write');
  });
});

test('allow_activation false refuses an ENABLE Smart+ child under a paused parent, and lets a DISABLE one through', async () => {
  await withWorld(async f => {
    saveSpendPolicy(f.store, owner, {scope: 'workspace', confirmed: true, policy: {allow_activation: false}});
    assertRefused(await f.prepareGroup(adgroupBody('ENABLE')), 'POLICY_ACTIVATION_FORBIDDEN', {
      writes: () => f.writes.length,
    });
    assertRefused(await f.prepareAd(adBody('ENABLE')), 'POLICY_ACTIVATION_FORBIDDEN', {writes: () => f.writes.length});
    const group = await f.prepareGroup(adgroupBody('DISABLE'));
    assert.equal(group.success, true, JSON.stringify(group.error ?? group).slice(0, 400));
    assert.equal((await f.execute(group, {})).success, true);
    const ad = await f.prepareAd(adBody('DISABLE'));
    assert.equal(ad.success, true, JSON.stringify(ad.error ?? ad).slice(0, 400));
    assert.equal((await f.execute(ad, {})).success, true);
    assert.equal(f.writes.length, 2);
  });
});

test('a Smart+ campaign is still created DISABLE only (Q1): ENABLE and a missing status are refused before any request', async () => {
  await withWorld(async f => {
    const enabled = await f.prepare(campaignBody('ENABLE'), 'tiktok_smart_plus_campaign_create');
    assertRefused(enabled, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => f.writes.length});
    assert.equal(enabled.error.details.field, 'operation_status');
    const {operation_status: dropped, ...unset} = campaignBody('DISABLE');
    const none = await f.prepare(unset, 'tiktok_smart_plus_campaign_create');
    assertRefused(none, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => f.writes.length});
    assert.equal(none.error.details.field, 'operation_status');
    // A child with no status would be enabled by TikTok's default: still refused locally.
    const noStatus = await f.prepareGroup(
      (() => {
        const {operation_status: gone, ...body} = adgroupBody('DISABLE');
        return body;
      })(),
    );
    assertRefused(noStatus, 'INVALID_TIKTOK_SMART_PLUS_ADGROUP', {writes: () => f.writes.length});
    assert.equal(noStatus.error.details.field, 'operation_status');
    for (const status of ['PAUSED', 'DELETE', 'enable', 7]) {
      const r = await f.prepareAd(adBody(status));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'operation_status', String(status));
    }
    assert.equal(f.requests.length, 0, 'every one is refused before any request: ' + f.requests.join(' | '));
  });
});

test('turning on an existing Smart+ ad group or campaign still needs the spend flag, and is not sent without it', async () => {
  for (const [kind, ids] of [
    ['adgroup', ['300']],
    ['campaign', ['80']],
  ])
    await withWorld(async f => {
      const p = await f.prepare(
        {advertiser_id: account, [kind + '_ids']: ids, operation_status: 'ENABLE'},
        'tiktok_smart_plus_' + kind + '_status_update',
      );
      assert.equal(p.success, true, kind + ': ' + JSON.stringify(p.error ?? p).slice(0, 400));
      assert.equal(p.data.execute_requirements.spend_change_confirmed, true, kind);
      assertRefused(await f.execute(p, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.writes.length});
      const done = await f.execute(p, {spend_change_confirmed: true});
      assert.equal(done.success, true, kind + ': ' + JSON.stringify(done.error ?? done).slice(0, 400));
      assert.equal(f.writes.length, 1, kind);
    });
});
