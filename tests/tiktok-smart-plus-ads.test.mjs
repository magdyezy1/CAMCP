import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {tiktokSmartPlusAdState} from '../dist/src/tiktok-smart-plus-ads.js';

/**
 * Paused Upgraded Smart+ website Spark Ads from existing TikTok posts (API for Business v1.3, checked 2026-09-26; the
 * website goals CLICK and TRAFFIC_LANDING_PAGE_VIEW beside CONVERT, "Create a regular Upgraded Smart+ Web Campaign",
 * checked 2026-11-19). Media and profile URLs are signed per read, so they must never look like a state change.
 */
const TIKTOK = '23232323-2323-4232-8232-232323232323',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-ads', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 80).toString('base64');
const url = 'https://shop.example.test/sale?utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__';
const ad = (extra = {}, configuration = {}) => ({
  advertiser_id: account,
  adgroup_id: '300',
  ad_name: 'Spark sale',
  operation_status: 'DISABLE',
  creative_list: [
    {creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: '9001', identity_type: 'TT_USER', identity_id: 'tt-1'}},
    {creative_info: {ad_format: 'CAROUSEL_ADS', tiktok_item_id: '9002', identity_type: 'TT_USER', identity_id: 'tt-1'}},
    {
      creative_info: {
        ad_format: 'SINGLE_VIDEO',
        tiktok_item_id: '9101',
        identity_type: 'BC_AUTH_TT',
        identity_id: 'bc-1',
        identity_authorized_bc_id: '7000',
      },
    },
  ],
  landing_page_url_list: [{landing_page_url: url}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', 'MUSIC_REFRESH'],
    utm_params: [
      {key: 'utm_source', value: 'tiktok'},
      {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
    ],
    ...configuration,
  },
  ...extra,
});
const post = (item, extra = {}) => ({
  creative_info: {
    ad_format: 'SINGLE_VIDEO',
    tiktok_item_id: item,
    identity_type: 'TT_USER',
    identity_id: 'tt-1',
    ...extra,
  },
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
    300: {
      adgroup_id: '300',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    301: {
      adgroup_id: '301',
      campaign_id: '81',
      promotion_type: 'LEAD_GENERATION',
      optimization_goal: 'LEAD_GENERATION',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    302: {
      adgroup_id: '302',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_PANGLE'],
      operation_status: 'DISABLE',
    },
    303: {
      adgroup_id: '303',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE'],
      operation_status: 'DISABLE',
    },
    // Website ad groups that optimize for clicks (CPC) or landing page views: TikTok documents no pixel for either goal.
    304: {
      adgroup_id: '304',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      pixel_id: null,
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    305: {
      adgroup_id: '305',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'TRAFFIC_LANDING_PAGE_VIEW',
      billing_event: 'OCPM',
      pixel_id: null,
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    // Ad groups outside the contract: an app install, a lead ad group that leaves the platform, a value goal and catalog web
    // ad groups (TikTok returns catalog_id only for a catalog campaign).
    306: {
      adgroup_id: '306',
      campaign_id: '82',
      promotion_type: 'APP_ANDROID',
      optimization_goal: 'INSTALL',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    307: {
      adgroup_id: '307',
      campaign_id: '81',
      promotion_type: 'LEAD_GENERATION',
      promotion_target_type: 'EXTERNAL_WEBSITE',
      optimization_goal: 'LEAD_GENERATION',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    308: {
      adgroup_id: '308',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'VALUE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    309: {
      adgroup_id: '309',
      campaign_id: '83',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      catalog_id: '7100',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    310: {
      adgroup_id: '310',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_PANGLE'],
      operation_status: 'DISABLE',
    },
    311: {
      adgroup_id: '311',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    312: {
      adgroup_id: '312',
      campaign_id: '83',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      catalog_id: '7100',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    // An ad group one ad short of TikTok's limit of 30 (the sibling-ad tests below).
    313: {
      adgroup_id: '313',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
  };
  const ads = {4000: {smart_plus_ad_id: '4000', adgroup_id: '300', ad_name: 'Existing', operation_status: 'DISABLE'}};
  for (const [group, from, count] of [
    ['303', 4100, 30],
    ['311', 4200, 30],
    ['313', 4300, 29],
  ])
    for (let i = 0; i < count; i++)
      ads[from + i] = {
        smart_plus_ad_id: String(from + i),
        adgroup_id: group,
        ad_name: 'Full ' + i,
        operation_status: 'DISABLE',
      };
  const identities = {
    'TT_USER:tt-1': {available_status: 'AVAILABLE', can_pull_video: true, is_gpppa: false},
    'BC_AUTH_TT:bc-1': {
      identity_authorized_bc_id: '7000',
      available_status: 'AVAILABLE',
      can_pull_video: true,
      is_gpppa: false,
    },
    'TT_USER:tt-private': {available_status: 'IS_PRIVATE_ACCOUNT', can_pull_video: true, is_gpppa: false},
    'TT_USER:tt-nopull': {available_status: 'AVAILABLE', can_pull_video: false, is_gpppa: false},
    'TT_USER:tt-gov': {available_status: 'AVAILABLE', can_pull_video: true, is_gpppa: true},
  };
  const posts = {
    'tt-1': {9001: 'VIDEO', 9002: 'CAROUSEL', 9003: 'VIDEO'},
    'bc-1': {9101: 'VIDEO'},
    'tt-private': {9201: 'VIDEO'},
    'tt-nopull': {9301: 'VIDEO'},
    'tt-gov': {9401: 'VIDEO'},
  };
  const portfolios = {
    700: {portfolio_content: [{asset_ids: ['201781', '201535'], asset_content: 'learn_more'}]},
    701: {
      creative_portfolio_id: '701',
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
  };
  const requests = [],
    writes = [];
  let n = 0,
    signed = 0,
    mode = '',
    hold;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const list = rows => ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
  // TikTok documents item_ids as a JSON array in the query string.
  const ids = v => {
    const a = JSON.parse(v);
    assert.ok(Array.isArray(a), 'item_ids is a JSON array');
    return a;
  };
  const transport = new NativeTransport(async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/')
      return list(
        JSON.parse(q('filtering'))
          .adgroup_ids.filter(id => groups[id])
          .map(id => structuredClone(groups[id])),
      );
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/') {
      const f = JSON.parse(q('filtering')),
        rows = Object.values(ads).filter(a =>
          f.smart_plus_ad_ids ? f.smart_plus_ad_ids.includes(a.smart_plus_ad_id) : f.adgroup_ids.includes(a.adgroup_id),
        );
      return list(rows.map(a => (readBack && f.smart_plus_ad_ids ? readBack(structuredClone(a)) : structuredClone(a))));
    }
    if (method === 'GET' && path === '/v1.3/identity/info/') {
      const i = identities[q('identity_type') + ':' + q('identity_id')];
      if (!i) return Response.json({code: 40002, message: 'Identity does not exist', request_id: 'r' + ++n, data: {}});
      return ok({
        identity_info: {
          identity_id: q('identity_id'),
          identity_type: q('identity_type'),
          display_name: 'Synthetic',
          profile_image_url: 'https://p16.example.test/avatar.jpeg?x-signature=' + ++signed,
          username: 'synthetic',
          can_push_video: true,
          can_use_live_ads: false,
          can_manage_message: false,
          ...i,
        },
      });
    }
    if (method === 'GET' && path === '/v1.3/identity/video/info/') {
      const own = posts[q('identity_id')] ?? {};
      return ok({
        video_details: ids(q('item_ids'))
          .filter(id => own[id])
          .map(id => ({
            item_id: id,
            item_type: own[id],
            status: 'ITEM_STATUS_HESITATE_RECOMMEND',
            text: 'Synthetic post',
            carousel_info: null,
            video_info:
              own[id] === 'VIDEO'
                ? {
                    duration: 12.5,
                    width: 720,
                    height: 1280,
                    url: 'https://v16.example.test/' + id + '.mp4?x-expires=' + ++signed,
                    poster_url: 'https://p16.example.test/' + id + '.jpeg?x-expires=' + signed,
                  }
                : null,
          })),
      });
    }
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/') {
      const p = portfolios[q('creative_portfolio_id')];
      return p
        ? ok(structuredClone(p))
        : Response.json({code: 40002, message: 'Creative portfolio does not exist', request_id: 'r' + ++n, data: {}});
    }
    // The published Instant Forms of the advertiser, read when an ad names a form (the destination negative below).
    if (method === 'GET' && path === '/v1.3/page/get/')
      return ok({
        list: [{page_id: '7700149', status: 'PUBLISHED', title: 'Form'}],
        page_info: {page: 1, page_size: Number(q('page_size')), total_number: 1, total_page: 1},
      });
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const id = String(5000 + writes.length);
      // A create in flight: the ad does not exist yet (the concurrent-execute test below holds it here).
      if (hold) await hold;
      // TikTok adds material IDs and its own defaults, and returns lists in its own order.
      ads[id] = {
        smart_plus_ad_id: id,
        campaign_id: '80',
        adgroup_id: b.adgroup_id,
        ad_name: b.ad_name,
        operation_status: b.operation_status,
        secondary_status: 'AD_STATUS_DISABLE',
        creative_list: b.creative_list
          .map((c, i) => ({
            ad_material_id: 'm' + i,
            smart_plus_creative_id: 'c' + i,
            material_operation_status: 'ENABLE',
            creative_info: {...c.creative_info, material_name: '', aigc_disclosure_type: 'NOT_DECLARED'},
          }))
          .reverse(),
        landing_page_url_list: b.landing_page_url_list,
        ad_configuration: {
          ...b.ad_configuration,
          creative_auto_enhancement_strategy_list: [
            ...b.ad_configuration.creative_auto_enhancement_strategy_list,
          ].reverse(),
          utm_params: [...(b.ad_configuration.utm_params ?? [])].reverse(),
          product_specific_type: 'UNSET',
        },
      };
      if (mode === 'lost') throw new Error('Synthetic accepted response lost');
      return mode === 'error'
        ? Response.json({code: 40002, message: 'Post is not available for Spark Ads', request_id: 'r' + ++n, data: {}})
        : ok(structuredClone(ads[id]));
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
  const args = (payload, action = 'tiktok_smart_plus_ad_create') => ({action, account_id: account, payload});
  const prepare = (payload, action) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    store,
    groups,
    ads,
    identities,
    posts,
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
    // Holds every create in flight until the promise settles.
    hold: promise => {
      hold = promise;
    },
    restart: () => {
      service = start();
    },
  };
}

test('Smart+ Spark Ad creation is a reviewed TikTok family under both action names', async () => {
  const f = fixture();
  try {
    for (const action of ['tiktok_smart_plus_ad_create', 'tiktok_smart_ad_create']) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args(ad(), action),
      });
      assert.equal(r.data.review_contract_supported, true, action + ' ' + JSON.stringify(r));
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only paused Spark Ads from existing posts with explicit automatic switches are accepted, before any request', async () => {
  const f = fixture();
  try {
    const drop = (k, v = ad()) => {
        delete v[k];
        return v;
      },
      config = (k, v) => {
        const a = ad();
        if (v === undefined) delete a.ad_configuration[k];
        else a.ad_configuration[k] = v;
        return a;
      };
    const cases = {
      'enabled': [ad({operation_status: 'ENABLE'}), 'operation_status'],
      'default status': [drop('operation_status'), 'operation_status'],
      'automatic name': [ad({ad_name: ''}), 'ad_name'],
      'ad texts': [ad({ad_text_list: [{ad_text: 'Sale'}]}), 'ad_text_list'],
      'standard CTA': [ad({call_to_action_list: [{call_to_action: 'SHOP_NOW'}]}), 'call_to_action_list'],
      'sticker add-on': [ad({interactive_add_on_list: [{card_id: '701'}]}), 'interactive_add_on_list'],
      'upload (Spark Ads Push)': [
        ad({creative_list: [post('9001', {video_info: {video_id: 'v1'}})]}),
        'creative_list[0].creative_info.video_info',
      ],
      'custom identity': [
        ad({creative_list: [post('9001', {identity_type: 'CUSTOMIZED_USER'})]}),
        'creative_list[0].creative_info.identity_type',
      ],
      'authorization-code post': [
        ad({creative_list: [post('9001', {identity_type: 'AUTH_CODE'})]}),
        'creative_list[0].creative_info.identity_type',
      ],
      'business center missing': [
        ad({creative_list: [post('9101', {identity_type: 'BC_AUTH_TT', identity_id: 'bc-1'})]}),
        'creative_list[0].creative_info.identity_authorized_bc_id',
      ],
      'business center on TT_USER': [
        ad({creative_list: [post('9001', {identity_authorized_bc_id: '7000'})]}),
        'creative_list[0].creative_info.identity_authorized_bc_id',
      ],
      'repeated post': [
        ad({creative_list: [post('9001'), post('9001')]}),
        'creative_list[1].creative_info.tiktok_item_id',
      ],
      'too many posts': [
        ad({creative_list: Array.from({length: 21}, (_, i) => post(String(9500 + i)))}),
        'creative_list',
      ],
      'text post ID': [ad({creative_list: [post('video')]}), 'creative_list[0].creative_info.tiktok_item_id'],
      'unknown format': [
        ad({creative_list: [post('9001', {ad_format: 'CATALOG_CAROUSEL'})]}),
        'creative_list[0].creative_info.ad_format',
      ],
      'two landing pages': [
        ad({landing_page_url_list: [{landing_page_url: url}, {landing_page_url: 'https://example.test/'}]}),
        'landing_page_url_list',
      ],
      'ftp landing page': [
        ad({landing_page_url_list: [{landing_page_url: 'ftp://example.test/'}]}),
        'landing_page_url_list',
      ],
      'no configuration': [drop('ad_configuration'), 'ad_configuration'],
      'no CTA portfolio': [config('call_to_action_id'), 'ad_configuration.call_to_action_id'],
      'default auto-add': [config('creative_auto_add_toggle'), 'ad_configuration.creative_auto_add_toggle'],
      'default enhancements': [
        config('creative_auto_enhancement_strategy_list'),
        'ad_configuration.creative_auto_enhancement_strategy_list',
      ],
      'unknown enhancement': [
        config('creative_auto_enhancement_strategy_list', ['AI_AVATAR']),
        'ad_configuration.creative_auto_enhancement_strategy_list',
      ],
      'ads-only mode': [config('dark_post_status', 'ON'), 'ad_configuration.dark_post_status'],
      'UTM not in URL': [config('utm_params', [{key: 'utm_source', value: 'tiktok'}]), 'ad_configuration.utm_params'],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details?.field, field, name);
    }
    assert.equal((await f.prepare(ad({advertiser_id: '999'}))).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a Spark Ad reads its ad group, identities, posts and CTA portfolio, is created once and verifies despite TikTok additions', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      [
        '/v1.3/smart_plus/adgroup/get/',
        '/v1.3/smart_plus/ad/get/',
        '/v1.3/identity/info/',
        '/v1.3/identity/video/info/',
        '/v1.3/identity/info/',
        '/v1.3/identity/video/info/',
        '/v1.3/creative/portfolio/get/',
      ],
    );
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false);
    // r25-field-tiktok (#7): the ad group's ads are a counter in another form, so the review keeps whether it has room (it listed
    // `existing_ads`, the number of the ad group's ads, which a sibling ad created since would change).
    assert.equal(impact.ad_group.at_limit, false);
    assert.equal(impact.ad_group.limit, 30);
    assert.equal(impact.ad_group.existing_ads, undefined);
    assert.deepEqual(impact.automatic_creative, {
      creative_auto_add_toggle: false,
      creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', 'MUSIC_REFRESH'],
      fixed_after_creation: 'TRANSLATE_AND_DUB cannot be added or removed later (excluded).',
    });
    // Every read above signed new media and profile URLs; execution still sees the same state and needs no spending confirmation.
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x));
    assert.deepEqual(f.writes, [ad()]);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('ad groups, identities, posts and portfolios that cannot carry the ad are refused before any write', async () => {
  const f = fixture();
  try {
    const cases = [
      [
        'lead ad group without an Instant Form',
        ad({adgroup_id: '301'}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        // r25-field-tiktok (#1): the refusal names the qualified kinds (it said "neither a website conversion ad group ...").
        /CONVERT, CLICK or TRAFFIC_LANDING_PAGE_VIEW/,
      ],
      [
        'Pangle-only ad group',
        ad({adgroup_id: '302'}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /excludes the TikTok placement/,
      ],
      ['full ad group', ad({adgroup_id: '303'}), 'INVALID_TIKTOK_SMART_PLUS_AD', /already has 30 ads/],
      ['missing ad group', ad({adgroup_id: '399'}), 'STATE_TARGET_MISMATCH', /./],
      [
        'private account',
        ad({creative_list: [post('9201', {identity_id: 'tt-private'})]}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /not available \(IS_PRIVATE_ACCOUNT\)/,
      ],
      [
        'posts not usable',
        ad({creative_list: [post('9301', {identity_id: 'tt-nopull'})]}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /can_pull_video/,
      ],
      [
        'political account',
        ad({creative_list: [post('9401', {identity_id: 'tt-gov'})]}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /political party/,
      ],
      [
        'other business center',
        ad({
          creative_list: [
            post('9101', {identity_type: 'BC_AUTH_TT', identity_id: 'bc-1', identity_authorized_bc_id: '7999'}),
          ],
        }),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /Business Center 7000/,
      ],
      ['post of another account', ad({creative_list: [post('9101')]}), 'STATE_TARGET_MISMATCH', /./],
      ['photo post as video', ad({creative_list: [post('9002')]}), 'INVALID_TIKTOK_SMART_PLUS_AD', /CAROUSEL post/],
      ['display card as CTA', ad({}, {call_to_action_id: '701'}), 'INVALID_TIKTOK_CTA_PORTFOLIO', /CARD portfolio/],
    ];
    for (const [name, payload, code, message] of cases) {
      const r = await f.prepare(payload);
      assert.equal(r.error?.code, code, name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300));
      assert.match(r.error.message, message, name);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

// r25-field-tiktok (#1): TikTok documents WEBSITE ad groups that optimize for CLICK (CPC) or TRAFFIC_LANDING_PAGE_VIEW, with no
// pixel, as regular Upgraded Smart+ web ad groups whose ads use the same /smart_plus/ad/create/ step as CONVERT ("Create a
// regular Upgraded Smart+ Web Campaign", checked 2026-11-19). VALUE is documented too and stays out until someone asks.
for (const [group, goal] of [
  ['304', 'CLICK'],
  ['305', 'TRAFFIC_LANDING_PAGE_VIEW'],
])
  test(
    'a Spark Ad in a website ad group that optimizes for ' + goal + ' is reviewed, created once, verified and replayed',
    async () => {
      const f = fixture();
      try {
        assert.equal(f.groups[group].pixel_id, null, 'TikTok documents no pixel for this goal');
        const p = await f.prepare(ad({adgroup_id: group}));
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(p.data.creative_impact.may_affect_serving, false);
        assert.equal(p.data.creative_impact.ad_group.adgroup_id, group);
        // A paused create needs no spending confirmation (Q14); every ad-level gate ran on the same reads as a CONVERT group's.
        const x = await f.execute(p.data.review_id);
        assert.equal(x.success, true, JSON.stringify(x));
        assert.deepEqual(f.writes, [ad({adgroup_id: group})]);
        const v = await f.verify(p.data.review_id);
        assert.equal(v.data.status, 'verified', JSON.stringify(v));
        assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
        assert.equal(f.writes.length, 1);
      } finally {
        f.store.close();
      }
    },
  );

test('every ad-level gate still refuses on a CLICK ad group, before any write', async () => {
  const f = fixture();
  try {
    const config = (k, v) => {
      const a = ad({adgroup_id: '304'});
      if (v === undefined) delete a.ad_configuration[k];
      else a.ad_configuration[k] = v;
      return a;
    };
    const cases = [
      // [name, payload, code, field or message]
      [
        'enabled create',
        ad({adgroup_id: '304', operation_status: 'ENABLE'}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'operation_status',
      ],
      [
        'no CTA portfolio',
        config('call_to_action_id'),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'ad_configuration.call_to_action_id',
      ],
      [
        'default auto-add',
        config('creative_auto_add_toggle'),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'ad_configuration.creative_auto_add_toggle',
      ],
      [
        'default enhancements',
        config('creative_auto_enhancement_strategy_list'),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'ad_configuration.creative_auto_enhancement_strategy_list',
      ],
      [
        'UTM not in the landing page',
        config('utm_params', [{key: 'utm_source', value: 'tiktok'}]),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'ad_configuration.utm_params',
      ],
      [
        'Instant Form on a website ad group',
        ad(
          {adgroup_id: '304', page_list: [{page_id: '7700149'}], landing_page_url_list: undefined},
          {utm_params: undefined},
        ),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        'page_list',
      ],
      [
        'display card as CTA',
        ad({adgroup_id: '304'}, {call_to_action_id: '701'}),
        'INVALID_TIKTOK_CTA_PORTFOLIO',
        /CARD portfolio/,
      ],
      [
        'Pangle-only ad group',
        ad({adgroup_id: '310'}),
        'INVALID_TIKTOK_SMART_PLUS_AD',
        /excludes the TikTok placement/,
      ],
      ['ad group at the 30-ad limit', ad({adgroup_id: '311'}), 'INVALID_TIKTOK_SMART_PLUS_AD', /already has 30 ads/],
    ];
    for (const [name, payload, code, expected] of cases) {
      const r = await f.prepare(JSON.parse(JSON.stringify(payload)));
      assert.equal(r.error?.code, code, name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300));
      if (expected instanceof RegExp) assert.match(r.error.message, expected, name);
      else assert.equal(r.error.details?.field, expected, name);
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('ad groups of other kinds are still refused, and the refusal names the qualified kinds', async () => {
  const f = fixture();
  try {
    for (const [group, name] of [
      ['306', 'app install (APP_ANDROID, INSTALL)'],
      ['307', 'lead generation that leaves TikTok (LEAD_GENERATION, EXTERNAL_WEBSITE)'],
      ['308', 'website with the VALUE goal'],
      ['309', 'website conversions in a catalog campaign (catalog_id)'],
      ['312', 'website clicks in a catalog campaign (catalog_id)'],
    ]) {
      const r = await f.prepare(ad({adgroup_id: group}));
      assert.equal(
        r.error?.code,
        'INVALID_TIKTOK_SMART_PLUS_AD',
        name + ': ' + JSON.stringify(r.error ?? r.data).slice(0, 300),
      );
      assert.equal(r.error.details?.field, 'adgroup_id', name);
      assert.match(r.error.message, /CONVERT, CLICK or TRAFFIC_LANDING_PAGE_VIEW/, name);
      assert.match(r.error.message, /Instant Form lead generation ad group \(LEAD_GENERATION, INSTANT_PAGE\)/, name);
      assert.match(r.error.message, new RegExp('adgroup_id ' + group + ' is not an ad group'), name);
    }
    // A catalog is named for what it is, and the other kinds say what they are.
    assert.match((await f.prepare(ad({adgroup_id: '309'}))).error.message, /catalog_id/);
    assert.match((await f.prepare(ad({adgroup_id: '308'}))).error.message, /WEBSITE with the goal VALUE/);
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a website ad group whose catalog_id is empty is no catalog ad group', async () => {
  const f = fixture();
  try {
    // TikTok returns catalog_id only for a catalog campaign; an empty or null one is no catalog.
    for (const value of [null, '', '0']) {
      f.groups[304].catalog_id = value;
      const p = await f.prepare(ad({adgroup_id: '304'}));
      assert.equal(
        p.success,
        true,
        'catalog_id ' + JSON.stringify(value) + ': ' + JSON.stringify(p.error ?? '').slice(0, 300),
      );
    }
    f.groups[304].catalog_id = '7100';
    assert.equal((await f.prepare(ad({adgroup_id: '304'}))).error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
  } finally {
    f.store.close();
  }
});

test('the ad group is read again at execution: a CLICK ad group that became a catalog ad group refuses the create', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad({adgroup_id: '304'}));
    assert.equal(p.success, true);
    f.groups[304].catalog_id = '7100';
    const r = await f.execute(p.data.review_id);
    assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD', JSON.stringify(r.error));
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('enabling the Spark Ad created in a CLICK ad group still needs spending confirmation', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad({adgroup_id: '304'}));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
    const created = Object.values(f.ads).find(a => a.ad_name === 'Spark sale');
    const enable = await f.prepare(
      {smart_plus_ad_ids: [created.smart_plus_ad_id], operation_status: 'ENABLE'},
      'tiktok_smart_plus_ad_status_update',
    );
    assert.equal(enable.success, true, JSON.stringify(enable.error ?? enable.data).slice(0, 300));
    assert.equal(enable.data.execute_requirements.spend_change_confirmed, true, 'the prepare says it is needed');
    const refused = await f.execute(enable.data.review_id);
    assert.equal(refused.error?.code, 'SPEND_CONFIRMATION_REQUIRED', JSON.stringify(refused.error));
    assert.equal(f.writes.length, 1, 'nothing more was sent');
  } finally {
    f.store.close();
  }
});

test('changed read-backs are inconclusive; rejected or lost creations are never resubmitted; concurrent executions submit once', async () => {
  for (const [readBack, field] of [
    [a => ({...a, operation_status: 'ENABLE'}), '/operation_status'],
    [a => ({...a, creative_list: a.creative_list.slice(1)}), '/creative_list'],
  ]) {
    const f = fixture({readBack});
    try {
      const p = await f.prepare(ad());
      assert.equal((await f.execute(p.data.review_id)).success, true);
      const v = await f.verify(p.data.review_id);
      assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
      assert.deepEqual(v.data.checks[0].changed_fields, [field]);
    } finally {
      f.store.close();
    }
  }
  for (const [mode, first, again] of [
    // r25-m2-refusal (Q16): TikTok’s refusal here is code 40002 with no data in an HTTP 200 answer, which its return-code table defines as a refusal of the request: the review is rejected and its key retired (WRITE_REJECTED), not uncertain. A lost response stays uncertain.
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(ad());
      f.mode(mode);
      assert.equal((await f.execute(p.data.review_id)).error?.code, first, mode);
      f.mode('');
      f.restart();
      assert.equal((await f.execute(p.data.review_id)).error?.code, again, mode);
      assert.equal(f.writes.length, 1, mode);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare(ad());
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

test('dependencies are read again before execution', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad());
    f.identities['TT_USER:tt-1'].available_status = 'NO_VALID_BIND_ACCOUNT';
    const r = await f.execute(p.data.review_id);
    assert.equal(r.error?.code, 'INVALID_TIKTOK_SMART_PLUS_AD', JSON.stringify(r.error));
    assert.match(r.error.message, /NO_VALID_BIND_ACCOUNT/);
    f.identities['TT_USER:tt-1'].available_status = 'AVAILABLE';
    f.ads[4001] = {
      smart_plus_ad_id: '4001',
      adgroup_id: '300',
      ad_name: 'Added meanwhile',
      operation_status: 'DISABLE',
    };
    const q = await f.prepare(ad({ad_name: 'Second'}));
    delete f.posts['tt-1'][9002];
    assert.equal((await f.execute(q.data.review_id)).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

// ---- r25-field-tiktok (#6): every violation of the contract in one answer, and product_info_enabled ------------------------
// The contract used to refuse at the first rule a request broke, one call per rule. It now runs every independent rule and refuses
// once: the first violation is the message (and details.field), and details.violations lists them all. A request that breaks one
// rule is refused exactly as before. TikTok returns ad_configuration.product_info_enabled with the ad (UNSET, NON_CATALOG or
// CATALOG; "Create an Upgraded Smart+ Ad" and "Get Upgraded Smart+ Ads", checked 2026-11-19), so a body copied from a read must
// pass with UNSET, the default; the other modes are outside the contract.
// Round 2 (the lead's review, S3-1): the message of several violations is the first one's own sentence, as a refusal of that one
// rule says it, because the website looks a message up in its catalogue as it is: a message built as a template with the sentence
// as a value showed that sentence in English on an Arabic page. That there are more is in details (violations_count, the list) and
// in the remedy, worded for people, which has its own Arabic (tests/tiktok-smart-plus-violations-localization.test.mjs).
const fieldsOf = r => r.error.details.violations.map(v => v.field);
const severalRulesRemedy =
  'This request breaks more than one rule, and the message states the first. Correct every rule it breaks and prepare the request again; the details of the answer list each rule with its field and its sentence. Nothing was sent.';
/** The four faults of the field report in one create (its fourth, product_info_enabled, is refused now only for a value but UNSET). */
const faulty = () => {
  const body = ad({ad_text_list: [{ad_text: 'Sale'}], operation_status: 'ENABLE'}, {product_info_enabled: 'ON'});
  delete body.ad_configuration.creative_auto_enhancement_strategy_list;
  return body;
};
const faultyFields = [
  'ad_text_list',
  'operation_status',
  'ad_configuration.creative_auto_enhancement_strategy_list',
  'ad_configuration.product_info_enabled',
];

test('a Spark Ad that breaks several rules is refused once: the message is the first violation in its own sentence, and every one is listed and counted', async () => {
  const f = fixture();
  try {
    const r = await f.prepare(faulty());
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    const first =
      '"ad_text_list" is outside the qualified Smart+ Spark Ad contract; Spark Ads from existing posts use the post text.';
    assert.equal(r.error.details.field, 'ad_text_list', 'the first violation is still details.field');
    assert.deepEqual(fieldsOf(r), faultyFields);
    for (const v of r.error.details.violations) assert.deepEqual(Object.keys(v).sort(), ['field', 'message']);
    assert.equal(r.error.details.violations[0].message, first);
    assert.equal(
      r.error.details.violations[1].message,
      'Create Smart+ ads paused: set operation_status to DISABLE (TikTok defaults to ENABLE).',
    );
    assert.equal(r.error.details.violations_omitted, undefined);
    assert.equal(r.error.details.violations_count, 4, 'every violation is counted');
    // The message is the first violation's own sentence, with no count and no template: a page looks it up as it is.
    assert.equal(r.error.message, first);
    assert.equal(r.error.message_localization, undefined);
    // That there are more says the remedy, which is the next action: worded for people, with its own Arabic.
    assert.equal(r.error.next_action, severalRulesRemedy);
    assert.deepEqual(r.error.remedy, {
      category: 'request',
      owner: 'operator',
      action: severalRulesRemedy,
      mutation_retry_safe: false,
    });
    assert.equal(f.requests.length, 0, 'refused before any request');
    // Inspect makes no request either, and shows the same list.
    const i = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(faulty()),
    });
    assert.equal(i.data.review_contract_supported, false);
    assert.equal(i.data.error.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.deepEqual(
      i.data.error.details.violations.map(v => v.field),
      faultyFields,
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a single violation is refused as it always was: its own sentence and field, no count and no list', async () => {
  const f = fixture();
  try {
    const r = await f.prepare(ad({operation_status: 'ENABLE'}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(
      r.error.message,
      'Create Smart+ ads paused: set operation_status to DISABLE (TikTok defaults to ENABLE).',
    );
    assert.equal(r.error.details.field, 'operation_status');
    assert.equal(r.error.details.violations, undefined);
    assert.equal(r.error.details.violations_count, undefined);
    assert.equal(r.error.message_localization, undefined);
    assert.notEqual(r.error.next_action, severalRulesRemedy, 'one rule has the remedy it always had');
  } finally {
    f.store.close();
  }
});

test('violations inside the keys, the creatives, the destination and the configuration are each listed; a dependent rule waits for what it needs', async () => {
  const f = fixture();
  try {
    const cases = [
      [
        'every unknown top-level key',
        ad({ad_text_list: [], call_to_action_list: [], interactive_add_on_list: []}),
        ['ad_text_list', 'call_to_action_list', 'interactive_add_on_list'],
      ],
      [
        'every unknown ad_configuration key',
        ad({}, {dark_post_status: 'ON', tracking_info: {}}),
        ['ad_configuration.dark_post_status', 'ad_configuration.tracking_info'],
      ],
      [
        // The duplicate of 9001 is the third creative's, after its own bad format; the invalid landing page leaves the UTM match unchecked.
        'several creatives, the landing page and the CTA, and no UTM match without a valid landing page',
        ad(
          {
            creative_list: [post('9001', {identity_type: 'AUTH_CODE'}), post('abc'), post('9001', {ad_format: 'REEL'})],
            landing_page_url_list: [{landing_page_url: 'ftp://example.test/'}],
          },
          {call_to_action_id: 'x'},
        ),
        [
          'creative_list[0].creative_info.identity_type',
          'creative_list[1].creative_info.tiktok_item_id',
          'creative_list[2].creative_info.ad_format',
          'creative_list[2].creative_info.tiktok_item_id',
          'landing_page_url_list',
          'ad_configuration.call_to_action_id',
        ],
      ],
      [
        'the UTM match, once the landing page is valid',
        ad({}, {creative_auto_add_toggle: undefined, utm_params: [{key: 'utm_source', value: 'tiktok'}]}),
        ['ad_configuration.creative_auto_add_toggle', 'ad_configuration.utm_params'],
      ],
      [
        'a material ID beside a creative that is not a post',
        ad({creative_list: [{ad_material_id: 'm0', creative_info: {ad_format: 'SINGLE_VIDEO'}}]}),
        [
          'creative_list[0].ad_material_id',
          'creative_list[0].creative_info.tiktok_item_id',
          'creative_list[0].creative_info.identity_type',
          'creative_list[0].creative_info.identity_id',
        ],
      ],
      [
        // ad() carries a landing page and UTM parameters, which an Instant Form ad has none of.
        'an Instant Form ad that also names a landing page and UTM parameters, and a list of two forms',
        ad({page_list: [{page_id: '7700149'}, {page_id: '7700001'}]}),
        ['landing_page_url_list', 'page_list', 'ad_configuration.utm_params'],
      ],
      [
        'an Instant Form ad that names a landing page and two forms, without UTM parameters',
        ad({page_list: [{page_id: '7700149'}, {page_id: '7700001'}]}, {utm_params: undefined}),
        ['landing_page_url_list', 'page_list'],
      ],
      [
        'a configuration that is no object, and a body with no creatives and no landing page',
        ad({creative_list: undefined, landing_page_url_list: undefined, ad_configuration: 'on'}),
        ['creative_list', 'landing_page_url_list', 'ad_configuration'],
      ],
    ];
    for (const [name, payload, fields] of cases) {
      const r = await f.prepare(JSON.parse(JSON.stringify(payload)));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.deepEqual(fieldsOf(r), fields, name);
      assert.equal(r.error.details.field, fields[0], name);
      assert.equal(r.error.details.violations_count, fields.length, name);
      // The message is the first violation's own sentence (a page that adds the field to it adds it after the sentence).
      assert.ok(
        r.error.message.startsWith(r.error.details.violations[0].message.replace(/\.$/, '')),
        name + ': ' + r.error.message,
      );
      assert.equal(r.error.message_localization, undefined, name);
      assert.equal(r.error.next_action, severalRulesRemedy, name);
    }
    assert.equal(f.requests.length, 0, 'every one was refused before any request');
  } finally {
    f.store.close();
  }
});

test('no more than 20 violations are listed, and the rest are counted', async () => {
  const f = fixture();
  try {
    const payload = ad();
    for (let i = 0; i < 25; i++) payload['extra_' + String(i).padStart(2, '0')] = i;
    const r = await f.prepare(payload);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.violations.length, 20);
    assert.equal(r.error.details.violations_omitted, 5);
    assert.equal(r.error.details.violations_count, 25, 'the count is of every violation, listed or not');
    assert.equal(r.error.details.field, 'extra_00');
  } finally {
    f.store.close();
  }
});

test('product_info_enabled UNSET, as a read returns it, is accepted, created once and verified', async () => {
  const f = fixture();
  try {
    const body = () => ad({}, {product_info_enabled: 'UNSET'});
    const p = await f.prepare(body());
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x));
    assert.deepEqual(f.writes, [body()], 'UNSET is sent as it was given');
    assert.equal(f.writes[0].ad_configuration.product_info_enabled, 'UNSET');
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('every other value of product_info_enabled is outside the contract and refused, before any request', async () => {
  const f = fixture();
  try {
    for (const value of ['ON', 'NON_CATALOG', 'CATALOG', 'unset', 'Unset', '', true, false, null, 0, ['UNSET'], {}]) {
      const r = await f.prepare(JSON.parse(JSON.stringify(ad({}, {product_info_enabled: value}))));
      const name = 'product_info_enabled ' + JSON.stringify(value);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.product_info_enabled', name);
      assert.match(r.error.message, /Set product_info_enabled to UNSET or leave it out/, name);
      assert.equal(r.error.details.violations, undefined, name + ' alone is one violation');
    }
    assert.equal(f.requests.length, 0);
    // Leaving it out is still the way to ask for the default.
    assert.equal((await f.prepare(ad())).success, true);
  } finally {
    f.store.close();
  }
});

// ---- r25-field-tiktok (#7): a sibling ad created in the same ad group is not a change ----------------------------------------------
// The review kept the sorted IDs of the ad group's ads, so any other ad created in the group made every other prepared create
// STATE_CHANGED, though the create depends on its siblings only through TikTok's limit of 30 ads per ad group ("Create an Upgraded
// Smart+ Ad", checked 2026-11-19). The family re-reads the ads and re-checks the limit at execute, before the state is compared, and
// an identical create is held back by the guard against creating twice, so nothing is protected by hashing the sibling IDs. The
// review keeps {adgroup_id, at_limit} and, only for a full group, {ad_count}.
const adsRead = group => ({gateway, path: '/v1.3/smart_plus/ad/get/', query: {filtering: {adgroup_ids: [group]}}});
const siblings = (group, n) =>
  Array.from({length: n}, (_, i) => ({smart_plus_ad_id: String(7000 + i), adgroup_id: group, ad_name: 'Ad ' + i}));

test('the review keeps the ad group and whether it has room, not the IDs of its other ads', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(ad());
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 300));
    const saved = f.store.document(actor.tenantId, 'write_review', p.data.review_id),
      at = saved.reads.findIndex(r => r.path === '/v1.3/smart_plus/ad/get/');
    assert.deepEqual(saved.state[at], {data: {adgroup_ads: {adgroup_id: '300', at_limit: false}}});
    assert.ok(
      !JSON.stringify(saved.state[at]).includes('4000'),
      'the ad the group already has (4000) is not in the state',
    );
  } finally {
    f.store.close();
  }
});

test('the state of the ads of an ad group: room, a full group with its count, and the shape an earlier review saved', () => {
  const read = adsRead('303'),
    room = {data: {adgroup_ads: {adgroup_id: '303', at_limit: false}}},
    full = n => ({data: {adgroup_ads: {adgroup_id: '303', at_limit: true, ad_count: n}}});
  for (const n of [0, 3, 29])
    assert.deepEqual(tiktokSmartPlusAdState(read, {data: {list: siblings('303', n)}}), room, n + ' ads');
  for (const n of [30, 31])
    assert.deepEqual(tiktokSmartPlusAdState(read, {data: {list: siblings('303', n)}}), full(n), n + ' ads');
  // A review prepared before this projection saved the sorted IDs; it is mapped to the same two facts.
  const old = ids => ({data: {adgroup_ads: {adgroup_id: '303', smart_plus_ad_ids: ids}}});
  assert.deepEqual(tiktokSmartPlusAdState(read, old(['7000', '7001'])), room);
  assert.deepEqual(tiktokSmartPlusAdState(read, old(siblings('303', 30).map(a => a.smart_plus_ad_id))), full(30));
  // A state already in the new shape is kept as it is, and what is not the ads of an ad group is none of its business.
  assert.deepEqual(tiktokSmartPlusAdState(read, full(30)), full(30));
  assert.equal(tiktokSmartPlusAdState(read, {data: {}}), undefined);
  assert.equal(
    tiktokSmartPlusAdState({...read, query: {filtering: {smart_plus_ad_ids: ['7000']}}}, {data: {list: []}}),
    undefined,
  );
});

test('two different creates prepared for one ad group both execute: the ad the first creates is no change for the second', async () => {
  const f = fixture();
  try {
    const first = await f.prepare(ad({ad_name: 'First'})),
      second = await f.prepare(ad({ad_name: 'Second', creative_list: [post('9003')]}));
    assert.equal(first.success && second.success, true, JSON.stringify([first.error, second.error]).slice(0, 300));
    const a = await f.execute(first.data.review_id);
    assert.equal(a.success, true, JSON.stringify(a.error ?? a.data).slice(0, 300));
    const b = await f.execute(second.data.review_id);
    assert.equal(b.success, true, JSON.stringify(b.error ?? b.data).slice(0, 500));
    assert.deepEqual(
      f.writes.map(w => w.ad_name),
      ['First', 'Second'],
    );
    for (const p of [first, second]) assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('the limit still holds: at 29 ads two creates are prepared, and the second is refused at execute before anything is sent', async () => {
  const f = fixture();
  try {
    const first = await f.prepare(ad({adgroup_id: '313', ad_name: 'Thirtieth'})),
      second = await f.prepare(ad({adgroup_id: '313', ad_name: 'Thirty-first'}));
    assert.equal(first.success && second.success, true, JSON.stringify([first.error, second.error]).slice(0, 300));
    assert.equal((await f.execute(first.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
    const r = await f.execute(second.data.review_id);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {message: /already has 30 ads/});
    assert.equal(f.writes.length, 1, 'nothing was sent for the second');
    // And a group that is full when the create is prepared is refused at prepare, as before.
    assertRefused(await f.prepare(ad({adgroup_id: '313', ad_name: 'Thirty-second'})), 'INVALID_TIKTOK_SMART_PLUS_AD', {
      message: /already has 30 ads/,
    });
  } finally {
    f.store.close();
  }
});

// Round 2 (the lead's review, S3-2): the sibling ad is no change for the review, and the limit still holds when two creates are executed
// at once. That is the target lock's doing (WRT-04): executes of one target run one at a time, so the later one reads the ads of the
// group again after the earlier one was sent and meets the 30th. Both creates read the same ad group and the same ads of it, so they
// share their locks. With AMCP_WRITE_TARGET_LOCK=false both read 29 and both are sent (the group would hold 31); this test is red then.
const targetLocks = f => f.store.db.prepare("SELECT key FROM service_locks WHERE key LIKE 'write-target:%'").all();
const claimOf = (f, id) =>
  f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId, id);

test('at 29 ads two different creates executed at once: one is sent, and the other is refused as the 31st before anything is claimed', async () => {
  const f = fixture();
  try {
    const first = await f.prepare(ad({adgroup_id: '313', ad_name: 'Thirtieth'})),
      second = await f.prepare(ad({adgroup_id: '313', ad_name: 'Thirty-first', creative_list: [post('9003')]}));
    assert.equal(first.success && second.success, true, JSON.stringify([first.error, second.error]).slice(0, 300));
    assert.notEqual(first.data.review_id, second.data.review_id);
    let release;
    f.hold(new Promise(resolve => (release = resolve)));
    const both = Promise.all([f.execute(first.data.review_id), f.execute(second.data.review_id)]);
    // One of them reaches TikTok and stays in flight there; the other has to wait for the ad group's target.
    for (let i = 0; i < 1000 && !f.writes.length; i++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 300));
    const inFlight = {writes: f.writes.length, locks: targetLocks(f).length};
    release();
    const results = await both;
    assert.equal(inFlight.writes, 1, 'the second is not sent while the first is in flight');
    assert.ok(inFlight.locks > 0, 'the first holds the ad group’s target while its create is in flight');
    // Exactly one was sent; the other is refused at execute, as a 31st ad, with nothing sent and nothing claimed.
    const sent = results.filter(r => r.success),
      refused = results.filter(r => !r.success);
    assert.equal(sent.length, 1, JSON.stringify(results.map(r => r.error?.code ?? 'sent')));
    assert.equal(refused.length, 1);
    assertRefused(refused[0], 'INVALID_TIKTOK_SMART_PLUS_AD', {message: /already has 30 ads/});
    assert.equal(f.writes.length, 1, 'one create was sent in all');
    const [winner, loser] = f.writes[0].ad_name === 'Thirtieth' ? [first, second] : [second, first];
    assert.equal(claimOf(f, winner.data.review_id)?.state, 'complete');
    assert.equal(claimOf(f, loser.data.review_id), undefined, 'the refused review was never claimed');
    assert.equal(
      Object.values(f.ads).filter(a => a.adgroup_id === '313').length,
      30,
      'the ad group holds 30 ads, not 31',
    );
    assert.deepEqual(targetLocks(f), [], 'the target is released after the send and after the refusal');
  } finally {
    f.store.close();
  }
});

test('two identical creates prepared for one ad group: the second is refused as a repeat of the first, not as a state change', async () => {
  const f = fixture();
  try {
    const first = await f.prepare(ad()),
      second = await f.prepare(ad());
    assert.equal(first.success && second.success, true, JSON.stringify([first.error, second.error]).slice(0, 300));
    assert.equal((await f.execute(first.data.review_id)).success, true);
    assertRefused(await f.execute(second.data.review_id), 'DUPLICATE_OF_COMPLETED_WRITE');
    assert.equal(f.writes.length, 1, 'only the first was sent');
  } finally {
    f.store.close();
  }
});

test('a change of the ad group itself between prepare and execute still refuses the create', async () => {
  const f = fixture();
  try {
    // The ad group turns Pangle-only: the family refuses it, whatever the state hash says.
    const a = await f.prepare(ad({ad_name: 'A'}));
    Object.assign(f.groups[300], {placement_type: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_PANGLE']});
    assertRefused(await f.execute(a.data.review_id), 'INVALID_TIKTOK_SMART_PLUS_AD', {
      writes: () => f.writes.length,
      message: /excludes the TikTok placement/,
    });
    Object.assign(f.groups[300], {placement_type: 'PLACEMENT_TYPE_AUTOMATIC'});
    delete f.groups[300].placements;
    // The ad group is turned on: what the ad is created under changed, so the state check refuses it.
    const b = await f.prepare(ad({ad_name: 'B'}));
    f.groups[300].operation_status = 'ENABLE';
    const r = await f.execute(b.data.review_id);
    assertRefused(r, 'STATE_CHANGED', {writes: () => f.writes.length});
    assert.ok(
      r.error.details.changed_fields.some(path => /operation_status/.test(path)),
      JSON.stringify(r.error.details.changed_fields),
    );
  } finally {
    f.store.close();
  }
});

test('a review prepared before the projection changed still executes, whatever other ads were created in the group since', async () => {
  for (const [name, sibling] of [
    ['nothing changed', false],
    ['an ad created since', true],
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(ad());
      assert.equal(p.success, true, name);
      // What such a review saved: the sorted IDs of the ad group's ads.
      const saved = f.store.document(actor.tenantId, 'write_review', p.data.review_id),
        at = saved.reads.findIndex(r => r.path === '/v1.3/smart_plus/ad/get/');
      saved.state[at] = {data: {adgroup_ads: {adgroup_id: '300', smart_plus_ad_ids: ['4000']}}};
      f.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, saved);
      if (sibling)
        f.ads[4001] = {
          smart_plus_ad_id: '4001',
          adgroup_id: '300',
          ad_name: 'Created since',
          operation_status: 'DISABLE',
        };
      const x = await f.execute(p.data.review_id);
      assert.equal(x.success, true, name + ': ' + JSON.stringify(x.error ?? x.data).slice(0, 500));
      assert.equal(f.writes.length, 1, name);
    } finally {
      f.store.close();
    }
  }
});
