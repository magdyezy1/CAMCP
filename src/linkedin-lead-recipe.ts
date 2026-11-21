import {MirrorError} from './errors.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {fingerprint} from './workspace-core.js';
import {currencyMinorDigits} from './budget-units.js';
import {recipeChoices, recipeEnum, recipeFolds} from './recipe-values.js';
import type {DependencyEvidenceContext, RecipeContextFacts} from './provider-adapter.js';

/**
 * linkedin_lead_generation (CMP-07 optional stretch, built before P7 named it; the owner may remove it): a guided
 * paused LinkedIn Lead Gen Form launch over the reviewed linkedin_entities creates (Microsoft Learn "Create and manage
 * campaign groups / campaigns / creatives", li-lms-2026-05, the fields the LinkedIn clone writes). A PAUSED campaign
 * group, a PAUSED Sponsored Content campaign with the LEAD_GENERATION objective and maximum-delivery bidding, and a
 * PAUSED creative that sponsors an existing post with the account's existing lead form as its call to action. LinkedIn
 * returns each new ID in x-restli-id, and each child names its parent by URN reference, as the clone does. Before
 * anything is created, preflight reads the account's lead forms through the owner finder: a form this account does not
 * own, or an archived one, blocks the plan. A form's state decides whether its creative serves ("Lead Syncing",
 * Updating Form Status), so the separate activation plan (campaign-activation.ts) reads it again and activates group,
 * campaign and creative only once the form is PUBLISHED, each status change under its own review.
 */
export const linkedinLeadSource =
  'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-05';
const gateway = 'linkedin_native_action';
/** Lead Gen Form call-to-action labels of Sponsored Content creatives, a qualified subset. */
export const linkedinLeadCtas = [
  'APPLY',
  'DOWNLOAD',
  'LEARN_MORE',
  'SIGN_UP',
  'SUBSCRIBE',
  'REGISTER',
  'REQUEST_DEMO',
  'VIEW_QUOTE',
  'JOIN',
  'ATTEND',
];
export const linkedinLeadRecipe = {
  id: 'linkedin_lead_generation',
  name: 'LinkedIn lead generation with an existing post and form',
  platform: 'linkedin',
  required: [
    'name',
    'account_id',
    'connection_id',
    'currency',
    'daily_budget',
    'location_urns',
    'locale',
    'post_urn',
    'lead_form_id',
    'call_to_action',
    'political_intent',
    'start_time',
  ],
  optional: ['end_time'],
  // The values these inputs accept (AMCP-08): `recipes` and `recipe_context` say them, and the builder reads the brief by them. Political
  // advertising needs a tailored native plan, so the one value this recipe takes for political_intent is NOT_POLITICAL.
  inputs: {
    call_to_action: recipeChoices(linkedinLeadCtas),
    political_intent: recipeChoices(['NOT_POLITICAL'], {declaration: true}),
  },
  description:
    'Creates a paused LinkedIn campaign group, a paused lead generation campaign with maximum delivery and a daily budget, and a paused creative that sponsors an existing post with the account’s existing lead form. Preflight reads the account’s lead forms; activation is separate.',
};
function invalid(message: string, field: string, code = 'RECIPE_INPUT_INVALID', details: JsonObject = {}): never {
  throw new MirrorError(code, message, {field, ...details});
}
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
/** An ISO timestamp with an explicit UTC offset, as the epoch milliseconds LinkedIn's runSchedule takes. */
function epoch(value: unknown, field: string): number {
  const m =
      typeof value === 'string' &&
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value),
    t = typeof value === 'string' ? Date.parse(value) : NaN;
  if (
    !m ||
    !Number.isFinite(t) ||
    Number(m[2]) > 23 ||
    Number(m[3]) > 59 ||
    Number(m[4]) > 59 ||
    new Date(m[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== m[1]
  )
    invalid('Use a valid timestamp with an explicit UTC offset.', field, 'RECIPE_DATE_INVALID');
  return t;
}
/** A LinkedIn decimal amount in the account currency, at most as many places as the currency has. */
function amount(v: unknown, currency: string): string {
  const digits = currencyMinorDigits(currency);
  if (digits === undefined) invalid('Unknown account currency.', 'currency', 'INVALID_RECIPE_MONEY');
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d{1,9}(?:\.\d+)?$/.test(String(v)))
    invalid('Use a positive decimal daily budget in account currency.', 'daily_budget', 'INVALID_RECIPE_MONEY');
  const [whole, fraction = ''] = String(v).split('.');
  if (fraction.length > digits! && /[1-9]/.test(fraction.slice(digits)))
    invalid(
      'The daily budget has more decimal places than the account currency.',
      'daily_budget',
      'INVALID_RECIPE_MONEY',
    );
  const kept = fraction.slice(0, digits).replace(/0+$/, ''),
    text = String(BigInt(whole!)) + (kept ? '.' + kept : '');
  if (Number(text) <= 0)
    invalid('Use a positive decimal daily budget in account currency.', 'daily_budget', 'INVALID_RECIPE_MONEY');
  return text;
}

