import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * A synthetic TikTok advertiser for Spark Ads Push and the authorization of creators' posts (r25-m4b-smartpush), shaped as API
 * for Business v1.3 answers it on the pages read on 2026-11-21: "Create an Upgraded Smart+ Ad" and "Update an Upgraded Smart+
 * Ad" (a Push creative reads back with `video_info`, `image_info` and `music_info`, and no `tiktok_item_id`; an identity that is
 * not a Business Center one reads `identity_authorized_bc_id` "0"), "Search for videos" and "Search for images" (a video that
 * cannot be used in ads is not returned; `is_carousel_usable`), "Get info about an identity" (`can_push_video`; `ads_only_mode`
 * only for a Business Center identity; `available_status` and `can_pull_video` for TT_USER and BC_AUTH_TT only), "Get info about
 * TikTok posts" (`auth_info` for an AUTH_CODE identity), "Get Spark Ad posts" (each row carries the post's `auth_code`), "Apply an
 * authorization code" (an empty `data`) and "Unbind a Spark Ad post". Synthetic IDs only; nothing leaves the process.
 *
 * `pushWorld` is the advertiser and its fetch-like handler, with no service in it (the journey harness serves it as it serves
 * another provider); `pushFixture` puts a MirrorService in front of it with the calls a test makes.
 *
 * What is in it:
 * - ad groups 300 (website, CONVERT), 301 (Instant Form lead) and 302 (a Pangle-only group); ad 5100 is a Pull ad (posts 9001 and
 *   9002), 5110 a Push video ad with two covers' videos and two ad texts, 5111 a Push carousel ad with a custom carousel name.
 * - identities TT_USER tt-1 (can push and pull), tt-nopush, tt-private; BC_AUTH_TT bc-1 (Business Center 7000), bc-nopush; and
 *   AUTH_CODE ac-1, whose post 9501 is authorized and 9502 has expired.
 * - a library of videos v-1 to v-60 and images img-1 to img-60 (img-flat is not usable in a carousel); `v-other` and `img-other`
 *   belong to no library of this advertiser.
 */
export const gateway = 'tiktok_native_action',
  account = '123',
  TIKTOK = '41414141-4141-4414-8414-414141414141';
export const actor = {tenantId: 'tiktok-smart-plus-push', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 93).toString('base64');
/** The secret-like codes a creator's TikTok app produced; the world knows which post each one authorizes. */
export const codes = {
  fresh: '#ZmFrZS1hdXRoLWNvZGUtMDAx+Zml4dHVyZQ==',
  second: '#ZmFrZS1hdXRoLWNvZGUtMDAy/Zml4dHVyZQ==',
  original: '#ZmFrZS1hdXRoLWNvZGUtb3JpZ2luYWw=',
  bound: '#ZmFrZS1hdXRoLWNvZGUtYm91bmQ=',
  expired: '#ZmFrZS1hdXRoLWNvZGUtZXhwaXJlZA==',
};

