/**
 * The pure normalization of the verification and reconciliation reads (the ARC-04 stage B leaf pattern; ARC-01 phase B,
 * wave 4c): a provider's created-resource lookup (src/google-write-reconciliation.ts) normalizes a read's rows here
 * without importing a lifecycle module; src/verification-reads.ts re-exports both where they were.
 */
import {normalizeComparable, noReviewVolatile, type ReviewVolatile} from './review-state-core.js';
import {obj} from './workspace-core.js';

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
