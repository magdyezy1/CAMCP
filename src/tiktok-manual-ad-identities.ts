import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Manual ads with a custom identity, per API for Business v1.3 "Create ads" and "Update ads" (checked 2026-09-26):
 * TikTok no longer accepts new non-Spark ads with a CUSTOMIZED_USER identity in ad groups that deliver on TikTok
 * (automatic placement, or selected placements that include TikTok); Pangle and Global App Bundle placements are not
 * affected, and existing ads stay editable. The ad group is already read before review and execution.
 */
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export function tiktokManualAdIdentityPrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (
    plan.gateway !== 'tiktok_native_action' ||
    plan.method !== 'POST' ||
    plan.path !== '/v1.3/ad/create/' ||
    !obj(plan.body) ||
    !Array.isArray(plan.body.creatives)
  )
    return;
  if (!plan.body.creatives.some((c: unknown) => obj(c) && c.identity_type === 'CUSTOMIZED_USER')) return;
  const group = values
    .flatMap(v => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : []))
    .find(
      (r: JsonObject) =>
        String(r?.adgroup_id) === String((plan.body as JsonObject).adgroup_id) && Object.hasOwn(r, 'placement_type'),
    ) as JsonObject | undefined;
  if (!group) return;
  const tiktok =
    group.placement_type === 'PLACEMENT_TYPE_AUTOMATIC' ||
    (Array.isArray(group.placements) && group.placements.includes('PLACEMENT_TIKTOK'));
  if (tiktok)
    throw new MirrorError(
      'TIKTOK_CUSTOM_IDENTITY_PLACEMENT',
      'Ad group ' +
        group.adgroup_id +
        ' delivers on TikTok (' +
        (group.placement_type === 'PLACEMENT_TYPE_AUTOMATIC'
          ? 'automatic placement'
          : 'TikTok is a selected placement') +
        '). TikTok no longer accepts new non-Spark ads with a CUSTOMIZED_USER identity there; use a Spark Ads identity (TT_USER or BC_AUTH_TT) or an ad group that delivers only on Pangle or Global App Bundle.',
      {adgroup_id: group.adgroup_id, field: 'creatives.identity_type'},
    );
}
