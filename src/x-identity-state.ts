/**
 * The row of X Ads that a review keeps to its identity (R2.5 M1, plan idea 1: the ACCOUNT role; L5-01).
 *
 * A create on an account reads the account. X returns it whole, with the computed and administrative fields of an account
 * beside the ones that say what it is. A review keeps the account to its identity: who it is, whether it is approved and
 * deleted, its time zone and business, and its currency where the answer names one. The line item and the campaign a
 * promotion or a targeting criterion goes under are not kept to their identity: they hold the budget, the bid and the flight
 * the child spends by, so they are read as the objects a write changes are, whole but for the fields X computes by itself
 * (src/x-review-volatile.ts), and a budget that changes still refuses (L4-13).
 *
 * Idempotent and monotone (src/review-state-core.ts pickIdentity: it only drops fields). X offers no way to ask for fewer
 * fields, so the projection is the narrowing.
 */
import {pickIdentity} from './review-state-core.js';
import type {CompiledRequest} from './types.js';

/** An ad account: its ID and name, whether it is approved, its time zone, its business, and a currency where the answer names one. */
const accountFields: readonly string[] = Object.freeze([
  'id',
  'name',
  'approval_status',
  'deleted',
  'timezone',
  'business_id',
  'business_name',
  'currency',
]);

export const xAccountState = (row: unknown): unknown => pickIdentity(row, accountFields);

/**
 * The record a review keeps of an X read by its role: the account's. Undefined for any other read, the line item or
 * campaign a promotion is the child of included: they are kept whole (minus the table's telemetry), as a target is.
 */
export function xRoleRecord(read: CompiledRequest, data: unknown): unknown {
  return read.stateRole === 'account' ? xAccountState(data) : undefined;
}
