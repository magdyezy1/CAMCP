import type {Actor, JsonObject} from './types.js';
import {bad, obj, type ToolCall} from './workspace-core.js';

/**
 * Launch activation (CMP-03). A recipe creates its campaign paused; activation is a separate, linked plan with its own
 * approval, preflight and spend confirmation, never part of the launch approval. Each platform's activation steps
 * come from the resources its completed plan verified, in the order that keeps delivery off until the last switch:
 *
 * - Meta and Google: the paused campaign holds ACTIVE/ENABLED children, so enabling the campaign is the one step.
 * - Snapchat: campaign, ad squad and ad were all created PAUSED, so all three are activated, each after the one
 *   before it is verified (activating the campaign alone delivers nothing).
 * - Microsoft: campaign, ad group, keywords and ad were all created Paused. The campaign step is refused without a
 *   positive location criterion (owner decision P7, microsoft-native.ts), which stops the whole plan at preflight.
 *
 * Read-only gates run at the activation plan's preflight, as one set, before any status write: the Snapchat ad's
 * creative review, the Meta ad's effective status and review feedback, the Meta conversion pixel, and the Google
 * conversion recipes' account-default goals and primary actions (the reads recipe_eligibility makes).
 */
export const activationPlatforms = ['meta', 'google', 'snapchat', 'microsoft'];

type Results = Map<string, JsonObject>;
const gateways: Record<string, string> = {
  meta: 'meta_native_action',
  google: 'google_ads_native_action',
  snapchat: 'snapchat_native_action',
  microsoft: 'microsoft_ads_native_action',
};
const numeric = /^[1-9][0-9]{0,31}$/,
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable(what: string): never {
  return bad(
    'The completed plan holds no verified ' +
      what +
      ', so AMCP cannot name what to activate. Activate it in the provider, or check the plan’s read-back.',
    'ACTIVATION_UNAVAILABLE',
    {missing: what},
  );
}
/** One value of a verified step's result, checked against the shape of a native ID. */
function verified(results: Results, step: string, read: (result: JsonObject) => unknown, shape: RegExp, what: string) {
  const result = results.get(step),
    value = result ? read(result) : undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !shape.test(String(value))) unavailable(what);
  return String(value);
}
/** The Google campaign a per-step plan or an all-or-nothing build created. */
function googleCampaign(results: Results): string {
  const perStep = results.get('campaign')?.data?.results?.[0]?.resourceName,
    build = results.get('build')?.data?.mutateOperationResponses,
    built = Array.isArray(build) ? build.find((r: unknown) => obj(r) && obj(r.campaignResult)) : undefined,
    name = perStep ?? built?.campaignResult?.resourceName;
  if (typeof name !== 'string' || !/^customers\/\d+\/campaigns\/\d+$/.test(name)) unavailable('Google campaign');
  return name;
}

/**
 * The activation steps of a completed recipe plan, from its verified results (step id → result, including any plan
 * it continues). Every ID is a literal read from a verified receipt; nothing is looked up or guessed.
 */
export function activationSteps(platform: string, results: Results, scope: JsonObject): JsonObject[] {
  const gateway = gateways[platform];
  if (!gateway)
    bad(
      'This plan’s recipe has no guided activation. Activate it through its provider’s reviewed writes.',
      'ACTIVATION_UNAVAILABLE',
    );
  const step = (id: string, description: string, args: JsonObject, depends_on: string[] = []) => ({
    id,
    kind: 'write',
    gateway,
    connection_id: scope.connection_id,
    account_id: scope.account_id,
    description,
    arguments: args,
    depends_on,
  });
  const active = [{op: 'replace', path: '/status', value: 'ACTIVE'}];
  if (platform === 'meta') {
    const campaign = verified(results, 'campaign', r => r.data?.id, numeric, 'Meta campaign');
    return [
      step(
        'activate_campaign',
        'Set campaign ' + campaign + ' ACTIVE. Its ad set and ad were created ACTIVE under it.',
        {action: 'meta_campaign_update', path_params: {campaign_id: campaign}, payload: {status: 'ACTIVE'}},
      ),
    ];
  }
  if (platform === 'google') {
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
  if (platform === 'snapchat') {
    const campaign = verified(
        results,
        'campaign',
        r => r.data?.campaigns?.[0]?.campaign?.id,
        uuid,
        'Snapchat campaign',
      ),
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
  const campaign = verified(results, 'campaign', r => r.data?.CampaignIds?.[0], numeric, 'Microsoft campaign'),
    adGroup = verified(results, 'adgroup', r => r.data?.AdGroupIds?.[0], numeric, 'Microsoft ad group'),
    ad = verified(results, 'ad', r => r.data?.AdIds?.[0], numeric, 'Microsoft ad'),
    keywords = results.get('keywords')?.data?.KeywordIds;
  if (!Array.isArray(keywords) || !keywords.length || keywords.some(k => typeof k !== 'string' || !numeric.test(k)))
    unavailable('Microsoft keywords');
  return [
    step('activate_campaign', 'Set campaign ' + campaign + ' Active (needs a positive location criterion).', {
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

/** A failed gate: the preflight check that blocks the activation plan, with what the provider showed. */
const blocked = (step: string, gate: string, message: string, observed: JsonObject = {}) => ({
  step,
  status: 'blocked',
  gate,
  error: {code: 'ACTIVATION_GATE_BLOCKED', message, details: {gate, ...observed}},
});

/** Reads the current Google conversion configuration (google-goal-inspection.ts), as recipe_eligibility does. */
export type ConversionGoalInspector = (actor: Actor, scope: JsonObject, current: () => void) => Promise<JsonObject>;

/**
 * The read-only gates of an activation plan (CMP-03), run as one set at its preflight. A read that fails or shows an
 * unexpected shape blocks too: readiness must be shown, never assumed. Returns the gate checks, passed or blocked.
 * `current` re-checks the actor between reads, as recipe_eligibility does.
 */
export async function activationGates(
  call: ToolCall,
  actor: Actor,
  activation: JsonObject,
  steps: JsonObject[],
  inspectConversionGoals?: ConversionGoalInspector,
  current: () => void = () => {},
): Promise<JsonObject[]> {
  const checks: JsonObject[] = [],
    ad = steps.find(s => s.id === 'activate_ad'),
    scope = {account_id: steps[0]?.account_id, connection_id: steps[0]?.connection_id};
  if (activation.platform === 'snapchat' && ad) {
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
  if (activation.platform === 'meta' && typeof activation.meta_ad_id === 'string') {
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
  if (activation.platform === 'meta' && typeof activation.meta_pixel_id === 'string') {
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
  // A Google conversion launch bids on account-default goals: the same bounded reads recipe_eligibility makes.
  if (activation.platform === 'google' && obj(activation.conversion_goals)) {
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
