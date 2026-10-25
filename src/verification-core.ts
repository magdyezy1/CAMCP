/**
 * The pure normalization of the verification and reconciliation reads (the ARC-04 stage B leaf pattern; ARC-01 phase B,
 * wave 4c): a provider's created-resource lookup (src/google-write-reconciliation.ts) normalizes a read's rows here
 * without importing a lifecycle module; src/verification-reads.ts re-exports both where they were.
 */
import {normalizeReviewState} from './review-state-core.js';
import {obj} from './workspace-core.js';

export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const normalize = (v: any): any =>
  Array.isArray(v)
    ? normalizeReviewState(v.map(normalize))
    : obj(v)
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), normalize(x)]))
      : v;
