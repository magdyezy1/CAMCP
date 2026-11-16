import type {ReviewVolatile} from './review-state-core.js';

/**
 * What changes by itself in Snapchat's records (R2.5 M1, L5-02). Its answers are projected to the records they hold, so the
 * names are those of the records: the request's and each row's status wrappers, `updated_at`, the delivery state a record
 * computes, the stats a record may embed, and what Snapchat's ad review and reach estimate report by themselves.
 *
 * Deliberately not here: `deleted`, `auto_bid`, `target_bid`, `separated_types` and `created_at`. The nested-update family
 * once excused them, with these, as fields a complete PUT need not carry; they are not telemetry (a record deleted between
 * review and execute, or a bid flag changed, changes what the write means), so that family keeps them as its own named set.
 * A leaf, so the adapter and its family modules share one table.
 */
export const snapchatReviewVolatile: ReviewVolatile = Object.freeze([
  'request_id',
  'request_status',
  'sub_request_status',
  'updated_at',
  'delivery_status',
  'effective_status',
  'stats',
  'total_stats',
  'timeseries_stats',
  'review_status*',
  'rejection*',
  'approval*',
  'targeting_reach_status',
  // A creative's media packaging (UNKNOWN, PENDING, SUCCESS, FAILED) completes after upload, by itself.
  'packaging_status',
]);
