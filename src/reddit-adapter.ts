import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';

/**
 * Reddit's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: reports, plus
 * the PRV-07 planning and history reads (src/reddit-extensions.ts), are POST reads.
 */
export const redditHooks: ProviderHooks = Object.freeze({
  gateway: 'reddit_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /^\/api\/v3\/ad_accounts\/[^/]+\/(?:reports|history|forecasting\/audience_and_delivery_estimates)$/.test(
        pathname,
      ) || ['/api/v3/forecasting/bid_suggestions', '/api/v3/targeting/keyword_suggestions'].includes(pathname),
  }),
});
