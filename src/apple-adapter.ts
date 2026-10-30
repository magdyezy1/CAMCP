import type {CatalogHooks, ProviderHooks, WireHeaders} from './provider-adapter.js';
import type {CompiledRequest, JsonObject, ToolDefinition} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
// Writes and campaigns (wave 4c).
import type {SharedAccountContext} from './provider-adapter.js';
import {assertMeasurementScopes} from './measurement-writes.js';
import {
  appleBudgetState,
  appleSharedAccountReads,
  appleSharedAccounts,
  appleSharedBudget,
} from './apple-entity-writes.js';
import {appleActions, validateApplePlan} from './apple-native.js';
import {requestAppleAccessToken} from './apple-auth.js';

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
 * Wave 4c (transport and catalog): Apple's part of the catalog registry (src/catalog.ts). Its v1 actions are AMCP's
 * own, registered with its tool beside the captured catalog; their help describes them, and any other operation is
 * left to the registry's help.
 */
const appleCatalog: CatalogHooks = Object.freeze({
  supplemental: Object.freeze({actions: appleActions, requires: 'tool' as const}),
  help(input: JsonObject, tool: ToolDefinition) {
    const action = appleActions.find(a => a.name === input.operation);
    if (action)
      return {...structuredClone(action), qualification: 'Independent AMCP implementation; no live parity claim.'};
    if (!input.operation)
      return {
        ...structuredClone(tool.help),
        amcp_actions: appleActions.map(a => ({
          action: a.name,
          method: a.method,
          path: a.path,
          read_only: a.read_only,
        })),
        qualification:
          'Independent AMCP v1 extensions. Captured catalog counts are unchanged. Legacy v5 routes are unavailable.',
      };
    return undefined;
  },
});
/**
 * Apple Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * documented /query selectors of the Apple Ads API (v1 on api.ads.apple.com) are POST reads. A review keeps a
 * record's result without Apple's own status observations.
 */
export const appleHooks: ProviderHooks = Object.freeze({
  gateway: 'apple_ads_native_action',
  // Wave 4c (transport and catalog): its v1 actions' numeric IDs and account path are checked as they are compiled.
  compile: Object.freeze({beforeJob: validateApplePlan}),
  catalog: appleCatalog,
  // Its access token is renewed with its own client-credentials request (src/apple-auth.ts), not a refresh token.
  refresh: Object.freeze({own: requestAppleAccessToken}),
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
  // Writes and campaigns (wave 4c): its parts of the reviewed write lifecycle (src/write-review.ts). A shared budget
  // changes every account it spans, each bound and granted like the selected one; its organization is frozen.
  writes: Object.freeze({
    sharedAccounts: (plan: CompiledRequest) => appleSharedAccounts(plan),
    writePermission: assertMeasurementScopes,
    sharedState: appleSharedBudgetState,
    prerequisites: appleSharedBudgetScope,
    // The owner's spending policy (src/spend-policy.ts) compares a shared budget with its own current value alone.
    policyState: appleBudgetState,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its account
  // aliases (src/parameters.ts).
  parameters: Object.freeze({accountAliases: Object.freeze(['account_id', 'ad_account_id', 'org_id'])}),
});

// Writes and campaigns (wave 4c): moved verbatim from WriteReviewService.state (src/write-review.ts).
/** A shared budget's own read binds each account it spans; the first one also freezes them and reads each account. */
function appleSharedBudgetState(
  plan: CompiledRequest,
  read: CompiledRequest,
  data: unknown,
  {bind, reads}: SharedAccountContext,
): void {
  if (!appleSharedBudget(plan) || read.path !== plan.path) return;
  const accounts = appleSharedAccounts(plan, data),
    frozen = plan.scopeContext?.appleSharedAccountIds;
  for (const account of accounts) bind(account);
  if (!frozen) {
    plan.scopeContext = {...plan.scopeContext, appleSharedAccountIds: accounts};
    for (const extra of appleSharedAccountReads(plan, accounts))
      if (!reads.some(r => r.path === extra.path)) reads.push(extra);
  }
}
/** The organization of the selected account and the accounts a shared budget's result spans, frozen with the review. */
function appleSharedBudgetScope(plan: CompiledRequest, values: unknown[], reads: CompiledRequest[]): void {
  if (appleSharedBudget(plan) && !plan.scopeContext?.appleSharedOrgId) {
    const account = obj(values[reads.findIndex(r => r.path === '/v1/ad-accounts/' + plan.accountId)]).result;
    const target = obj(values[reads.findIndex(r => r.path === plan.path)]).result;
    plan.scopeContext = {
      ...plan.scopeContext,
      appleSharedAccountIds: appleSharedAccounts(plan),
      appleSharedOrgId: String(account.orgId),
      appleSharedResultAccounts: (obj(plan.body).adAccountIds ?? target.adAccountIds).map(String),
    };
  }
}
