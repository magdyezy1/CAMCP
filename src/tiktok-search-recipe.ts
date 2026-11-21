import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import type {DependencyEvidenceContext, RecipeContextFacts} from './provider-adapter.js';
import {stable} from './security.js';
import {tiktokBudget, tiktokCallToActions, utc} from './tiktok-launch-recipes.js';

/**
 * The guided paused TikTok Search pack (R2.5 M4, package r25-m4-search, stage 1; Q6, owner): a manual Search Ads campaign, its ad
 * group with the advertiser's keywords and a Spark Ad from an existing post, compiled to the existing reviewed tiktok_entities creates
 * (POST /v1.3/campaign/create/, /v1.3/adgroup/create/ and /v1.3/ad/create/ of API for Business v1.3), as the traffic pack is. The
 * campaign is created DISABLE and its ad group and ad ENABLE under it (paused-parents.ts, Q14), so enabling the campaign is the one
 * activation, a separate reviewed status change.
 *
 * The date this pack stops working is NOT settled. The banner of TikTok's create pages ("Create manual ads", read 2026-11-20) names only
 * non-Search Sales, App Promotion and Lead Generation campaigns for 2027-01-01, which leaves a Search campaign outside it. But TikTok's
 * migration guide to Upgraded Smart+ (https://business-api.tiktok.com/portal/docs/upgraded-smart-campaign/v1.3, read 2026-11-21 by the
 * lead) says that after December 31, 2026 a Manual Campaign can no longer be created with /campaign/create/, the endpoint this pack
 * uses. If the guide holds, this pack works until 2026-12-31 only. Which reading holds for a Search campaign is UNVERIFIED (the lead's
 * check M4 LV-27 reads the banner page again on 2027-01-02). The lead's decision (2026-11-21): the context carries a static notice
 * (`tiktokSearchMigrationNotice`, with its Arabic) and the pack refuses nothing on that date; TikTok's own answer decides, and it is
 * recorded rejected when it is one of the nine definitive codes. Smart+ Search (Sales with a website destination) is planned as stage 2
 * of this package.
 *
 * The shape follows "Create Manual Search Ads Campaigns"
 * (https://business-api.tiktok.com/portal/docs/create-search-ads-campaigns/v1.3, read 2026-11-20 in the lead's documentation session,
 * r25-m4-DOCS-EVIDENCE section 6) and, for the keyword enum, "Create a manual ad group"
 * (https://business-api.tiktok.com/portal/docs/create-an-ad-group-reference/v1.3, read 2026-11-20):
 * - the campaign is /campaign/create/ with objective_type TRAFFIC and is_search_campaign true (which cannot be updated once set), with
 *   campaign budget optimization off (no budget_optimize_on). The page's examples use BUDGET_MODE_TOTAL and nothing makes a budget mode
 *   required; this pack keeps the traffic pack's BUDGET_MODE_INFINITE, so the daily budget lives on the ad group. That is UNVERIFIED until
 *   the live check M4 LV-24;
 * - the ad group is WEBSITE on PLACEMENT_TYPE_NORMAL with PLACEMENT_TIKTOK, CLICK optimization billed CPC with maximum delivery
 *   (BID_TYPE_NO_BID) and smooth pacing, and search_keywords of 1 to 1,000 {keyword, match_type} items. It names none of what the page says
 *   must not be passed (saved or custom audiences, interests, smart audience and interest behaviour, targeting expansion, contextual
 *   tags, Pangle blocking, brand safety partners), nor search_result_enabled (the page: "ignored and default to false"; a Search Ads
 *   campaign is not compatible with the Automatic Search Placement), nor automated_keywords_enabled (its own allowlist), nor a keyword bid
 *   (only under Cost Cap), nor creative_material_mode;
 * - the ad is a Spark Ad from an existing post (tiktok_item_id, identity TT_USER or BC_AUTH_TT; the page also lists AUTH_CODE and
 *   CUSTOMIZED_USER, which this pack does not use), SINGLE_VIDEO, with a call to action, which the page requires, and a website URL.
 *
 * Access: Search Ads campaigns are allowlist-only, for each objective separately. An advertiser that is not on the allowlist is refused by
 * TikTok with code 40118 ("The app or advertiser is not on the allowlist for accessing the feature", Return codes, read 2026-11-20), one
 * of the nine codes AMCP records as rejected with nothing created (src/tiktok-write-rejection.ts). TikTok documents no read of the
 * allowlist, so preflight cannot check it: the campaign create is the plan's first write, and it is where the allowlist is decided. The
 * owner confirmed on 2026-11-21 that the TikTok test advertiser is on it for Traffic.
 *
 * Preflight reads, before any create, the identity and the post of the ad step marked `tiktok_spark_post`, by the traffic pack's own rules
 * (src/tiktok-launch-recipes.ts); a Search ad group reads no pixel. TikTok's budget-minimum, keyword and ad review rules stay with the
 * provider: a refusal is a typed review or execution error that is never retried.
 */
