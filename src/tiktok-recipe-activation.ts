import type {JsonObject} from './types.js';
import type {ActivationStep} from './provider-adapter.js';
import {numeric, verified, type Results} from './campaign-activation-core.js';

// TikTok's launch activation, its adapter's `campaign.activation` (CMP-07; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts, which keeps the checks every activation passes).

/** The DISABLE campaign holds ENABLE children, so enabling it through tiktok_entity_status is the one step. */
export function tiktokActivationSteps(results: Results, scope: JsonObject, step: ActivationStep): JsonObject[] {
  const campaign = verified(results, 'campaign', r => r.data?.data?.campaign_id, numeric, 'TikTok campaign');
  return [
    step(
      'activate_campaign',
      'Set campaign ' + campaign + ' ENABLE. Its ad group and ad were created ENABLE under it.',
      {
        action: 'tiktok_campaign_status_update',
        payload: {advertiser_id: String(scope.account_id), campaign_ids: [campaign], operation_status: 'ENABLE'},
      },
    ),
  ];
}
