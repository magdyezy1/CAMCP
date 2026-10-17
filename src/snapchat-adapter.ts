import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {snapchatPlanningRoute} from './snapchat-planning-reads.js';

/**
 * Snapchat's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the planning
 * POSTs, the by-ID entity reads, the audience, bid and forecasting estimates, and the catalog and Ads Library searches.
 */
export const snapchatHooks: ProviderHooks = Object.freeze({
  gateway: 'snapchat_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => !!snapchatPlanningRoute(p),
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /^\/v1\/adaccounts\/[^/]+\/(?:get_(?:campaigns|adsquads|ads|creatives|media)_by_ids|ad_squad_outcome_estimates_v2|audience_size(?:_v2)?|bid_estimate|targeting_insights|reserved_forecasting)$/.test(
        pathname,
      ) ||
      /^\/v1\/(?:catalogs\/[^/]+\/(?:product_search|products\/search|flights\/search|hotels\/search|facets)|ads_library\/(?:ads|sponsored_content)\/search)$/.test(
        pathname,
      ),
  }),
});