export const tiktokSearchSource =
  'https://business-api.tiktok.com/portal/docs/create-search-ads-campaigns/v1.3 (API for Business v1.3, "Create Manual Search Ads Campaigns", read 2026-11-20)';
const gateway = 'tiktok_native_action';
/** The match types of a Search keyword: exact, phrase and broad ("Create a manual ad group", read 2026-11-20). */
export const tiktokSearchMatchTypes: readonly string[] = ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'];
/** An ad group create lists 1 to 1,000 keywords ("Create Manual Search Ads Campaigns", read 2026-11-20). */
export const tiktokSearchKeywordLimit = 1000;
/** The inputs of the traffic pack (src/tiktok-launch-recipes.ts), and the keywords. */
const required = [
  'name',
  'account_id',
  'connection_id',
  'currency',
  'daily_budget',
  'location_ids',
  'tiktok_item_id',
  'identity_type',
  'identity_id',
  'destination_url',
  'call_to_action',
  'start_time',
  'keywords',
];
export const tiktokSearchRecipe = {
  id: 'tiktok_search_traffic',
  name: 'TikTok Search ads with an existing post',
  platform: 'tiktok',
  required,
  optional: ['end_time', 'identity_authorized_bc_id'],
  description:
    'Creates a paused TikTok Search Ads campaign for the Traffic objective, a daily-budget ad group on the TikTok placement with your keywords and match types, and a Spark Ad from an existing post. Optimizes clicks with maximum delivery. Search Ads campaigns are allowlist-only: TikTok refuses an advertiser without the allowlist for this objective with code 40118, and nothing is created. Preflight reads the identity and post; activation is separate.',
};

function invalid(message: string, field: string, code = 'RECIPE_INPUT_INVALID', details: JsonObject = {}): never {
  throw new MirrorError(code, message, {field, ...details});
}
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown, max = 32): v is string =>
  typeof v === 'string' && new RegExp('^[1-9][0-9]{0,' + (max - 1) + '}$').test(v);

/**
 * A keyword written as a line, `MATCH_TYPE: keyword` (the website's brief form and a playbook's defaults write the keywords one per line,
 * and a line is the one shape their text fields hold): the match type, a colon, then the keyword, which may hold colons itself.
 */
const keywordLine = /^\s*([A-Z][A-Z_]*)\s*:\s*([\s\S]*)$/;
/**
 * The keywords of a brief as the ad group sends them: 1 to 1,000 items, each a record of exactly a keyword and a match type or a line
 * `MATCH_TYPE: keyword`, both compiled to the record; each keyword a non-empty text after trimming (sent trimmed), no keyword and match
 * type twice. The page states no length or character limit for a keyword, so this sets none: TikTok's own refusal is definitive (40002
 * is recorded rejected). A record with a keyword bid or any other key is refused, because bids are only available under Cost Cap, which
 * this pack does not use.
 */
