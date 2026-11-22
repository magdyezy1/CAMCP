/**
 * A synthetic TikTok advertiser for Upgraded Smart+ Search (R2.5 M4, package r25-m4-search2): the unit tests of
 * tests/tiktok-smart-plus-search.test.mjs and tests/tiktok-smart-plus-search-recipe.test.mjs run on it, and it is the fixture of journey
 * J24 of the M4 merge (a Smart+ Sales/Web Search build and its go-live in one review). Every ID is synthetic and nothing here reaches
 * TikTok.
 *
 * smartPlusSearchBriefs(connectionId) returns the two briefs of the Search pack, for advertiser 7001: `clicks` (its default goal, CLICK, no
 * pixel) and `conversions` (CONVERT, a purchase event of a pixel), each with keywords.
 *
 * smartPlusSearchAdvertiser(options) returns the responder:
 *   fetch(raw, init)   a fetcher in the shape NativeTransport takes. It answers the advertiser, identity, video, pixel and CTA portfolio
 *                      reads of a launch's preflight, the Smart+ campaign, ad group and ad reads and creates, the ad group update, and the
 *                      Smart+ campaign status update that is the go-live. Any other request throws, so a request a plan should not make
 *                      fails the run;
 *   campaigns, groups, ads   the Smart+ objects it holds, by ID: what TikTok would read back;
 *   writes, requests   every POST ({path, body}) and every request ('METHOD path') it saw, in order.
 * What it models of Search, as TikTok's pages describe it ("Create Upgraded Smart+ Search Ads Campaigns", read 2026-11-20 and 2026-11-21 by the
 * lead's documentation sessions, impl/r25-m4-search2-DOCS.md): a Smart+ campaign created with `is_search_campaign: true` reads it back (a
 * campaign that is not Search carries no such key), and it must be created with campaign budget optimization off; an ad group carries
 * `search_keywords` ({keyword, match_type} items) and `automated_keywords_enabled`, and under a Search campaign it must be MANUAL targeting
 * with the TikTok placement only; TikTok adds a review status to each keyword it reads back (`audit_status`: AUDITING, PASS or REJECTED, with
 * `reject_info` on a REJECTED one only) and states no order for them; an advertiser that is not on the Search allowlist is refused at the
 * campaign create with code 40118, in an HTTP 200 body, and nothing is created. An ad group update replaces the keyword list it is given
 * (the reading of "supports incremental updates" that lets a rejected keyword be removed, which the page implies and does not state, P15;
 * the `merge` world stays for the tests that show a verification catching the other reading).
 * options:
 *   `identity`, `post`, `pixel`  override the fields those reads answer; `portfolios` adds CTA or other portfolios by ID (700 is a dynamic
 *                                CTA portfolio and 701 a card portfolio); `routes(method, path, url, body)` may answer a request first
 *                                (return a Response);
 *   `allowlisted`                false: a Search campaign create is refused with 40118 (default true); 'type': it is refused as the live check LV-30 of
 *                                2026-11-21 found TikTok to do, with code 40002 and the message that the account has no access to this Search campaign type;
 *   `keywordOrder`               'stored' (default), 'reversed', or 'rotating': the order the keywords of an ad group read back in. A
 *                                rotating order differs at every read, which a review of an ad group must not mistake for a change;
 *   `keywordUpdate`              'replace' (default): an update stores exactly the list it is given; 'merge': it adds the items it is given
 *                                to the list the ad group has (the other reading of the page, for the tests that show a verification
 *                                catching it);
 *   `rejectedKeywords`           keyword texts that read back REJECTED with a `reject_info` (a row set directly may hold a `reject_info` on an
 *                                item for the same effect).
 */
export const smartPlusSearchAccount = '7001';
const item = '7300000000000000001';

export function smartPlusSearchBriefs(connectionId) {
  const clicks = {
    name: 'Synthetic Smart+ Search clicks',
    account_id: smartPlusSearchAccount,
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
    keywords: [
      {keyword: 'running shoes', match_type: 'PHRASE_WORD'},
      {keyword: 'trail shoes', match_type: 'PRECISE_WORD'},
      {keyword: 'shoe sale', match_type: 'BROAD_WORD'},
    ],
  };
  return {
    clicks,
    conversions: {
      ...clicks,
      name: 'Synthetic Smart+ Search purchases',
      optimization_goal: 'CONVERT',
      pixel_id: '8800',
      optimization_event: 'SHOPPING',
    },
  };
}

