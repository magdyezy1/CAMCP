import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Paused Upgraded Smart+ Instant Form lead generation Spark Ads (API for Business v1.3, checked 2026-09-26). The form
 * goes in page_list; /page/get/ cannot filter by page ID, so the review reads the advertiser's published forms by page.
 */
const TIKTOK = '29292929-2929-4292-8292-292929292929',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-lead-ads', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 88).toString('base64');
const post = item => ({
  creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1'},
});
const ad = (extra = {}) => ({
  advertiser_id: account,
  adgroup_id: '310',
  ad_name: 'Lead form ad',
  operation_status: 'DISABLE',
  creative_list: [post('9001')],
  page_list: [{page_id: '7700149'}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  },
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
    300: {
      adgroup_id: '300',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    310: {
      adgroup_id: '310',
      promotion_type: 'LEAD_GENERATION',
      promotion_target_type: 'INSTANT_PAGE',
      optimization_goal: 'LEAD_GENERATION',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
  };
  // 150 published forms over two pages of 100; the ad's form is on the second page. Drafts are not returned by the status filter.
  const forms = Array.from({length: 150}, (_, i) => ({
    page_id: String(7700000 + i),
    status: 'PUBLISHED',
    title: 'Form ' + i,
    preview_url: 'https://example.test/p/' + i + '?sig=' + Math.random(),
  }));
  const ads = {},
    requests = [],
    writes = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (path === '/v1.3/page/get/' ? ' p' + q('page') : ''));
    if (path === '/v1.3/smart_plus/adgroup/get/') {
      const ids = JSON.parse(q('filtering')).adgroup_ids;
      const list = ids.filter(i => groups[i]).map(i => structuredClone(groups[i]));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (path === '/v1.3/smart_plus/ad/get/') {
      const f = JSON.parse(q('filtering'));
      const list = Object.values(ads)
        .filter(a =>
          f.smart_plus_ad_ids ? f.smart_plus_ad_ids.includes(a.smart_plus_ad_id) : f.adgroup_ids.includes(a.adgroup_id),
        )
        .map(a => structuredClone(a));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (path === '/v1.3/identity/info/')
      return ok({
        identity_info: {
          identity_id: q('identity_id'),
          identity_type: q('identity_type'),
          available_status: 'AVAILABLE',
          can_pull_video: true,
          is_gpppa: false,
        },
      });
    if (path === '/v1.3/identity/video/info/')
      return ok({
        video_details: JSON.parse(q('item_ids')).map(id => ({
          item_id: id,
          item_type: 'VIDEO',
          status: 'ITEM_STATUS_HESITATE_RECOMMEND',
        })),
      });
    if (path === '/v1.3/creative/portfolio/get/')
      return ok({portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]});
    if (path === '/v1.3/page/get/') {
      assert.equal(q('library_id'), null, 'never a Business Center library');
      const page = Number(q('page')),
        size = Number(q('page_size')),
        list =
          q('status') === 'PUBLISHED' && q('business_type') === 'LEAD_GEN'
            ? forms.slice((page - 1) * size, page * size)
            : [];
      return ok({
        list: structuredClone(list),
        page_info: {page, page_size: size, total_number: forms.length, total_page: Math.ceil(forms.length / size)},
      });
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const id = String(6000 + writes.length);
      ads[id] = {
        smart_plus_ad_id: id,
        adgroup_id: b.adgroup_id,
        ad_name: b.ad_name,
        operation_status: b.operation_status,
        creative_list: b.creative_list,
        page_list: b.page_list,
        ad_configuration: b.ad_configuration,
      };
      return ok(structuredClone(ads[id]));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = payload =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: 'tiktok_smart_plus_ad_create', account_id: account, payload},
    });
  const execute = id => call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {store, forms, requests, writes, call, prepare, execute, verify};
}

test('an Instant Form ad reads the advertiser forms page by page, is created paused once and verifies', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 500));
    assert.deepEqual(
      f.requests.filter(r => r.includes('/page/get/')),
      ['GET /v1.3/page/get/ p1', 'GET /v1.3/page/get/ p2'],
      'the second page is read because the first names two pages',
    );
    assert.deepEqual(p.data.creative_impact.destination, {instant_form: '7700149'});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes[0].page_list, [{page_id: '7700149'}]);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('the destination must match the ad group and the form must be published and the advertiser own', async () => {
  const f = fixture();
  try {
    for (const [payload, code, message] of [
      [
        ad({landing_page_url_list: [{landing_page_url: 'https://example.test/'}]}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /no landing_page_url_list/,
      ],
      [ad({page_list: [{page_id: '7700149'}, {page_id: '7700001'}]}), 'INVALID_TIKTOK_SMART_PLUS_AD', /exactly one/],
      [
        ad({
          ad_configuration: {
            call_to_action_id: '700',
            creative_auto_add_toggle: false,
            creative_auto_enhancement_strategy_list: [],
            utm_params: [{key: 'utm_source', value: 'tiktok'}],
          },
        }),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /no landing page/,
      ],
      [ad({adgroup_id: '300'}), 'INVALID_TIKTOK_SMART_PLUS_AD', /need landing_page_url_list/],
      [
        ad({page_list: undefined, landing_page_url_list: [{landing_page_url: 'https://example.test/'}]}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /need page_list/,
      ],
      [ad({page_list: [{page_id: '7799999'}]}), 'STATE_TARGET_MISMATCH', /not a published Instant Form/],
    ]) {
      const r = await f.prepare(JSON.parse(JSON.stringify(payload)));
      assert.equal(r.error?.code, code, JSON.stringify(r.error).slice(0, 300));
      assert.match(r.error.message, message);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('advertisers with more published forms than the review reads are refused when the form is not found', async () => {
  const f = fixture();
  try {
    f.forms.push(...Array.from({length: 1000}, (_, i) => ({page_id: String(7800000 + i), status: 'PUBLISHED'})));
    const r = await f.prepare(ad({page_list: [{page_id: '7799998'}]}));
    assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD', JSON.stringify(r.error).slice(0, 300));
    assert.match(r.error.message, /more than 1000 published Instant Forms/);
    assert.equal(f.requests.filter(x => x.includes('/page/get/')).length, 10);
  } finally {
    f.store.close();
  }
});

test('page reads stay inside the advertiser: a Business Center library read is refused', async () => {
  const f = fixture();
  try {
    const own = await f.call('tiktok_native_action', {
      action: 'tiktok_page_get',
      advertiser_id: account,
      connection_id: TIKTOK,
      params: {business_type: 'LEAD_GEN'},
    });
    assert.equal(own.success, true, JSON.stringify(own).slice(0, 300));
    const library = await f.call('tiktok_native_action', {
      action: 'tiktok_page_get',
      advertiser_id: account,
      connection_id: TIKTOK,
      params: {library_id: '555'},
    });
    assert.notEqual(library.success, true, JSON.stringify(library).slice(0, 300));
  } finally {
    f.store.close();
  }
});
