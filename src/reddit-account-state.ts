/**
 * The Reddit ad account row that a review keeps to its identity (R2.5 M1, plan idea 1: the ACCOUNT role; lead review S3-3).
 *
 * Every reviewed Reddit write reads the ad account (`GET /api/v3/ad_accounts/{id}`) to prove it is the account the connection
 * selected. The documented `AdAccount` (`.mirror/VENDOR/reddit-v3.json`, `components_schema_ad_account`) carries no balance,
 * and the one field of it that changes by itself is `modified_at`, which the table of src/reddit-adapter.ts drops. A review
 * keeps the fields that say who the account is and what state Reddit holds it in: its ID and name, its currency and time zone,
 * its business, its type, and `admin_approval` and `suspension_reason`, which Reddit alone changes (they are status, so a
 * suspension or a revoked approval between review and execute refuses). A change of any of them still refuses.
 *
 * Idempotent and monotone (src/review-state-core.ts pickIdentity: it only drops fields), so a state saved before is
 * projected again at execute.
 */
import {pickIdentity} from './review-state-core.js';

const accountFields: readonly string[] = Object.freeze([
  'id',
  'name',
  'currency',
  'time_zone_id',
  'business_id',
  'type',
  'admin_approval',
  'suspension_reason',
]);

export const redditAccountState = (row: unknown): unknown => pickIdentity(row, accountFields);
