import type {ReviewVolatile} from './review-state-core.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';

/**
 * What changes by itself in LinkedIn's resources (R2.5 M1, L4-26). Its resources are flat, so the flat-resource names apply
 * (`changeAuditStamps.lastModified` is `last_modified`, a creative's `lastModifiedAt` is `last_modified_at`); beyond them,
 * LinkedIn derives a serving state that follows budgets, flights and the parent's state, and runs an ad review that completes
 * by itself: a campaign's `servingStatuses`, a creative's `isServing` and `servingHoldReasons`, and its `review`. A creative
 * activation prepared while its review is pending would otherwise fail with a false STATE_CHANGED when the review
 * completes. The creative's own `intendedStatus` is what a user sets, and stays protected. A leaf, so the adapter and its
 * family modules share one table.
 */
export const linkedinReviewVolatile: ReviewVolatile = Object.freeze([
  ...flatResourceTelemetry,
  'serving_statuses',
  'is_serving',
  'serving_hold_reasons',
  'review',
]);
