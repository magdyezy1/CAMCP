import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {xAudienceEstimateRoute} from './x-audience-estimate.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
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
  paging: Object.freeze({
    nextPage(_plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response),
        data = obj(d.data);
      const cursor = d.next_cursor ?? data.next_cursor;
      if (!cursor || cursor === '0') return null;
      next.query.cursor = cursor;
      return next;
    },
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/12/accounts/' + id;
      return read;
    },
  }),
});
