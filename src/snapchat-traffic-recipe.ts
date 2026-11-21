import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeChoices, recipeEnum, recipeMoney} from './recipe-values.js';
import type {DependencyEvidenceContext, RecipeContextFacts} from './provider-adapter.js';

export const snapchatTrafficRecipe = {
  id: 'snapchat_website_traffic',
  name: 'Snapchat website traffic with an existing creative',
  platform: 'snapchat',
  required: [
    'name',
    'account_id',
    'connection_id',
    'currency',
    'daily_budget',
    'country_codes',
    'creative_id',
    'regulated_content',
    'start_time',
  ],
  // The website traffic recipe optimizes swipes and takes no choice of goal (AMCP-08: `inputs` lists what each recipe lets the brief choose).
  inputs: {},
  description:
    'Creates a paused auction campaign, daily-budget ad squad and website ad using an existing WEB_VIEW creative. Optimizes swipes with automatic bidding. Inspect the creative destination and account eligibility during native review; activation is separate.',
};
export const snapchatLeadRecipe = {
  ...snapchatTrafficRecipe,
  id: 'snapchat_lead_generation',
  name: 'Snapchat lead generation with an existing form creative',
  required: [...snapchatTrafficRecipe.required, 'optimization_goal'],
  // The values the goal accepts (AMCP-08): `recipes` and `recipe_context` say them, and the builder below reads the brief by them.
  inputs: {optimization_goal: recipeChoices(['SWIPES', 'LEAD_FORM_SUBMISSIONS'])},
  description:
    'Creates a paused lead campaign, daily-budget ad squad and lead ad using an existing LEAD_GENERATION creative and its account-owned form. Choose swipe or form-submission optimization explicitly. The original creative and form remain unchanged; provider eligibility and consent acceptance need separate evidence.',
};
function timestamp(value: unknown): number {
  if (typeof value !== 'string')
    throw new MirrorError('RECIPE_DATE_INVALID', 'Use a valid timestamp with an explicit UTC offset.');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value),
    time = Date.parse(value);
  if (
    !m ||
    !Number.isFinite(time) ||
    Number(m[2]) > 23 ||
    Number(m[3]) > 59 ||
    Number(m[4]) > 59 ||
    !Number.isFinite(Date.parse(m[1] + 'T00:00:00Z')) ||
    new Date(m[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== m[1]
  )
    throw new MirrorError('RECIPE_DATE_INVALID', 'Use a valid timestamp with an explicit UTC offset.');
  return time;
}

/** Existing reviewed routes only. Original creative content is never edited by this recipe. */
export function buildSnapchatTrafficRecipe(b: JsonObject): JsonObject {
  return buildSnapchatLaunchRecipe(b, false);
}
export function buildSnapchatLeadRecipe(b: JsonObject): JsonObject {
  // The goal is the person's explicit choice for the lead-form creative, read by its declared values and never defaulted (AMCP-08).
  return buildSnapchatLaunchRecipe(
    b,
    true,
    recipeEnum(b, 'optimization_goal', snapchatLeadRecipe.inputs.optimization_goal) as string,
  );
}
function buildSnapchatLaunchRecipe(b: JsonObject, leads: boolean, leadGoal?: string): JsonObject {
  if (
    !b.name.trim() ||
    !/^[-A-Za-z0-9_]{1,200}$/.test(b.account_id) ||
    typeof b.creative_id !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.creative_id)
  )
    throw new MirrorError(
      'RECIPE_INPUT_INVALID',
      'Use an exact selected account and an existing Snapchat creative UUID.',
    );
  if (typeof b.regulated_content !== 'boolean')
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Declare regulated_content explicitly as a boolean.');
  if (b.regulated_content)
    throw new MirrorError(
      'RECIPE_PREREQUISITES_REQUIRED',
      'Regulated Snapchat advertising requires a tailored native plan and account eligibility.',
    );
  const countries = b.country_codes;
  if (
    !Array.isArray(countries) ||
    countries.length < 1 ||
    countries.length > 20 ||
    countries.some(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) ||
    new Set(countries).size !== countries.length
  )
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Choose 1–20 distinct two-letter uppercase country codes.');
  const budget = recipeMoney(b.daily_budget, 1000000, 'daily budget'),
    start = timestamp(b.start_time);
  if (BigInt(budget) < 5000000n)
    throw new MirrorError(
      'INVALID_RECIPE_MONEY',
      'Snapchat documents a minimum daily ad-squad budget of five account-currency units; account eligibility is checked separately.',
    );
  if (b.end_time !== undefined && timestamp(b.end_time) <= start)
    throw new MirrorError('RECIPE_DATE_INVALID', 'End time must follow start time.');
  const goal = leads ? leadGoal : 'SWIPES',
    adType = leads ? 'LEAD_GENERATION' : 'REMOTE_WEBPAGE',
    schedule = {start_time: b.start_time, ...(b.end_time !== undefined ? {end_time: b.end_time} : {})},
    campaign = {$ref: 'campaign#/data/campaigns/0/campaign/id'},
    squad = {$ref: 'squad#/data/adsquads/0/adsquad/id'},
    step = (
      id: string,
      action: string,
      payload: JsonObject,
      path_params: JsonObject = {},
      depends_on: string[] = [],
    ) => ({
      id,
      kind: 'write',
      gateway: 'snapchat_native_action',
      account_id: b.account_id,
      connection_id: b.connection_id,
      expected_currency: b.currency,
      arguments: {action, ...(Object.keys(path_params).length ? {path_params} : {}), payload},
      depends_on,
    });
  return {
    action: 'create',
    name: b.name,
    brief: leads
      ? 'Paused Snapchat lead generation using an existing creative and its original form. Inspect both account-owned dependencies and the explicit optimization goal; every change uses its own review and activation is separate.'
      : 'Paused Snapchat website traffic with automatic swipe optimization and an existing creative. Inspect the original creative destination and provider eligibility; every change uses its own review and activation is separate.',
    steps: [
      step('campaign', 'snapchat_campaign_create', {
        campaigns: [
          {
            name: b.name,
            ad_account_id: b.account_id,
            status: 'PAUSED',
            buy_model: 'AUCTION',
            pacing_level: 'AD_SQUAD',
            objective_v2_properties: {objective_v2_type: leads ? 'LEADS' : 'TRAFFIC'},
            ...schedule,
          },
        ],
      }),
      step(
        'squad',
        'snapchat_adsquad_create',
        {
          adsquads: [
            {
              name: b.name + (leads ? ' · lead generation' : ' · website traffic'),
              campaign_id: campaign,
              status: 'PAUSED',
              type: 'SNAP_ADS',
              child_ad_type: adType,
              billing_event: 'IMPRESSION',
              delivery_constraint: 'DAILY_BUDGET',
              daily_budget_micro: budget,
              bid_strategy: 'AUTO_BID',
              optimization_goal: goal,
              pacing_type: 'STANDARD',
              placement_v2: {config: 'AUTOMATIC'},
              targeting: {
                regulated_content: false,
                geos: countries.map(country_code => ({country_code: country_code.toLowerCase(), operation: 'INCLUDE'})),
              },
              ...schedule,
            },
          ],
        },
        {campaign_id: campaign},
        ['campaign'],
      ),
      step(
        'ad',
        'snapchat_ad_create',
        {
          ads: [
            {
              name: b.name + (leads ? ' · lead ad' : ' · website ad'),
              ad_squad_id: squad,
              creative_id: b.creative_id,
              type: adType,
              status: 'PAUSED',
            },
          ],
        },
        {ad_squad_id: squad},
        ['squad'],
      ),
    ],
    recipe: {
      id: leads ? snapchatLeadRecipe.id : snapchatTrafficRecipe.id,
      platform: 'snapchat',
      currency: b.currency,
      daily_budget_micro: budget,
      schedule_inputs: ['start_time', 'end_time'],
      bidding_strategy: 'AUTO_BID',
      optimization_goal: goal,
      creative_id: b.creative_id,
      creative_acceptance: leads
        ? 'Native inspection reads the existing creative and its account-owned form definition. Provider approval, objective eligibility, privacy-policy availability and consent acceptance remain unverified. This plan does not edit the creative or form and never reads submitted leads.'
        : 'The existing creative type, destination, processing/approval and objective eligibility remain unverified until their own native inspection/review. This plan does not edit media or the landing page.',
      placement_acceptance:
        'Automatic placement is explicit but Snapchat does not return placement_v2 on GET. The review retains that read-back limitation.',
    },
  };
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of each recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
export const snapchatTrafficContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing WEB_VIEW creative without editing its destination or media. Inspect its exact account, destination and approval before review. Automatic swipe bidding may spend the daily budget; activation is separate.',
  ]),
  prerequisite: 'existing account-owned website creative and explicit country/schedule inputs',
});
export const snapchatLeadContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Uses an existing LEAD_GENERATION creative and its original account-owned form without editing either. Choose swipe or form-submission optimization explicitly. Native review reads both again; provider eligibility, privacy-policy availability and consent acceptance remain unverified. Activation is separate.',
  ]),
  prerequisite: 'existing account-owned lead creative and form with explicit optimization/country/schedule inputs',
});

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`).
/** The existing creative and lead form a Snapchat recipe reuses, as its preflight read them for this exact account. */
export function snapchatDependencyEvidence(
  id: string,
  {assets, scope, business}: DependencyEvidenceContext,
): JsonObject | undefined {
  if (!['existing_website_creative', 'existing_lead_creative', 'existing_lead_form'].includes(id)) return undefined;
  const creative = assets.find(
    a =>
      a.asset_type === 'Snapchat creative' &&
      a.asset_id === business.creative_id &&
      a.account_id === scope.account_id &&
      a.connection_id === scope.connection_id,
  );
  const proof = assets.find(
    a =>
      a.asset_type === (id === 'existing_lead_form' ? 'Snapchat lead form' : 'Snapchat creative') &&
      a.asset_id === (id === 'existing_lead_form' ? creative?.lead_generation_form_id : business.creative_id) &&
      a.account_id === scope.account_id &&
      a.connection_id === scope.connection_id &&
      a.status === 'provider_read_checked',
  );
  return proof ? {status: 'ready', evidence: proof, meaning: proof.meaning} : undefined;
}
