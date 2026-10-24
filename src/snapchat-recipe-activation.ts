import type {JsonObject} from './types.js';
import {obj} from './workspace-core.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, uuid, verified, type Results} from './campaign-activation-core.js';

// Snapchat's launch activation, its adapter's `campaign.activation` (CMP-03; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts, which keeps the checks every activation passes).

/**
 * Campaign, ad squad and ad were all created PAUSED, so all three are activated, each after the one before it is
 * verified (activating the campaign alone delivers nothing).
 */
export function snapchatActivationSteps(results: Results, _scope: JsonObject, step: ActivationStep): JsonObject[] {
  const active = [{op: 'replace', path: '/status', value: 'ACTIVE'}];
  const campaign = verified(results, 'campaign', r => r.data?.campaigns?.[0]?.campaign?.id, uuid, 'Snapchat campaign'),
    squad = verified(results, 'squad', r => r.data?.adsquads?.[0]?.adsquad?.id, uuid, 'Snapchat ad squad'),
    ad = verified(results, 'ad', r => r.data?.ads?.[0]?.ad?.id, uuid, 'Snapchat ad');
  return [
    step('activate_campaign', 'Set campaign ' + campaign + ' ACTIVE.', {
      action: 'snapchat_campaign_update',
      path_params: {campaign_id: campaign},
      payload: active,
    }),
    step(
      'activate_squad',
      'Set ad squad ' + squad + ' ACTIVE, after its campaign.',
      {action: 'snapchat_adsquad_update', path_params: {campaign_id: campaign, ad_squad_id: squad}, payload: active},
      ['activate_campaign'],
    ),
    step(
      'activate_ad',
      'Set ad ' + ad + ' ACTIVE, after its ad squad.',
      {action: 'snapchat_ad_update', path_params: {ad_squad_id: squad, ad_id: ad}, payload: active},
      ['activate_squad'],
    ),
  ];
}
/** The ad's creative review. */
export async function snapchatActivationGates({
  call,
  actor,
  steps,
  scope,
}: ActivationGateContext): Promise<JsonObject[]> {
  const checks: JsonObject[] = [],
    ad = steps.find(s => s.id === 'activate_ad');
  if (ad) {
    const out = await call(
      'snapchat_native_action',
      {action: 'snapchat_ad_get', ...scope, path_params: {ad_id: ad.arguments.path_params.ad_id}},
      actor,
    );
    const row = out.success ? out.data?.data?.ads?.[0]?.ad : undefined,
      review = typeof row?.review_status === 'string' ? row.review_status : undefined;
    if (!out.success || !obj(row) || row.id !== ad.arguments.path_params.ad_id || !review)
      checks.push(
        blocked(
          ad.id,
          'snapchat_creative_review',
          'AMCP could not read the Snapchat ad’s creative review status, so activation is not shown to be safe.',
          {read_error: out.success ? null : (out.error?.code ?? null)},
        ),
      );
    else if (review !== 'APPROVED')
      checks.push(
        blocked(
          ad.id,
          'snapchat_creative_review',
          'Snapchat has not approved this ad’s creative (review status ' +
            review +
            '). Activating now would deliver nothing; wait for approval or correct the creative.',
          {review_status: review, review_status_reasons: row.review_status_reasons ?? null},
        ),
      );
    else checks.push({step: ad.id, status: 'gate_passed', gate: 'snapchat_creative_review', review_status: review});
  }
  return checks;
}
