import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * A synthetic TikTok advertiser for the Smart+ edits of r25-m4-smartedits (the pixel of a Smart+ ad, T5, and the schedule
 * of a Smart+ ad group, T6), shaped as API for Business v1.3 returns it ("Get Upgraded Smart+ Ads", "Get Upgraded Smart+ Ad
 * Groups", "Get pixels"); it is also the data of journey J17 (the lead's merge-gate harness). Synthetic IDs only.
 *
 * `editsWorld` is the advertiser and its fetch-like handler, with no service in it, so that the journey harness can serve
 * it as it serves another provider. `editsFixture` puts a MirrorService in front of it, with the helpers a test calls.
 *
 * What the ads and ad groups are:
 * - Instant Form lead ads (AMCP's lead ads: LEAD_GENERATION and INSTANT_PAGE, `page_list`, no landing page) in ad group
 *   310; 311 has its own pixel (7002), 312 reads the pixel "0" (none), 313 sends people to an external website (outside
 *   the documented scenarios of an ad-level pixel). Ad 5201 is a lead ad whose read has no `landing_page_url_list` at all.
 * - Website Spark ads: 5100 in a CLICK ad group (304, no pixel), 5101 in a CONVERT ad group with a pixel (300), 5305 in a catalog
 *   ad group (305), 5102 an uploaded video under a custom identity (outside the Spark edit contract: since r25-m4b-smartpush (E12) an
 *   upload under a TikTok account is an ad of uploads and is edited, so this one holds the identity that keeps the ad name-only), 5400
 *   as TikTok returned a UI-made ad (no automatic add switch, a
 *   `null`-padded list, and the keys `catalog_creative_toggle` and `dark_post_status`).
 * - Ad groups for the schedule: 320 starts later and has a total budget (SCHEDULE_START_END), 321 has started, 322 runs from
 *   now and started five days ago, 323 starts later and ends soon, 324 starts later, is enabled and has no total budget (a
 *   SCHEDULE_START_END group without one: AMCP's own create allowed it before r25-m4-smartweb, and TikTok's UI makes them),
 *   325 runs from now and has not started (SCHEDULE_FROM_NOW with a start in the future).
 */
export const gateway = 'tiktok_native_action',
  account = '123',
  TIKTOK = '31313131-3131-4313-8313-313131313131';
export const actor = {tenantId: 'tiktok-smart-plus-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 91).toString('base64');
const day = 86400000;
/** A UTC time as TikTok writes it: "YYYY-MM-DD HH:MM:SS". */
export const utcText = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export const post = (item, format = 'SINGLE_VIDEO', extra = {}) => ({
  creative_info: {ad_format: format, tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1', ...extra},
});
/** The creatives as TikTok keeps them: with material IDs, and the disclosure type it adds. */
export const stored = list =>
  list.map((c, i) => ({
    ad_material_id: 'm' + i,
    material_operation_status: 'ENABLE',
    creative_info: {...c.creative_info, aigc_disclosure_type: 'NOT_DECLARED'},
  }));
/** The qualified keys of an ad_configuration, the CTA portfolio 700 and both automatic switches stated. */
export const config = (extra = {}) => ({
  call_to_action_id: '700',
  creative_auto_add_toggle: false,
  creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
  ...extra,
});
/** What TikTok returns beside them for an ad that sets no pixel (the reads of 2026-11-21: "0" is no pixel). */
export const readDefaults = () => ({
  tracking_info: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'},
  product_specific_type: 'UNSET',
  dark_post_status: 'ON',
});

const lead = (id, extra = {}) => ({
  adgroup_id: id,
  campaign_id: '81',
  promotion_type: 'LEAD_GENERATION',
  promotion_target_type: 'INSTANT_PAGE',
  optimization_goal: 'LEAD_GENERATION',
  placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
  operation_status: 'DISABLE',
  ...extra,
});
const web = (id, extra = {}) => ({
  adgroup_id: id,
  campaign_id: '80',
  promotion_type: 'WEBSITE',
  placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
  operation_status: 'DISABLE',
  ...extra,
});
const spark = (id, group, extra = {}) => ({
  smart_plus_ad_id: id,
  adgroup_id: group,
  ad_name: 'Spark ' + id,
  operation_status: 'DISABLE',
  creative_list: stored([post('9001'), post('9002', 'CAROUSEL_ADS')]),
  landing_page_url_list: [{landing_page_url: 'https://shop.example.test/sale?utm_source=tiktok'}],
  ad_configuration: config({utm_params: [{key: 'utm_source', value: 'tiktok'}], ...readDefaults()}),
  ...extra,
});
const form = (id, group, extra = {}) => ({
  smart_plus_ad_id: id,
  adgroup_id: group,
  ad_name: 'Lead spark ' + id,
  operation_status: 'DISABLE',
  creative_list: stored([post('9001')]),
  page_list: [{page_id: '7700149'}],
  landing_page_url_list: [],
  ad_configuration: config(readDefaults()),
  ...extra,
});

/** The advertiser: rows by ID, the requests it saw, the writes it took, and how it behaves (`behaviour`, changed by a test). */
export function editsWorld({now = Date.now()} = {}) {
  const timed = (days, extra = {}) => ({
    schedule_type: 'SCHEDULE_START_END',
    schedule_start_time: utcText(now + days * day),
    schedule_end_time: utcText(now + 90 * day),
    ...extra,
  });
  const groups = {
    // Instant Form lead ad groups, and the website ad groups of the pixel edits.
    310: lead('310'),
    311: lead('311', {pixel_id: '7002'}),
    312: lead('312', {pixel_id: '0'}),
    313: lead('313', {promotion_target_type: 'EXTERNAL_WEBSITE'}),
    300: web('300', {optimization_goal: 'CONVERT', billing_event: 'OCPM', pixel_id: '7001'}),
    304: web('304', {optimization_goal: 'CLICK', billing_event: 'CPC', pixel_id: null}),
    // A website ad group of a catalog campaign (its row carries a catalog_id): not a qualified website group.
    305: web('305', {optimization_goal: 'CONVERT', billing_event: 'OCPM', pixel_id: '7001', catalog_id: '7100'}),
    306: {
      adgroup_id: '306',
      campaign_id: '82',
      promotion_type: 'APP_ANDROID',
      optimization_goal: 'INSTALL',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    // The ad groups of the schedule edits (a group starts, runs and ends in UTC, as "Get Upgraded Smart+ Ad Groups" says).
    320: web('320', {
      campaign_id: '90',
      adgroup_name: 'Starts later',
      optimization_goal: 'CONVERT',
      bid_type: 'BID_TYPE_NO_BID',
      budget_mode: 'BUDGET_MODE_TOTAL',
      budget: 500,
      ...timed(2),
    }),
    321: web('321', {
      campaign_id: '90',
      adgroup_name: 'Started',
      optimization_goal: 'CONVERT',
      budget_mode: 'BUDGET_MODE_TOTAL',
      budget: 500,
      ...timed(-3),
    }),
    322: web('322', {
      campaign_id: '91',
      adgroup_name: 'Runs from now',
      optimization_goal: 'CONVERT',
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 100,
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: utcText(now - 5 * day),
    }),
    323: web('323', {
      campaign_id: '92',
      adgroup_name: 'Starts later, ends soon',
      optimization_goal: 'CONVERT',
      budget_mode: 'BUDGET_MODE_TOTAL',
      budget: 500,
      ...timed(2, {schedule_end_time: utcText(now + 4 * day)}),
    }),
    324: web('324', {
      campaign_id: '93',
      adgroup_name: 'Starts later, enabled',
      optimization_goal: 'CONVERT',
      operation_status: 'ENABLE',
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 100,
      ...timed(2),
    }),
    325: web('325', {
      campaign_id: '94',
      adgroup_name: 'Runs from later',
      optimization_goal: 'CONVERT',
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 100,
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: utcText(now + 2 * day),
    }),
  };
  const ads = {
    5200: form('5200', '310'),
    5201: (() => {
      const a = form('5201', '310');
      delete a.landing_page_url_list;
      return a;
    })(),
    5211: form('5211', '311'),
    5213: form('5213', '313'),
    5100: spark('5100', '304'),
    5101: spark('5101', '300'),
    5102: {
      smart_plus_ad_id: '5102',
      adgroup_id: '300',
      ad_name: 'Uploaded video',
      operation_status: 'DISABLE',
      creative_list: [
        {
          ad_material_id: 'm0',
          creative_info: {
            ad_format: 'SINGLE_VIDEO',
            video_info: {video_id: 'v1'},
            image_info: [{web_uri: 'img-1'}],
            identity_type: 'CUSTOMIZED_USER',
            identity_id: 'custom-1',
          },
        },
      ],
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/'}],
      ad_configuration: config({utm_params: [], ...readDefaults()}),
    },
    5305: spark('5305', '305'),
    // A Spark ad whose ad group is an app install group: a pixel there is no documented scenario of AMCP's.
    5300: spark('5300', '306'),
    // As TikTok returned the reference ad of a UI-made campaign: no automatic add switch, a list padded with null, catalog_creative_toggle.
    5400: spark('5400', '304', {
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', null, null],
        utm_params: [{key: 'utm_source', value: 'tiktok'}],
        ...readDefaults(),
        catalog_creative_toggle: false,
      },
    }),
  };
  const pixels = {
    7001: {pixel_id: '7001', pixel_code: 'C7001', pixel_name: 'Site pixel', asset_ownership: {ownership_status: true}},
    7002: {
      pixel_id: '7002',
      pixel_code: 'C7002',
      pixel_name: 'Second pixel',
      asset_ownership: {ownership_status: true},
    },
    7005: {
      pixel_id: '7005',
      pixel_code: 'C7005',
      pixel_name: 'Agency pixel',
      asset_ownership: {ownership_status: false, asset_relation_status: 'SHARED'},
    },
    7006: {
      pixel_id: '7006',
      pixel_code: 'C7006',
      pixel_name: 'Old pixel',
      asset_ownership: {ownership_status: false, asset_relation_status: 'UNBOUND'},
    },
  };
  const identities = {'TT_USER:tt-1': {available_status: 'AVAILABLE', can_pull_video: true, is_gpppa: false}};
  const posts = {'tt-1': {9001: 'VIDEO', 9002: 'CAROUSEL', 9003: 'VIDEO'}};
  const portfolios = {
    700: {portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]},
    701: {
      creative_portfolio_id: '701',
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
  };
  /**
   * `update`: how TikTok treats the keys of a new ad_configuration it is not sent: 'merge' keeps them, 'replace' drops them
   * ("Update an Upgraded Smart+ Ad" says only that the update is incremental, so both are possible). `pixel`: what the ad
   * keeps of a tracking_pixel_id it accepts: 'stored', 'dropped' (accepted and not kept: the read shows "0") or 'refused'
   * (code 40002). `extras`: what a read of an ad adds to its tracking_info beyond what was sent. `mode`: 'lost' loses the
   * answer of a write, 'error' answers code 40002.
   */
  const behaviour = {update: 'merge', pixel: 'stored', extras: {}, mode: ''};
  const requests = [],
    writes = [];
  let n = 0,
    signed = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const list = rows => ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
  const refusal = message => Response.json({code: 40002, message, request_id: 'r' + ++n, data: {}});
  /** An ad as a read returns it: what a read adds to its tracking_info beyond what was sent. */
  const read = ad => {
    const row = structuredClone(ad);
    if (row.ad_configuration?.tracking_info && Object.keys(behaviour.extras).length)
      row.ad_configuration.tracking_info = {...behaviour.extras, ...row.ad_configuration.tracking_info};
    return row;
  };
  const handle = async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path + (path === '/v1.3/pixel/list/' ? ' ' + q('pixel_id') : ''));
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      const f = JSON.parse(q('filtering'));
      return list(
        Object.values(groups)
          .filter(g => (f.adgroup_ids ? f.adgroup_ids.includes(g.adgroup_id) : f.campaign_ids.includes(g.campaign_id)))
          .map(g => structuredClone(g)),
      );
    }
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/') {
      const f = JSON.parse(q('filtering'));
      return list(
        Object.values(ads)
          .filter(a =>
            f.smart_plus_ad_ids
              ? f.smart_plus_ad_ids.includes(a.smart_plus_ad_id)
              : f.adgroup_ids.includes(a.adgroup_id),
          )
          .map(read),
      );
    }
    if (method === 'GET' && path === '/v1.3/pixel/list/') {
      const p = pixels[q('pixel_id')];
      return ok({
        pixels: p ? [structuredClone(p)] : [],
        page_info: {page: 1, page_size: 10, total_number: p ? 1 : 0, total_page: 1},
      });
    }
    if (method === 'GET' && path === '/v1.3/identity/info/') {
      const i = identities[q('identity_type') + ':' + q('identity_id')];
      return i
        ? ok({
            identity_info: {
              identity_id: q('identity_id'),
              identity_type: q('identity_type'),
              profile_image_url: 'https://p16.example.test/a.jpeg?x-signature=' + ++signed,
              ...i,
            },
          })
        : refusal('Identity does not exist');
    }
    if (method === 'GET' && path === '/v1.3/identity/video/info/') {
      const own = posts[q('identity_id')] ?? {};
      return ok({
        video_details: JSON.parse(q('item_ids'))
          .filter(id => own[id])
          .map(id => ({
            item_id: id,
            item_type: own[id],
            status: 'ITEM_STATUS_HESITATE_RECOMMEND',
            video_info: {url: 'https://v16.example.test/' + id + '.mp4?x-expires=' + ++signed},
          })),
      });
    }
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/') {
      const p = portfolios[q('creative_portfolio_id')];
      return p ? ok(structuredClone(p)) : refusal('Creative portfolio does not exist');
    }
    // The published Instant Forms of the advertiser, read when an ad names a form.
    if (method === 'GET' && path === '/v1.3/page/get/')
      return ok({
        list: [{page_id: '7700149', status: 'PUBLISHED', title: 'Form'}],
        page_info: {page: 1, page_size: Number(q('page_size')), total_number: 1, total_page: 1},
      });
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const id = String(5600 + writes.length);
      ads[id] = {
        smart_plus_ad_id: id,
        adgroup_id: b.adgroup_id,
        ad_name: b.ad_name,
        operation_status: b.operation_status,
        creative_list: stored(b.creative_list),
        ...(b.page_list !== undefined ? {page_list: b.page_list, landing_page_url_list: []} : {}),
        ...(b.landing_page_url_list !== undefined ? {landing_page_url_list: b.landing_page_url_list} : {}),
        ad_configuration: {...b.ad_configuration, ...(b.ad_configuration.tracking_info ? {} : readDefaults())},
      };
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return behaviour.mode === 'error' ? refusal('Pixel is not valid for this ad') : ok(read(ads[id]));
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const a = ads[b.smart_plus_ad_id],
        sent = b.ad_configuration?.tracking_info?.tracking_pixel_id;
      if (behaviour.mode === 'error' || (behaviour.pixel === 'refused' && sent !== undefined && sent !== '0'))
        return refusal('tracking_pixel_id is not valid for this ad');
      if (b.ad_name !== undefined) a.ad_name = b.ad_name;
      if (b.creative_list) a.creative_list = stored(b.creative_list);
      if (b.landing_page_url_list) a.landing_page_url_list = b.landing_page_url_list;
      if (b.ad_configuration) {
        const next = structuredClone(b.ad_configuration);
        if (behaviour.pixel === 'dropped' && next.tracking_info?.tracking_pixel_id !== undefined)
          next.tracking_info.tracking_pixel_id = '0';
        a.ad_configuration =
          behaviour.update === 'replace'
            ? next
            : {
                ...a.ad_configuration,
                ...next,
                ...(next.tracking_info
                  ? {tracking_info: {...a.ad_configuration.tracking_info, ...next.tracking_info}}
                  : {}),
              };
      }
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return ok(read(a));
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const {advertiser_id, adgroup_id, ...changes} = b;
      void advertiser_id;
      if (behaviour.mode === 'error') return refusal('Schedule is not valid for this ad group');
      Object.assign(groups[adgroup_id], changes);
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return ok(structuredClone(groups[adgroup_id]));
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  };
  return {groups, ads, pixels, identities, posts, portfolios, behaviour, requests, writes, handle, now};
}

