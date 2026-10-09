import type {CompiledRequest} from './types.js';
import {microsoftGateway, microsoftRead} from './microsoft-native.js';
import {qualifiedProviderRead} from './provider-read-contracts.js';
import {googleGenerationKind} from './google-generation.js';
import {dv360TargetingSearchRoute} from './dv360-targeting-search.js';
import {xAudienceEstimateRoute} from './x-audience-estimate.js';
import {snapchatPlanningRoute} from './snapchat-planning-reads.js';
import {linkedinPlanningRoute} from './linkedin-planning-reads.js';
import {tiktokPreviewRoute} from './tiktok-preview-reads.js';
import {familyOf} from './reviewed-families.js';
import {criteoRoute} from './criteo-version.js';

// Read-only metadata is a compatibility observation, never sufficient execution
// authorization. POST reads must match a separately maintained route allowlist.
const googleReadMethods = new Set([
  'search',
  'searchStream',
  'suggest',
  'generateAudienceCompositionInsights',
  'generateAudienceDefinition',
  'generateAudienceOverlapInsights',
  'generateInsightsFinderReport',
  'generateSuggestedTargetingInsights',
  'generateTargetingSuggestionMetrics',
  'searchAudienceInsightsAttributes',
  'listInsightsEligibleDates',
  'generateBenchmarksMetrics',
  'listBenchmarksAvailableDates',
  'listBenchmarksLocations',
  'listBenchmarksProducts',
  'listBenchmarksSources',
  'suggestBrands',
  'generateCreatorInsights',
  'generateTrendingInsights',
  'generateAdGroupThemes',
  'generateKeywordForecastMetrics',
  'generateKeywordHistoricalMetrics',
  'generateKeywordIdeas',
  'generateConversionRates',
  'generateReachForecast',
  'listPlannableLocations',
  'listPlannableProducts',
  'listPlannableUserInterests',
  'listPlannableUserLists',
  'quoteCampaigns',
  'suggestKeywordThemes',
  'suggestSmartCampaignAd',
  'suggestSmartCampaignBudgetOptions',
  'suggestTravelAssets',
]);
const tiktokReads = new Set([
  '/v1.3/ad/audience_size/estimate/',
  '/v1.3/audience/insight/info/',
  '/v1.3/tool/bid/recommend/',
  '/v1.3/tool/targeting/info/',
  '/v1.3/tool/targeting/search/',
  '/v1.3/tool/targeting_category/recommend/',
  '/v1.3/business/message/auto_message/get/',
  '/v1.3/business/message/media/download/',
  '/v1.3/gmv_max/creation/custom_anchor_video_list/get/',
]);
// Root-level RPCs are /vNN:method, not /vNN/customers/...:method. These
// documented planning metadata reads create no customer-owned resources.
const googleGlobalReadMethods = new Set([
  'generateConversionRates',
  'listBenchmarksAvailableDates',
  'listBenchmarksLocations',
  'listBenchmarksProducts',
  'listBenchmarksSources',
  'listPlannableLocations',
  'listPlannableProducts',
  'listPlannableUserInterests',
  'listPlannableUserLists',
]);
// Two documented planning reads sit under a service rather than the root: /vNN/audienceInsights:listInsightsEligibleDates
// and /vNN/keywordThemeConstants:suggest. Neither names a customer.
const googleGlobalServiceReads = new Set([
  'audienceInsights:listInsightsEligibleDates',
  'keywordThemeConstants:suggest',
]);
/** A documented Google Ads planning read outside any customer (a decoded path). */
export function googleGlobalRead(pathname: string): boolean {
  const m = /^\/v\d+(?::([A-Za-z]+)|\/([A-Za-z]+:[A-Za-z]+))$/.exec(pathname);
  return !!m && (m[1] ? googleGlobalReadMethods.has(m[1]) : googleGlobalServiceReads.has(m[2]!));
}
export function independentlyReadOnly(plan: CompiledRequest): boolean {
  if (
    !plan.readOnly &&
    !dv360TargetingSearchRoute(plan) &&
    !xAudienceEstimateRoute(plan) &&
    !snapchatPlanningRoute(plan) &&
    !linkedinPlanningRoute(plan) &&
    !tiktokPreviewRoute(plan)
  )
    return false;
  if (plan.gateway === microsoftGateway) return microsoftRead(plan);
  let pathname: string;
  try {
    pathname = decodeURIComponent(plan.path);
  } catch {
    return false;
  }
  // Search Console encodes full property/sitemap URLs as resource segments.
  // Their escaped query delimiters and path words are identifiers, not HTTP
  // method overrides. Only documented fixed route structures receive this rule.
  if (
    plan.gateway === 'google_search_console_native_action' &&
    /^\/webmasters\/v3\/sites\/[^/?#\r\n\\]+(?:\/sitemaps(?:\/[^/?#\r\n\\]+)?|\/searchAnalytics\/query)?$/.test(
      plan.path,
    )
  )
    pathname = plan.path
      .replace(/^(\/webmasters\/v3\/sites\/)[^/]+/, '$1PROPERTY')
      .replace(/(\/sitemaps\/)[^/]+$/, '$1SITEMAP');
  if (/[?#\r\n\\]/.test(pathname)) return false;
  const tokens = pathname
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[\/_:.-]+/);
  if (
    !qualifiedProviderRead(plan) &&
    !tiktokPreviewRoute(plan) &&
    tokens.some(t =>
      [
        'update',
        'delete',
        'remove',
        'mutate',
        'activate',
        'deactivate',
        'publish',
        'unpublish',
        'revoke',
        'authorize',
        'authorization',
        'verify',
        'create',
        'insert',
        'patch',
        'set',
        'upload',
        'submit',
        'send',
      ].includes(t),
    )
  )
    return false;
  const queryAndBody = [plan.query, plan.body];
  for (const bag of queryAndBody)
    if (bag && typeof bag === 'object' && !Array.isArray(bag))
      for (const [key, v] of Object.entries(bag)) {
        if (
          ['method', '_method', 'http_method', 'method_override'].includes(key.toLowerCase()) &&
          !['GET', 'HEAD'].includes(String(v).toUpperCase())
        )
          return false;
        if (plan.gateway === 'meta_native_action' && key.toLowerCase() === 'batch') return false;
      }
  let override: string | undefined;
  for (const [key, value] of Object.entries(plan.headers)) {
    if (key.toLowerCase() === 'x-http-method-override') {
      const method = value.toUpperCase();
      if (!['GET', 'HEAD'].includes(method) || (override !== undefined && override !== method)) return false;
      override = method;
    }
    if (
      key.toLowerCase() === 'x-restli-method' &&
      !['GET', 'BATCH_GET', 'FINDER', 'GET_ALL'].includes(value.toUpperCase())
    )
      return false;
  }
  const method = override ?? plan.method;
  if (['GET', 'HEAD'].includes(method)) return true;
  if (method !== 'POST') return false;
  switch (plan.gateway) {
    case 'x_ads_native_action':
      return xAudienceEstimateRoute(plan);
    case 'dv360_native_action':
      return dv360TargetingSearchRoute(plan);
    case 'linkedin_native_action':
      return !!linkedinPlanningRoute(plan);
    case 'google_ads_native_action':
      return (
        !!googleGenerationKind(plan) ||
        (/^\/v\d+\//.test(pathname) && googleReadMethods.has(pathname.split(':').at(-1)!)) ||
        googleGlobalRead(pathname)
      );
    case 'tiktok_native_action':
      return tiktokReads.has(pathname.replace(/^\/open_api/, '')) || !!tiktokPreviewRoute(plan);
    case 'snapchat_native_action':
      return (
        /^\/v1\/adaccounts\/[^/]+\/(?:get_(?:campaigns|adsquads|ads|creatives|media)_by_ids|ad_squad_outcome_estimates_v2|audience_size(?:_v2)?|bid_estimate|targeting_insights|reserved_forecasting)$/.test(
          pathname,
        ) ||
        /^\/v1\/(?:catalogs\/[^/]+\/(?:product_search|products\/search|flights\/search|hotels\/search|facets)|ads_library\/(?:ads|sponsored_content)\/search)$/.test(
          pathname,
        )
      );
    case 'ga4_native_action':
      return (
        /\/properties\/[^/:]+:(?:runReport|batchRunReports|runPivotReport|batchRunPivotReports|runRealtimeReport|checkCompatibility|runFunnelReport)$/.test(
          pathname,
        ) ||
        /^\/v1beta\/properties\/[^/:]+\/audienceExports\/[^/:]+:query$/.test(pathname) ||
        /^\/v1alpha\/properties\/[^/:]+\/reportTasks\/[^/:]+:query$/.test(pathname)
      );
    case 'gtm_native_action':
      return /\/folders\/[^/:]+:entities$/.test(pathname);
    case 'google_search_console_native_action':
      return /\/searchAnalytics\/query$/.test(pathname) || pathname === '/v1/urlInspection/index:inspect';
    case 'criteo_native_action':
      return (
        /\/(?:search|preview)$/.test(pathname) ||
        criteoRoute('/retailers/[^/:]+/(?:cpc-min-bids|recommend-categories|recommend-keywords)$').test(pathname)
      );
    case 'google_business_native_action':
      return (
        (plan.origin === 'https://mybusinessbusinessinformation.googleapis.com' &&
          pathname === '/v1/googleLocations:search') ||
        (plan.origin === 'https://mybusinessverifications.googleapis.com' &&
          /^\/v1\/locations\/[^/:]+:fetchVerificationOptions$/.test(pathname))
      );
    case 'reddit_native_action':
      return /^\/api\/v3\/ad_accounts\/[^/]+\/reports$/.test(pathname);
    case 'apple_ads_native_action':
      return (
        plan.origin === 'https://api.ads.apple.com' &&
        /^\/v1\/(?:campaigns|adgroups|ads|creatives|keywords|negative-keywords|shared-budgets|reports\/apps\/(?:campaigns|adgroups|ads|keywords|searchterms))\/query$/.test(
          pathname,
        )
      );
    default:
      return false;
  }
}
/**
 * Deletions a provider takes as a body value on a route that is not a DELETE (WRT-02). The catalog marks these routes
 * non-destructive, so without this table the owner's allow_deletion:false let them through. Each gateway maps a field
 * (snake_case) to the values that delete or remove; they match anywhere in the body, JSON Patch operations and REST.li
 * `$set` patches included. tests/deletion-policy-coverage.test.mjs holds every deletion value of the pinned provider
 * documents against this table, so a newly pinned value fails until it is classified here or exempted there.
 */
export const bodyDeletionValues: Readonly<
  Record<string, {readonly fields: Readonly<Record<string, readonly string[]>>; readonly source: string}>
> = Object.freeze({
  tiktok_native_action: {
    fields: {operation_status: ['DELETE']},
    source:
      'API for Business v1.3 campaign, ad group and ad /status/update/: operation_status ENABLE, DISABLE or DELETE',
  },
  meta_native_action: {
    fields: {status: ['DELETED']},
    source: 'Marketing API campaign, ad set and ad updates: status ACTIVE, PAUSED, DELETED or ARCHIVED',
  },
  google_ads_native_action: {
    // A REMOVE account budget proposal, experiment asset detail or targeting restriction operation removes what it names.
    fields: {
      status: ['REMOVED'],
      proposal_type: ['REMOVE'],
      asset_detail_operation: ['REMOVE'],
      operator: ['REMOVE'],
    },
    source: 'pinned Google Ads v25 Discovery document: writable enums of the request messages',
  },
  reddit_native_action: {
    fields: {configured_status: ['DELETED'], status: ['DELETED']},
    source:
      'pinned Reddit Ads API v3 OpenAPI document: configured_status and status ACTIVE, ARCHIVED, DELETED or PAUSED',
  },
  dv360_native_action: {
    fields: {entity_status: ['ENTITY_STATUS_SCHEDULED_FOR_DELETION']},
    source:
      'pinned Display & Video 360 v4 Discovery document: "the advertiser will be deleted 30 days from when it was first scheduled for deletion"',
  },
  linkedin_native_action: {
    fields: {status: ['PENDING_DELETION', 'REMOVED'], intended_status: ['PENDING_DELETION', 'REMOVED']},
    source:
      'LinkedIn campaign groups and creatives: "update the status to PENDING_DELETION" to delete (src/linkedin-entity-deletes.ts)',
  },
  microsoft_ads_native_action: {
    // Status Deleted on entities; Action Delete in AdGroupCriterionAction and AssetGroupListingGroupAction.
    fields: {status: ['Deleted'], action: ['Delete']},
    source: 'pinned Microsoft Advertising v13 Campaign Management WSDL: entity statuses Deleted, ItemAction Delete',
  },
});
const riskField = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * Where the body of a write deletes something by value: a value of `bodyDeletionValues`, or a Google Ads `remove`
 * operation (`{remove: 'customers/…'}`, nested under any operation wrapper). Undefined when it does not.
 */
export function bodyDeletion(plan: CompiledRequest): string | undefined {
  const rule = bodyDeletionValues[plan.gateway]?.fields,
    google = plan.gateway === 'google_ads_native_action';
  if (!rule && !google) return;
  const deletes = (field: string, value: unknown) =>
    typeof value === 'string' && !!rule?.[riskField(field)]?.includes(value);
  const walk = (v: unknown, path: string, depth: number): string | undefined => {
    // A body nested deeper than this cannot be inspected; deny it the benefit of the doubt.
    if (depth > 64) return path || '/';
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) {
        const hit = walk(x, path + '/' + i, depth + 1);
        if (hit) return hit;
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string' && Object.hasOwn(o, 'value') && deletes(o.path.split('/').at(-1) ?? '', o.value))
      return path + '/value';
    for (const [k, x] of Object.entries(o)) {
      if (deletes(k, x)) return path + '/' + k;
      if (google && k === 'remove' && typeof x === 'string' && x.startsWith('customers/')) return path + '/' + k;
      const hit = walk(x, path + '/' + k, depth + 1);
      if (hit) return hit;
    }
  };
  return walk(plan.body, '/body', 0);
}
/**
 * `before`, the reviewed state when the caller has it, lets a family decide a deletion that depends on the current
 * state (a feed whose deletion rule is already on): the owner policy passes it at prepare and execute.
 */
export function applyExecutionRisk(plan: CompiledRequest, before?: unknown): CompiledRequest {
  const readOnly = independentlyReadOnly(plan);
  // Google's RPC remains POST for remove operations. Catalog method/risk flags
  // cannot decide whether the frozen operation deletes an association or entity.
  const googleRemoval =
    plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    plan.path.endsWith(':mutate') &&
    [
      ...(Array.isArray((plan.body as any)?.operations) ? (plan.body as any).operations : []),
      (plan.body as any)?.operation,
    ].some((op: any) => op && typeof op.remove === 'string');
  const family = familyOf(plan);
  const warnings = [
    ...plan.warnings,
    ...(family?.warnings?.(plan) ?? []),
    ...(plan.readOnly && !readOnly
      ? [
          'Catalog read-only metadata is not sufficient for this route; execution is treated as a mutation or an unqualified operation.',
        ]
      : []),
  ];
  return {
    ...plan,
    readOnly,
    destructive:
      plan.destructive ||
      googleRemoval ||
      (!readOnly && bodyDeletion(plan) !== undefined) ||
      family?.destructive?.(plan, before) === true,
    requiresConfirmation: plan.requiresConfirmation || !readOnly,
    warnings: [...new Set(warnings)],
  };
}
