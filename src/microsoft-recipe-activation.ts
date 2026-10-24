import type {JsonObject} from './types.js';
import type {ActivationGateContext, ActivationStep} from './provider-adapter.js';
import {blocked, numeric, unavailable, verified, type Results} from './campaign-activation-core.js';
import {locationCriteriaPayload, positiveLocation} from './microsoft-campaign-criteria.js';

// Microsoft Advertising's launch activation, its adapter's `campaign.activation` (CMP-03; ARC-01 phase B, wave 4c:
// moved verbatim from src/campaign-activation.ts, which keeps the checks every activation passes).

/**
 * Campaign, ad group, keywords and ad were all created Paused. The campaign needs a positive location criterion (owner
 * decision P7): the gate below reads its location criteria, and the campaign step's own review reads them again
 * (microsoft-native.ts) before anything is sent.
 */
export function microsoftActivationSteps(results: Results, _scope: JsonObject, step: ActivationStep): JsonObject[] {
  const campaign = verified(results, 'campaign', r => r.data?.CampaignIds?.[0], numeric, 'Microsoft campaign'),
    adGroup = verified(results, 'adgroup', r => r.data?.AdGroupIds?.[0], numeric, 'Microsoft ad group'),
    ad = verified(results, 'ad', r => r.data?.AdIds?.[0], numeric, 'Microsoft ad'),
    keywords = results.get('keywords')?.data?.KeywordIds;
  if (!Array.isArray(keywords) || !keywords.length || keywords.some(k => typeof k !== 'string' || !numeric.test(k)))
    unavailable('Microsoft keywords');
  return [
    step('activate_campaign', 'Set campaign ' + campaign + ' Active (its positive location criteria are read first).', {
      action: 'UpdateCampaigns',
      payload: {Campaigns: [{Id: campaign, Status: 'Active'}]},
    }),
    step(
      'activate_adgroup',
      'Set ad group ' + adGroup + ' Active, after its campaign.',
      {action: 'UpdateAdGroups', payload: {CampaignId: campaign, AdGroups: [{Id: adGroup, Status: 'Active'}]}},
      ['activate_campaign'],
    ),
    step(
      'activate_keywords',
      'Set ' + keywords.length + ' keywords Active, after their ad group.',
      {
        action: 'UpdateKeywords',
        campaign_id: campaign,
        payload: {AdGroupId: adGroup, Keywords: keywords.map((Id: string) => ({Id, Status: 'Active'}))},
      },
      ['activate_adgroup'],
    ),
    step(
      'activate_ad',
      'Set ad ' + ad + ' Active, after its keywords.',
      {
        action: 'UpdateAds',
        campaign_id: campaign,
        payload: {AdGroupId: adGroup, Ads: [{Id: ad, Type: 'ResponsiveSearch', Status: 'Active'}]},
      },
      ['activate_keywords'],
    ),
  ];
}
/**
 * Owner decision P7: a Microsoft campaign is activated only with a positive location criterion. The gate lists the
 * locations Microsoft names, so the operator can confirm the geography before approving the activation.
 */
export async function microsoftActivationGates({
  call,
  actor,
  steps,
  scope,
  current,
}: ActivationGateContext): Promise<JsonObject[]> {
  const checks: JsonObject[] = [];
  const campaignStep = steps.find(s => s.id === 'activate_campaign'),
    campaign = campaignStep?.arguments?.payload?.Campaigns?.[0]?.Id;
  if (campaignStep && typeof campaign === 'string') {
    const out = await call(
      'microsoft_ads_native_action',
      {action: 'GetCampaignCriterionsByIds', ...scope, payload: locationCriteriaPayload(campaign)},
      actor,
    );
    current();
    const rows = out.success ? out.data?.data?.CampaignCriterions : undefined,
      readable = out.success && (rows === null || Array.isArray(rows)),
      locations = (Array.isArray(rows) ? rows : []).filter(r => positiveLocation(r, campaign));
    if (!readable)
      checks.push(
        blocked(
          campaignStep.id,
          'microsoft_location_criteria',
          'AMCP could not read the Microsoft campaign’s location criteria, so activation is not shown to be safe.',
          {campaign_id: campaign, read_error: out.success ? null : (out.error?.code ?? null)},
        ),
      );
    else if (!locations.length)
      checks.push(
        blocked(
          campaignStep.id,
          'microsoft_location_criteria',
          'The Microsoft campaign has no positive location criterion, so Microsoft could serve it in any location it supports. Add its target locations while it is paused, then run preflight again.',
          {campaign_id: campaign, owner_decision: 'P7'},
        ),
      );
    else
      checks.push({
        step: campaignStep.id,
        status: 'gate_passed',
        gate: 'microsoft_location_criteria',
        locations: locations.map((r: JsonObject) => ({
          location_id: String(r.Criterion.LocationId),
          name: r.Criterion.DisplayName ?? null,
        })),
      });
  }
  return checks;
}
