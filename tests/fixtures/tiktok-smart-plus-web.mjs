/**
 * A synthetic TikTok advertiser for the two guided Upgraded Smart+ website packs (R2.5 M4, package r25-m4-smartweb): the unit tests of
 * tests/tiktok-smart-plus-recipe.test.mjs run on it, and it is the fixture of journey J15 of the M4 merge (a Smart+ website build and its
 * go-live in one review). Every ID is synthetic and nothing here reaches TikTok.
 *
 * smartPlusWebBriefs(connectionId) returns the two briefs: the traffic pack's (clicks, its default goal; add optimization_goal:
 * 'TRAFFIC_LANDING_PAGE_VIEW' for landing page views) and the purchases pack's (a purchase event of a pixel), for advertiser 7001.
 *
 * smartPlusWebAdvertiser(options) returns the responder:
 *   fetch(raw, init)   a fetcher in the shape NativeTransport takes. It answers the advertiser, identity, video, pixel and CTA portfolio
 *                      reads of a launch's preflight, the Smart+ campaign, ad group and ad reads and creates, and the Smart+ campaign
 *                      status update that is the go-live. Any other request throws, so a request a plan should not make fails the run;
 *   campaigns, groups, ads   the Smart+ objects it holds, by ID: what TikTok would read back;
 *   writes, requests   every POST ({path, body}) and every request ('METHOD path') it saw, in order.
 * options: `identity`, `post`, `pixel` override the fields those reads answer; `portfolios` adds CTA or other portfolios by ID (700 is a
 * dynamic CTA portfolio and 701 a card portfolio); `routes(method, path, url, body)` may answer a request first (return a Response);
 * `endCards` adds portfolio types by ID to what the portfolio list returns (8801 and 8802 are end cards, 8890 a Display Card), and an ad
 * create keeps its `end_card_list` (r25-m4b-endcards).
 */
export const smartPlusWebAccount = '7001';
const item = '7300000000000000001';

export function smartPlusWebBriefs(connectionId) {
  const traffic = {
    name: 'Synthetic Smart+ traffic',
    account_id: smartPlusWebAccount,
    connection_id: connectionId,
    currency: 'USD',
    daily_budget: '25.50',
    location_ids: ['6252001', '102358'],
    tiktok_item_id: item,
    identity_type: 'TT_USER',
    identity_id: 'tt-identity-1',
    destination_url: 'https://example.com/tiktok-landing',
    call_to_action_id: '700',
    start_time: '2026-12-01T10:00:00+03:00',
  };
  return {
    traffic,
    conversions: {...traffic, name: 'Synthetic Smart+ purchases', pixel_id: '8800', optimization_event: 'SHOPPING'},
  };
}