function searchKeywords(value: unknown): {keyword: string; match_type: string}[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > tiktokSearchKeywordLimit)
    invalid('Use 1 to 1,000 keywords, each with a keyword and a match type.', 'keywords');
  const seen = new Set<string>();
  return value.map((item, index) => {
    // The sentence is a literal argument at each raise, so that the localization inventory sees it (it reads no other form).
    const at = 'keywords[' + index + ']';
    let text: unknown, matchType: unknown;
    if (typeof item === 'string') {
      const line = keywordLine.exec(item);
      if (!line)
        invalid(
          'Each keyword is a record of a keyword and a match_type, or a line written as MATCH_TYPE: keyword.',
          at,
        );
      [matchType, text] = [line[1], line[2]];
    } else {
      if (!obj(item) || Object.keys(item).some(key => key !== 'keyword' && key !== 'match_type'))
        invalid(
          'Each keyword is a record of a keyword and a match_type, or a line written as MATCH_TYPE: keyword.',
          at,
        );
      [matchType, text] = [item.match_type, item.keyword];
    }
    if (typeof text !== 'string' || !text.trim()) invalid('Each keyword needs text.', at + '.keyword');
    if (!tiktokSearchMatchTypes.includes(matchType as string))
      invalid(
        'Choose a match type for each keyword: PRECISE_WORD, PHRASE_WORD or BROAD_WORD.',
        at + '.match_type',
        undefined,
        {allowed: tiktokSearchMatchTypes},
      );
    const keyword = text.trim(),
      pair = JSON.stringify([keyword, matchType]);
    if (seen.has(pair)) invalid('This keyword and match type are listed twice.', at);
    seen.add(pair);
    return {keyword, match_type: matchType as string};
  });
}

