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
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, groups, requests, writes, prepare, prepareBody, execute, verify};
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
