import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {xAudienceEstimateRoute} from './x-audience-estimate.js';

/**
 * X Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the audience
 * estimate, a POST the catalog marks as a write, is a reviewed read.
 */
export const xHooks: ProviderHooks = Object.freeze({
  gateway: 'x_ads_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => xAudienceEstimateRoute(p),
    postRead: (plan: CompiledRequest) => xAudienceEstimateRoute(plan),
  }),
});
