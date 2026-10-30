import type {JsonObject} from './types.js';
import {obj} from './workspace-core.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, numeric, verified, type Results} from './campaign-activation-core.js';

// LinkedIn's launch activation, its adapter's `campaign.activation` (CMP-07; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts and src/campaign-runner.ts, which keep the checks every activation passes).

/** The numeric ID of a LinkedIn create receipt (x-restli-id): a bare ID, or the entity's URN (possibly encoded). */
function linkedinCreated(value: unknown, kind: string): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  let text = String(value);
  try {
    text = decodeURIComponent(text);
  } catch {
    return undefined;
  }
  return new RegExp('^(?:urn:li:' + kind + ':)?([1-9][0-9]{0,19})$').exec(text)?.[1];
}
/**
 * Campaign group, campaign and creative were all created PAUSED, so all three are activated through REST.li
 * PARTIAL_UPDATE reviews, each after the one before it is verified; the creative is the last switch.
 */
export function linkedinActivationSteps(results: Results, _scope: JsonObject, step: ActivationStep): JsonObject[] {
  const id = (step: string, kind: string, what: string) =>
      verified(results, step, r => linkedinCreated(r.created_id, kind), numeric, what),
    group = id('group', 'sponsoredCampaignGroup', 'LinkedIn campaign group'),
    campaign = id('campaign', 'sponsoredCampaign', 'LinkedIn campaign'),
    creative = 'urn:li:sponsoredCreative:' + id('creative', 'sponsoredCreative', 'LinkedIn creative'),
    update = (action: string, path_params: JsonObject, field: string) => ({
      action: 'linkedin_rest_ad_accounts_ad_account_id_' + action,
      restli_method: 'PARTIAL_UPDATE',
      path_params,
      payload: {patch: {$set: {[field]: 'ACTIVE'}}},
    });
  return [
    step(
      'activate_group',
      'Set campaign group ' + group + ' ACTIVE.',
      update('ad_campaign_groups_campaign_group_id_post', {campaign_group_id: group}, 'status'),
    ),
    step(
      'activate_campaign',
      'Set campaign ' + campaign + ' ACTIVE, after its campaign group.',
      update('ad_campaigns_campaign_id_post', {campaign_id: campaign}, 'status'),
      ['activate_group'],
    ),
    step(
      'activate_creative',
      'Set creative ' + creative + ' ACTIVE, after its campaign.',
      update('creatives_creative_id_post', {creative_id: creative}, 'intendedStatus'),
      ['activate_campaign'],
    ),
  ];
}
/** A LinkedIn lead launch is gated on its form's state (CMP-07). */
export function linkedinActivationRecord(run: JsonObject): JsonObject {
  const leadForm = typeof run.recipe.lead_form_id === 'string' ? run.recipe.lead_form_id : undefined;
  return leadForm ? {linkedin_lead_form_id: leadForm} : {};
}
/**
 * A LinkedIn lead launch (CMP-07): the form's state decides whether its creative serves, so the account's forms are
 * read through the owner finder (the launch preflight's read) and anything but a PUBLISHED form blocks activation.
 */
export async function linkedinActivationGates({
  call,
  actor,
  activation,
  steps,
  scope,
  current,
}: ActivationGateContext): Promise<JsonObject[]> {
  const checks: JsonObject[] = [];
  if (typeof activation.linkedin_lead_form_id === 'string') {
    const step = steps.find(s => s.id === 'activate_creative') ?? steps[0]!,
      form = activation.linkedin_lead_form_id,
      out = await call(
        'linkedin_native_action',
        {
          action: 'linkedin_rest_lead_forms_get',
          ...scope,
          query: {q: 'owner', owner: {sponsoredAccount: 'urn:li:sponsoredAccount:' + scope.account_id}, count: 100},
          aggregate_pages: true,
        },
        actor,
      );
    current();
    const rows =
        out.success && !out.data?.truncated && Array.isArray(out.data?.data?.elements)
          ? (out.data.data.elements as unknown[])
          : undefined,
      row = rows?.find(f => obj(f) && String(f.id) === form) as JsonObject | undefined;
    if (!rows)
      checks.push(
        blocked(
          step.id,
          'linkedin_lead_form',
          'AMCP could not completely read the ad account’s lead forms, so activation is not shown to be safe.',
          {lead_form_id: form, read_error: out.success ? null : (out.error?.code ?? null)},
        ),
      );
    else if (!row)
      checks.push(
        blocked(
          step.id,
          'linkedin_lead_form',
          'LinkedIn no longer returns this lead form for the ad account. Choose a form of this account before activating.',
          {lead_form_id: form},
        ),
      );
    else if (row.state !== 'PUBLISHED')
      checks.push(
        blocked(
          step.id,
          'linkedin_lead_form',
          'The lead form is not published, and its state decides whether the creative serves. Publish it with its own reviewed state change before activating.',
          {lead_form_id: form, state: typeof row.state === 'string' ? row.state : null},
        ),
      );
    else checks.push({step: step.id, status: 'gate_passed', gate: 'linkedin_lead_form', lead_form_id: form});
  }
  return checks;
}
