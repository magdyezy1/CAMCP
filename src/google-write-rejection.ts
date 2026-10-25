import type {CompiledRequest, JsonObject} from './types.js';
import {definitiveRefusalStatuses} from './write-rejection-core.js';

// Writes and campaigns (ARC-01 phase B, wave 4c): Google Ads' proof that a refusal applied nothing, moved verbatim from
// src/write-rejection.ts, which asks it as the adapter's `writes.rejectionIsNonApplied` where no family proves one.
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const on = (v: unknown) => v === true || v === 'true';

/**
 * A Google Ads per-service Mutate with partial failure off and no validate-only flag. Google documents that such a
 * request's operations "will be carried out in one transaction if and only if they are all valid" (partial_failure
 * false is the default), so a definitive refusal created, changed or removed nothing.
 */
export function googleServiceMutate(plan: CompiledRequest): boolean {
  const body = object(plan.body) ? plan.body : {};
  return (
    plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    /^\/v\d+\/customers\/\d+\/[A-Za-z]+:mutate$/.test(plan.path) &&
    !on(body.partial_failure) &&
    !on(body.partialFailure) &&
    !on(body.validate_only) &&
    !on(body.validateOnly)
  );
}

/** Google's proof: a per-service or googleAds:mutate request refused with Google's own error body. */
export function googleRejectionIsNonApplied(plan: CompiledRequest, status: number, body: JsonObject): boolean {
  return googleServiceMutate(plan) && definitiveRefusalStatuses.includes(status) && object(body.error);
}
