import type {Actor, JsonObject} from './types.js';
import {bad, obj, type ToolCall} from './workspace-core.js';
import {locationCriteriaPayload, positiveLocation} from './microsoft-campaign-criteria.js';

/**
 * Launch activation (CMP-03). A recipe creates its campaign paused; activation is a separate, linked plan with its own
 * approval, preflight and spend confirmation, never part of the launch approval. Each platform's activation steps
 * come from the resources its completed plan verified, in the order that keeps delivery off until the last switch:
 *
 * - Meta and Google: the paused campaign holds ACTIVE/ENABLED children, so enabling the campaign is the one step.
 * - Snapchat: campaign, ad squad and ad were all created PAUSED, so all three are activated, each after the one
 *   before it is verified (activating the campaign alone delivers nothing).
 * - Microsoft: campaign, ad group, keywords and ad were all created Paused. The campaign needs a positive location
 *   criterion (owner decision P7): the gate below reads its location criteria, and the campaign step's own review
 *   reads them again (microsoft-native.ts) before anything is sent.
 * - TikTok (CMP-07): the DISABLE campaign holds ENABLE children, so enabling the campaign through the reviewed
 *   tiktok_entity_status family is the one step.
 * - LinkedIn (CMP-07): campaign group, campaign and creative were all created PAUSED, so all three are activated
 *   through REST.li PARTIAL_UPDATE reviews, each after the one before it is verified; the creative is the last switch.
 *
 * Read-only gates run at the activation plan's preflight, as one set, before any status write: the Snapchat ad's
 * creative review, the Meta ad's effective status and review feedback, the Meta conversion pixel, the Google
 * conversion recipes' account-default goals and primary actions (the reads recipe_eligibility makes), the Microsoft
 * campaign's positive location criteria, whose names Microsoft returns are listed for the operator, and the state of
 * the LinkedIn lead form a lead launch uses.
 */
export const activationPlatforms = ['meta', 'google', 'snapchat', 'microsoft', 'tiktok', 'linkedin'];

type Results = Map<string, JsonObject>;
const gateways: Record<string, string> = {
  meta: 'meta_native_action',
  google: 'google_ads_native_action',
  snapchat: 'snapchat_native_action',
  microsoft: 'microsoft_ads_native_action',
  tiktok: 'tiktok_native_action',
  linkedin: 'linkedin_native_action',
};
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
  if (platform === 'tiktok') {
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
  if (platform === 'linkedin') {
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
  // A LinkedIn lead launch (CMP-07): the form's state decides whether its creative serves, so the account's forms are
  // read through the owner finder (the launch preflight's read) and anything but a PUBLISHED form blocks activation.
  if (activation.platform === 'linkedin' && typeof activation.linkedin_lead_form_id === 'string') {
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
  // Owner decision P7: a Microsoft campaign is activated only with a positive location criterion. The gate lists the
  // locations Microsoft names, so the operator can confirm the geography before approving the activation.
  const campaignStep = steps.find(s => s.id === 'activate_campaign'),
    campaign = campaignStep?.arguments?.payload?.Campaigns?.[0]?.Id;
  if (activation.platform === 'microsoft' && campaignStep && typeof campaign === 'string') {
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
