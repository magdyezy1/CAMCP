import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Paused Upgraded Smart+ website conversion Spark Ads from existing TikTok posts (API for Business v1.3, checked
 * 2026-09-26). Media and profile URLs are signed per read, so they must never look like a state change.
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
  };
  const ads = {4000: {smart_plus_ad_id: '4000', adgroup_id: '300', ad_name: 'Existing', operation_status: 'DISABLE'}};
  for (let i = 0; i < 30; i++)
    ads[4100 + i] = {
      smart_plus_ad_id: String(4100 + i),
      adgroup_id: '303',
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
    mode = '';
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
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const id = String(5000 + writes.length);
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
    assert.equal(impact.ad_group.existing_ads, 1);
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
        /neither a website conversion ad group/,
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
