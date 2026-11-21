import type {JsonObject} from './types.js';
import type {ActivationStep} from './provider-adapter.js';
import {numeric, verified, type Results} from './campaign-activation-core.js';
import {tiktokSmartPlusChildStatus} from './tiktok-smart-plus-recipe.js';

// TikTok's launch activation, its adapter's `campaign.activation` (CMP-07; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts, which keeps the checks every activation passes).

/**
 * The DISABLE campaign holds ENABLE children, so enabling it through tiktok_entity_status is the one step. A Smart+ launch (R2.5 M4: its
 * plan holds the step `smart_plus_campaign`) is activated through the Smart+ status family instead, in the shape its own recipe facts say its
 * children were created in (`children_start`, S4-2, the lead's review of eb0c133f), not the constant of the day: a plan built before the constant is
 * flipped (after the live check LV-18) is still turned on as it was built. A plan whose facts name neither status takes the constant.
 */
export function tiktokActivationSteps(
  results: Results,
  scope: JsonObject,
  step: ActivationStep,
  recipe?: JsonObject,
): JsonObject[] {
  if (results.has('smart_plus_campaign'))
    return tiktokSmartPlusActivationSteps(
      results,
      scope,
      step,
      recipe?.children_start === 'ENABLE' || recipe?.children_start === 'DISABLE'
        ? recipe.children_start
        : tiktokSmartPlusChildStatus,
      recipe,
    );
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
 * What the switch of a campaign says of the budget, for a pack whose campaign carries none (the Search pack, S2-1: its recipe facts say
 * `budget_level` is the ad group's): the ad group's daily budget, in the facts' own amount and currency, is what starts spending.
 */
const budgetNote = (recipe?: JsonObject): string =>
  recipe?.budget_level === 'adgroup' && typeof recipe.daily_budget === 'string' && typeof recipe.currency === 'string'
    ? ' The campaign has no budget of its own: the ad group’s daily budget of ' +
      recipe.daily_budget +
      ' ' +
      recipe.currency +
      ' is what starts spending.'
    : '';
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
  recipe?: JsonObject,
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
        'Set Smart+ campaign ' +
          campaign +
          ' ENABLE. Its ad group and ad were created ENABLE under it.' +
          budgetNote(recipe),
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
      'Set Smart+ campaign ' + campaign + ' ENABLE, after its ad group: the last switch.' + budgetNote(recipe),
      {
        action: 'tiktok_smart_plus_campaign_status_update',
        payload: {advertiser_id, campaign_ids: [campaign], operation_status: 'ENABLE'},
      },
      ['activate_adgroup'],
    ),
  ];
}
