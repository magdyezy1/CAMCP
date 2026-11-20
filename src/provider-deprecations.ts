import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Dated provider deprecations below the version level (PRV-04): a route, an enum value, a header or a field that a
 * provider stops accepting on a known day while the API version AMCP sends stays the same. `src/provider-sunsets.ts`
 * records whole versions; this table records what changes inside one. Each entry cites its primary source, and the
 * module named by `enforcement` refuses it from `effective_date` (UTC) with PROVIDER_DEPRECATED before any provider
 * request, or, for a header, stops sending it. Values a deprecation leaves accepted are listed as `surviving`, and a
 * test keeps them accepted: a too-strict entry would block a request the provider still takes.
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
      'POST /v1.3/campaign/create/, /v1.3/adgroup/create/, /v1.3/ad/create/ and /v1.3/ad/aco/create/ for non-Search manual (Legacy Manual Flow) campaigns with the Sales, App Promotion or Lead Generation objective',
    values: ['WEB_CONVERSIONS', 'PRODUCT_SALES', 'APP_PROMOTION', 'LEAD_GENERATION', 'virtual_objective_type: SALES'],
    surviving: ['TRAFFIC', 'is_search_campaign: true'],
    effective_date: '2027-01-01',
    source_url: 'https://business-api.tiktok.com/portal/docs/create-ads/v1.3',
    accessed: '2026-11-19',
    enforcement:
      'src/tiktok-manual-cutoff.ts (a campaign create at inspect, prepare and execute; an ad group create from its parent campaign read), src/tiktok-launch-recipes.ts (the website purchases pack) and src/tiktok-campaign-clone.ts (the clone); an ad create is left to TikTok’s own refusal',
    note: 'A banner on TikTok’s "Create ads" page (read 2026-11-19, in a browser, by the field analysis of r25-field-tiktok) says that from January 1, 2027 these routes no longer create "non-Search Legacy Manual Flow campaigns", or ad groups or ads under them, for the Sales, App Promotion and Lead Generation objectives. That Sales means WEB_CONVERSIONS, PRODUCT_SALES or virtual_objective_type SALES, and the banner’s time zone, are unverified until the lead’s documentation session (the registry refuses from 00:00 UTC, at most hours early). Traffic and every Search campaign are not named. AMCP refuses a campaign create, an ad group create under such a campaign and the purchases pack before any request, naming the Upgraded Smart+ routes; existing campaigns keep running (the banner speaks of creating).',
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
/** The cited refusal of a deprecated request: no provider request is made. */
export function refuseDeprecated(id: string, message: string, details: JsonObject = {}): never {
  const entry = providerDeprecation(id);
  throw new MirrorError(
    'PROVIDER_DEPRECATED',
    message + ' (' + entry.provider + ', from ' + entry.effective_date + '; ' + entry.source_url + ').',
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
