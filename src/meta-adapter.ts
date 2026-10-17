import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {MirrorError} from './errors.js';
import {
  boundedWait,
  errorInteger,
  errorMinute,
  errorObject,
  metaRegainAccessMs,
  providerReference,
} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});

// Meta Graph and Marketing API error codes (developers.facebook.com: Graph API "Handling Errors" and Marketing API
// "Rate Limiting", read 2026-10-08). Only these documented codes are mapped; every other Meta code keeps its HTTP
// classification with layer `unknown`.
const metaThrottles = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);
/** The ad-account-level throttle subcodes Meta documents for codes 17 and 613. */
const metaAccountSubcodes = new Set([2446079, 1487742]);
/** A Meta refusal, classified from its documented codes (PRV-01); every Meta refusal is classified here. */
function classifyMetaError(input: ProviderErrorInput, context: ProviderErrorContext): ProviderErrorClass {
  const {headers, readOnly} = input,
    {base, legacyCode, legacyRetryable, layerOf} = context,
    error = errorObject(errorObject(input.body).error);
  const code = errorInteger(error.code),
    subcode = errorInteger(error.error_subcode),
    meta = {...base, ...(subcode !== undefined ? {providerSubcode: subcode} : {})};
  if (code === 190)
    return {...meta, code: 'REAUTHORIZATION_REQUIRED', layer: 'credential', retryable: false, documented: true};
  if (code !== undefined && (code === 10 || (code >= 200 && code <= 299)))
    return {...meta, code: 'PROVIDER_PERMISSION_MISSING', layer: 'consent', retryable: false, documented: true};
  if (code !== undefined && metaThrottles.has(code)) {
    const account = code >= 80000 || (subcode !== undefined && metaAccountSubcodes.has(subcode));
    return {
      ...meta,
      code: 'PLATFORM_RATE_LIMIT',
      layer: 'rate_limit',
      retryable: readOnly || legacyRetryable,
      retryAfterMs: boundedWait(
        Math.max(metaRegainAccessMs(headers.get('x-business-use-case-usage')) ?? errorMinute, input.retryAfterMs ?? 0),
      ),
      cooldownScope: account ? 'account' : 'login',
      documented: true,
    };
  }
  return {
    ...meta,
    code: legacyCode,
    layer: layerOf(legacyCode),
    // Meta marks a temporary failure is_transient; a read may be retried, a write never is.
    retryable: legacyRetryable || (readOnly && error.is_transient === true),
    documented: false,
  };
}
/**
 * Meta's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a Graph batch is
 * never a read, and an account's value rule sets are a documented read whose path holds "set". The account read is the
 * ad account node with its status, currency and time zone, which the response is.
 */
export const metaHooks: ProviderHooks = Object.freeze({
  gateway: 'meta_native_action',
  reads: Object.freeze({
    batch: (key: string) => key === 'batch',
    // GET act_<id>/value_rule_set. The fixed act_ path binds it, so it has no authorizer of its own.
    qualifiedRead: (p: CompiledRequest) =>
      (!p.origin || p.origin === 'https://graph.facebook.com') && metaRoute('act_\\d+/value_rule_set$').test(p.path),
  }),
  paging: Object.freeze({
    nextPage(_plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      if (!d.paging?.next) return null;
      const cursor = d.paging?.cursors?.after;
      if (!cursor) throw new MirrorError('UNKNOWN_PAGINATION', 'Meta advertises another page but supplies no cursor.');
      next.query.after = cursor;
      return next;
    },
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = metaPrefix + 'act_' + id;
      read.query = {fields: 'id,name,account_status,currency,timezone_name'};
      return read;
    },
    account: (data: JsonObject) => data,
  }),
  // Graph requests send their body form-encoded; Meta's trace ID may sit in the error body, and its documented codes
  // classify credential, permission and throttle refusals.
  wire: Object.freeze({
    formBody: () => true,
    reportData: (plan: CompiledRequest) => /\/insights$/.test(plan.path),
    errors: Object.freeze({
      bodyRequestId: (body: unknown) => providerReference(errorObject(errorObject(body).error).fbtrace_id),
      code: (body: unknown) => errorInteger(errorObject(errorObject(body).error).code),
      classify: classifyMetaError,
    }),
  }),
});
