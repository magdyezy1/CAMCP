import {createHash} from 'node:crypto';
import type {CompiledRequest, JsonObject} from './types.js';

// Writes and campaigns (R2.5 M2, package r25-m2-refusal; Q16, owner 2026-11-15; L1-09): the deduplication key of a TikTok create,
// frozen into the request when its review is prepared, which the adapter declares as its `writes.dedupeBody`
// (src/tiktok-adapter.ts) and src/write-review.ts asks before it fingerprints the request.
//
// TikTok's `request_id` is the key that makes a create idempotent at TikTok. What the pinned documents say of it
// (`.mirror/CATALOG/tiktok_native_action.json`, captured 2026-09-04; docs/implementation/TIKTOK-SMART-PLUS-CAMPAIGNS-2026-09-26.md
// and TIKTOK-SMART-PLUS-ADGROUPS-2026-09-26.md): the standard campaign and ad group creates list it as an optional native field (the
// captured description of the campaign's reads "It also supports idempotency", cut off by the capture; the ad group's description was
// not kept), and the Smart+ campaign and ad group creates require it, "a 64-bit request_id that makes creation idempotent at TikTok".
// The ad create and the Smart+ ad create do not list it. Neither document states how long TikTok remembers a key, which the lead's
// live check LV-10 shows. A Smart+ create already needs the caller's own value (src/tiktok-smart-plus-campaigns.ts and
// -adgroups.ts refuse a request without one), which is frozen with the request like every other field, so only the standard
// campaign and ad group creates take AMCP's.

/** The standard creates the pinned catalog lists `request_id` for (optional there); every other route is left as it is. */
const takesRequestId = /^\/v1\.3\/(?:campaign|adgroup)\/create\/$/;

/**
 * The key of one review: a positive 64-bit integer written as a string, the form the Smart+ contracts document (a TikTok
 * `request_id` is "a 64-bit integer"). It is a function of the review's ID alone, so each review has its own key, a corrected
 * request is a new review with a new key, and nothing the caller sends moves it. The hash only spreads the ID over 63 bits.
 */
export function tiktokRequestIdFor(reviewId: string): string {
  const digest = createHash('sha256')
    .update('amcp-tiktok-request-id\0' + reviewId)
    .digest();
  const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return (value === 0n ? 1n : value).toString();
}

/**
 * The body of a standard TikTok campaign or ad group create with its `request_id` set to the review's key, or undefined where the
 * route takes none or the caller supplied one (a value the caller chose is frozen as it is). A new object: the caller's payload
 * is never changed, so the arguments a review keeps to prepare it again start without a key and a later review gets its own.
 */
export function tiktokDedupeBody(plan: CompiledRequest, reviewId: string): JsonObject | undefined {
  if (plan.gateway !== 'tiktok_native_action' || plan.readOnly || plan.method !== 'POST') return undefined;
  if (!takesRequestId.test(plan.path)) return undefined;
  const body = plan.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if ((body as JsonObject).request_id !== undefined) return undefined;
  return {...(body as JsonObject), request_id: tiktokRequestIdFor(reviewId)};
}
