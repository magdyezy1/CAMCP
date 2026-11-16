import type {CompiledRequest, JsonObject} from './types.js';

// Writes and campaigns (R2.5 M2, package r25-m2-refusal): TikTok's proof that a refusal applied nothing, which the adapter
// declares as its `writes.rejectionIsNonApplied` (src/tiktok-adapter.ts) and src/write-rejection.ts asks where no family
// proves one (CMP-04).
//
// TikTok reports a refusal as a non-zero `code` in the body of an HTTP 200 answer. Until Q16 (owner, 2026-11-15) every such
// refusal after dispatch left the review uncertain, so the review could not be amended and a plan froze (L1-07). The lead's
// live check of 2026-11-16 (LV-8) sent a paused campaign create with a budget of 1 to the owner's test advertiser: TikTok
// answered HTTP 200, code 40002, "Your budget must be $50 or more.", `data: {}` and a request ID, and a read by that name
// found nothing created.
//
// The proof is closed. It accepts only a code that TikTok's "Return codes" table
// (https://business-api.tiktok.com/portal/docs/return-codes/v2.0, read 2026-11-06 for the adapter's mapping,
// src/tiktok-adapter.ts) defines as a refusal of the request itself, and only in the answer that table describes: HTTP 200,
// with nothing in `data`. Everything else stays uncertain, as before: a failure on TikTok's side (5xxxx), a throttle (40100,
// 40132, 40133), a credential failure, a code the reading leaves unmapped, an answer that carries data (TikTok may then have
// applied part of the request), any other HTTP status, and a response that was lost. The table's page is not pinned in
// `.mirror/VENDOR/`: this list is the one place to change when it is read again.

/**
 * The parameter and business-logic errors of the table, which src/tiktok-adapter.ts names as the codes it leaves unmapped
 * (40000, 40002, 40006 to 40008). 40002 is also the live evidence: TikTok refused a budget below its minimum, and nothing
 * was created.
 */
const parameterCodes: readonly number[] = [40000, 40002, 40006, 40007, 40008];
/** Role: the login cannot act on this advertiser or object (the adapter's `tiktokRoleCodes`: a refusal before any change). */
const roleCodes: readonly number[] = [40001, 40119];
/** Consent: a permission the login has not granted (the adapter's `tiktokConsentCodes`). */
const consentCodes: readonly number[] = [40125];
/** Eligibility: an eligibility the app or account lacks (the adapter's `tiktokEligibilityCodes`). */
const eligibilityCodes: readonly number[] = [40118];

/** Every code that declares a refusal of the request itself. The throttles, the 5xxxx codes and the credential codes are not in it. */
export const tiktokRefusalCodes: ReadonlySet<number> = new Set([
  ...parameterCodes,
  ...roleCodes,
  ...consentCodes,
  ...eligibilityCodes,
]);

/** No data: absent, null, or an empty object or list. An answer that carries any may describe part of what was applied. */
const noData = (data: unknown): boolean =>
  data === undefined || data === null || (typeof data === 'object' && Object.keys(data).length === 0);

/**
 * Whether a TikTok write's refusal provably applied nothing: its answer was HTTP 200, its `code` is one of
 * `tiktokRefusalCodes` (an integer, not its text), and its `data` is empty. `body` is the answer TikTok sent.
 */
export function tiktokRejectionIsNonApplied(plan: CompiledRequest, status: number, body: JsonObject): boolean {
  return (
    plan.gateway === 'tiktok_native_action' &&
    !plan.readOnly &&
    status === 200 &&
    typeof body.code === 'number' &&
    tiktokRefusalCodes.has(body.code) &&
    noData(body.data)
  );
}
