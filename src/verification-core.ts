/**
 * The pure normalization of the verification and reconciliation reads (the ARC-04 stage B leaf pattern; ARC-01 phase B,
 * wave 4c): a provider's created-resource lookup (src/google-write-reconciliation.ts) normalizes a read's rows here
 * without importing a lifecycle module; src/verification-reads.ts re-exports both where they were.
 */
import {normalizeComparable, noReviewVolatile, type ReviewVolatile} from './review-state-core.js';
import {fingerprint, obj} from './workspace-core.js';

export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * What a write sent and what its provider stores, in one shape to compare: keys as snake_case, and in a list the fields of
 * the provider's own review table (`volatile`, R2.5 M1: what changes by itself) left out of each item, as they always were.
 * It compares a request with a stored value, so the value-shape rule of a review's URLs does not apply: a link is a value
 * the provider must return as it was sent.
 */
export const normalize = (v: any, volatile: ReviewVolatile = noReviewVolatile): any =>
  Array.isArray(v)
    ? normalizeComparable(
        v.map(item => normalize(item, volatile)),
        volatile,
      )
    : obj(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), normalize(x, volatile)]))
      : v;
/**
 * What a read holds at the fields a write sent, in the shape it sent them (R2.5 r25-fr-verify, the owner's friction B5): objects by key, anything else whole, as
 * `differing` compares them, and null where the read holds nothing. A check hashes this, so `actual_hash` is the hash of the checked fields and not of the whole
 * entity, which always holds more than was sent (its resource name, the fields the read selected for itself); with nothing differing the two hashes are equal.
 */
export const checkedView = (expected: unknown, actual: unknown): unknown =>
  obj(expected)
    ? Object.fromEntries(
        Object.keys(expected).map(key => [key, checkedView(expected[key], obj(actual) ? actual[key] : undefined)]),
      )
    : (actual ?? null);
/**
 * The two hashes of a check (R2.5 r25-fr-verify, the owner's friction B5): what was sent, and what was read. A check that no field differs in has one hash for
 * both, whatever else the read holds (a field the comparison leaves out as volatile, a resource name): two hashes that differ beside an empty `changed_fields`
 * said "verified" and "different" at once. A check that differs hashes `actual` as the caller gives it (a mismatch's `actual_hash` is what an operator accepts).
 */
export const checkHashes = (changed: readonly unknown[], expected: unknown, actual: unknown) => {
  const expectedHash = fingerprint(expected);
  return {expected_hash: expectedHash, actual_hash: changed.length ? fingerprint(actual) : expectedHash};
};
