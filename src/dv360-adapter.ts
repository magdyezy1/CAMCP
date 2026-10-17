import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {
  dv360TargetingSearchResult,
  dv360TargetingSearchRoute,
  validateDV360TargetingSearch,
} from './dv360-targeting-search.js';

/**
 * Display & Video 360's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * targeting option search, a POST the catalog marks as a write, is a reviewed read. The account read is the advertiser.
 * On the wire, the targeting search is checked before it is sent and its response after, and the advertiser asset
 * uploads are its multipart/related contracts.
 */
export const dv360Hooks: ProviderHooks = Object.freeze({
  gateway: 'dv360_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => dv360TargetingSearchRoute(p),
    postRead: (plan: CompiledRequest) => dv360TargetingSearchRoute(plan),
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/v4/advertisers/' + id;
      return read;
    },
  }),
  wire: Object.freeze({
    validateRoute: validateDV360TargetingSearch,
    relatedUpload: (plan: CompiledRequest) =>
      plan.method === 'POST' &&
      /^\/upload\/v4\/advertisers\/\d+\/(?:assets|adAssets:uploadAdAsset)$/.test(plan.path) &&
      plan.query.uploadType === 'multipart',
    checkResult: (plan: CompiledRequest, data: unknown) => {
      if (dv360TargetingSearchRoute(plan)) dv360TargetingSearchResult(plan, data);
    },
  }),
});