export function smartPlusWebAdvertiser({
  identity = {},
  post = {},
  pixel = {},
  portfolios = {},
  routes,
  endCards = {},
} = {}) {
  const campaigns = new Map(),
    groups = new Map(),
    ads = new Map(),
    writes = [],
    requests = [];
  // r25-m4b-endcards: the portfolios of the advertiser that "Get portfolios or end cards" lists, by ID and type: two end cards and a Display
  // Card (`endCards` adds or replaces).
  const endCardRows = {8801: 'END_CARD', 8802: 'END_CARD', 8890: 'CARD', ...endCards};
  let signed = 0;
  const cta = {portfolio_content: [{asset_ids: ['201781', '201535'], asset_content: 'learn_more'}]},
    cards = {
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
    known = {700: cta, 701: cards, ...portfolios};
  let next = 900;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r', data});
  const page = list => ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  const fetch = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace('/open_api', ''),
      method = init.method ?? 'GET',
      json = name => {
        const v = url.searchParams.get(name);
        try {
          return v === null ? undefined : JSON.parse(v);
        } catch {
          return v;
        }
      },
      filtering = json('filtering') ?? {};
    requests.push(method + ' ' + path);
    const extra = routes?.(method, path, url, init.body);
    if (extra) return extra;
    const idsOf = (key, rows, field) =>
      filtering[key] ? [...rows.values()].filter(r => filtering[key].map(String).includes(String(r[field]))) : [];
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return page([
        {advertiser_id: smartPlusWebAccount, currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'},
      ]);
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/')
      return page(idsOf('campaign_ids', campaigns, 'campaign_id'));
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/')
      return page(
        filtering.adgroup_ids
          ? idsOf('adgroup_ids', groups, 'adgroup_id')
          : idsOf('campaign_ids', groups, 'campaign_id'),
      );
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/')
      return page(
        filtering.smart_plus_ad_ids
          ? idsOf('smart_plus_ad_ids', ads, 'smart_plus_ad_id')
          : idsOf('adgroup_ids', ads, 'adgroup_id'),
      );
    if (method === 'GET' && path === '/v1.3/identity/info/')
      return ok({
        identity_info: {
          identity_id: json('identity_id'),
          identity_type: json('identity_type'),
          display_name: 'Synthetic creator',
          available_status: 'AVAILABLE',
          can_pull_video: true,
          is_gpppa: false,
          ...identity,
        },
      });
    if (method === 'GET' && path === '/v1.3/identity/video/info/') {
      const wanted = [].concat(json('item_ids') ?? []).map(String);
      return ok({
        video_details: wanted
          .filter(id => id === item)
          .map(item_id => ({item_id, item_type: 'VIDEO', status: 'PUBLIC', ...post})),
      });
    }
    if (method === 'GET' && path === '/v1.3/pixel/list/')
      return ok({
        pixels: [
          {
            pixel_id: '8800',
            pixel_name: 'Synthetic pixel',
            asset_ownership: {ownership_status: true, asset_relation_status: 'OWNER'},
            ...pixel,
          },
        ].filter(p => !json('pixel_id') || String(p.pixel_id) === String(json('pixel_id'))),
        page_info: {page: 1, page_size: 20, total_number: 1, total_page: 1},
      });
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/') {
      const p = known[json('creative_portfolio_id')];
      return p
        ? ok(structuredClone(p))
        : Response.json({code: 40002, message: 'Creative portfolio does not exist', request_id: 'r', data: {}});
    }
    // r25-m4b-endcards: "Get portfolios or end cards within an ad account", by ID; each row's preview link is signed anew at every read.
    if (method === 'GET' && path === '/v1.3/creative/portfolio/list/') {
      const wanted = (filtering.creative_portfolio_ids ?? []).map(String).filter(id => endCardRows[id]);
      return ok({
        creative_portfolios: wanted.map(id => ({
          creative_portfolio_id: id,
          creative_portfolio_type: endCardRows[id],
          creative_portfolio_preview_url: 'https://p16.example.test/' + id + '.png?x-signature=s' + ++signed,
          image_id: 'img-' + id,
        })),
        page_info: {page: 1, page_size: 100, total_number: wanted.length, total_page: 1},
      });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init.body)),
        id = String(next++);
      writes.push({path, body});
      if (path === '/v1.3/smart_plus/campaign/create/') {
        const {advertiser_id, request_id, ...stored} = body;
        campaigns.set(id, {...stored, campaign_id: id, catalog_enabled: false, is_search_campaign: false});
        return ok({campaign_id: id});
      }
      if (path === '/v1.3/smart_plus/adgroup/create/') {
        const {advertiser_id, request_id, ...stored} = body;
        groups.set(id, {
          ...stored,
          adgroup_id: id,
          // TikTok returns targeting with its documented defaults added: automatic targeting is the default mode.
          targeting_optimization_mode: body.targeting_optimization_mode ?? 'AUTOMATIC',
          targeting_spec: {brand_safety_type: 'STANDARD_INVENTORY', spending_power: 'ALL', ...body.targeting_spec},
          pacing: 'PACING_MODE_SMOOTH',
        });
        return ok({adgroup_id: id});
      }
      if (path === '/v1.3/smart_plus/ad/create/') {
        ads.set(id, {
          smart_plus_ad_id: id,
          campaign_id: groups.get(String(body.adgroup_id))?.campaign_id,
          adgroup_id: body.adgroup_id,
          ad_name: body.ad_name,
          operation_status: body.operation_status,
          creative_list: body.creative_list.map((c, i) => ({
            ad_material_id: 'm' + i,
            material_operation_status: 'ENABLE',
            creative_info: c.creative_info,
          })),
          landing_page_url_list: body.landing_page_url_list,
          ...(body.end_card_list ? {end_card_list: body.end_card_list} : {}),
          ad_configuration: {...body.ad_configuration, product_specific_type: 'UNSET'},
        });
        return ok({smart_plus_ad_id: id});
      }
      if (path === '/v1.3/smart_plus/campaign/status/update/') {
        for (const c of body.campaign_ids) campaigns.get(c).operation_status = body.operation_status;
        return ok({
          campaign_list: body.campaign_ids.map(campaign_id => ({campaign_id, status: body.operation_status})),
          error_list: [],
        });
      }
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  };
  return {fetch, campaigns, groups, ads, writes, requests};
}
