import {providerHttpErrorCode} from './errors.js';
import {providerHooks} from './provider-hooks.js';
import type {ErrorEnvelope} from './provider-adapter.js';
import {credentialFree, hideOpaqueCredentials, redact} from './security.js';
import {
  describeProviderErrors,
  errorInteger,
  errorObject,
  errorToken,
  providerErrorRows,
  providerMessageText,
  providerReference,
  type ProviderErrorToken,
} from './provider-error-core.js';

// The values the classification reads live in the leaf src/provider-error-core.ts, which the provider adapters' wire
// profiles read too; the types below are imported by those adapters as types only, so no runtime cycle forms.
export {metaRegainAccessMs, providerReference} from './provider-error-core.js';

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
/**
 * What the generic classification already decided for a refusal, from which a provider's documented classification
 * starts: the provider code, the pre-PRV-01 code and retryability, and the layer of a generic code.
 */
export interface ProviderErrorContext {
  base: {providerCode?: string | number};
  legacyCode: string;
  legacyRetryable: boolean;
  layerOf(code: string): ProviderErrorLayer;
}

/** The classifier is on unless the deployment turns it off; off, the transport returns exactly the pre-PRV-01 codes. */
export const providerErrorTaxonomyEnabled = (value = process.env.AMCP_PROVIDER_ERROR_TAXONOMY) => value !== 'off';

/** A provider's documented error shapes (ARC-01 phase B: its adapter's wire profile, src/<provider>-adapter.ts). */
const envelope = (gateway: string) => providerHooks(gateway)?.wire?.errors;

/**
 * The provider's correlation reference for a response. LinkedIn asks callers to record x-li-uuid (x-li-request-id on
 * older responses); Meta's trace ID is a header or, when the header is absent, error.fbtrace_id in the body. Each is its
 * provider's; values that are not short tokens are dropped rather than echoed, and so is one with the shape of a credential
 * (the pattern of a reference also fits a token; lead review S4-5): the one place every answer that carries it reads it from.
 */
export function providerRequestId(
  gateway: string,
  headers: {get(name: string): string | null},
  body: unknown,
): string | undefined {
  const header = (name: string) => providerReference(headers.get(name)),
    own = envelope(gateway),
    found =
      own?.requestId?.(header) ??
      header('request-id') ??
      header('x-request-id') ??
      header('x-fb-trace-id') ??
      own?.bodyRequestId?.(body);
  return found !== undefined && credentialFree(found) ? found : undefined;
}
/**
 * The provider's own code from its documented error shape (its wire profile), or the generic shapes; anything that is
 * not a token or an integer is dropped.
 */
export function providerErrorCode(gateway: string, body: unknown): string | number | undefined {
  const own = envelope(gateway)?.code;
  if (own) return own(body);
  const root = errorObject(body),
    error = errorObject(root.error),
    first = (v: unknown) => (Array.isArray(v) ? errorObject(v[0]) : {});
  return (
    errorInteger(error.code) ??
    errorToken(error.status) ??
    errorToken(error.code) ??
    errorToken(first(error.details).reason) ??
    errorToken(root.code) ??
    errorInteger(root.code) ??
    errorToken(root.error_code) ??
    errorToken(first(root.errors).code)
  );
}

/**
 * What a refusal says apart from its classification (G9, Round 2.5 M0): the rows of closed-set tokens its provider's wire
 * profile finds in the documented error shape (every token checked against its pattern here, whatever the hook returned:
 * `errors`), the part of them a message may quote (`echo`, the review's S2-1: numbers, words the provider's schema holds,
 * places the `request` AMCP sent holds, and the operation's index; empty when nothing can be quoted), and the provider's own
 * first sentence, redacted like `details.upstream`, cleaned and clipped (`text`). The sentence is never echoed (src/errors.ts
 * keeps provider text out of messages), and the rows are marked untrusted with it. `omitted` (only when there is one) is how
 * many valid rows the bounds of the list left out (src/provider-error-core.ts `providerErrorRows`).
 */
export function providerRefusal(
  gateway: string,
  body: unknown,
  own: ErrorEnvelope | undefined = envelope(gateway),
  request?: unknown,
): {errors: ProviderErrorToken[]; echo: string; omitted?: number; text?: string} {
  // A hook that fails costs its own part of this decoration, never the refusal it decorates: the refusal is thrown
  // right after, and nothing here may replace it with a crash.
  const attempt = <T>(read: () => T): T | undefined => {
      try {
        return read();
      } catch {
        return undefined;
      }
    },
    sentence = attempt(() => own?.text?.(body)),
    text =
      typeof sentence === 'string'
        ? attempt(() => providerMessageText(hideOpaqueCredentials(redact(sentence))))
        : undefined,
    // A token that redact() would change is dropped, as the body it came from is redacted in details.upstream: a credential
    // has the shape of a word, and no pattern of a closed alphabet keeps it out (the review's S2-2). A trigger is kept only
    // when the request holds it (r25-field3-errors, AMCP-03): `request` is what the provider refused.
    found = attempt(() =>
      providerErrorRows(
        attempt(() => own?.tokens?.(body)),
        credentialFree,
        () => redact(request),
      ),
    ) ?? {
      rows: [],
      omitted: 0,
    },
    errors = found.rows,
    echo =
      attempt(() =>
        describeProviderErrors(errors, {
          known: row => attempt(() => own?.quotable?.(row)) === true,
          request,
        }),
      ) ?? '';
  return {errors, echo, ...(found.omitted ? {omitted: found.omitted} : {}), ...(text !== undefined ? {text} : {})};
}
/**
 * The rows a refusal's details carry, checked again where a check is made from them (src/provider-validation.ts): the
 * same patterns, the same credential check, and a trigger only where `request` holds it.
 */
export const providerRowsFrom = (rows: unknown, request: unknown) =>
  providerErrorRows(rows, credentialFree, () => redact(request));

/**
 * One provider refusal, classified from documented provider codes before the HTTP status (PRV-01): a provider's wire
 * profile classifies the refusals its documented tables name (Meta's codes, Google Ads' quota errors, Business
 * Profile's unapproved projects, LinkedIn's unsupported versions). Unknown codes keep today's code with layer
 * `unknown`. A refusal of a write is never made retryable here: writes are sent once.
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClass {
  const {gateway, status, headers, body} = input,
    providerCode = providerErrorCode(gateway, body);
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
  const documented = envelope(gateway)?.classify?.(input, {base, legacyCode, legacyRetryable, layerOf});
  if (documented) return documented;
  // TikTok reports token and QPS failures inside HTTP 200 bodies. Its wire profile classifies the codes of its official
  // return-code table (src/tiktok-adapter.ts; https://business-api.tiktok.com/portal/docs/return-codes/v2.0, read
  // 2026-11-06, which the 2026-10-08 review could not render). A code that table does not map, and a provider whose
  // profile classifies nothing, keeps PLATFORM_ERROR in a 200 body with layer `unknown` and its numeric code.
  return {...base, code: legacyCode, layer: layerOf(legacyCode), retryable: legacyRetryable, documented: false};
}
