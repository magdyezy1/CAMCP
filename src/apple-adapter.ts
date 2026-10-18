import type {ProviderHooks, WireHeaders} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
// SDK output-only processing/approval observations are not advertiser edits.
const observational = new Set([
  'systemStatus',
  'systemStatusReasons',
  'systemStatusLimitingReasons',
  'displayStatus',
  'eligibility',
]);
/** An Apple record's ad account IDs, in one order (a shared budget lists the accounts it spans). */
const sortedAccounts = (ids: unknown[]) => [...ids].sort((a, b) => String(a).localeCompare(String(b), 'en'));
/**
 * Apple Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented /query selectors of the Apple Ads API (v1 on api.ads.apple.com) are POST reads. A review keeps a
 * record's result without Apple's own status observations.
 */
export const appleHooks: ProviderHooks = Object.freeze({
  gateway: 'apple_ads_native_action',
  // Its writes follow the measurement resource contract (src/measurement-writes.ts: Apple's entity and shared-budget
  // writes); a resource's 404 is its documented absence, and the resource checks every state read's target.
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404) return false;
        validateMeasurementState(read, result);
        return true;
      },
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
  review: Object.freeze({
    snapshot(_read: CompiledRequest, d: JsonObject) {
      if (!Object.hasOwn(d, 'result')) return d;
      const result = Object.fromEntries(Object.entries(d.result ?? {}).filter(([key]) => !observational.has(key)));
      if (Array.isArray(result.adAccountIds)) result.adAccountIds = sortedAccounts(result.adAccountIds);
      return {result};
    },
    // A deleted record an optional state read finds reads as absent.
    observed(plan: CompiledRequest, data: JsonObject) {
      if (plan.action === 'AMCP_STATE_OPTIONAL' && data.result?.deleted === true)
        return {amcp_absent: true, path: plan.path};
      return Array.isArray(data.result?.adAccountIds)
        ? {...data.result, adAccountIds: sortedAccounts(data.result.adAccountIds)}
        : data.result;
    },
  }),
  // The mandatory X-AP-Context header (below) confines every request to the selected account.
  scope: Object.freeze({resource: () => true}),
  reads: Object.freeze({
    postRead: (plan: CompiledRequest, pathname: string) =>
      plan.origin === 'https://api.ads.apple.com' &&
      /^\/v1\/(?:campaigns|adgroups|ads|creatives|keywords|negative-keywords|shared-budgets|reports\/apps\/(?:campaigns|adgroups|ads|keywords|searchterms)|eligibilities\/apps|product-pages|insights\/apps\/(?:impression-share|search-term-popularity)|suggestions\/keywords)\/query$/.test(
        pathname,
      ),
  }),
  paging: Object.freeze({
    // The query selectors of api.ads.apple.com page by offset in the body; any other Apple read pages generically.
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      if (plan.origin !== 'https://api.ads.apple.com' || !plan.path.endsWith('/query')) return undefined;
      const d = obj(response);
      const pagination = obj(d.pagination),
        body = obj(plan.body),
        requested = obj(body.pagination);
      const rows = Array.isArray(d.result) ? d.result : obj(d.result).rows;
      if (!Array.isArray(rows))
        throw new MirrorError('UNKNOWN_PAGINATION', 'Apple query response is missing its row collection.');
      const offset = requested.offset ?? 0,
        size = requested.pageSize ?? 100,
        total = pagination.totalCount;
      if (
        (pagination.offset !== undefined && pagination.offset !== offset) ||
        (pagination.pageSize !== undefined &&
          (!Number.isSafeInteger(pagination.pageSize) || pagination.pageSize < 0)) ||
        (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) ||
        rows.length > size
      )
        throw new MirrorError('UNKNOWN_PAGINATION', 'Apple returned inconsistent pagination metadata.');
      if ((total !== undefined && offset + rows.length >= total) || (total === undefined && rows.length < size))
        return null;
      if (!rows.length)
        throw new MirrorError('UNKNOWN_PAGINATION', 'Apple returned an empty page before its reported total.');
      next.body = {...body, pagination: {...requested, offset: offset + rows.length}};
      return next;
    },
  }),
  // Readiness reads the selected ad account on the Apple Ads API (CON-03), which answers with it under result.
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/v1/ad-accounts/' + id, 'https://api.ads.apple.com'),
    names: (id: string, data: JsonObject) => String((data.result ?? data).id) === id,
    account: (data: JsonObject) => data.result ?? data.data ?? data,
  }),
  wire: Object.freeze({
    // The selected account travels in X-AP-Context (adAccountId on the Apple Ads API v1, orgId on Search Ads).
    // Shared-budget mutations are organization-level methods in Apple's SDK: the review layer authorizes every
    // affected account and a header cannot scope them, so they carry none. Reads keep the selected-account context.
    headers({plan, url, headers}: WireHeaders) {
      if (!plan.accountId) return;
      const sharedWrite =
        url.origin === 'https://api.ads.apple.com' &&
        !plan.readOnly &&
        /^\/v1\/shared-budgets(?:\/\d+)?$/.test(plan.path);
      if (sharedWrite) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-ap-context') delete headers[key];
      } else
        headers['X-AP-Context'] =
          url.origin === 'https://api.ads.apple.com' && plan.path.startsWith('/v1/')
            ? 'adAccountId=' + plan.accountId + ';'
            : 'orgId=' + plan.accountId;
    },
  }),
});
