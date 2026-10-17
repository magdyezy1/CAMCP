import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {googleGenerationKind} from './google-generation.js';

/**
 * Google Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented read RPCs a POST may carry (src/execution-risk.ts keeps the generic rules).
 */

// Read-only metadata is a compatibility observation, never sufficient execution authorization: POST reads must match
// this separately maintained list of documented read methods.
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
// Root-level RPCs are /vNN:method, not /vNN/customers/...:method. These documented planning metadata reads create no
// customer-owned resources.
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

export const googleAdsHooks: ProviderHooks = Object.freeze({
  gateway: 'google_ads_native_action',
  reads: Object.freeze({
    // Generation drafts (reviewed as reads), the customer read RPCs and the global planning reads.
    postRead: (plan: CompiledRequest, pathname: string) =>
      !!googleGenerationKind(plan) ||
      (/^\/v\d+\//.test(pathname) && googleReadMethods.has(pathname.split(':').at(-1)!)) ||
      googleGlobalRead(pathname),
  }),
});
