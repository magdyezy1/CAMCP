import {MirrorError} from './errors.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * The third outcome of a submitted write (CMP-04): `rejected`, beside complete and uncertain. A write is rejected only
 * when the provider answered with a definitive refusal (an HTTP 4xx with a parsed error body; never a timeout, a rate
 * limit, a 5xx or a lost response) and a proof declares that such a refusal applied nothing. Without a proof the
 * outcome stays uncertain, as before. A rejected key is never sent again; the step it belonged to may be amended and
 * reviewed under a new key, and the day's spend reservation is released (owner decision D12).
 *
 * Rollback: AMCP_WRITE_REJECTED_OUTCOME=false returns every refusal after dispatch to uncertain.
 */
export const rejectedOutcomeEnabled = () => process.env.AMCP_WRITE_REJECTED_OUTCOME !== 'false';

/** Statuses a provider sends only after deciding the request; a timeout (408) and a rate limit (429) are not among them. */
export const definitiveRefusalStatuses: readonly number[] = [400, 401, 403, 404, 409, 412, 422];

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

/**
 * Whether this error, raised after the request was dispatched, is a refusal that provably applied nothing. The family
 * that owns the request (familyOf) decides; a Google Ads request no family proves follows Google's per-service rule. Meta,
 * Snapchat, Microsoft and the others declare no proof yet, so their refusals stay uncertain.
 */
export function nonAppliedRejection(plan: CompiledRequest, error: unknown, family?: ReviewedFamily): boolean {
  if (!rejectedOutcomeEnabled() || !(error instanceof MirrorError)) return false;
  const details = error.details ?? {},
    status = Number(details.http_status);
  if (
    !definitiveRefusalStatuses.includes(status) ||
    details.layer === 'rate_limit' ||
    details.retry_after_ms !== undefined ||
    !object(details.upstream)
  )
    return false;
  const proof =
      family?.rejectionIsNonApplied ??
      (plan.gateway === 'google_ads_native_action' ? googleRejectionIsNonApplied : undefined);
  return proof?.(plan, status, details.upstream) === true;
}

/** The same refusal, marked as rejected: nothing was applied, and its key is retired. */
export function rejectedError(e: unknown, reviewId: string): unknown {
  if (!(e instanceof MirrorError)) return e;
  return new MirrorError(
    e.code,
    e.message,
    {...e.details, submission: 'rejected', review_id: reviewId, key_retired: true},
    e.status,
    false,
  );
}