/**
 * The advertiser behind a MirrorService with a connection to it (a write-capable one), and the calls a test makes:
 * `prepare(payload, extra, action)` of an ad edit (or any native action), `execute(reviewId, extra)`, `verify(reviewId)`.
 * `restart()` builds a new service on the same store, as a server restart does.
 */
export function editsFixture({now = Date.now()} = {}) {
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
  const w = editsWorld({now}),
    transport = new NativeTransport(w.handle);
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input) => service.call(tool, input, actor);
  const args = (payload, action = 'tiktok_smart_plus_ad_update') => ({action, account_id: account, payload});
  const prepare = (payload, extra = {}, action) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action), ...extra});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  /** Prepares the group's edit (the ad group update action). */
  const prepareGroup = (payload, extra = {}) => prepare(payload, extra, 'tiktok_smart_plus_adgroup_update');
  return {
    ...w,
    store,
    call,
    args,
    prepare,
    prepareGroup,
    execute,
    verify,
    restart: () => {
      service = start();
    },
    /** Prepares a request and returns its review, failing the test with the answer when it was refused. */
    async prepared(payload, extra, action) {
      const p = await prepare(payload, extra, action);
      assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 600));
      return p;
    },
    /** Prepares an ad group edit and returns its review, failing the test with the answer when it was refused. */
    async preparedGroup(payload, extra) {
      const p = await prepareGroup(payload, extra);
      assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 600));
      return p;
    },
  };
}
