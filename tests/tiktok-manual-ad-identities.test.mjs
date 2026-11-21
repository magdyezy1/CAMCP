import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Manual TikTok ads (API for Business v1.3, checked 2026-09-26): new non-Spark ads with a CUSTOMIZED_USER identity are
 * no longer accepted in ad groups that deliver on TikTok; Pangle and Global App Bundle placements are not affected.
 * r25-field-tiktok (#2): the classic /ad/create/ does not support Upgraded Smart+ ads either. "Get ad groups" returns each
 * ad group's `campaign_automation_type` (MANUAL, SMART_PLUS or UPGRADED_SMART_PLUS; checked 2026-11-19), which the parent
 * read of the create already holds, so the create is refused at prepare and execute with the Smart+ route named.
 */
const TIKTOK = '27272727-2727-4272-8272-272727272727',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-manual-ad-identities', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 85).toString('base64');
const custom = (extra = {}) => ({
  ad_name: 'Custom identity ad',
  operation_status: 'DISABLE',
  ad_format: 'SINGLE_VIDEO',
  video_id: 'v10',
  image_ids: ['img-1'],
  identity_type: 'CUSTOMIZED_USER',
  identity_id: '9000000000000000011',
  ad_text: 'Synthetic text',
  landing_page_url: 'https://example.test/',
  call_to_action: 'LEARN_MORE',
  ...extra,
});
/** A Spark ad from an existing post: no custom identity, so only the route of the create is in question. */
const sparkAd = (extra = {}) =>
  custom({
    identity_type: 'TT_USER',
    identity_id: 'tt-1',
    tiktok_item_id: '9001',
    video_id: undefined,
    image_ids: undefined,
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
  const groups = {
    200: {
      adgroup_id: '200',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    },
    201: {
      adgroup_id: '201',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE'],
    },
    202: {
      adgroup_id: '202',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_PANGLE'],
    },
    // The classic ad group read names the automation type of the campaign (groups 200 to 202 carry none).
    203: {
      adgroup_id: '203',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
    },
    204: {
      adgroup_id: '204',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      campaign_automation_type: 'MANUAL',
    },
    205: {
      adgroup_id: '205',
      advertiser_id: account,
      operation_status: 'DISABLE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      campaign_automation_type: 'SMART_PLUS',
    },
  };
  // The classic campaign read names its automation type (r25-m4-classic, the twin of #2: TikTok's campaign row carries the field, as the
  // documentation session of 2026-11-20 confirmed and live check M4 LV-23 reads once more, so a row without it is a case of its own).
  const campaigns = {
    300: {
      campaign_id: '300',
      advertiser_id: account,
      operation_status: 'DISABLE',
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
    },
    301: {campaign_id: '301', advertiser_id: account, operation_status: 'DISABLE', campaign_automation_type: 'MANUAL'},
    302: {
      campaign_id: '302',
      advertiser_id: account,
      operation_status: 'DISABLE',
      campaign_automation_type: 'SMART_PLUS',
    },
    303: {campaign_id: '303', advertiser_id: account, operation_status: 'DISABLE'},
    304: {campaign_id: '304', advertiser_id: account, operation_status: 'ENABLE', campaign_automation_type: 'MANUAL'},
    // The rows `Get campaigns` returns, in the shape the lead read live on a Smart+ Search reference campaign (synthetic IDs), and a manual one
    // with the fields of the documented response (r25-m4-classic: the docs session of 2026-11-20 confirmed the type is in every row).
    305: {
      campaign_id: '305',
      advertiser_id: account,
      campaign_name: 'Reference Smart+ Search',
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
      is_search_campaign: true,
      objective_type: 'TRAFFIC',
      operation_status: 'DISABLE',
      budget_mode: 'BUDGET_MODE_INFINITE',
      is_smart_performance_campaign: false,
    },
    306: {
      campaign_id: '306',
      advertiser_id: account,
      campaign_name: 'Manual traffic',
      campaign_automation_type: 'MANUAL',
      is_search_campaign: false,
      objective_type: 'TRAFFIC',
      operation_status: 'DISABLE',
      secondary_status: 'CAMPAIGN_STATUS_DISABLE',
      budget_mode: 'BUDGET_MODE_INFINITE',
      is_smart_performance_campaign: false,
    },
  };
  const ads = {},
    requests = [],
    writes = [];
  let n = 0,
    id = 400;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (path === '/v1.3/advertiser/info/') return ok({list: [{advertiser_id: account, name: 'Synthetic'}]});
    if (path === '/v1.3/adgroup/get/') {
      const ids = JSON.parse(u.searchParams.get('filtering')).adgroup_ids;
      return ok({list: ids.filter(i => groups[i]).map(i => structuredClone(groups[i]))});
    }
    if (path === '/v1.3/ad/get/') {
      const ids = JSON.parse(u.searchParams.get('filtering')).ad_ids;
      return ok({list: ids.filter(i => ads[i]).map(i => structuredClone(ads[i]))});
    }
    if (method === 'POST' && path === '/v1.3/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const ad = String(id++);
      ads[ad] = {...b.creatives[0], adgroup_id: b.adgroup_id, advertiser_id: account, ad_id: ad};
      return ok({ad_ids: [ad]});
    }
    if (path === '/v1.3/campaign/get/') {
      const ids = JSON.parse(u.searchParams.get('filtering')).campaign_ids;
      return ok({list: ids.filter(i => campaigns[i]).map(i => structuredClone(campaigns[i]))});
    }
    if (method === 'POST' && path === '/v1.3/adgroup/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const group = String(id++);
      groups[group] = {...b, adgroup_id: group};
      return ok({adgroup_id: group});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepareBody = payload =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_ad_create', account_id: account, payload},
    });
  const prepare = (adgroup, creative) =>
    prepareBody({advertiser_id: account, adgroup_id: adgroup, creatives: [creative]});
  /** A classic ad group create under campaign `campaign` (paused, a click ad group on the TikTok placement). */
  const prepareGroup = (campaign, extra = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {
        action: 'tiktok_adgroup_create',
        account_id: account,
        payload: {
          advertiser_id: account,
          campaign_id: campaign,
          adgroup_name: 'Classic ad group',
          promotion_type: 'WEBSITE',
          placement_type: 'PLACEMENT_TYPE_NORMAL',
          placements: ['PLACEMENT_TIKTOK'],
          location_ids: ['6252001'],
          budget_mode: 'BUDGET_MODE_DAY',
          budget: 50,
          schedule_type: 'SCHEDULE_FROM_NOW',
          schedule_start_time: '2027-06-01 00:00:00',
          optimization_goal: 'CLICK',
          billing_event: 'CPC',
          bid_type: 'BID_TYPE_NO_BID',
          operation_status: 'DISABLE',
          ...extra,
        },
      },
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, groups, campaigns, requests, writes, prepare, prepareBody, prepareGroup, execute, verify};
}

test('custom identity ads are refused in ad groups that deliver on TikTok, before any write', async () => {
  const f = fixture();
  try {
    for (const [adgroup, where] of [
      ['200', /automatic placement/],
      ['201', /TikTok is a selected placement/],
    ]) {
      const r = await f.prepare(adgroup, custom());
      assert.equal(r.error?.code, 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', JSON.stringify(r.error));
      assert.match(r.error.message, where);
      assert.match(r.error.message, /TT_USER or BC_AUTH_TT/);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('custom identity ads in a Pangle-only ad group and Spark ads anywhere are unaffected', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('202', custom());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    const spark = await f.prepare(
      '200',
      custom({
        identity_type: 'TT_USER',
        identity_id: 'tt-1',
        tiktok_item_id: '9001',
        video_id: undefined,
        image_ids: undefined,
      }),
    );
    assert.equal(spark.success, true, JSON.stringify(spark));
  } finally {
    f.store.close();
  }
});

test('the ad group placement is checked again before execution', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('202', custom());
    assert.equal(p.success, true);
    f.groups[202].placement_type = 'PLACEMENT_TYPE_AUTOMATIC';
    delete f.groups[202].placements;
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

// ---- r25-field-tiktok (#2): the classic create under an Upgraded Smart+ campaign ------------------------------------------

test('a classic ad create under an Upgraded Smart+ ad group is refused at prepare, before any write, naming the Smart+ route', async () => {
  const f = fixture();
  try {
    // A Spark ad and a custom identity ad alike: the route is wrong whatever the creative is, so its refusal comes first.
    for (const [name, creative] of [
      ['a Spark ad', sparkAd()],
      ['a custom identity ad', custom()],
    ]) {
      const r = await f.prepare('203', creative);
      assertRefused(r, 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {
        writes: () => f.writes.length,
        message: /tiktok_smart_plus_ad_create/,
      });
      assert.match(r.error.message, /203/, name);
      assert.match(r.error.message, /UPGRADED_SMART_PLUS/, name);
      assert.equal(r.error.details.adgroup_id, '203', name);
      assert.equal(r.error.details.campaign_automation_type, 'UPGRADED_SMART_PLUS', name);
      assert.equal(r.error.details.use_action, 'tiktok_smart_plus_ad_create', name);
      // The call that goes on: the same ad group on the Smart+ route.
      assert.equal(r.error.details.next_call.tool, 'amcp_write', name);
      assert.equal(r.error.details.next_call.arguments.action, 'inspect', name);
      assert.equal(r.error.details.next_call.arguments.gateway, gateway, name);
      assert.deepEqual(
        r.error.details.next_call.arguments.arguments,
        {action: 'tiktok_smart_plus_ad_create', account_id: account, payload: {adgroup_id: '203'}},
        name,
      );
    }
    assert.ok(
      f.requests.every(r => r.startsWith('GET ')),
      'only reads were sent: ' + f.requests.join(', '),
    );
  } finally {
    f.store.close();
  }
});

test('the route is checked again before execution', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('204', sparkAd());
    assert.equal(p.success, true, JSON.stringify(p));
    f.groups[204].campaign_automation_type = 'UPGRADED_SMART_PLUS';
    assertRefused(await f.execute(p.data.review_id), 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {
      writes: () => f.writes.length,
    });
  } finally {
    f.store.close();
  }
});

test('a classic ad create under a manual, a legacy Smart+ or an unlabelled ad group is unchanged', async () => {
  const f = fixture();
  try {
    // Only UPGRADED_SMART_PLUS is refused. A row without the field (200) keeps what it did before the check existed.
    for (const adgroup of ['200', '204', '205']) {
      const p = await f.prepare(adgroup, sparkAd());
      assert.equal(p.success, true, adgroup + ': ' + JSON.stringify(p.error ?? p.data).slice(0, 300));
    }
    const p = await f.prepare('204', sparkAd());
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('the other gates of the classic create stay as they are', async () => {
  const f = fixture();
  try {
    // A manual ad group (204), so none of these meets the route check: each is refused by its own gate.
    const topLevelStatus = await f.prepareBody({
      advertiser_id: account,
      adgroup_id: '204',
      operation_status: 'DISABLE',
      creatives: [sparkAd()],
    });
    assertRefused(topLevelStatus, 'INVALID_ARGUMENT', {writes: () => f.writes.length, message: /operation_status/});
    const two = await f.prepareBody({
      advertiser_id: account,
      adgroup_id: '204',
      creatives: [sparkAd(), sparkAd({ad_name: 'Second'})],
    });
    assertRefused(two, 'WRITE_CONTRACT_UNAVAILABLE', {writes: () => f.writes.length});
    assertRefused(await f.prepare('204', custom()), 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', {
      writes: () => f.writes.length,
    });
    assertRefused(await f.prepare('204', sparkAd({call_to_action_id: '700'})), 'INVALID_TIKTOK_CTA_PORTFOLIO', {
      writes: () => f.writes.length,
    });
  } finally {
    f.store.close();
  }
});

// ---- r25-m4-classic: the classic ad group create under an Upgraded Smart+ campaign (the twin of #2) --------------------------------------
// "Get campaigns" filters by campaign_automation_type (MANUAL, SMART_PLUS or UPGRADED_SMART_PLUS), so the campaign row an ad group create
// already reads can say it. The row returns the field (the documentation session of 2026-11-20 confirmed it; live check M4 LV-23 reads it once
// more): a row without it keeps what it did.

test('a classic ad group create under an Upgraded Smart+ campaign is refused at prepare, before any write, naming the Smart+ route and the call that goes on', async () => {
  const f = fixture();
  try {
    const r = await f.prepareGroup('300');
    assertRefused(r, 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {
      writes: () => f.writes.length,
      message: /tiktok_smart_plus_adgroup_create/,
    });
    assert.match(r.error.message, /300/);
    assert.match(r.error.message, /UPGRADED_SMART_PLUS/);
    assert.equal(r.error.details.campaign_id, '300');
    assert.equal(r.error.details.campaign_automation_type, 'UPGRADED_SMART_PLUS');
    assert.equal(r.error.details.use_action, 'tiktok_smart_plus_adgroup_create');
    assert.equal(r.error.details.field, 'campaign_id');
    // The call that goes on: the same campaign on the Smart+ route.
    assert.equal(r.error.details.next_call.tool, 'amcp_write');
    assert.deepEqual(r.error.details.next_call.arguments, {
      action: 'inspect',
      gateway,
      arguments: {action: 'tiktok_smart_plus_adgroup_create', account_id: account, payload: {campaign_id: '300'}},
    });
    assert.ok(
      f.requests.every(q => q.startsWith('GET ')),
      'only reads were sent: ' + f.requests.join(', '),
    );
  } finally {
    f.store.close();
  }
});

test('the route of a classic ad group create is checked again before execution', async () => {
  const f = fixture();
  try {
    const p = await f.prepareGroup('301');
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
    f.campaigns[301].campaign_automation_type = 'UPGRADED_SMART_PLUS';
    assertRefused(await f.execute(p.data.review_id), 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {
      writes: () => f.writes.length,
    });
  } finally {
    f.store.close();
  }
});

test('a classic ad group create under a manual, a legacy Smart+ or an unlabelled campaign is unchanged', async () => {
  const f = fixture();
  try {
    // Only UPGRADED_SMART_PLUS is refused. A row without the field (303) keeps what it did before the check existed.
    for (const campaign of ['301', '302', '303']) {
      const p = await f.prepareGroup(campaign);
      assert.equal(p.success, true, campaign + ': ' + JSON.stringify(p.error ?? p.data).slice(0, 300));
      assert.deepEqual(
        p.data.state_reads.map(r => r.path),
        ['/v1.3/advertiser/info/', '/v1.3/campaign/get/'],
        campaign,
      );
    }
    const p = await f.prepareGroup('301');
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x.data).slice(0, 400));
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('the other gates of the classic ad group create stay as they are: an enabled ad group under a serving campaign prepares and asks for spend_change_confirmed, a paused campaign takes it, and the ad route check is untouched', async () => {
  const f = fixture();
  try {
    // An enabled ad group under a campaign that serves, whatever the automation type says: PARENT_SERVING until the merge of r25-m4-smartops (Q1,
    // owner 2026-11-15, the lead's design (b) of L5; merge r25-m4a-merge, merge 6), which lets it prepare and asks for spend_change_confirmed
    // instead (refused at execute without it: tests/tiktok-serving-parent-children.test.mjs). A parent it cannot read still refuses.
    const serving = await f.prepareGroup('304', {operation_status: 'ENABLE'});
    assert.equal(serving.success, true, JSON.stringify(serving.error ?? serving.data).slice(0, 300));
    assert.equal(
      serving.data.execute_requirements.spend_change_confirmed,
      true,
      'a serving campaign asks for the flag',
    );
    assert.equal(f.writes.length, 0, 'the prepare sent nothing');
    // A paused campaign accepts an enabled ad group, the one activation of a launch pack.
    const enabled = await f.prepareGroup('301', {operation_status: 'ENABLE'});
    assert.equal(enabled.success, true, JSON.stringify(enabled.error ?? enabled.data).slice(0, 300));
    // The ad route gate still refuses by the ad group's own row.
    assertRefused(await f.prepare('203', sparkAd()), 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {
      writes: () => f.writes.length,
      message: /tiktok_smart_plus_ad_create/,
    });
  } finally {
    f.store.close();
  }
});

test('the campaign row "Get campaigns" returns names its automation type: a Smart+ Search campaign is refused as Upgraded Smart+, a manual row prepares', async () => {
  const f = fixture();
  try {
    // The reference row the lead read live: UPGRADED_SMART_PLUS, a Search campaign, objective TRAFFIC. Search and Traffic are never the
    // cut-off's, so the refusal is the route's own.
    const r = await f.prepareGroup('305');
    assertRefused(r, 'TIKTOK_SMART_PLUS_ROUTE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(r.error.details.campaign_id, '305');
    assert.equal(r.error.details.campaign_automation_type, 'UPGRADED_SMART_PLUS');
    // A manual row with the documented fields prepares, and its type is kept in the review's before-state.
    const p = await f.prepareGroup('306');
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 300));
    assert.match(JSON.stringify(p.data.before_state), /"campaign_automation_type":"MANUAL"/);
  } finally {
    f.store.close();
  }
});
