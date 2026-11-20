import type {JsonObject} from './types.js';
import type {ActivationStep} from './provider-adapter.js';
import {numeric, verified, type Results} from './campaign-activation-core.js';
import {tiktokSmartPlusChildStatus} from './tiktok-smart-plus-recipe.js';

// TikTok's launch activation, its adapter's `campaign.activation` (CMP-07; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts, which keeps the checks every activation passes).

/**
 * The DISABLE campaign holds ENABLE children, so enabling it through tiktok_entity_status is the one step. A Smart+ launch (R2.5 M4: its
 * plan holds the step `smart_plus_campaign`) is activated through the Smart+ status family instead.
 */
export function tiktokActivationSteps(results: Results, scope: JsonObject, step: ActivationStep): JsonObject[] {
  if (results.has('smart_plus_campaign')) return tiktokSmartPlusActivationSteps(results, scope, step);
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

/**
 * The activation of a Smart+ launch (R2.5 M4, L1-05). Its ad group and ad were created as `children` says, under the campaign it created
 * DISABLE: ENABLE today, so enabling the campaign through the Smart+ status family is the one step, and the step's own review asks for
 * spend_change_confirmed (a Smart+ status change may affect serving). If TikTok were to refuse a child created ENABLE under a DISABLE
 * campaign, the children are created DISABLE (tiktokSmartPlusChildStatus) and the launch is turned on in three steps, each after the one
 * before it is verified: the ad, the ad group, and the campaign last, so that nothing delivers until the last switch. Each ID is read from
 * its step's verified receipt; a gap is refused, never guessed.
 */
export function tiktokSmartPlusActivationSteps(
  results: Results,
  scope: JsonObject,
  step: ActivationStep,
  children: string = tiktokSmartPlusChildStatus,
): JsonObject[] {
  const advertiser_id = String(scope.account_id),
    campaign = verified(
      results,
      'smart_plus_campaign',
      r => r.data?.data?.campaign_id,
      numeric,
      'TikTok Smart+ campaign',
    );
  if (children === 'ENABLE')
    return [
      step(
        'activate_campaign',
        'Set Smart+ campaign ' + campaign + ' ENABLE. Its ad group and ad were created ENABLE under it.',
        {
          action: 'tiktok_smart_plus_campaign_status_update',
          payload: {advertiser_id, campaign_ids: [campaign], operation_status: 'ENABLE'},
        },
      ),
    ];
  const adgroup = verified(
      results,
      'smart_plus_adgroup',
      r => r.data?.data?.adgroup_id,
      numeric,
      'TikTok Smart+ ad group',
    ),
    ad = verified(results, 'smart_plus_ad', r => r.data?.data?.smart_plus_ad_id, numeric, 'TikTok Smart+ ad');
  return [
    step('activate_ad', 'Set Smart+ ad ' + ad + ' ENABLE, the first of three switches.', {
      action: 'tiktok_smart_plus_ad_status_update',
      payload: {advertiser_id, smart_plus_ad_ids: [ad], operation_status: 'ENABLE'},
    }),
    step(
      'activate_adgroup',
      'Set Smart+ ad group ' + adgroup + ' ENABLE, after its ad.',
      {
        action: 'tiktok_smart_plus_adgroup_status_update',
        payload: {advertiser_id, adgroup_ids: [adgroup], operation_status: 'ENABLE'},
      },
      ['activate_ad'],
    ),
    step(
      'activate_campaign',
      'Set Smart+ campaign ' + campaign + ' ENABLE, after its ad group: the last switch.',
      {
        action: 'tiktok_smart_plus_campaign_status_update',
        payload: {advertiser_id, campaign_ids: [campaign], operation_status: 'ENABLE'},
      },
      ['activate_adgroup'],
    ),
  ];
}
