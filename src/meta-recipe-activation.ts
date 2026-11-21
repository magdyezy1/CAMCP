import type {CompiledRequest, JsonObject} from './types.js';
import {obj} from './workspace-core.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, numeric, verified, type Results} from './campaign-activation-core.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';
import {metaPrefix} from './meta-version.js';

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
/** The pages of the account's pixel list one gate reads, of Meta's 100 rows each: the bound the preflight's prerequisites use. */
const pixelListPages = 25;
/**
 * The ad account's pixels, as its list returns them with the fields the gate decides on (id and is_unavailable): the rows of the
 * pages read, whether those were all the pages, and the code of the refusal when the read failed. The list is the account's own, so
 * it names the account in its path and needs no pixel ownership; what it returns is remembered as ownership for five minutes, as
 * every pixel list is (src/meta-dataset-scope.ts). A gate that cannot run the read has no list: blocked, never passed.
 */
async function accountPixels(
  runPlan: ActivationGateContext['runPlan'],
  actor: ActivationGateContext['actor'],
  scope: JsonObject,
): Promise<{rows?: JsonObject[]; complete: boolean; error?: string}> {
  if (!runPlan) return {complete: false, error: 'GATE_READ_UNAVAILABLE'};
  const account = normalizeAccount('meta_native_action', scope.account_id),
    plan: CompiledRequest = {
      gateway: 'meta_native_action',
      accountId: account,
      action: 'AMCP_META_ACTIVATION_PIXEL_LIST',
      method: 'GET',
      path: metaPrefix + 'act_' + account + '/adspixels',
      query: {fields: 'id,is_unavailable', limit: 100},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Activation gate read of the selected Meta ad account’s pixel list',
      warnings: [],
    };
  try {
    const result = await runPlan(actor, plan, {
        connection_id: scope.connection_id,
        aggregate_pages: true,
        max_pages: pixelListPages,
      }),
      rows = obj(result) && obj(result.data) ? result.data.data : undefined;
    if (!Array.isArray(rows)) return {complete: false, error: 'UPSTREAM_RESPONSE_INVALID'};
    return {rows: rows.filter(obj), complete: (result as JsonObject).truncated !== true};
  } catch (e) {
    if (e instanceof MirrorError) return {complete: false, error: e.code};
    throw e;
  }
}
/** The ad's effective status and review feedback, then the conversion pixel. */
export async function metaActivationGates({
  call,
  actor,
  activation,
  steps,
  scope,
  current,
  runPlan,
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
  // A Meta conversion launch optimizes on its pixel: the ad account must list it, and Meta must not mark it unavailable. The gate
  // decides from the account's pixel list, one read that shows both (r25-field2-access B2: the pixel node it read before was
  // refused for want of ownership, so in production every conversion launch was blocked at this gate, and its only test stubbed the
  // call layer, so the guard never ran). A pixel on a page the bounded read did not reach is not shown to be missing.
  if (typeof activation.meta_pixel_id === 'string') {
    const step = steps[0]!,
      pixel = activation.meta_pixel_id,
      listing = await accountPixels(runPlan, actor, scope);
    current();
    const row = listing.rows?.find(r => String(r.id) === pixel),
      unread = 'AMCP could not read the Meta pixel this campaign optimizes on, so activation is not shown to be safe.';
    if (row?.is_unavailable === true)
      checks.push(
        blocked(
          step.id,
          'meta_pixel',
          'Meta reports the pixel this campaign optimizes on as unavailable. Restore the pixel before activating.',
          {pixel_id: pixel, is_unavailable: true},
        ),
      );
    else if (row) checks.push({step: step.id, status: 'gate_passed', gate: 'meta_pixel', pixel_id: pixel});
    else if (listing.error !== undefined)
      checks.push(blocked(step.id, 'meta_pixel', unread, {pixel_id: pixel, read_error: listing.error}));
    else if (!listing.complete)
      checks.push(blocked(step.id, 'meta_pixel', unread, {pixel_id: pixel, reason: 'list_incomplete'}));
    else
      checks.push(
        blocked(
          step.id,
          'meta_pixel',
          'The ad account does not list the Meta pixel this campaign optimizes on, so activation is not shown to be safe. Choose a pixel of this account.',
          {pixel_id: pixel, reason: 'not_listed'},
        ),
      );
  }
  return checks;
}