/** Compiles a LinkedIn lead generation brief; existing reviewed routes only, nothing is read or sent. */
export function buildLinkedinLeadRecipe(b: JsonObject): JsonObject {
  if (!numeric(b.account_id)) invalid('Use the exact numeric LinkedIn ad account ID.', 'account_id');
  if (!b.name.trim() || /\p{Extended_Pictographic}/u.test(b.name))
    invalid('Use a campaign name without emoji.', 'name');
  const locations = b.location_urns;
  if (
    !Array.isArray(locations) ||
    !locations.length ||
    locations.length > 50 ||
    locations.some(l => typeof l !== 'string' || !/^urn:li:geo:[1-9][0-9]{0,18}$/.test(l)) ||
    new Set(locations).size !== locations.length
  )
    invalid('Choose 1–50 distinct LinkedIn location URNs (urn:li:geo:…).', 'location_urns');
  const locale = /^([a-z]{2})_([A-Z]{2})$/.exec(String(b.locale));
  if (!locale) invalid('Use the campaign locale as language_COUNTRY, for example en_US.', 'locale');
  if (typeof b.post_urn !== 'string' || !/^urn:li:(?:share|ugcPost):[1-9][0-9]{0,19}$/.test(b.post_urn))
    invalid('Use the URN of an existing post: urn:li:share:… or urn:li:ugcPost:….', 'post_urn');
  if (!numeric(b.lead_form_id)) invalid('Use the numeric ID of a lead form of this ad account.', 'lead_form_id');
  const callToAction = recipeEnum(b, 'call_to_action', linkedinLeadRecipe.inputs.call_to_action) as string;
  // Political advertising needs a tailored native plan: the declaration is the person's own and is never defaulted (AMCP-08).
  // A declared POLITICAL is not a value to correct: political advertising needs a tailored native plan, so it is refused as a prerequisite, and the
  // answer never invites the one value this recipe takes, which would be a false declaration (the lead's review S3-2).
  if (recipeFolds(b.political_intent, 'POLITICAL'))
    throw new MirrorError('RECIPE_PREREQUISITES_REQUIRED', 'Political advertising needs a tailored native plan.', {
      field: 'political_intent',
    });
  const politicalIntent = recipeEnum(b, 'political_intent', linkedinLeadRecipe.inputs.political_intent) as string;
  const budget = amount(b.daily_budget, b.currency),
    start = epoch(b.start_time, 'start_time'),
    end = b.end_time === undefined || b.end_time === '' ? undefined : epoch(b.end_time, 'end_time');
  if (end !== undefined && end <= start) invalid('End time must follow start time.', 'end_time', 'RECIPE_DATE_INVALID');
  const account = 'urn:li:sponsoredAccount:' + b.account_id,
    schedule = {start, ...(end !== undefined ? {end} : {})};
  const step = (
    id: string,
    action: string,
    payload: JsonObject,
    depends_on: string[] = [],
    prerequisites?: string[],
  ) => ({
    id,
    kind: 'write',
    gateway,
    account_id: b.account_id,
    connection_id: b.connection_id,
    expected_currency: b.currency,
    arguments: {action, payload},
    depends_on,
    ...(prerequisites ? {prerequisites} : {}),
  });
  return {
    action: 'create',
    name: b.name,
    brief:
      linkedinLeadRecipe.name +
      ' in ' +
      b.currency +
      '. The campaign group, campaign and creative start paused. Preflight reads the account’s lead forms; every change uses its own review and activation is a separate reviewed change.',
    steps: [
      step('group', 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post', {
        account,
        name: b.name,
        status: 'PAUSED',
        runSchedule: schedule,
      }),
      step(
        'campaign',
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
        {
          account,
          campaignGroup: {$ref: 'group#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'},
          name: (b.name + ' · lead generation').slice(0, 100),
          status: 'PAUSED',
          type: 'SPONSORED_UPDATES',
          objectiveType: 'LEAD_GENERATION',
          costType: 'CPM',
          optimizationTargetType: 'MAX_LEAD',
          dailyBudget: {amount: budget, currencyCode: b.currency},
          locale: {country: locale![2], language: locale![1]},
          offsiteDeliveryEnabled: false,
          audienceExpansionEnabled: false,
          creativeSelection: 'OPTIMIZED',
          politicalIntent,
          runSchedule: schedule,
          targetingCriteria: {
            include: {
              and: [
                {or: {'urn:li:adTargetingFacet:locations': locations}},
                {or: {'urn:li:adTargetingFacet:interfaceLocales': ['urn:li:locale:' + b.locale]}},
              ],
            },
          },
        },
        ['group'],
      ),
      step(
        'creative',
        'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
        {
          campaign: {$ref: 'campaign#/created_id', prefix: 'urn:li:sponsoredCampaign:'},
          name: (b.name + ' · creative').slice(0, 100),
          content: {reference: b.post_urn},
          leadgenCallToAction: {destination: 'urn:li:adForm:' + b.lead_form_id, label: callToAction},
          intendedStatus: 'PAUSED',
        },
        ['campaign'],
        ['linkedin_lead_form'],
      ),
    ],
    recipe: {
      id: linkedinLeadRecipe.id,
      platform: 'linkedin',
      currency: b.currency,
      daily_budget: budget,
      schedule_inputs: ['start_time', 'end_time'],
      schedule: {start_epoch_ms: start, end_epoch_ms: end ?? null},
      objective_type: 'LEAD_GENERATION',
      optimization_target_type: 'MAX_LEAD',
      location_urns: locations,
      locale: b.locale,
      post_urn: b.post_urn,
      lead_form_id: b.lead_form_id,
      call_to_action: callToAction,
      political_intent: politicalIntent,
      bidding_effect:
        'Maximum delivery uses the daily budget to seek lead form submissions. It does not guarantee a cost per lead or result; LinkedIn may spend up to 150% of a daily budget on a day. Activation is separate.',
      budget_acceptance:
        'LinkedIn sets a minimum daily campaign budget per currency and refuses a smaller one when the campaign is created.',
      creative_acceptance:
        'Preflight reads the account’s lead forms for this exact form. Post sponsorship eligibility, ad review and objective acceptance remain unverified until LinkedIn reviews the creative; the activation plan reads the form’s state again.',
      source: linkedinLeadSource,
    },
  };
}

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Preflight read of a LinkedIn lead generation pack (CMP-07): the account's lead forms through the owner finder, before
 * any predecessor exists. A form this account does not own, or an archived one, blocks the plan. The native review of
 * the creative reads its own state again; nothing here is a grant.
 */
