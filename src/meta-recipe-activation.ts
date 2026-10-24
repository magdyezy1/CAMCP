import type {JsonObject} from './types.js';
import {obj} from './workspace-core.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, numeric, verified, type Results} from './campaign-activation-core.js';

// Meta's launch activation, its adapter's `campaign.activation` (CMP-03; ARC-01 phase B, wave 4c: moved verbatim from
// src/campaign-activation.ts and src/campaign-runner.ts, which keep the checks every activation passes).

/** The paused campaign holds ACTIVE children, so enabling the campaign is the one step. */
export function metaActivationSteps(results: Results, _scope: JsonObject, step: ActivationStep): JsonObject[] {
  const campaign = verified(results, 'campaign', r => r.data?.id, numeric, 'Meta campaign');
  return [
    step('activate_campaign', 'Set campaign ' + campaign + ' ACTIVE. Its ad set and ad were created ACTIVE under it.', {
      action: 'meta_campaign_update',
      path_params: {campaign_id: campaign},
      payload: {status: 'ACTIVE'},
    }),
  ];
}
/** The ad its gates read, and the pixel a conversion launch optimizes on. */
export function metaActivationRecord(run: JsonObject, results: Results): JsonObject {
  const metaAd = results.get('ad')?.data?.id,
    metaPixel = typeof run.recipe.pixel_id === 'string' ? run.recipe.pixel_id : undefined;
  return {
    ...(typeof metaAd === 'string' ? {meta_ad_id: metaAd} : {}),
    ...(metaPixel ? {meta_pixel_id: metaPixel} : {}),
  };
}
/** The ad's effective status and review feedback, then the conversion pixel. */
export async function metaActivationGates({
  call,
  actor,
  activation,
  steps,
  scope,
  current,
}: ActivationGateContext): Promise<JsonObject[]> {
  const checks: JsonObject[] = [];
  if (typeof activation.meta_ad_id === 'string') {
    const step = steps[0]!,
      out = await call(
        'meta_native_action',
        {
          action: 'meta_ad_get',
          ...scope,
          path_params: {ad_id: activation.meta_ad_id},
          query: {fields: 'id,status,effective_status,ad_review_feedback'},
        },
        actor,
      );
    const row = out.success ? out.data?.data : undefined,
      effective = typeof row?.effective_status === 'string' ? row.effective_status : undefined,
      feedback = obj(row?.ad_review_feedback) && Object.keys(row.ad_review_feedback).length;
    if (!out.success || !obj(row) || String(row.id) !== activation.meta_ad_id || !effective)
      checks.push(
        blocked(
          step.id,
          'meta_ad_review',
          'AMCP could not read the Meta ad’s effective status, so activation is not shown to be safe.',
          {read_error: out.success ? null : (out.error?.code ?? null)},
        ),
      );
    else if (['DISAPPROVED', 'WITH_ISSUES'].includes(effective) || feedback)
      checks.push(
        blocked(
          step.id,
          'meta_ad_review',
          'Meta reports this ad as ' +
            effective +
            (feedback ? ' with review feedback' : '') +
            '. Correct the ad before activating its campaign.',
          {effective_status: effective, ad_review_feedback: row.ad_review_feedback ?? null},
        ),
      );
    else checks.push({step: step.id, status: 'gate_passed', gate: 'meta_ad_review', effective_status: effective});
  }
  // A Meta conversion launch optimizes on its pixel: the pixel must still be readable and not marked unavailable.
  if (typeof activation.meta_pixel_id === 'string') {
    const step = steps[0]!,
      out = await call(
        'meta_native_action',
        {
          action: 'meta_pixel_id_get',
          ...scope,
          path_params: {pixel_id: activation.meta_pixel_id},
          query: {fields: 'id,is_unavailable'},
        },
        actor,
      );
    current();
    const row = out.success ? out.data?.data : undefined;
    if (!out.success || !obj(row) || String(row.id) !== activation.meta_pixel_id)
      checks.push(
        blocked(
          step.id,
          'meta_pixel',
          'AMCP could not read the Meta pixel this campaign optimizes on, so activation is not shown to be safe.',
          {pixel_id: activation.meta_pixel_id, read_error: out.success ? null : (out.error?.code ?? null)},
        ),
      );
    else if (row.is_unavailable === true)
      checks.push(
        blocked(
          step.id,
          'meta_pixel',
          'Meta reports the pixel this campaign optimizes on as unavailable. Restore the pixel before activating.',
          {pixel_id: activation.meta_pixel_id, is_unavailable: true},
        ),
      );
    else checks.push({step: step.id, status: 'gate_passed', gate: 'meta_pixel', pixel_id: activation.meta_pixel_id});
  }
  return checks;
}
