import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {snapchatPlanningRoute} from './snapchat-planning-reads.js';
import {MirrorError} from './errors.js';
import {errorObject, errorToken} from './provider-error-core.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
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
  paging: Object.freeze({
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      const link = d.paging?.next_link ?? d.paging?.next;
      if (!link) return null;
      const url = new URL(link, 'https://adsapi.snapchat.com');
      if (url.origin !== 'https://adsapi.snapchat.com' || url.pathname !== plan.path)
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed upstream scope.');
      const paginationKeys = new Set(['cursor', 'offset', 'page', 'page_token']);
      for (const [key, value] of url.searchParams) {
        if (paginationKeys.has(key)) {
          next.query[key] = value;
          continue;
        }
        const original = plan.query[key];
        if (original === undefined || String(original) !== value)
          throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed account scope or report filters.', {
            parameter: key,
          });
      }
      // The server may omit invariant filters from its link; retain them verbatim.
      return next;
    },
  }),
  // The account read returns the ad account wrapped like every entity read (adaccounts[0].adaccount, S8).
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/v1/adaccounts/' + id;
      return read;
    },
    account: (data: JsonObject) => data.adaccounts?.[0]?.adaccount,
  }),
  // Chunked media uploads INIT and FINALIZE as field-only multipart forms; a PATCH body is a JSON Patch; an update's
  // state reads carry their own deadline.
  wire: Object.freeze({
    fieldUpload: (plan: CompiledRequest) =>
      plan.method === 'POST' &&
      /^\/(?:[a-z]{2}\/)?v1\/media\/[\w-]+\/multipart-upload-v2$/.test(plan.path) &&
      ['INIT', 'FINALIZE'].includes(plan.query.action),
    jsonType: (plan: CompiledRequest) => (plan.method === 'PATCH' ? 'application/json-patch+json' : undefined),
    deadline: (plan: CompiledRequest) => (plan.readOnly && plan.method === 'GET' ? plan.snapUpdateDeadline : undefined),
    reportData: (plan: CompiledRequest) => /\/stats$/.test(plan.path),
    errors: Object.freeze({code: (body: unknown) => errorToken(errorObject(body).error_code)}),
  }),
});