/** Compiles a TikTok Search brief; existing reviewed routes only, nothing is read or sent. */
export function buildTiktokSearchRecipe(b: JsonObject): JsonObject {
  if (!b.name.trim() || /\p{Extended_Pictographic}/u.test(b.name))
    invalid('Use a campaign name without emoji.', 'name');
  if (!numeric(b.account_id)) invalid('Use the exact numeric TikTok advertiser ID.', 'account_id');
  if (!numeric(b.tiktok_item_id)) invalid('Use the numeric ID of an existing TikTok post.', 'tiktok_item_id');
  if (b.identity_type !== 'TT_USER' && b.identity_type !== 'BC_AUTH_TT')
    invalid(
      'Choose the TikTok account identity type that owns the post: TT_USER or BC_AUTH_TT. A custom identity cannot run new ads on the TikTok placement.',
      'identity_type',
    );
  if (typeof b.identity_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.identity_id))
    invalid('Use the exact identity_id of the TikTok account that owns the post.', 'identity_id');
  const bc = b.identity_authorized_bc_id === '' ? undefined : b.identity_authorized_bc_id;
  if ((b.identity_type === 'BC_AUTH_TT') !== (bc !== undefined) || (bc !== undefined && !numeric(bc)))
    invalid(
      'identity_authorized_bc_id is the numeric Business Center ID, required for BC_AUTH_TT and only for it.',
      'identity_authorized_bc_id',
    );
  const locations = b.location_ids;
  if (
    !Array.isArray(locations) ||
    locations.length < 1 ||
    locations.length > 20 ||
    locations.some(l => !numeric(l, 16)) ||
    new Set(locations).size !== locations.length
  )
    invalid('Choose 1–20 distinct numeric TikTok location IDs (from /v1.3/tool/region/).', 'location_ids');
  if (!tiktokCallToActions.includes(b.call_to_action))
    invalid('Choose one of the listed calls to action.', 'call_to_action', undefined, {allowed: tiktokCallToActions});
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  // A Search Ads ad group is not passed a pixel or an optimization event: it optimizes clicks (the page, read 2026-11-20).
  for (const key of ['pixel_id', 'optimization_event'])
    if (b[key] !== undefined && b[key] !== '')
      invalid('A Search Ads campaign takes no pixel and no optimization event.', key);
  const keywords = searchKeywords(b.keywords),
    budget = tiktokBudget(b.daily_budget, b.currency),
    start = utc(b.start_time, 'start_time'),
    end = b.end_time === undefined || b.end_time === '' ? undefined : utc(b.end_time, 'end_time');
  if (end && end.time <= start.time) invalid('End time must follow start time.', 'end_time', 'RECIPE_DATE_INVALID');
  const step = (
    id: string,
    action: string,
    payload: JsonObject,
    depends_on: string[] = [],
    prerequisites: string[] = [],
    description?: string,
  ) => ({
    id,
    kind: 'write',
    gateway,
    account_id: b.account_id,
    connection_id: b.connection_id,
    expected_currency: b.currency,
    arguments: {action, payload},
    depends_on,
    ...(prerequisites.length ? {prerequisites} : {}),
    ...(description ? {description} : {}),
  });
  const creative: JsonObject = {
    ad_name: (b.name + ' · ad').slice(0, 512),
    ad_format: 'SINGLE_VIDEO',
    tiktok_item_id: b.tiktok_item_id,
    identity_type: b.identity_type,
    identity_id: b.identity_id,
    ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
    landing_page_url: url.href,
    call_to_action: b.call_to_action,
    // Under the disabled campaign the ad group and ad start enabled; enabling the campaign is the one activation.
    operation_status: 'ENABLE',
  };
  const byMatchType = Object.fromEntries(
    tiktokSearchMatchTypes.map(type => [type, keywords.filter(k => k.match_type === type).length]),
  );
  return {
    action: 'create',
    name: b.name,
    brief:
      tiktokSearchRecipe.name +
      ' in ' +
      b.currency +
      '. The campaign starts disabled. Search Ads campaigns are allowlist-only: TikTok refuses an advertiser without the allowlist for this objective at the campaign create, and nothing is created. Preflight reads the identity and post of the selected advertiser; every change uses its own review and activation is a separate reviewed change.',
    steps: [
      step(
        'campaign',
        'tiktok_campaign_create',
        {
          advertiser_id: b.account_id,
          campaign_name: b.name,
          objective_type: 'TRAFFIC',
          // Once set, this field cannot be updated; with campaign budget optimization off (no budget_optimize_on).
          is_search_campaign: true,
          // UNVERIFIED (M4 LV-24): the page's examples use BUDGET_MODE_TOTAL; this keeps the traffic pack's mode.
          budget_mode: 'BUDGET_MODE_INFINITE',
          operation_status: 'DISABLE',
        },
        [],
        [],
        'Create the paused Search Ads campaign. It needs TikTok’s Search Ads allowlist for this objective; without it TikTok refuses with code 40118 and nothing is created.',
      ),
      step(
        'adgroup',
        'tiktok_adgroup_create',
        {
          advertiser_id: b.account_id,
          campaign_id: {$ref: 'campaign#/data/data/campaign_id'},
          adgroup_name: (b.name + ' · Search').slice(0, 512),
          promotion_type: 'WEBSITE',
          placement_type: 'PLACEMENT_TYPE_NORMAL',
          placements: ['PLACEMENT_TIKTOK'],
          location_ids: locations,
          budget_mode: 'BUDGET_MODE_DAY',
          budget: budget.native,
          schedule_type: end ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
          schedule_start_time: start.text,
          ...(end ? {schedule_end_time: end.text} : {}),
          optimization_goal: 'CLICK',
          billing_event: 'CPC',
          bid_type: 'BID_TYPE_NO_BID',
          pacing: 'PACING_MODE_SMOOTH',
          search_keywords: keywords,
          operation_status: 'ENABLE',
        },
        ['campaign'],
      ),
      step(
        'ad',
        'tiktok_ad_create',
        {advertiser_id: b.account_id, adgroup_id: {$ref: 'adgroup#/data/data/adgroup_id'}, creatives: [creative]},
        ['adgroup'],
        ['tiktok_spark_post'],
      ),
    ],
    recipe: {
      id: tiktokSearchRecipe.id,
      platform: 'tiktok',
      currency: b.currency,
      daily_budget: budget.text,
      schedule_inputs: ['start_time', 'end_time'],
      schedule: {
        type: end ? 'SCHEDULE_START_END' : 'SCHEDULE_FROM_NOW',
        start_utc: start.text,
        end_utc: end?.text ?? null,
        meaning: 'TikTok reads ad group schedule times in UTC; the brief’s offsets were converted exactly.',
      },
      bidding_strategy: 'BID_TYPE_NO_BID',
      optimization_goal: 'CLICK',
      placements: ['PLACEMENT_TIKTOK'],
      location_ids: locations,
      keywords: {count: keywords.length, by_match_type: byMatchType},
      creative: {
        tiktok_item_id: b.tiktok_item_id,
        identity_type: b.identity_type,
        identity_id: b.identity_id,
        ...(bc !== undefined ? {identity_authorized_bc_id: bc} : {}),
      },
      bidding_effect:
        'Maximum delivery uses the daily budget to seek clicks on the keywords given. It does not guarantee a cost per click, impressions or results. Activation is separate.',
      budget_acceptance:
        'TikTok sets a minimum daily ad group budget per currency and refuses a smaller one at review or execution.',
      creative_acceptance:
        'Preflight reads the identity (available, may use its posts, not a political account) and the post (a video owned by the identity). Ad review, Spark authorization lifetime and objective acceptance remain unverified until TikTok reviews the ad.',
      keyword_acceptance:
        'TikTok reviews each keyword after the ad group is created (audit_status in the ad group read); AMCP reads the keywords back and does not wait for their review.',
      allowlist_acceptance:
        'Search Ads campaigns are allowlist-only for each objective, and TikTok documents no read of the allowlist, so preflight cannot check it. TikTok decides at the campaign create: an advertiser that is not on the allowlist for this objective is refused with code 40118, recorded as rejected, and nothing is created.',
      source: tiktokSearchSource,
    },
  };
}

