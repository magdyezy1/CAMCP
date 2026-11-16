import type {CompiledRequest, JsonObject} from './types.js';
import {familyOfRead} from './reviewed-families.js';
import {normalizeReviewState, noReviewVolatile, type ReviewVolatile} from './review-state-core.js';
import {providerHooks} from './provider-hooks.js';

// The pure projection helpers live in the leaf src/review-state-core.ts, which family modules import (ARC-04 stage B).
export {
  normalizeReviewState,
  normalizeComparable,
  reviewStateHash,
  changedStateFields,
  noReviewVolatile,
} from './review-state-core.js';
export type {ReviewVolatile} from './review-state-core.js';

/**
 * What a gateway's provider says changes by itself in its answers (R2.5 M1: its adapter's `review.volatile`); none for
 * AMCP's own tools, an unknown name and a provider that declares none, so nothing is dropped by name for them. The state
 * stage hashes and compares every state with the table of the gateway it read.
 */
export const reviewVolatile = (gateway: unknown): ReviewVolatile =>
  providerHooks(gateway)?.review?.volatile ?? noReviewVolatile;

/** Allowlist configuration-bearing response containers, not response metadata.
 * Only call after raw success, completeness and exact-target validation. Preserve
 * the native container shape for spending/ownership checks and field diagnostics.
 * Flat resource responses have no separate envelope: keep unknown configuration.
 * This is idempotent so saved, unsubmitted reviews can use the same projection. */
export function normalizeSnapshot(read: CompiledRequest, data: unknown): unknown {
  const volatile = reviewVolatile(read.gateway);
  if (!data || Array.isArray(data) || typeof data !== 'object') return normalizeReviewState(data, volatile);
  const d = data as JsonObject;
  // A read with a role (the account a create is made in, the parent a child is created under) is kept to its identity by its
  // provider (`review.identity`, R2.5 M1), whichever family built the read: a family that projects its own reads does not
  // lead a role read back to the whole row. A saved review's read carries its role, so it is projected the same at execute.
  const identity = read.stateRole ? providerHooks(read.gateway)?.review?.identity?.(read, d) : undefined;
  if (identity !== undefined) return normalizeReviewState(identity, volatile);
  const family = familyOfRead(read);
  if (!family) return normalizeReviewState(gatewayStateValue(read, d), volatile);
  return normalizeReviewState(
    family.snapshotState ? family.snapshotState(read, d, () => gatewayStateValue(read, d)) : d,
    volatile,
  );
}
/**
 * The state a review keeps from a read no family projects: the gateway's configuration fields, before normalization.
 * Each provider's projection is its adapter's (`review.snapshot`, ARC-01 phase B); a read it does not project, or of
 * a provider without one, is kept whole.
 */
function gatewayStateValue(read: CompiledRequest, d: JsonObject): unknown {
  const snapshot = providerHooks(read.gateway)?.review?.snapshot;
  return snapshot ? snapshot(read, d) : d;
}
