/**
 * The Reddit rows that a review keeps to their identity (R2.5 M1, plan idea 1: the ACCOUNT and REFERENCE roles; lead review
 * S3-3 and S3-4).
 *
 * The ad account. Every reviewed Reddit write reads the ad account (`GET /api/v3/ad_accounts/{id}`) to prove it is the
 * account the connection selected. The documented `AdAccount` (`.mirror/VENDOR/reddit-v3.json`,
 * `components_schema_ad_account`) carries no balance, and the one field of it that changes by itself is `modified_at`, which
 * the table of src/reddit-adapter.ts drops. A review keeps the fields that say who the account is and what state Reddit holds
 * it in: its ID and name, its currency and time zone, its business, its type, and `admin_approval` and `suspension_reason`,
 * which Reddit alone changes (they are status, so a suspension or a revoked approval between review and execute refuses).
 *
 * The funding instrument. A campaign that names one (`funding_instrument_id`) is paid from it, so the write reads it
 * (`.../funding_instruments`). It is an object the write only names, not one it changes: a REFERENCE. The documented
 * `FundingInstrument` carries a meter, `billable_amount` ("the funding instrument's current outstanding debt"), that grows with
 * every day the account spends, and `is_servable` and `reasons_not_servable`, which Reddit computes from it. A review keeps what
 * the campaign depends on: which instrument it is, its currency, its credit limit and the flight it allows (`start_time`,
 * `end_time`). Whether the instrument is the account's is checked on every read, before the state is kept
 * (`validateRedditState`).
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
const fundingInstrumentFields: readonly string[] = Object.freeze([
  'id',
  'currency',
  'credit_limit',
  'start_time',
  'end_time',
]);

export const redditAccountState = (row: unknown): unknown => pickIdentity(row, accountFields);
export const redditFundingInstrumentState = (row: unknown): unknown => pickIdentity(row, fundingInstrumentFields);