/**
 * What recipe_context tells a person and an agent of the date TikTok's migration guide names (the lead's decision, 2026-11-21): static, with
 * no clock in it, and nothing is refused on the date. It restates the guide's statement in AMCP's words (TikTok's migration guide to
 * Upgraded Smart+, read 2026-11-21, and the banner of its create pages, read 2026-11-20); see the header of this module.
 */
export const tiktokSearchMigrationNotice =
  'TikTok’s migration guide to Upgraded Smart+ (read 2026-11-21) says that after December 31, 2026 Manual Campaigns can no longer be created with /campaign/create/, the endpoint this pack uses, while the notice on TikTok’s create pages (read 2026-11-20) names only Sales, App Promotion and Lead Generation campaigns that are not Search campaigns. Which reading holds for a Search campaign is not confirmed, so this pack may stop working after 2026-12-31. AMCP refuses nothing on that date; a Smart+ Search route is planned.';

// Writes and campaigns (wave 4c): what recipe_context says of the pack, as the traffic pack's context does (src/tiktok-launch-recipes.ts).
export const tiktokSearchContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Search Ads campaigns are allowlist-only for each objective: TikTok refuses an advertiser without the Traffic Search allowlist with code 40118 at the campaign create, which AMCP records as rejected with nothing created, and preflight cannot read the allowlist. Uses an existing TikTok post as a Spark Ad on the TikTok placement and optimizes clicks on the keywords given. Preflight reads the identity and post; keyword review, ad review and objective acceptance remain unverified. Activation is separate.',
    tiktokSearchMigrationNotice,
  ]),
  prerequisite:
    'TikTok Search Ads allowlist for the Traffic objective, an existing TikTok post and account identity with explicit location/schedule inputs and keywords',
});

/**
 * The evidence of the pack's dependencies that is its own (wave 4c, `campaign.dependencyEvidence`; the identity and the post are the
 * traffic pack's, src/tiktok-launch-recipes.ts): the Search Ads allowlist, which no read shows. It stays unknown, and says why.
 */
export function tiktokSearchDependencyEvidence(
  id: string,
  _context: DependencyEvidenceContext,
): JsonObject | undefined {
  if (id !== 'search_ads_allowlist') return undefined;
  return {
    status: 'unknown',
    meaning:
      'TikTok documents no read of its Search Ads allowlist, so preflight cannot check it. TikTok decides at the campaign create: an advertiser that is not on the allowlist for this objective is refused with code 40118, which AMCP records as rejected with nothing created.',
  };
}

/**
 * The keywords of a Search ad group as a set, for the read-back (the adapter's verification and observed hooks). TikTok adds the review
 * status of each keyword to the list it reads back (`audit_status` in the `search_keywords` array of /adgroup/get/, "Create Manual Search
 * Ads Campaigns", read 2026-11-20, which names the field and not its values) and states no order, while the create sent a list of
 * {keyword, match_type}. What the write sent is compared with what is stored as the set of those pairs and nothing else (the lead's review
 * S3-3): every other field of an item is TikTok's own, as the status is, and the page names one more, `keyword_bid_type`, which defaults to
 * FOLLOW_ADGROUP, so a comparison that dropped only the status would stop every build at the ad group the day TikTok adds another. A
 * missing, an extra, a duplicated, a re-cased and a re-typed keyword still differ. The review's own state keeps its list as TikTok reads it,
 * less the volatile `audit_status` (src/tiktok-adapter.ts).
 */
export function tiktokSearchKeywordSet(list: unknown[]): unknown[] {
  return list
    .map(item => {
      if (!obj(item)) return item;
      return Object.fromEntries(['keyword', 'match_type'].filter(key => key in item).map(key => [key, item[key]]));
    })
    .sort((a, b) => {
      const x = stable(a),
        y = stable(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}
