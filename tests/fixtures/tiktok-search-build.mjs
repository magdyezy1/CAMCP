/**
 * A synthetic TikTok advertiser for the guided Search pack (R2.5 M4, package r25-m4-search, stage 1): the unit tests of
 * tests/tiktok-search-recipe.test.mjs run on it, and it is the fixture of journey J16 of the M4 merge (a Search build and its
 * go-live in one review). Every ID is synthetic and nothing here reaches TikTok.
 *
 * tiktokSearchBrief(connectionId) returns the brief of the pack for advertiser 7001: the traffic pack's inputs and its keywords.
 *
 * tiktokSearchAdvertiser(options) returns the responder:
 *   fetch(raw, init)   a fetcher in the shape NativeTransport takes. It answers the advertiser, identity and video reads of a
 *                      launch's preflight, the campaign, ad group and ad reads and creates, the campaign status update that is the
 *                      go-live, and the negative keyword reads and adds. Any other request throws, so a request a plan should not
 *                      make fails the run;
 *   campaigns, groups, ads, negatives   what TikTok would read back, by ID (negatives by "OBJECT_TYPE:id");
 *   review        {status}: the review status read back with each keyword; set status to move it;
 *   writes, requests   every POST ({path, body}) and every request ('METHOD path') it saw, in order.
 * options:
 *   allowlisted   false answers a Search campaign create as TikTok does an advertiser that is not on its Search Ads allowlist:
 *                 HTTP 200, code 40118 and an empty `data` (the Return codes page, read 2026-11-20). It answers no other create
 *                 differently, so a campaign that is not a Search campaign is created.
 *   audit         the review status TikTok adds to each keyword it reads back (`audit_status`, named by "Create Manual Search Ads
 *                 Campaigns", read 2026-11-20; the page names the field and not its values). Default on; false leaves it off.
 *   keywordOrder  'reversed' reads the keywords back in the opposite order (the page states no order).
 *   keywordFields fields TikTok adds to each keyword it reads back besides the review status (an object, default none; the page names
 *                 keyword_bid_type, which defaults to FOLLOW_ADGROUP): what AMCP sent is compared with the keyword and its match type
 *                 only (the lead's review S3-3), so none of them may matter.
 *   stores        a function from the keywords an ad group create sends to the ones TikTok stores (default: as sent): a store that
 *                 changes a keyword is what a verification must still see.
 *   identity, post   override the fields the identity and post reads answer;
 *   routes(method, path, url, body)   may answer a request first (return a Response).
 */
export const tiktokSearchAccount = '7001';
const item = '7300000000000000001';

