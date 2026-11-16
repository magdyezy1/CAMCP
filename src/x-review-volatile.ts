import type {ReviewVolatile} from './review-state-core.js';

/**
 * What changes by itself in X Ads' rows (R2.5 M1, L4-13): X states these per read, without any advertiser edit. A line
 * item's `servable` and `reasons_not_servable` follow its flight, its budget cap and the account's funding; `effective_status`
 * and `updated_at` follow them. The batch family already left these four out (it held its own set); the creative and
 * promotion state kept whole line item, campaign and account rows and did not. A leaf, so the adapter and its family modules
 * share one table without importing each other.
 */
export const xReviewVolatile: ReviewVolatile = Object.freeze([
  'servable',
  'reasons_not_servable',
  'effective_status',
  'updated_at',
]);
