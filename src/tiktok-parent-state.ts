/**
 * The parent rows a TikTok review keeps (R2.5 M1, plan idea 1: the PARENT role; M0's "Found, not fixed" 4).
 *
 * An ad group is created under a campaign and an ad under an ad group. The review reads that parent and compares it again
 * at execute, so that a write is never sent under a parent that is not the one the approver saw. What the write depends on is
 * who the parent is and its status, not its budget, schedule or counters: a parent row is kept to its identity, and the
 * parent's own configuration that a gate of the child create reads. Everything else the row carries (a budget that was
 * edited, a delivery state, a modification time) neither refuses the write nor is shown to the approver as the state of what
 * the write changes. The campaign or ad group a write itself changes is another role (its read is the write's target) and
 * keeps its whole protection, minus the fields its provider table names.
 *
 * Idempotent and monotone (src/review-state-core.ts pickIdentity: it only drops fields), so a state saved before is
 * projected again at execute. No `fields` list is sent with the read: TikTok's allowed values for it on these two routes
 * are not in the captured catalog and not yet read live, and a name TikTok refused would stop every child create. The
 * projection gives the same hash from the whole row.
 */
import {pickIdentity} from './review-state-core.js';
import type {CompiledRequest, JsonObject} from './types.js';

export const tiktokCampaignGetPath = '/v1.3/campaign/get/';
export const tiktokAdgroupGetPath = '/v1.3/adgroup/get/';

/** A campaign: who it is, its status, and the objective and type that decide which ad groups can sit under it. */
const campaignFields: readonly string[] = Object.freeze([
  'campaign_id',
  'campaign_name',
  'advertiser_id',
  'operation_status',
  'objective_type',
  'campaign_type',
]);
/**
 * An ad group: who it is, which campaign it sits under, its status, and where it delivers. `placement_type` and `placements`
 * are its configuration that a gate of an ad create reads: TikTok no longer accepts a new custom-identity ad in an ad group
 * that delivers on TikTok (src/tiktok-manual-ad-identities.ts, which skips its refusal when the field is absent from the
 * state, so a projection that dropped them would switch that gate off).
 */
const adgroupFields: readonly string[] = Object.freeze([
  'adgroup_id',
  'adgroup_name',
  'campaign_id',
  'advertiser_id',
  'operation_status',
  'placement_type',
  'placements',
]);

/** The state of a parent read: its list of rows, each reduced to its identity; undefined for a read that is no parent's. */
export function tiktokParentState(read: CompiledRequest, answer: JsonObject): JsonObject | undefined {
  const fields =
      read.path === tiktokCampaignGetPath
        ? campaignFields
        : read.path === tiktokAdgroupGetPath
          ? adgroupFields
          : undefined,
    list = answer.data?.list;
  return fields && Array.isArray(list) ? {data: {list: list.map(row => pickIdentity(row, fields))}} : undefined;
}
