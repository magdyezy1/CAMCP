import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';

/**
 * Apple Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented /query selectors of the Apple Ads API (v1 on api.ads.apple.com) are POST reads.
 */
export const appleHooks: ProviderHooks = Object.freeze({
  gateway: 'apple_ads_native_action',
  reads: Object.freeze({
    postRead: (plan: CompiledRequest, pathname: string) =>
      plan.origin === 'https://api.ads.apple.com' &&
      /^\/v1\/(?:campaigns|adgroups|ads|creatives|keywords|negative-keywords|shared-budgets|reports\/apps\/(?:campaigns|adgroups|ads|keywords|searchterms)|eligibilities\/apps|product-pages|insights\/apps\/(?:impression-share|search-term-popularity)|suggestions\/keywords)\/query$/.test(
        pathname,
      ),
  }),
});