export function smartPlusSearchAdvertiser({
  identity = {},
  post = {},
  pixel = {},
  portfolios = {},
  routes,
  allowlisted = true,
  keywordOrder = 'stored',
  keywordUpdate = 'replace',
  rejectedKeywords = [],
} = {}) {
  const campaigns = new Map(),
    groups = new Map(),
    ads = new Map(),
    writes = [],
    requests = [];
  const cta = {portfolio_content: [{asset_ids: ['201781', '201535'], asset_content: 'learn_more'}]},
    cards = {
      creative_portfolio_type: 'CARD',
      portfolio_content: [{card_type: 'IMAGE', image_id: 'img-1'}],
    },
    known = {700: cta, 701: cards, ...portfolios};
  let next = 900,
    groupReads = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r', data});
  const page = list => ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
  // What TikTok reads back of a keyword list, as its pages describe it ("Get Upgraded Smart+ Ad Groups"): each keyword with its review status,
  // AUDITING or PASS, which moves by itself (it flips at every read of an ad group), or REJECTED with a `reject_info` that "is returned only when
  // audit_status is REJECTED" (`forbidden_location` and `reject_reasons` of `reason`), in the order the option names ('rotating' turns the list one
  // place more at every read). A keyword is REJECTED when its text is in the option `rejectedKeywords` or the row holds a `reject_info` for it.
  const rejectionOf = k =>
    k.reject_info ?? [{forbidden_location: 'KEYWORD', reject_reasons: [{reason: 'Synthetic reason'}]}];
  const reviewed = list =>
    list.map(({reject_info, audit_status, ...k}) =>
      reject_info !== undefined || rejectedKeywords.includes(k.keyword)
        ? {...k, audit_status: 'REJECTED', reject_info: rejectionOf({reject_info})}
        : {...k, audit_status: groupReads % 2 ? 'PASS' : 'AUDITING'},
    );
  const view = row => {
    const out = structuredClone(row);
    if (Array.isArray(out.search_keywords)) {
      // Whatever else a keyword holds (a field TikTok adds, or a setting made in Ads Manager) is read back as it is; the review status is TikTok's own.
      let list = out.search_keywords.map(({audit_status, ...rest}) => rest);
      if (keywordOrder === 'reversed') list = list.reverse();
      if (keywordOrder === 'rotating' && list.length) {
        const turn = groupReads % list.length;
        list = [...list.slice(turn), ...list.slice(0, turn)];
      }
      out.search_keywords = reviewed(list);
    }
    return out;
  };
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
        {advertiser_id: smartPlusSearchAccount, currency: 'USD', timezone: 'Etc/GMT', status: 'STATUS_ENABLE'},
      ]);
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/')
      return page(idsOf('campaign_ids', campaigns, 'campaign_id').map(row => structuredClone(row)));
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/') {
      groupReads++;
      return page(
        (filtering.adgroup_ids
          ? idsOf('adgroup_ids', groups, 'adgroup_id')
          : idsOf('campaign_ids', groups, 'campaign_id')
        ).map(view),
      );
    }
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
    if (method === 'POST') {
      const body = JSON.parse(String(init.body)),
        id = String(next++);
      writes.push({path, body});
      if (path === '/v1.3/smart_plus/campaign/create/') {
        // "When is_search_campaign is true, you can only set budget_optimize_on to false" ("Create an Upgraded Smart+ Campaign"), and TikTok's
        // default is true: a Search campaign created with campaign budget optimization on, or with the key left out, is a parameter error
        // (code 40002, an HTTP 200 answer), and nothing is created.
        if (body.is_search_campaign === true && (body.budget_optimize_on ?? true) !== false)
          return Response.json({
            code: 40002,
            message: 'The budget settings are invalid for a Search campaign.',
            request_id: 'r',
            data: {},
          });
        // The Search allowlist is decided here: TikTok refuses a Search campaign of an advertiser that is not on it, and creates nothing.
        if (body.is_search_campaign === true && allowlisted === 'type')
          return Response.json({
            code: 40002,
            message:
              "Your account doesn't have access to this Search campaign type. Request access or choose a type your account supports.",
            request_id: 'r',
            data: {},
          });
        if (body.is_search_campaign === true && !allowlisted)
          return Response.json({
            code: 40118,
            message: 'The app or advertiser is not on the allowlist for accessing the feature',
            request_id: 'r',
            data: {},
          });
        const {advertiser_id, request_id, is_search_campaign, ...stored} = body,
          cbo = body.budget_optimize_on ?? true;
        campaigns.set(id, {
          ...stored,
          campaign_id: id,
          catalog_enabled: false,
          // The get examples of TikTok's pages show is_search_campaign on a Search campaign only: another campaign's row carries no such key.
          ...(is_search_campaign === true ? {is_search_campaign: true} : {}),
          // TikTok stores the documented defaults: campaign budget optimization and the budget mode it implies.
          budget_optimize_on: cbo,
          budget_mode: body.budget_mode ?? (cbo ? 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET' : 'BUDGET_MODE_INFINITE'),
        });
        return ok({campaign_id: id});
      }
      if (path === '/v1.3/smart_plus/adgroup/create/') {
        const {advertiser_id, request_id, ...stored} = body,
          parent = campaigns.get(String(body.campaign_id)),
          search = parent?.is_search_campaign === true;
        // The ad group's budget is "Required when ... CBO is disabled" ("Create an Upgraded Smart+ Ad Group").
        if (parent?.budget_optimize_on === false && body.budget === undefined)
          return Response.json({
            code: 40002,
            message: 'The ad group needs a budget.',
            request_id: 'r',
            data: {},
          });
        // A Search ad group takes custom targeting (targeting_optimization_mode MANUAL) and the TikTok search placement only (PLACEMENT_TYPE_NORMAL with
        // ["PLACEMENT_TIKTOK"]): "Create an Upgraded Smart+ Search Ads Campaign for Web", and the create page's default targeting mode is AUTOMATIC, so a
        // body that leaves it out is refused too, with a parameter error and nothing created.
        if (
          search &&
          (body.targeting_optimization_mode !== 'MANUAL' ||
            body.placement_type !== 'PLACEMENT_TYPE_NORMAL' ||
            JSON.stringify(body.placements) !== '["PLACEMENT_TIKTOK"]')
        )
          return Response.json({
            code: 40002,
            message: 'The targeting or the placement is invalid for a Search ad group.',
            request_id: 'r',
            data: {},
          });
        groups.set(id, {
          ...stored,
          adgroup_id: id,
          // TikTok returns targeting with its documented defaults added: automatic targeting is the default mode.
          targeting_optimization_mode: body.targeting_optimization_mode ?? 'AUTOMATIC',
          targeting_spec: {brand_safety_type: 'STANDARD_INVENTORY', spending_power: 'ALL', ...body.targeting_spec},
          pacing: 'PACING_MODE_SMOOTH',
          // A Search ad group reads the way the owner's reference campaign did: search_result_enabled false and the automated switch.
          ...(search
            ? {search_result_enabled: false, automated_keywords_enabled: body.automated_keywords_enabled ?? false}
            : {}),
        });
        return ok({adgroup_id: id});
      }
      if (path === '/v1.3/smart_plus/adgroup/update/') {
        const row = groups.get(String(body.adgroup_id));
        if (!row)
          return Response.json({code: 40007, message: 'The ad group does not exist', request_id: 'r', data: {}});
        const {advertiser_id, adgroup_id, search_keywords, ...fields} = body;
        Object.assign(row, fields);
        if (search_keywords !== undefined) {
          // 'merge' adds the items it is given that the list does not hold already; 'replace' stores the list it is given.
          const held = (row.search_keywords ?? []).map(k => JSON.stringify([k.keyword, k.match_type]));
          row.search_keywords =
            keywordUpdate === 'merge'
              ? [
                  ...(row.search_keywords ?? []),
                  ...search_keywords.filter(k => !held.includes(JSON.stringify([k.keyword, k.match_type]))),
                ]
              : search_keywords;
        }
        return ok({});
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
