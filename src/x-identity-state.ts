/**
 * The rows of X Ads that a review keeps by role (R2.5 M1, plan idea 1: ACCOUNT and PARENT; L5-01 and L4-13).
 *
 * A create on an account reads the account; a promotion or a targeting criterion reads the line item (and the campaign) it
 * goes under. X returns those rows whole, with the computed and administrative fields of an account or an entity beside the
 * ones that say what it is. A review keeps the account and the parents to their identity: who and what they are, their
 * status, whether they are deleted, and for a line item the objective and product it was made for. The objects a write changes
 * are another role and keep every field but telemetry (src/x-review-volatile.ts), so an unknown field there stays protected.
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
/** A line item as the parent of a promotion or a targeting criterion: who it is, its campaign, its status, its objective and product. */
const lineItemFields: readonly string[] = Object.freeze([
  'id',
  'name',
  'account_id',
  'campaign_id',
  'entity_status',
  'deleted',
  'objective',
  'product_type',
]);
/** A campaign as the parent of a line item or a promotion. */
const campaignFields: readonly string[] = Object.freeze(['id', 'name', 'account_id', 'entity_status', 'deleted']);

export const xAccountState = (row: unknown): unknown => pickIdentity(row, accountFields);
export const xLineItemState = (row: unknown): unknown => pickIdentity(row, lineItemFields);
export const xCampaignState = (row: unknown): unknown => pickIdentity(row, campaignFields);

/**
 * The record a review keeps of an X read by its role: the account's, or the line item's or campaign's it is the parent of.
 * Undefined when the read has no role (the objects a write changes) or a role this module keeps no record for.
 */
export function xRoleRecord(read: CompiledRequest, data: unknown): unknown {
  if (read.stateRole === 'account') return xAccountState(data);
  if (read.stateRole === 'parent') {
    const kind = /\/(line_items|campaigns)\/[^/]+$/.exec(read.path)?.[1];
    if (kind === 'line_items') return xLineItemState(data);
    if (kind === 'campaigns') return xCampaignState(data);
  }
  return undefined;
}
