import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Dated provider deprecations below the version level (PRV-04): a route, an enum value, a header or a field that a
 * provider stops accepting on a known day while the API version AMCP sends stays the same. `src/provider-sunsets.ts`
 * records whole versions; this table records what changes inside one. Each entry cites its primary source, and the
 * module named by `enforcement` refuses it from `effective_date` (UTC) with PROVIDER_DEPRECATED before any provider
 * request, or, for a header, stops sending it. Values a deprecation leaves accepted are listed as `surviving`, and a
 * test keeps them accepted: a too-strict entry would block a request the provider still takes.
 *
 * A date can also be one from which a provider starts requiring something, such as a field, for advertisers on an
 * allowlist that no read shows (r25-m4b-endcards; the lead's decision L4 of M4b: "never a local refusal on a guess"). The
 * entry then gives the alarm and the dated text, and its `enforcement` says that the module only tells the review, and
 * leaves the refusal to the provider.
 */
export interface ProviderDeprecation {
  id: string;
  provider: string;
  scope: 'route' | 'enum' | 'header' | 'field';
  target: string;
  values?: readonly string[];
  surviving?: readonly string[];
  effective_date: string;
  source_url: string;
  accessed: string;
  enforcement: string;
  note: string;
}
const dv360Deprecations = 'https://developers.google.com/display-video/api/deprecations';
/** Line-item SensitiveCategory exclusions DV360 stops accepting on 2026-10-01; EMBEDDED_VIDEO and LIVE_STREAMING_VIDEO remain. */
export const deprecatedDV360SensitiveCategories = Object.freeze(
  [
    'ADULT',
    'DEROGATORY',
    'DOWNLOADS_SHARING',
    'WEAPONS',
    'GAMBLING',
    'VIOLENCE',
    'SUGGESTIVE',
    'PROFANITY',
    'ALCOHOL',
    'DRUGS',
    'TOBACCO',
    'POLITICS',
    'RELIGION',
    'TRAGEDY',
    'TRANSPORTATION_ACCIDENTS',
    'SENSITIVE_SOCIAL_ISSUES',
    'SHOCKING',
  ].map(v => 'SENSITIVE_CATEGORY_' + v),
);
/** Line-item content rating tier exclusions DV360 stops accepting on 2026-10-01; only CONTENT_RATING_TIER_UNRATED remains. */
export const deprecatedDV360ContentRatingTiers = Object.freeze(
  ['UNSPECIFIED', 'GENERAL', 'PARENTAL_GUIDANCE', 'TEENS', 'MATURE', 'FAMILIES'].map(v => 'CONTENT_RATING_TIER_' + v),
);
export const providerDeprecations: readonly ProviderDeprecation[] = Object.freeze([
  {
    id: 'x_v5_recommendations',
    provider: 'x',
    scope: 'route',
    target: 'GET /5/accounts/{account_id}/recommendations[/{recommendation_id}]',
    effective_date: '2020-03-03',
    source_url: 'https://docs.x.com/x-ads-api/fundamentals/versioning',
    accessed: '2026-10-08',
    enforcement: 'src/retired-provider-actions.ts (provider_unsupported)',
    note: 'X Ads API v5 was deprecated on 2019-08-28 and reached end of life on 2020-03-03; AMCP sends v12. The two captured recommendation reads still named /5/.',
  },
  {
    id: 'dv360_line_item_sensitive_category_exclusions',
    provider: 'dv360',
    scope: 'enum',
    target: 'SensitiveCategoryAssignedTargetingOptionDetails.excludedSensitiveCategory (line items and ad groups)',
    values: deprecatedDV360SensitiveCategories,
    surviving: ['SENSITIVE_CATEGORY_EMBEDDED_VIDEO', 'SENSITIVE_CATEGORY_LIVE_STREAMING_VIDEO'],
    effective_date: '2026-10-01',
    source_url: dv360Deprecations,
    accessed: '2026-10-08',
    enforcement: 'src/dv360-line-item-targeting.ts',
    note: 'The pinned Discovery document (.mirror/VENDOR/dv360-v4.json, revision 20260928) states for this field: "Starting on October 1, 2026, this field will only accept SENSITIVE_CATEGORY_EMBEDDED_VIDEO or SENSITIVE_CATEGORY_LIVE_STREAMING_VIDEO". Advertiser-level targeting stays provider-checked.',
  },
  {
    id: 'dv360_line_item_content_rating_exclusions',
    provider: 'dv360',
    scope: 'enum',
    target: 'DigitalContentLabelAssignedTargetingOptionDetails.excludedContentRatingTier (line items and ad groups)',
    values: deprecatedDV360ContentRatingTiers,
    surviving: ['CONTENT_RATING_TIER_UNRATED'],
    effective_date: '2026-10-01',
    source_url: dv360Deprecations,
    accessed: '2026-10-08',
    enforcement: 'src/dv360-line-item-targeting.ts',
    note: 'The pinned Discovery document (revision 20260928) states: "Starting on October 1, 2026, this field will only accept the value CONTENT_RATING_TIER_UNRATED. All other values will be deprecated". Advertiser-level targeting stays provider-checked.',
  },
  {
    id: 'dv360_youtube_ad_business_name_logo',
    provider: 'dv360',
    scope: 'field',
    target: 'DemandGenVideoAd.businessName and DemandGenVideoAd.logo',
    effective_date: '2026-10-12',
    source_url: dv360Deprecations,
    accessed: '2026-10-08',
    enforcement: 'src/dv360-demand-gen-ads.ts',
    note: 'YouTube video ads need a business name and a logo unless the advertiser sets defaultBusinessName and defaultLogoAssetId (pinned Discovery document: "required unless a default value is set at the advertiser level"). The review reads the advertiser defaults.',
  },
  {
    id: 'google_ads_developer_token_header',
    provider: 'google',
    scope: 'header',
    target: 'developer-token',
    effective_date: '2026-09-09',
    source_url: 'https://developers.google.com/google-ads/api/docs/api-policy/developer-token',
    accessed: '2026-10-08',
    enforcement: 'src/transport.ts (header no longer sent); src/google-version.ts (startup and health warning)',
    note: 'Google sunset developer tokens on 2026-09-09: the header is ignored today and a future major version will reject it. API access belongs to the OAuth client Cloud project.',
  },
  {
    id: 'reddit_report_breakdowns_2026_12',
    provider: 'reddit',
    scope: 'field',
    target: 'GET_INSIGHTS data.breakdowns',
    values: [
      'HOUR over more than 7 days',
      'more than one of KEYWORD, COMMUNITY, INTEREST, LANGUAGE',
      'one of those with DMA, METRO, REGION, GALLERY_ITEM_ID, CAROUSEL_CARD, OS_TYPE or COUNTRY',
    ],
    effective_date: '2026-12-08',
    source_url: 'https://ads-api.reddit.com/docs/v3/guides/programs/reporting/upcoming-reporting-api-changes',
    accessed: '2026-10-08',
    enforcement: 'src/reddit-report-rules.ts (compile path and reporting bootstrap warning)',
    note: 'The pinned Reddit OpenAPI (generated/vendor-routes.json, GET_INSIGHTS data.breakdowns) states that these requests return 400 Bad Request from December 8, 2026.',
  },
  {
    id: 'tiktok_manual_sales_app_lead_creates',
    provider: 'tiktok',
    scope: 'route',
    target:
      'POST /v1.3/campaign/create/, /v1.3/campaign/copy/task/create/, /v1.3/adgroup/create/, /v1.3/ad/create/ and /v1.3/ad/aco/create/ for non-Search manual (Legacy Manual Flow) campaigns with the Sales, App Promotion or Lead Generation objective',
    values: ['WEB_CONVERSIONS', 'PRODUCT_SALES', 'APP_PROMOTION', 'LEAD_GENERATION', 'virtual_objective_type: SALES'],
    surviving: ['TRAFFIC', 'is_search_campaign: true'],
    effective_date: '2027-01-01',
    source_url: 'https://business-api.tiktok.com/portal/docs/create-ads/v1.3',
    accessed: '2026-11-20',
    enforcement:
      'src/tiktok-manual-cutoff.ts (a campaign create at inspect, prepare and execute; an ad group create from its parent campaign read), src/tiktok-launch-recipes.ts (the website purchases pack) and src/tiktok-campaign-clone.ts (the clone); an ad create is left to TikTok’s own refusal, and the campaign copy task (/campaign/copy/task/create/) is withheld, so its family inherits this entry when it is qualified',
    note: 'A banner on TikTok’s API documentation pages (read 2026-11-19 by the field analysis of r25-field-tiktok, and again 2026-11-20 in the lead’s documentation session, impl/r25-m4-DOCS-EVIDENCE.md) says that from January 1, 2027 five endpoints, /campaign/create/, /campaign/copy/task/create/, /adgroup/create/, /ad/create/ and /ad/aco/create/, no longer support creating or copying "non-Search Legacy Manual Flow campaigns", or creating ad groups or ads under them, for the Sales, App Promotion and Lead Generation objectives. TikTok’s objective page says that Sales is WEB_CONVERSIONS or PRODUCT_SALES, merged into one objective that a campaign names with virtual_objective_type SALES; the other two are APP_PROMOTION and LEAD_GENERATION. AMCP refuses a WEB_CONVERSIONS or PRODUCT_SALES campaign with or without the virtual type, a fail-closed reading of a banner that does not say which form counts. The pages state no time zone (AMCP refuses from 00:00 UTC, at most hours early), no return code, and nothing about edits or status changes of existing campaigns (AMCP refuses creating only). A Search campaign (is_search_campaign true), a campaign whose row reads campaign_automation_type UPGRADED_SMART_PLUS or SMART_PLUS, and Traffic are not named, so they are not refused. TikTok’s Upgraded Smart+ migration guide (https://business-api.tiktok.com/portal/docs/upgraded-smart-campaign/v1.3, read 2026-11-21 by the lead) is wider than the banner: it says that after December 31, 2026 Manual campaigns can no longer be created with /campaign/create/, and that /campaign/update/ and /campaign/status/update/ keep working. The two pages conflict, since the banner names the Sales, App Promotion and Lead Generation objectives only. AMCP follows the banner and refuses only what it names, because a create TikTok stops makes nothing and the refusal TikTok gives is safe; the classic website traffic pack carries a static notice of the guide’s sentence and names the Smart+ traffic pack as the route that lasts (src/tiktok-launch-recipes.ts).',
  },
  {
    id: 'tiktok_smart_plus_end_cards',
    provider: 'tiktok',
    scope: 'field',
    target:
      'POST /v1.3/smart_plus/ad/create/ end_card_list (end cards, required for advertisers on TikTok’s allowlist in the ad scenarios it calls eligible)',
    effective_date: '2027-02-22',
    source_url: 'https://business-api.tiktok.com/portal/docs/use-end-cards-in-tiktok-ad-network-ads/v1.3',
    accessed: '2026-11-22',
    enforcement:
      'src/tiktok-smart-plus-end-cards.ts (a note in the review of a Smart+ ad create that has no end_card_list, from this day, only in the scenario the guide documents: a custom identity ad in a website ad group on Pangle placements, which this contract does not create yet; a Spark Ad with end cards has a caveat that TikTok decides instead; never a refusal: TikTok’s own refusal is definitive and creates nothing)',
    note: 'TikTok’s pages "Create an Upgraded Smart+ Ad" and "Use end cards in TikTok Ad Network ads" (read 2026-11-22) say, word for word: "Starting February 22, 2027, if you are an allowlisted advertiser, end cards are required for eligible ad scenarios. To ensure a seamless integration, begin including end cards for these scenarios now." They define no eligible scenario beyond the one their guide documents (an Upgraded Smart+ web campaign, an ad group on the TikTok Ad Network, a custom identity ad with at least one video and end_card_list set), document no read of the allowlist, and name no return code or time zone. AMCP therefore never refuses a create for lacking an end card. The review of a create with no end_card_list says from 2027-02-22 (UTC) that TikTok requires end cards for advertisers on its allowlist, and that if TikTok has allowlisted this advertiser it may refuse the ad, only for the scenario the guide documents: an ad under a custom identity in a website ad group on Pangle placements (the update page adds that such an ad cannot be created with TikTok placements). Every ad this contract creates is a Spark Ad, outside that scenario, so none of its reviews carries the note (the lead’s review of r25-m4b-endcards, S3-1: a note keyed on the placement alone told agents to add end cards, which TikTok refuses with 40118 for an advertiser that is not on its allowlist); the note waits for the package that creates custom identity ads (matrix A4). An Instant Form ad group, an ad group that is not on Pangle placements and an edit carry no note either. A request that sends end_card_list is read, reviewed and verified, with a caveat that a Spark Ad is outside the scenario and TikTok decides (src/tiktok-smart-plus-end-cards.ts). The "Update an Upgraded Smart+ Ad" page has no such sentence and says end_card_list only updates existing end cards.',
  },
]);
const day = 86400000;
let clock: () => number = Date.now;
/** The time deprecations are evaluated at. */
export function deprecationNow(): number {
  return clock();
}
/** Test hook: evaluate deprecations at another time (omit to restore the real clock). */
export function setDeprecationClock(next?: () => number): void {
  clock = next ?? Date.now;
}
/**
 * Test hook: the clock now in force, the real one unless a test or a preload (the clock probe of the M4a merge, which sets it to the day after
 * the cut-off for every test file) has set another. A test that pins the clock gives back the clock it found with this, not the real one, so
 * that the tests after it stay on the clock they were run on.
 */
export function deprecationClock(): () => number {
  return clock;
}
/** The UTC start of an entry's effective day. */
export function deprecationDate(entry: ProviderDeprecation): number {
  return Date.parse(entry.effective_date + 'T00:00:00Z');
}
export function providerDeprecation(id: string): ProviderDeprecation {
  const entry = providerDeprecations.find(d => d.id === id);
  if (!entry) throw Error('Unknown provider deprecation ' + id);
  return entry;
}
/** Whether a deprecation applies at `now`. */
export function deprecationEffective(id: string, now = deprecationNow()): boolean {
  return now >= deprecationDate(providerDeprecation(id));
}
/**
 * The cited refusal of a deprecated request: no provider request is made. A refusal given `messageValues` is a template of src/errors.ts, as
 * a refusal of any other kind can be (R2.5 M4, the lead's review of r25-m4-classic, S3-1): its `{slot}`s are filled from them, a page in another
 * language looks the template up as it is, and the entry's own provider, date and source are slots of its citation (`{provider}`,
 * `{effective_date}`, `{source}`), so a sentence has one key in the catalogue whichever entry says it. Without values the message is composed
 * here as it always was (DV360's and Reddit's), and a page shows it as written.
 */
export function refuseDeprecated(
  id: string,
  message: string,
  details: JsonObject = {},
  messageValues?: Record<string, string | number>,
): never {
  const entry = providerDeprecation(id);
  throw new MirrorError(
    'PROVIDER_DEPRECATED',
    message +
      (messageValues
        ? ' ({provider}, from {effective_date}; {source}).'
        : ' (' + entry.provider + ', from ' + entry.effective_date + '; ' + entry.source_url + ').'),
    {
      deprecation: entry.id,
      provider: entry.provider,
      scope: entry.scope,
      target: entry.target,
      effective_date: entry.effective_date,
      source: entry.source_url,
      accessed: entry.accessed,
      ...details,
    },
    400,
    false,
    messageValues
      ? {
          ...messageValues,
          provider: entry.provider,
          effective_date: entry.effective_date,
          source: entry.source_url,
        }
      : undefined,
  );
}
/** Each entry with the days until it takes effect; an alarm while it is 90 days away or less and not yet effective. */
export function deprecationStatus(now = deprecationNow(), days = 90) {
  return providerDeprecations.map(entry => {
    const left = Math.ceil((deprecationDate(entry) - now) / day);
    return {
      id: entry.id,
      provider: entry.provider,
      scope: entry.scope,
      target: entry.target,
      effective_date: entry.effective_date,
      days_until_effective: left,
      effective: left <= 0,
      alarm: left > 0 && left <= days,
      source: entry.source_url,
      enforcement: entry.enforcement,
    };
  });
}
/** Every entry is well formed: unique id, dated, cited, and its surviving values are not also deprecated. */
export function assertDeprecationRegistry(entries: readonly ProviderDeprecation[] = providerDeprecations): void {
  const problems: string[] = [];
  if (new Set(entries.map(e => e.id)).size !== entries.length) problems.push('an id is recorded twice');
  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.effective_date) || !Number.isFinite(deprecationDate(e)))
      problems.push(e.id + ': malformed effective_date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.accessed)) problems.push(e.id + ': malformed accessed date');
    if (!/^https:\/\//.test(e.source_url)) problems.push(e.id + ': the source must be an https URL');
    if (e.surviving?.some(v => e.values?.includes(v))) problems.push(e.id + ': a surviving value is also deprecated');
  }
  if (problems.length) throw Error('Provider deprecation registry: ' + problems.join('; '));
}