export function tiktokSearchBrief(connectionId) {
  return {
    name: 'Synthetic TikTok Search',
    account_id: tiktokSearchAccount,
    connection_id: connectionId,
    currency: 'USD',
    daily_budget: '25.50',
    location_ids: ['6252001', '102358'],
    tiktok_item_id: item,
    identity_type: 'TT_USER',
    identity_id: 'tt-identity-1',
    destination_url: 'https://example.com/tiktok-landing',
    call_to_action: 'LEARN_MORE',
    start_time: '2026-12-01T10:00:00+03:00',
    keywords: [
      {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
      {keyword: 'trail running shoes', match_type: 'PRECISE_WORD'},
      {keyword: 'shoes', match_type: 'BROAD_WORD'},
    ],
  };
}

export function tiktokSearchAdvertiser({
  allowlisted = true,
  audit = true,
  keywordOrder = 'sent',
  keywordFields = {},
  stores = words => words,
  identity = {},
  post = {},
  routes,
} = {}) {
  const campaigns = new Map(),
    groups = new Map(),
    ads = new Map(),
    negatives = new Map(),
    writes = [],
    requests = [];
  // The review status TikTok gives each keyword it reads back; a test moves it, as TikTok's review does after the ad group is created.
  const review = {status: 'SYNTHETIC_AUDIT_STATE'};
  let next = 900,
    nextKeyword = 5000;
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
    const rowsOf = (rows, key, field) =>
      filtering[key] ? [...rows.values()].filter(r => filtering[key].map(String).includes(String(r[field]))) : [];
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return page([
        {advertiser_id: tiktokSearchAccount, currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'},
      ]);
    if (method === 'GET' && path === '/v1.3/campaign/get/')
      return page(rowsOf(campaigns, 'campaign_ids', 'campaign_id'));
    if (method === 'GET' && path === '/v1.3/adgroup/get/')
      return page(
        (filtering.adgroup_ids
          ? rowsOf(groups, 'adgroup_ids', 'adgroup_id')
          : rowsOf(groups, 'campaign_ids', 'campaign_id')
        ).map(g => ({
          ...g,
          search_keywords: (keywordOrder === 'reversed' ? [...g.search_keywords].reverse() : g.search_keywords).map(
            k => ({
              ...k,
              ...(audit ? {audit_status: review.status} : {}),
              ...structuredClone(keywordFields),
            }),
          ),
        })),
      );
    if (method === 'GET' && path === '/v1.3/ad/get/') return page(rowsOf(ads, 'ad_ids', 'ad_id'));
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
    if (method === 'GET' && path === '/v1.3/search_ad/negative_keyword/get/') {
      const list = negatives.get(url.searchParams.get('object_type') + ':' + url.searchParams.get('object_id')) ?? [],
        number = Number(url.searchParams.get('page')),
        size = Number(url.searchParams.get('page_size'));
      return ok({
        keywords: structuredClone(list.slice((number - 1) * size, number * size)),
        page_info: {
          page: number,
          page_size: size,
          total_number: list.length,
          total_page: Math.max(1, Math.ceil(list.length / size)),
        },
      });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init.body)),
        id = String(next++);
      writes.push({path, body});
      if (path === '/v1.3/campaign/create/') {
        if (body.is_search_campaign === true && !allowlisted)
          return Response.json({
            code: 40118,
            message: 'The app or advertiser is not on the allowlist for accessing the feature.',
            request_id: 'r',
            data: {},
          });
        campaigns.set(id, {
          ...body,
          campaign_id: id,
          campaign_automation_type: 'MANUAL',
          is_search_campaign: body.is_search_campaign === true,
        });
        return ok({campaign_id: id});
      }
      if (path === '/v1.3/adgroup/create/') {
        groups.set(id, {
          ...body,
          adgroup_id: id,
          campaign_automation_type: 'MANUAL',
          // TikTok ignores search_result_enabled on a Search Ads ad group and holds it false.
          search_result_enabled: false,
          search_keywords: structuredClone(stores(body.search_keywords ?? [])),
        });
        return ok({adgroup_id: id});
      }
      if (path === '/v1.3/ad/create/') {
        const group = groups.get(String(body.adgroup_id));
        ads.set(id, {
          ...body.creatives[0],
          ad_id: id,
          adgroup_id: body.adgroup_id,
          campaign_id: group.campaign_id,
          advertiser_id: tiktokSearchAccount,
        });
        return ok({ad_ids: [id]});
      }
      if (path === '/v1.3/campaign/status/update/') {
        for (const c of body.campaign_ids) campaigns.get(c).operation_status = body.operation_status;
        return ok({});
      }
      if (path === '/v1.3/search_ad/negative_keyword/add/') {
        for (const object of body.object_ids) {
          const key = body.object_type + ':' + object,
            current = body.replace ? [] : (negatives.get(key) ?? []);
          for (const word of body.keywords)
            if (!current.some(c => c.name.toLowerCase() === word.name.toLowerCase()))
              current.push({
                keyword_id: String(nextKeyword++),
                name: word.name,
                match_type: word.match_type ?? 'BROAD_WORD',
              });
          negatives.set(key, current);
        }
        return ok({});
      }
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  };
  return {fetch, campaigns, groups, ads, negatives, review, writes, requests};
}
