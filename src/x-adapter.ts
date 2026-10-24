import type {ExpectState, ProviderHooks, ProviderVerificationRead, StateTarget} from './provider-adapter.js';
import type {CompiledRequest, Credentials, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {assertXTargeting} from './x-targeting-writes.js';
import {authorizeXAudienceEstimate, xAudienceEstimatePlan, xAudienceEstimateRoute} from './x-audience-estimate.js';
import {extendXReportTool} from './x-report-jobs.js';
import {scopeKey, sha256} from './security.js';
import {oauth1} from './oauth1.js';
import {errorInteger, errorObject, errorToken} from './provider-error-core.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/** X's catalog reference gives products and product sets a "JSON body"; catalogs and feeds take parameters. */
const jsonBody = (plan: CompiledRequest) =>
  (['POST', 'PUT'].includes(plan.method) &&
    /^\/12\/accounts\/[^/]+\/cards(?:\/[^/]+)?$/.test(plan.path) &&
    !/\/cards\/(?:poll|image_conversation|video_conversation)$/.test(plan.path)) ||
  (plan.method === 'POST' && /^\/12\/accounts\/[a-z0-9]{1,32}\/audience_estimate$/.test(plan.path)) ||
  (['PUT', 'DELETE'].includes(plan.method) && /^\/12\/product_catalogs\/\d+\/products$/.test(plan.path)) ||
  (['POST', 'PUT'].includes(plan.method) && /^\/12\/product_catalogs\/\d+\/product_sets(?:\/\d+)?$/.test(plan.path));
/**
 * X Ads' provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the audience
 * estimate, a POST the catalog marks as a write, is a reviewed read. On the wire, requests are signed with OAuth 1.0a
 * and their bodies form-encoded outside batches and the JSON-body routes; X's rate limits are its own (per access
 * token, origin and endpoint, its account limits under them) and a 429 reports its reset in headers.
 */
export const xHooks: ProviderHooks = Object.freeze({
  gateway: 'x_ads_native_action',
  // Wave 4c (transport and catalog): the audience estimate is planned as a bounded read after its report job's controls.
  compile: Object.freeze({afterJob: xAudienceEstimatePlan}),
  // Its tool takes the report job operations AMCP adds to the captured definition.
  catalog: Object.freeze({tools: Object.freeze({x_ads_native_action: extendXReportTool})}),
  checks: Object.freeze({
    shape: Object.freeze({
      // New campaigns and line items start paused; a targeting criterion follows its own contract.
      after(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
        if (/^\/12\/accounts\/[^/]+\/(campaigns|line_items)$/.test(plan.path) && plan.method === 'POST')
          expect(body, 'entity_status', ['PAUSED']);
        assertXTargeting(plan);
      },
    }),
    // An entity read returns it under data.
    state: Object.freeze({
      target: (_read: CompiledRequest, _result: TransportResult, data: JsonObject, context: StateTarget) =>
        context.sameIds([data.data?.id], [context.target()]),
    }),
  }),
  // A response's records are under data, the rest is its envelope; a write is verified by each record it returned.
  review: Object.freeze({
    snapshot: (_read: CompiledRequest, d: JsonObject) => (Object.hasOwn(d, 'data') ? {data: d.data} : d),
    verification(
      plan: CompiledRequest,
      result: JsonObject,
      read: (path: string, query?: JsonObject) => CompiledRequest,
    ): ProviderVerificationRead[] {
      const b = (plan.body ?? {}) as JsonObject,
        d = result.data ?? {};
      const records = Array.isArray(d.data) ? d.data : [d.data];
      return records.filter(Boolean).map((r: JsonObject) => ({
        read: read(plan.method === 'POST' ? plan.path + '/' + r.id : plan.path),
        expected: b,
        id: String(r.id),
      }));
    },
    observed: (_plan: CompiledRequest, data: JsonObject) => data.data,
  }),
  // The audience estimate: an account-scoped POST read of the current connection's account.
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'x_audience_estimate',
        stage: 'before_families' as const,
        claims: xAudienceEstimateRoute,
        authorize: authorizeXAudienceEstimate,
      }),
    ]),
  }),
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
  wire: Object.freeze({
    formBody: (plan: CompiledRequest) => !plan.path.includes('/batch/') && !jsonBody(plan),
    authorization: (plan: CompiledRequest, url: URL, credentials: Credentials, form?: URLSearchParams) =>
      oauth1(plan.method, url, credentials, form),
    userRateKey(tenantKey: string, url: URL, credentials: Credentials) {
      const endpoint = url.pathname.replace(/\/accounts\/[^/]+/, '/accounts/:account');
      return scopeKey(
        tenantKey,
        'x-rate',
        sha256(credentials.accessToken ?? ''),
        url.origin,
        endpoint.startsWith('/12/stats/accounts/') ? 'analytics' : endpoint,
      );
    },
    accountThrottle: (response: Response) => response.headers.has('x-account-rate-limit-reset'),
    resetWait(response: Response, now: number) {
      const reset = response.headers.get('x-account-rate-limit-reset') ?? response.headers.get('x-rate-limit-reset'),
        seconds = Number(reset);
      if (!reset || !Number.isFinite(seconds) || seconds <= 0) return undefined;
      const server = Date.parse(response.headers.get('date') ?? '');
      return seconds * 1000 - (Number.isFinite(server) ? server : now);
    },
    // Targeting, audience and report reads carry their own deadlines.
    deadline(plan: CompiledRequest) {
      if (!plan.readOnly) return undefined;
      if (plan.method === 'GET' && plan.xTargetingDeadline !== undefined) return plan.xTargetingDeadline;
      if (plan.xAudienceDeadline !== undefined) return plan.xAudienceDeadline;
      if (plan.method === 'GET' && plan.xReportDeadline !== undefined) return plan.xReportDeadline;
      return undefined;
    },
    failedResult: (data: JsonObject) => Array.isArray(data.errors) && data.errors.length > 0,
    errors: Object.freeze({
      code(body: unknown) {
        const errors = errorObject(body).errors,
          first = Array.isArray(errors) ? errorObject(errors[0]) : {};
        return errorToken(first.code) ?? errorInteger(first.code);
      },
    }),
  }),
});
