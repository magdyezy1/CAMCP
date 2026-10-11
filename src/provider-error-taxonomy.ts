import {providerHttpErrorCode} from './errors.js';

/**
 * Which party must act on a provider refusal (PRV-01). `credential`: the login's token expired or was revoked, so the
 * login is reauthorized. `consent`: the provider names a permission the login has not granted. `role_or_asset_access`
 * and `app_eligibility`: a provider role, asset or application tier the provider itself names. `rate_limit`: the
 * provider throttled the caller. `api_version`: the provider no longer accepts the API version AMCP sent. `unknown`:
 * nothing documented identifies the cause, which is never guessed (a bare 403 stays here).
 */
export type ProviderErrorLayer =
  'credential' | 'consent' | 'role_or_asset_access' | 'app_eligibility' | 'rate_limit' | 'api_version' | 'unknown';
export interface ProviderErrorInput {
  gateway: string;
  status: number;
  headers: {get(name: string): string | null};
  body: unknown;
  readOnly: boolean;
  /** The provider's own unsuccessful result inside a 2xx response. */
  inBody?: boolean;
  /** A delay the transport already derived from Retry-After or the X reset headers. */
  retryAfterMs?: number;
}
export interface ProviderErrorClass {
  code: string;
  layer: ProviderErrorLayer;
  retryable: boolean;
  retryAfterMs?: number;
  /** `account`: the provider throttled the selected ad account; `login`: the whole login or application. */
  cooldownScope?: 'account' | 'login';
  /** A closed-set provider token (^[A-Z0-9_]{2,64}$) or a number; free provider text is never copied. */
  providerCode?: string | number;
  providerSubcode?: number;
  /** A documented provider table entry, not only the HTTP status, decided the classification. */
  documented: boolean;
}
/** The classifier is on unless the deployment turns it off; off, the transport returns exactly the pre-PRV-01 codes. */
export const providerErrorTaxonomyEnabled = (value = process.env.AMCP_PROVIDER_ERROR_TAXONOMY) => value !== 'off';

const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
const token = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Z0-9_]{2,64}$/.test(v) ? v : undefined;
const integer = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
/** A provider correlation reference: at most 128 token characters, never free text. */
export const providerReference = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+=\/-]{0,127}$/.test(v) ? v : undefined;

/**
 * The provider's correlation reference for a response. LinkedIn asks callers to record x-li-uuid (x-li-request-id on
 * older responses); Meta's trace ID is a header or, when the header is absent, error.fbtrace_id in the body. Values that
 * are not short tokens are dropped rather than echoed.
 */
export function providerRequestId(
  gateway: string,
  headers: {get(name: string): string | null},
  body: unknown,
): string | undefined {
  const header = (name: string) => providerReference(headers.get(name));
  return (
    (gateway === 'linkedin_native_action' ? (header('x-li-uuid') ?? header('x-li-request-id')) : undefined) ??
    header('request-id') ??
    header('x-request-id') ??
    header('x-fb-trace-id') ??
    (gateway === 'meta_native_action' ? providerReference(object(object(body).error).fbtrace_id) : undefined)
  );
}
/** The provider's own code from the documented error shapes; anything that is not a token or an integer is dropped. */
export function providerErrorCode(gateway: string, body: unknown): string | number | undefined {
  const root = object(body),
    error = object(root.error),
    first = (v: unknown) => (Array.isArray(v) ? object(v[0]) : {});
  if (gateway === 'meta_native_action') return integer(error.code);
  if (gateway === 'tiktok_native_action') return integer(root.code);
  if (gateway === 'linkedin_native_action') return token(root.code) ?? integer(root.serviceErrorCode);
  if (gateway === 'google_ads_native_action') {
    for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : [])
      for (const row of Array.isArray(object(detail).errors) ? object(detail).errors.slice(0, 10) : []) {
        const found = Object.values(object(object(row).errorCode))
          .map(token)
          .find(Boolean);
        if (found) return found;
      }
    return token(error.status);
  }
  if (gateway === 'x_ads_native_action') return token(first(root.errors).code) ?? integer(first(root.errors).code);
  if (gateway === 'snapchat_native_action') return token(root.error_code);
  return (
    integer(error.code) ??
    token(error.status) ??
    token(error.code) ??
    token(first(error.details).reason) ??
    token(root.code) ??
    integer(root.code) ??
    token(root.error_code) ??
    token(first(root.errors).code)
  );
}