export const post = (item, format = 'SINGLE_VIDEO', extra = {}) => ({
  creative_info: {ad_format: format, tiktok_item_id: item, identity_type: 'TT_USER', identity_id: 'tt-1', ...extra},
});
/** A Push video creative: the video, its cover, and the identity that publishes it. */
export const video = (id, cover = 'img-1', extra = {}) => ({
  creative_info: {
    ad_format: 'SINGLE_VIDEO',
    video_info: {video_id: id},
    image_info: [{web_uri: cover}],
    identity_type: 'TT_USER',
    identity_id: 'tt-1',
    ...extra,
  },
});
/** A Push carousel creative: its images in order, its music, and the identity that publishes it. */
export const carousel = (images = ['img-2', 'img-3'], music = 'mus-1', extra = {}) => ({
  creative_info: {
    ad_format: 'CAROUSEL_ADS',
    image_info: images.map(web_uri => ({web_uri})),
    music_info: {music_id: music},
    identity_type: 'TT_USER',
    identity_id: 'tt-1',
    ...extra,
  },
});
/** The Business Center identity of the owner's reference ad. */
export const bc = {identity_type: 'BC_AUTH_TT', identity_id: 'bc-1', identity_authorized_bc_id: '7000'};
export const texts = (...list) => list.map(ad_text => ({ad_text}));
export const url = 'https://shop.example.test/sale?utm_source=tiktok&utm_campaign=__CAMPAIGN_NAME__';
/** A create of an ad in ad group 300 with the given creatives; `extra` replaces top-level keys, `configuration` adds to the configuration. */
export const ad = (creative_list, extra = {}, configuration = {}) => ({
  advertiser_id: account,
  adgroup_id: '300',
  ad_name: 'Push sale',
  operation_status: 'DISABLE',
  creative_list,
  landing_page_url_list: [{landing_page_url: url}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
    utm_params: [
      {key: 'utm_source', value: 'tiktok'},
      {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
    ],
    ...configuration,
  },
  ...extra,
});
/** The keys TikTok returns with every ad at their defaults. */
export const readDefaults = () => ({
  tracking_info: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'},
  product_specific_type: 'UNSET',
  dark_post_status: 'ON',
});
/** A time as TikTok writes it (UTC). */
export const utc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** The creatives as TikTok keeps and returns them: material IDs, and the shapes of the create page's response example. */
export const stored = list =>
  list.map((c, i) => {
    if (c.ad_material_id !== undefined && c.creative_info === undefined)
      return {...c, material_operation_status: 'ENABLE'};
    const ci = c.creative_info,
      common = {
        ad_format: ci.ad_format,
        identity_authorized_bc_id: ci.identity_authorized_bc_id ?? '0',
        identity_id: ci.identity_id,
        identity_type: ci.identity_type,
      };
    const info =
      ci.tiktok_item_id !== undefined
        ? {...common, tiktok_item_id: ci.tiktok_item_id}
        : ci.video_info
          ? {
              ...common,
              image_info: ci.image_info,
              material_name: '',
              video_info: {file_name: '', video_id: ci.video_info.video_id},
            }
          : {...common, image_info: ci.image_info, material_name: ci.material_name ?? '', music_info: ci.music_info};
    return {
      ad_material_id: 'm' + i,
      smart_plus_creative_id: 'c' + i,
      material_operation_status: 'ENABLE',
      creative_info: info,
    };
  });

/** The advertiser: rows by ID, the requests it saw, the writes it took, and how it behaves (`behaviour`, changed by a test). */
export function pushWorld() {
  const groups = {
    300: {
      adgroup_id: '300',
      campaign_id: '80',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CONVERT',
      pixel_id: '7001',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
    301: {
      adgroup_id: '301',
      campaign_id: '81',
      promotion_type: 'LEAD_GENERATION',
      promotion_target_type: 'INSTANT_PAGE',
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
  };
  const ads = {
    5100: {
      smart_plus_ad_id: '5100',
      adgroup_id: '300',
      ad_name: 'Pull spark',
      operation_status: 'DISABLE',
      creative_list: stored([post('9001'), post('9002', 'CAROUSEL_ADS')]),
      landing_page_url_list: [{landing_page_url: url}],
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
        utm_params: [
          {key: 'utm_source', value: 'tiktok'},
          {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
        ],
        ...readDefaults(),
      },
    },
    5110: {
      smart_plus_ad_id: '5110',
      adgroup_id: '300',
      ad_name: 'Push videos',
      operation_status: 'DISABLE',
      creative_list: stored([video('v-1', 'img-1'), video('v-2', 'img-4')]),
      ad_text_list: texts('Spring sale', 'Free delivery'),
      landing_page_url_list: [{landing_page_url: url}],
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
        utm_params: [
          {key: 'utm_source', value: 'tiktok'},
          {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
        ],
        ...readDefaults(),
      },
    },
    5111: {
      smart_plus_ad_id: '5111',
      adgroup_id: '300',
      ad_name: 'Push carousel',
      operation_status: 'DISABLE',
      creative_list: stored([
        carousel(['img-2', 'img-3'], 'mus-1', {material_name: 'Spring set'}),
        video('v-1', 'img-1'),
      ]),
      ad_text_list: texts('Swipe for the spring set'),
      landing_page_url_list: [{landing_page_url: url}],
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
        utm_params: [
          {key: 'utm_source', value: 'tiktok'},
          {key: 'utm_campaign', value: '__CAMPAIGN_NAME__'},
        ],
        ...readDefaults(),
      },
    },
  };
  const identities = {
    'TT_USER:tt-1': {available_status: 'AVAILABLE', can_pull_video: true, can_push_video: true, is_gpppa: false},
    'TT_USER:tt-nopush': {available_status: 'AVAILABLE', can_pull_video: true, can_push_video: false, is_gpppa: false},
    'TT_USER:tt-private': {
      available_status: 'IS_PRIVATE_ACCOUNT',
      can_pull_video: true,
      can_push_video: true,
      is_gpppa: false,
    },
    'TT_USER:tt-gov': {available_status: 'AVAILABLE', can_pull_video: true, can_push_video: true, is_gpppa: true},
    'BC_AUTH_TT:bc-1': {
      identity_authorized_bc_id: '7000',
      available_status: 'AVAILABLE',
      can_pull_video: true,
      can_push_video: true,
      is_gpppa: false,
      ads_only_mode: false,
    },
    'BC_AUTH_TT:bc-nopush': {
      identity_authorized_bc_id: '7000',
      available_status: 'AVAILABLE',
      can_pull_video: true,
      can_push_video: false,
      is_gpppa: false,
      ads_only_mode: false,
    },
    // An authorized creator's post: "available_status" and "can_pull_video" are valid for TT_USER and BC_AUTH_TT only, so it has neither.
    'AUTH_CODE:ac-1': {identity_authorized_bc_id: null, is_gpppa: false},
  };
  const own = {
    'tt-1': {9001: 'VIDEO', 9002: 'CAROUSEL', 9003: 'VIDEO'},
    'bc-1': {9101: 'VIDEO'},
    'tt-private': {9201: 'VIDEO'},
    'tt-gov': {9401: 'VIDEO'},
  };
  // Sixty more video posts of tt-1 (9600 to 9659), for a list at TikTok's limit of 50 creatives.
  for (let i = 0; i < 60; i++) own['tt-1'][9600 + i] = 'VIDEO';
  /** The posts creators authorized to this advertiser: the list read returns each with its code (the world's secret). */
  const authorized = [
    {
      item_id: '9501',
      item_type: 'VIDEO',
      identity_id: 'ac-1',
      code: codes.bound,
      status: 'AUTHORIZED',
      text: 'A creator post',
    },
    {
      item_id: '9502',
      item_type: 'VIDEO',
      identity_id: 'ac-1',
      code: codes.expired,
      status: 'EXPIRED',
      text: 'An expired creator post',
    },
  ];
  /** What a creator's app produced: the post each code would authorize. */
  const creator = {
    [codes.fresh]: {item_id: '9511', item_type: 'VIDEO', identity_id: 'ac-2', text: 'A new creator post'},
    [codes.second]: {item_id: '9512', item_type: 'CAROUSEL', identity_id: 'ac-2', text: 'Another creator post'},
    [codes.original]: {item_id: '9513', item_type: 'VIDEO', identity_id: 'ac-3', text: 'The original post'},
  };
  const library = {videos: {}, images: {}};
  for (let i = 1; i <= 60; i++) {
    library.videos['v-' + i] = true;
    library.images['img-' + i] = {is_carousel_usable: true};
  }
  library.images['img-flat'] = {is_carousel_usable: false};
  const portfolios = {
    700: {portfolio_content: [{asset_ids: ['201781', '201535'], asset_content: 'learn_more'}]},
    701: {
      creative_portfolio_id: '701',
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
  };
  const advertiser = {ads_only_mode: false};
  /**
   * `texts` is how TikTok treats ad_text_list on an update ('replace' or 'append': "Update an Upgraded Smart+ Ad" states neither,
   * so both are possible); `allowlisted` is whether the advertiser may update by ad_material_id; `pushItem` makes a Push read-back
   * return a generated tiktok_item_id (the page's example has none); `mode` is 'lost' (the answer of a write is lost) or 'error'
   * (code 40002); `unbindRefusal` is a code TikTok answers an unbind with.
   */
  const behaviour = {
    texts: 'replace',
    allowlisted: false,
    pushItem: false,
    mode: '',
    unbindRefusal: 0,
    authorizeRefusal: 0,
  };
  const requests = [],
    writes = [],
    queries = [];
  let n = 0,
    signed = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const refusal = (message, code = 40002) => Response.json({code, message, request_id: 'r' + ++n, data: {}});
  const list = rows => ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
  /** An ad as a read returns it. */
  const read = ad => {
    const row = structuredClone(ad);
    if (behaviour.pushItem)
      for (const c of row.creative_list ?? [])
        if (c.creative_info?.video_info) c.creative_info.tiktok_item_id = '77' + c.ad_material_id;
    return row;
  };
  const handle = async (raw, init = {}) => {
    const u = new URL(String(raw)),
      path = u.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => u.searchParams.get(k);
    requests.push(method + ' ' + path);
    if (method === 'GET') queries.push({path, search: u.search});
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      const f = JSON.parse(q('filtering'));
      return list(
        Object.values(groups)
          .filter(g => (f.adgroup_ids ? f.adgroup_ids.includes(g.adgroup_id) : f.campaign_ids.includes(g.campaign_id)))
          .map(g => structuredClone(g)),
      );
    }
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/')
      return list(JSON.parse(q('filtering')).campaign_ids.map(id => ({campaign_id: id, operation_status: 'DISABLE'})));
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
    if (method === 'GET' && path === '/v1.3/identity/info/') {
      const i = identities[q('identity_type') + ':' + q('identity_id')];
      return i
        ? ok({
            identity_info: {
              identity_id: q('identity_id'),
              identity_type: q('identity_type'),
              display_name: 'Synthetic',
              profile_image_url: 'https://p16.example.test/a.jpeg?x-signature=' + ++signed,
              username: 'synthetic',
              can_use_live_ads: false,
              can_manage_message: false,
              ...i,
            },
          })
        : refusal('Identity does not exist');
    }
    if (method === 'GET' && path === '/v1.3/identity/video/info/') {
      const type = q('identity_type'),
        id = q('identity_id'),
        items = JSON.parse(q('item_ids'));
      // "Get info about TikTok posts": item_ids has a max size of 20.
      assert.ok(items.length <= 20, 'at most 20 item IDs per identity video read, got ' + items.length);
      const rows =
        type === 'AUTH_CODE'
          ? authorized.filter(p => p.identity_id === id)
          : Object.entries(own[id] ?? {}).map(([item_id, item_type]) => ({item_id, item_type}));
      return ok({
        video_details: items
          .map(item => rows.find(p => String(p.item_id) === String(item)))
          .filter(Boolean)
          .map(p => ({
            item_id: String(p.item_id),
            item_type: p.item_type,
            status: 'ITEM_STATUS_HESITATE_RECOMMEND',
            text: 'Synthetic post',
            carousel_info: null,
            video_info: {url: 'https://v16.example.test/' + p.item_id + '.mp4?x-expires=' + ++signed},
            ...(type === 'AUTH_CODE'
              ? {
                  auth_info: {
                    ad_auth_status: p.status,
                    auth_start_time: '2026-11-20 00:00:00',
                    auth_end_time: '2027-11-20 00:00:00',
                    invite_start_time_stamp: '2026-11-19 00:00:00',
                  },
                }
              : {}),
          })),
      });
    }
    if (method === 'GET' && path === '/v1.3/file/video/ad/search/') {
      const ids = JSON.parse(q('filtering')).video_ids;
      assert.ok(ids.length <= 100, 'at most 100 video IDs per search');
      return list(
        ids
          .filter(id => library.videos[id])
          .map(id => ({
            video_id: id,
            material_id: 'mat-' + id,
            file_name: id + '.mp4',
            format: 'mp4',
            duration: 12.5,
            width: 720,
            height: 1280,
            signature: 'sig-' + id,
            allowed_placements: ['PLACEMENT_TIKTOK'],
            displayable: true,
            video_cover_url:
              'https://p16.example.test/' + id + '.jpeg?x-expires=' + ++signed + '&x-signature=s' + signed,
            preview_url: 'https://v16.example.test/' + id + '.mp4?x-expires=' + signed + '&x-signature=s' + signed,
            preview_url_expire_time: utc(Date.now() + 6 * 3600000),
          })),
      );
    }
    if (method === 'GET' && path === '/v1.3/file/image/ad/search/') {
      const ids = JSON.parse(q('filtering')).image_ids;
      assert.ok(ids.length <= 100, 'at most 100 image IDs per search');
      return list(
        ids
          .filter(id => library.images[id])
          .map(id => ({
            image_id: id,
            material_id: 'mat-' + id,
            is_carousel_usable: library.images[id].is_carousel_usable,
            width: 1080,
            height: 1920,
            format: 'jpeg',
            signature: 'sig-' + id,
            size: 1000,
            file_name: id + '.jpg',
            displayable: true,
            image_url: 'https://p16.example.test/' + id + '.jpeg?x-expires=' + ++signed + '&x-signature=s' + signed,
          })),
      );
    }
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({list: [{advertiser_id: account, ads_only_mode: advertiser.ads_only_mode}]});
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/') {
      const p = portfolios[q('creative_portfolio_id')];
      return p ? ok(structuredClone(p)) : refusal('Creative portfolio does not exist');
    }
    if (method === 'GET' && path === '/v1.3/page/get/')
      return ok({
        list: [{page_id: '7700149', status: 'PUBLISHED', title: 'Form'}],
        page_info: {page: 1, page_size: Number(q('page_size')), total_number: 1, total_page: 1},
      });
    if (method === 'GET' && path === '/v1.3/tt_video/list/') {
      const page = Number(q('page') ?? 1),
        size = Number(q('page_size') ?? 20),
        keyword = q('keyword');
      const rows = authorized.filter(p => !keyword || String(p.item_id) === keyword);
      return ok({
        list: rows.slice((page - 1) * size, page * size).map(p => ({
          user_info: {tiktok_name: 'creator', identity_id: p.identity_id, identity_type: 'AUTH_CODE'},
          item_info: {
            anchor_list: null,
            text: p.text,
            status: 'HESITATE_RECOMMEND',
            auth_code: p.code,
            item_id: p.item_id,
            item_type: p.item_type,
            carousel_info: null,
          },
          auth_info: {
            auth_start_time: '2026-11-20 00:00:00',
            ad_auth_status: p.status,
            invite_start_time: '2026-11-19 00:00:00',
            auth_end_time: '2027-11-20 00:00:00',
          },
          video_info: {
            duration: 8.081,
            preview_url: 'https://v16.example.test/' + p.item_id + '.mp4?x-expires=' + ++signed,
          },
        })),
        page_info: {
          page,
          page_size: size,
          total_number: rows.length,
          total_page: Math.max(1, Math.ceil(rows.length / size)),
        },
      });
    }
    if (method === 'GET' && path === '/v1.3/ad/get/') return list([]);
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const id = String(5600 + writes.length);
      ads[id] = {
        smart_plus_ad_id: id,
        adgroup_id: b.adgroup_id,
        ad_name: b.ad_name,
        operation_status: b.operation_status,
        creative_list: stored(b.creative_list).reverse(),
        ...(b.ad_text_list ? {ad_text_list: [...b.ad_text_list].reverse()} : {}),
        ...(b.page_list !== undefined ? {page_list: b.page_list, landing_page_url_list: []} : {}),
        ...(b.landing_page_url_list !== undefined ? {landing_page_url_list: b.landing_page_url_list} : {}),
        ad_configuration: {...readDefaults(), ...b.ad_configuration},
      };
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return behaviour.mode === 'error' ? refusal('Video is not available for Spark Ads') : ok(read(ads[id]));
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/update/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      const a = ads[b.smart_plus_ad_id];
      if (behaviour.mode === 'error') return refusal('Creative is not valid for this ad');
      if (!behaviour.allowlisted && (b.creative_list ?? []).some(c => c.ad_material_id !== undefined))
        return refusal('The app or advertiser is not on the allowlist for accessing the feature.', 40118);
      if (b.ad_name !== undefined) a.ad_name = b.ad_name;
      if (b.creative_list) {
        const before = a.creative_list;
        a.creative_list = b.creative_list.map((c, i) => {
          if (c.ad_material_id === undefined) return stored([c])[0];
          const kept = before.find(x => x.ad_material_id === c.ad_material_id);
          return {...structuredClone(kept), ad_material_id: c.ad_material_id};
        });
      }
      if (b.ad_text_list)
        a.ad_text_list = behaviour.texts === 'append' ? [...(a.ad_text_list ?? []), ...b.ad_text_list] : b.ad_text_list;
      if (b.landing_page_url_list) a.landing_page_url_list = b.landing_page_url_list;
      if (b.ad_configuration) a.ad_configuration = {...a.ad_configuration, ...b.ad_configuration};
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return ok(read(a));
    }
    if (method === 'POST' && path === '/v1.3/tt_video/authorize/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      if (behaviour.authorizeRefusal)
        return refusal('The app or advertiser is not on the allowlist.', behaviour.authorizeRefusal);
      const post = creator[b.auth_code];
      if (!post) return refusal('Invalid authorization code');
      if (b.original_post_auth_code !== undefined && !creator[b.original_post_auth_code])
        return refusal('Invalid authorization code for the original post');
      if (!authorized.some(p => p.item_id === post.item_id))
        authorized.push({...post, code: b.auth_code, status: 'AUTHORIZED'});
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return ok({});
    }
    if (method === 'POST' && path === '/v1.3/tt_video/unbind/') {
      const b = JSON.parse(init.body);
      writes.push(b);
      if (behaviour.unbindRefusal) return refusal('The authorization is still in effect', behaviour.unbindRefusal);
      const at = authorized.findIndex(p => p.item_id === b.item_id);
      if (at < 0) return refusal('The post is not authorized to this advertiser');
      authorized.splice(at, 1);
      if (behaviour.mode === 'lost') throw new Error('Synthetic accepted response lost');
      return ok({});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  };
  return {
    groups,
    ads,
    identities,
    own,
    authorized,
    creator,
    library,
    portfolios,
    advertiser,
    behaviour,
    requests,
    queries,
    writes,
    handle,
  };
}

/**
 * The advertiser behind a MirrorService with a connection to it (a write-capable one), and the calls a test makes: `prepare` of a
 * Smart+ ad create (or any native action), `execute`, `verify`; `restart()` builds a new service on the same store, as a server
 * restart does.
 */
export function pushFixture() {
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
  const w = pushWorld(),
    transport = new NativeTransport(w.handle);
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input, as = actor) => service.call(tool, input, as);
  const args = (payload, action = 'tiktok_smart_plus_ad_create') => ({action, account_id: account, payload});
  const prepare = (payload, action, extra = {}) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(payload, action), ...extra});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  return {
    ...w,
    store,
    call,
    args,
    prepare,
    execute,
    verify,
    restart: () => {
      service = start();
    },
    /** Prepares a request and returns its review, failing the test with the answer when it was refused. */
    async prepared(payload, action, extra) {
      const p = await prepare(payload, action, extra);
      assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 700));
      return p;
    },
  };
}
