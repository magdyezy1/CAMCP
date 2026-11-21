/**
 * Microsoft Advertising's guided Search recipe (ARC-04: one of campaignRecipe's per-recipe builders, declared by
 * Microsoft's adapter hooks): a paused Search campaign targeting the brief's Microsoft location IDs (CMP-03).
 */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeMoney as money} from './recipe-values.js';
import type {RecipeContextFacts} from './provider-adapter.js';
import {microsoftLocationLookupStatus} from './microsoft-location-pin.js';
import {
  assertRecipeAtomic,
  recipeDates,
  recipeDestination,
  recipePlan,
  recipeSearchText,
  recipeSteps,
  recipeStrings as strings,
} from './recipe-steps.js';
/** The Microsoft Search recipe the catalog lists after Google's. */
export const microsoftSearchRecipe = {
  id: 'microsoft_search',
  name: 'Microsoft Search campaign',
  platform: 'microsoft',
  required: [
    'name',
    'account_id',
    'connection_id',
    'currency',
    'daily_budget',
    'keywords',
    'headlines',
    'descriptions',
    'destination_url',
    'cpc_bid',
    'language',
    'location_ids',
  ],
  // AMCP-08: this recipe declares no fixed set of values. Whether Microsoft's `language` is a closed set is UNVERIFIED, so the recipe
  // says nothing of it rather than list values it has not read.
  inputs: {},
  // Owner decision P7 (CMP-03): the pack targets the Microsoft location IDs of the brief with positive location
  // criteria on the paused campaign; activation stays separate and is refused without a positive location criterion.
  description:
    'Paused Microsoft Search campaign targeting the Microsoft location IDs you enter, with an ad group, exact keywords and a responsive search ad. Activation is a separate plan, refused without a positive location criterion.',
};
/** The plan of the Microsoft Search recipe, from a brief that passed the catalog's shared checks. */
export function buildMicrosoftSearchRecipe(b: JsonObject): JsonObject {
  const definition = microsoftSearchRecipe,
    id = definition.id;
  assertRecipeAtomic(definition, b);
  const url = recipeDestination(b),
    {steps, ref, add} = recipeSteps(b, 'microsoft_ads_native_action');
  const {headlines, descriptions, keywords} = recipeSearchText(b);
  money(b.daily_budget, 1e6, 'daily budget');
  money(b.cpc_bid, 1e6, 'CPC bid');
  // Microsoft location IDs come from its geographical locations file; each becomes one positive location criterion.
  const locations = strings(b.location_ids, 'location_ids', 1, 100);
  if (
    locations.some(id => !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) ||
    new Set(locations).size !== locations.length
  )
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Use 1–100 different numeric Microsoft location IDs.', {
      field: 'location_ids',
    });
  add('campaign', 'AddCampaigns', {
    AccountId: b.account_id,
    Campaigns: [
      {
        Name: b.name,
        CampaignType: 'Search',
        Status: 'Paused',
        BudgetType: 'DailyBudgetStandard',
        DailyBudget: Number(b.daily_budget),
      },
    ],
  });
  // The campaign's geography, set while it is paused (CMP-03): Microsoft's default location intent applies.
  add(
    'targets',
    'AddCampaignCriterions',
    {
      CriterionType: 'Targets',
      CampaignCriterions: locations.map(LocationId => ({
        Type: 'BiddableCampaignCriterion',
        CampaignId: ref('campaign', '/data/CampaignIds/0'),
        Criterion: {Type: 'LocationCriterion', LocationId},
      })),
    },
    ['campaign'],
  );
  add(
    'adgroup',
    'AddAdGroups',
    {
      CampaignId: ref('campaign', '/data/CampaignIds/0'),
      AdGroups: [
        {Name: b.name + ' · search', Status: 'Paused', Language: b.language, CpcBid: {Amount: Number(b.cpc_bid)}},
      ],
    },
    ['campaign'],
  );
  add(
    'keywords',
    'AddKeywords',
    {
      AdGroupId: ref('adgroup', '/data/AdGroupIds/0'),
      Keywords: keywords.map(Text => ({
        Text,
        MatchType: 'Exact',
        Status: 'Paused',
        Bid: {Amount: Number(b.cpc_bid)},
      })),
    },
    ['adgroup'],
  );
  add(
    'ad',
    'AddAds',
    {
      AdGroupId: ref('adgroup', '/data/AdGroupIds/0'),
      Ads: [
        {
          Type: 'ResponsiveSearch',
          Status: 'Paused',
          Headlines: headlines.map(Text => ({Asset: {Type: 'TextAsset', Text}})),
          Descriptions: descriptions.map(Text => ({Asset: {Type: 'TextAsset', Text}})),
          FinalUrls: [url.href],
        },
      ],
    },
    ['adgroup'],
  );
  for (const step of steps.filter(s => ['keywords', 'ad'].includes(s.id))) {
    step.arguments.campaign_id = ref('campaign', '/data/CampaignIds/0');
    step.depends_on.push('campaign');
  }
  // Date-only search schedules use the account timezone.
  recipeDates(b, k => {
    const [Year, Month, Day] = b[k].split('-').map(Number);
    steps.find(s => s.id === 'adgroup')!.arguments.payload.AdGroups[0][k === 'start_date' ? 'StartDate' : 'EndDate'] = {
      Year,
      Month,
      Day,
    };
  });
  return recipePlan(definition, b, steps, '', {
    id,
    platform: definition.platform,
    currency: b.currency,
    schedule_inputs: ['start_date', 'end_date'],
    geo_warning: null,
    location_ids: b.location_ids,
    location_targeting:
      'Positive location criteria on the paused campaign, each read back by ID. Activation preflight lists each location with the name Microsoft gives it. Microsoft’s default location intent applies: people in, searching for or viewing pages about these locations.',
    activation:
      'Activation is a separate plan. AMCP refuses to activate this campaign without a positive location criterion (owner decision P7).',
  });
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of the recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
export const microsoftSearchContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'Enter Microsoft location IDs of Active locations from its geographical locations file, one per line: each becomes a positive location criterion of the paused campaign, read back by ID, and activation preflight lists each location with the name Microsoft gives it. Microsoft’s default location intent applies (people in, searching for or viewing pages about these locations). Activation is a separate plan, refused without a positive location criterion.',
  ]),
  // CMP-03: whether recipe_lookup can search Microsoft's geographical locations file in this deployment.
  extra: () => ({location_lookup: microsoftLocationLookupStatus()}),
});
