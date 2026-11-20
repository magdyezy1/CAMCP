import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Manual ads with a custom identity, per API for Business v1.3 "Create ads" and "Update ads" (checked 2026-09-26):
 * TikTok no longer accepts new non-Spark ads with a CUSTOMIZED_USER identity in ad groups that deliver on TikTok
 * (automatic placement, or selected placements that include TikTok); Pangle and Global App Bundle placements are not
 * affected, and existing ads stay editable. The ad group is already read before review and execution.
 *
 * The classic ad create is manual-only (r25-field-tiktok, #2): "Get ad groups"
 * (https://business-api.tiktok.com/portal/docs/get-ad-groups/v1.3, checked 2026-11-19) returns each ad group's
 * `campaign_automation_type` (MANUAL, SMART_PLUS or UPGRADED_SMART_PLUS), and an ad of an Upgraded Smart+ campaign is
 * created with /smart_plus/ad/create/ instead. The parent read of the create already holds the field, so the refusal
 * costs no request and spares the execute that TikTok would refuse with its own error (code 40002).
 */
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A classic ad create in an ad group of an Upgraded Smart+ campaign is refused, with the Smart+ route named and the call
 * that goes on (the same ad group). A row without `campaign_automation_type`, and one that is MANUAL or SMART_PLUS (the
 * legacy Smart+ campaigns), keep what they did before this check: TikTok's own answer is then definitive and is recorded
 * as rejected (R2.5 M2), with nothing created.
 */
export function tiktokManualAdRoutePrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (
    plan.gateway !== 'tiktok_native_action' ||
    plan.method !== 'POST' ||
    plan.path !== '/v1.3/ad/create/' ||
    !obj(plan.body)
  )
    return;
  const group = values
    .flatMap(v => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : []))
    .find((r: JsonObject) => String(r?.adgroup_id) === String((plan.body as JsonObject).adgroup_id)) as
    JsonObject | undefined;
  if (group?.campaign_automation_type !== 'UPGRADED_SMART_PLUS') return;
  const adgroup = String(group.adgroup_id);
  throw new MirrorError(
    'TIKTOK_SMART_PLUS_ROUTE_REQUIRED',
    'Ad group {adgroup_id} belongs to an Upgraded Smart+ campaign (campaign_automation_type UPGRADED_SMART_PLUS), and the classic ad create does not support Upgraded Smart+ ads. Create the ad with tiktok_smart_plus_ad_create for the same adgroup_id (details.next_call). Nothing was sent.',
    {
      adgroup_id: adgroup,
      campaign_automation_type: 'UPGRADED_SMART_PLUS',
      use_action: 'tiktok_smart_plus_ad_create',
      field: 'adgroup_id',
      next_call: {
        tool: 'amcp_write',
        arguments: {
          action: 'inspect',
          gateway: plan.gateway,
          arguments: {
            action: 'tiktok_smart_plus_ad_create',
            account_id: plan.accountId,
            payload: {adgroup_id: adgroup},
          },
        },
        meaning:
          'The same ad group on the Upgraded Smart+ route. Add the rest of the ad to payload; inspect lists every field it still needs.',
      },
    },
    400,
    false,
    {adgroup_id: adgroup},
  );
}
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