// Meta Graph and Marketing API error codes (developers.facebook.com: Graph API "Handling Errors" and Marketing API
// "Rate Limiting", read 2026-10-08). Only these documented codes are mapped; every other Meta code keeps its HTTP
// classification with layer `unknown`.
const metaThrottles = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);
/** The ad-account-level throttle subcodes Meta documents for codes 17 and 613. */
const metaAccountSubcodes = new Set([2446079, 1487742]);
const minute = 60000;
/** The longest estimated_time_to_regain_access (minutes) in X-Business-Use-Case-Usage, as milliseconds. */
export function metaRegainAccessMs(header: string | null): number | undefined {
  if (!header || header.length > 16384) return;
  let usage: unknown;
  try {
    usage = JSON.parse(header);
  } catch {
    return;
  }
  let longest: number | undefined;
  for (const entries of Object.values(object(usage)).slice(0, 50))
    for (const entry of Array.isArray(entries) ? entries.slice(0, 50) : []) {
      const value = object(entry).estimated_time_to_regain_access;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        longest = Math.max(longest ?? 0, value * minute);
    }
  return longest;
}
/** Google Ads QuotaErrorDetails.retryDelay ("30s", "1.5s"), as milliseconds. */
function googleRetryDelay(row: Record<string, any>): number | undefined {
  const value = object(object(row.details).quotaErrorDetails).retryDelay,
    match = typeof value === 'string' ? /^(\d{1,6}(?:\.\d{1,9})?)s$/.exec(value) : null;
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}
const bounded = (ms: number) => Math.max(1000, Math.min(86400000, Math.ceil(ms)));

/**
 * One provider refusal, classified from documented provider codes before the HTTP status (PRV-01). Unknown codes keep
 * today's code with layer `unknown`. A refusal of a write is never made retryable here: writes are sent once.
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClass {
  const {gateway, status, headers, body, readOnly} = input,
    providerCode = providerErrorCode(gateway, body),
    root = object(body),
    error = object(root.error);
  const legacyCode = input.inBody
      ? 'PLATFORM_ERROR'
      : providerHttpErrorCode(status, body, headers.get('www-authenticate')),
    legacyRetryable = input.inBody ? false : status === 429 || status >= 500;
  const base = {
    ...(providerCode !== undefined ? {providerCode} : {}),
  };
  const layerOf = (code: string): ProviderErrorLayer =>
    code === 'AUTH_EXPIRED'
      ? 'credential'
      : code === 'PLATFORM_RATE_LIMIT'
        ? 'rate_limit'
        : code === 'INSUFFICIENT_SCOPE'
          ? 'consent'
          : 'unknown';
  if (gateway === 'meta_native_action') {
    const code = integer(error.code),
      subcode = integer(error.error_subcode),
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
        retryAfterMs: bounded(
          Math.max(metaRegainAccessMs(headers.get('x-business-use-case-usage')) ?? minute, input.retryAfterMs ?? 0),
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
  if (gateway === 'google_ads_native_action') {
    for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : [])
      for (const row of Array.isArray(object(detail).errors) ? object(detail).errors.slice(0, 10) : [])
        if (object(object(row).errorCode).quotaError === 'RESOURCE_TEMPORARILY_EXHAUSTED')
          return {
            ...base,
            code: 'PLATFORM_RATE_LIMIT',
            layer: 'rate_limit',
            retryable: readOnly || legacyRetryable,
            retryAfterMs: bounded(Math.max(googleRetryDelay(object(row)) ?? 30000, input.retryAfterMs ?? 0)),
            cooldownScope: 'login',
            documented: true,
          };
  }
  // Google answers a Cloud project it has not approved for the Business Profile APIs with a quota of 0 requests per
  // minute (google.rpc.ErrorInfo metadata quota_limit_value "0"), and one without the APIs enabled with SERVICE_DISABLED
  // (developers.google.com/my-business/content/prereqs, read 2026-10-08). Retrying or reconnecting cannot help; the
  // deployment owner must act (CON-06).
  if (gateway === 'google_business_native_action' && !input.inBody && [403, 429].includes(status))
    for (const detail of Array.isArray(error.details) ? error.details.slice(0, 10) : []) {
      const d = object(detail),
        quota = object(d.metadata).quota_limit_value;
      if ((status === 429 && quota === '0') || (status === 403 && d.reason === 'SERVICE_DISABLED'))
        return {
          ...base,
          code: 'BUSINESS_PROFILE_API_NOT_APPROVED',
          layer: 'app_eligibility',
          retryable: false,
          providerCode: status === 429 ? 'RESOURCE_EXHAUSTED' : 'SERVICE_DISABLED',
          documented: true,
        };
    }
  if (gateway === 'linkedin_native_action' && !input.inBody && status === 426)
    return {...base, code: 'PROVIDER_VERSION_UNSUPPORTED', layer: 'api_version', retryable: false, documented: true};
  // TikTok reports token and QPS failures inside HTTP 200 bodies. Its official return-code table has not been
  // verified (TikTok's portal did not render during the 2026-10-08 review), so no TikTok code is mapped: each keeps
  // PLATFORM_ERROR with layer `unknown` and its numeric code, until the table is checked against TikTok's own reference.
  return {...base, code: legacyCode, layer: layerOf(legacyCode), retryable: legacyRetryable, documented: false};
}
