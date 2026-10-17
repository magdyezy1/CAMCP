import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest} from './types.js';
import {dv360TargetingSearchRoute} from './dv360-targeting-search.js';

/**
 * Display & Video 360's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * targeting option search, a POST the catalog marks as a write, is a reviewed read.
 */
export const dv360Hooks: ProviderHooks = Object.freeze({
  gateway: 'dv360_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => dv360TargetingSearchRoute(p),
    postRead: (plan: CompiledRequest) => dv360TargetingSearchRoute(plan),
  }),
});
