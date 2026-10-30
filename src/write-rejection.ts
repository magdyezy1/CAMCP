import {MirrorError} from './errors.js';
import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {definitiveRefusalStatuses} from './write-rejection-core.js';
import {providerHooks} from './provider-hooks.js';

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

// The definitive refusal statuses live in the leaf src/write-rejection-core.ts, which the providers' proofs import
// (ARC-01 phase B, wave 4c); this import path keeps them.
export {definitiveRefusalStatuses};

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether this error, raised after the request was dispatched, is a refusal that provably applied nothing. The family
 * that owns the request (familyOf) decides; a request no family proves follows its provider's rule where the provider
 * declares one (its adapter's `writes.rejectionIsNonApplied`, ARC-01 phase B: Google Ads' per-service rule,
 * src/google-write-rejection.ts). Meta, Snapchat, Microsoft and the others declare no proof yet, so their refusals stay
 * uncertain.
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
  const proof = family?.rejectionIsNonApplied ?? providerHooks(plan.gateway)?.writes?.rejectionIsNonApplied;
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