export async function linkedinRecipePrerequisites(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  prerequisites: string[],
): Promise<JsonObject[]> {
  if (
    plan.gateway !== gateway ||
    plan.method !== 'POST' ||
    !/^\/rest\/adAccounts\/[^/]+\/creatives$/.test(plan.path) ||
    !prerequisites.includes('linkedin_lead_form') ||
    !obj(plan.body)
  )
    return [];
  const destination = plan.body.leadgenCallToAction?.destination,
    form = typeof destination === 'string' ? /^urn:li:adForm:([1-9][0-9]{0,18})$/.exec(destination)?.[1] : undefined;
  if (!form) return [];
  const account = String(plan.accountId),
    query = {q: 'owner', owner: {sponsoredAccount: 'urn:li:sponsoredAccount:' + account}, count: 100};
  const out = await service.call(
    gateway,
    {
      action: 'linkedin_rest_lead_forms_get',
      account_id: account,
      connection_id: connectionId,
      query,
      aggregate_pages: true,
    },
    actor,
  );
  if (!out.success) throw new MirrorError(out.error.code, out.error.message, out.error.details);
  const data = out.data?.data;
  if (out.data?.truncated || !obj(data) || !Array.isArray(data.elements))
    throw new MirrorError('INCOMPLETE_STATE', 'LinkedIn did not return the complete lead form list of this account.');
  const row = data.elements.find((f: unknown) => obj(f) && String(f.id) === form);
  if (!row || !obj(row.owner) || row.owner.sponsoredAccount !== 'urn:li:sponsoredAccount:' + account)
    throw new MirrorError(
      'CAMPAIGN_PREREQUISITE_REQUIRED',
      'LinkedIn did not return this lead form for the selected ad account.',
      {
        lead_form_id: form,
        field: 'lead_form_id',
      },
    );
  if (row.state === 'ARCHIVED')
    throw new MirrorError('CAMPAIGN_PREREQUISITE_REQUIRED', 'The lead form is archived; choose an active form.', {
      lead_form_id: form,
      state: row.state,
      field: 'lead_form_id',
    });
  return [
    {
      asset_type: 'LinkedIn lead form',
      asset_id: form,
      status: 'provider_read_checked',
      account_id: account,
      connection_id: connectionId,
      state: typeof row.state === 'string' ? row.state : null,
      source_reference: {
        source_kind: 'native_lead_form_owner_read',
        request: {action: 'linkedin_rest_lead_forms_get', query},
        response_hash: fingerprint(data),
        captured_at: Date.now(),
      },
      meaning:
        'LinkedIn returned this lead form for the selected ad account. The creative serves only while the form is published, which the activation plan reads again; ad review and objective acceptance remain unverified.',
    },
  ];
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of the recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
export const linkedinLeadContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Sponsors an existing post with the account’s existing lead form and maximum-delivery bidding. Preflight reads the account’s lead forms; post eligibility, privacy-policy acceptance, ad review and objective acceptance remain unverified. Activation is separate.',
  ]),
  prerequisite: 'existing post and account-owned lead form with explicit location, locale and schedule inputs',
});

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`).
/** The LinkedIn lead generation pack (CMP-07): the owner-finder read of this exact form. */
export function linkedinDependencyEvidence(
  id: string,
  {assets, scope, business}: DependencyEvidenceContext,
): JsonObject | undefined {
  if (id !== 'linkedin_lead_form') return undefined;
  const proof = assets.find(
    a =>
      a.asset_type === 'LinkedIn lead form' &&
      a.asset_id === business.lead_form_id &&
      a.account_id === scope.account_id &&
      a.connection_id === scope.connection_id &&
      a.status === 'provider_read_checked',
  );
  return proof ? {status: 'ready', evidence: proof, meaning: proof.meaning} : undefined;
}
