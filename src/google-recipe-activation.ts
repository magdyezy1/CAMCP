import type {JsonObject} from './types.js';
import {obj} from './workspace-core.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, unavailable, type Results} from './campaign-activation-core.js';

// Google Ads' launch activation, its adapter's `campaign.activation` (CMP-03; ARC-01 phase B, wave 4c: moved verbatim
// from src/campaign-activation.ts and src/campaign-runner.ts, which keep the checks every activation passes).

/** The Google campaign a per-step plan or an all-or-nothing build created. */
function googleCampaign(results: Results): string {
  const perStep = results.get('campaign')?.data?.results?.[0]?.resourceName,
    build = results.get('build')?.data?.mutateOperationResponses,
    built = Array.isArray(build) ? build.find((r: unknown) => obj(r) && obj(r.campaignResult)) : undefined,
    name = perStep ?? built?.campaignResult?.resourceName;
  if (typeof name !== 'string' || !/^customers\/\d+\/campaigns\/\d+$/.test(name)) unavailable('Google campaign');
  return name;
}
/** The paused campaign holds ENABLED children, so enabling the campaign is the one step. */
export function googleActivationSteps(results: Results, _scope: JsonObject, step: ActivationStep): JsonObject[] {
  const campaign = googleCampaign(results);
  return [
    step('activate_campaign', 'Set campaign ' + campaign + ' ENABLED. Its children were created ENABLED.', {
      action: 'google_ads_v23_campaign_mutate_campaigns',
      payload: {
        operations: [{update: {resource_name: campaign, status: 'ENABLED'}, update_mask: 'status'}],
        partial_failure: false,
      },
    }),
  ];
}
/** A Google conversion launch is gated on the reads recipe_eligibility makes for it (the recipe's declared objects). */
export function googleActivationRecord(run: JsonObject, _results: Results, declared: string[]): JsonObject {
  const conversionGoals = declared.includes('account_default_conversion_goals')
    ? {
        currency: run.recipe.currency,
        ...(declared.includes('conversion_value_configuration') ? {include_value_settings: true} : {}),
        ...(declared.includes('reported_conversion_activity') ? {include_activity: true} : {}),
      }
    : undefined;
  return conversionGoals ? {conversion_goals: conversionGoals} : {};
}
/** A Google conversion launch bids on account-default goals: the same bounded reads recipe_eligibility makes. */
export async function googleActivationGates({
  actor,
  activation,
  steps,
  scope,
  inspectConversionGoals,
  current,
}: ActivationGateContext): Promise<JsonObject[]> {
  const checks: JsonObject[] = [];
  if (obj(activation.conversion_goals)) {
    const step = steps[0]!;
    const inspection = inspectConversionGoals
      ? await inspectConversionGoals(
          actor,
          {gateway: 'google_ads_native_action', ...scope, ...activation.conversion_goals},
          current,
        )
      : undefined;
    current();
    const statuses = obj(inspection?.dependency_statuses) ? inspection.dependency_statuses : {},
      failing = ['account_default_conversion_goals', 'primary_conversion_actions'].filter(
        id => statuses[id] === 'blocked',
      );
    if (!inspection || inspection.provider_mutations !== 0 || inspection.error)
      checks.push(
        blocked(
          step.id,
          'google_conversion_goals',
          'AMCP could not completely read the account’s conversion goals, so activation is not shown to be safe.',
          {read_error: inspection?.error?.code ?? null},
        ),
      );
    else if (failing.length)
      checks.push(
        blocked(
          step.id,
          'google_conversion_goals',
          'The account has no biddable account-default conversion goal with an enabled primary action. This campaign bids on conversions, so resolve the account’s goals before activating.',
          {dependency_statuses: statuses},
        ),
      );
    else
      checks.push({
        step: step.id,
        status: 'gate_passed',
        gate: 'google_conversion_goals',
        complete: inspection.complete === true,
        dependency_statuses: statuses,
        ...(inspection.reason ? {reason: inspection.reason} : {}),
      });
  }
  return checks;
}
