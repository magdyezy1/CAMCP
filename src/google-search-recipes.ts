/**
 * Google's guided Search recipes (ARC-04: campaignRecipe's per-recipe builders, declared by Google Ads' adapter hooks):
 * a paused Search campaign with manual CPC, Maximize Clicks, Maximize Conversions (with an optional target CPA) or
 * Maximize Conversion Value (with an optional target ROAS), built in one all-or-nothing step unless the brief asks for
 * one step per resource (CMP-04).
 */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {
  recipeMoney as money,
  recipeRoas,
  recipeCurrencyMicros as currencyMicros,
  recipeChoices,
  recipeDateInput,
  recipeEnum,
} from './recipe-values.js';
import {composeGoogleBuild} from './google-atomic-builds.js';
import type {
  DependencyEvidenceContext,
  RecipeContextFacts,
  RecipeInputSpec,
  RecipeLookupContext,
} from './provider-adapter.js';
import {
  assertRecipeAtomic,
  recipeDates,
  recipeDestination,
  recipePlan,
  recipeSearchText,
  recipeSteps,
  recipeStrings as strings,
} from './recipe-steps.js';
/**
 * The closed sets Google's guided recipes share (AMCP-08, R2.5 field3 package r25-field3-recipes), declared once so that the Search recipes
 * and the Performance Max recipe (src/google-pmax-recipe.ts) offer, and read, the same values: each recipe lists them in the `inputs` of
 * its definition, and its builder judges the brief by that very declaration (src/recipe-values.ts recipeEnum).
 */
const euPolitical = ['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'] as const;
/**
 * The Google EU political advertising declaration of a campaign (pinned v25 Campaign.contains_eu_political_advertising). It is the person's
 * own statement and is never defaulted: a recipe left without it is refused. Its two answers are also the boolean `true` and the boolean
 * `false`, each the one value its name says, because "false" for "does this contain EU political advertising" is the plain answer (the
 * owner's session of 2026-11-21 read it as missing).
 */
export const googleEuDeclaration: RecipeInputSpec = recipeChoices(euPolitical, {
  accepts_boolean: Object.freeze({true: euPolitical[0], false: euPolitical[1]}),
  declaration: true,
});
/** The one conversion goal policy a guided Google recipe takes: the account's own default goals, chosen explicitly and never changed. */
export const googleConversionGoalPolicy: RecipeInputSpec = recipeChoices(['ACCOUNT_DEFAULT'], {declaration: true});
/** The one conversion value policy of the value-bidding Search recipes: the values the account records, chosen explicitly and never changed. */
export const googleConversionValuePolicy: RecipeInputSpec = recipeChoices(['ACCOUNT_RECORDED_VALUES'], {
  declaration: true,
});
// Standard campaign bidding, pinned Google v25 MaximizeConversions: target CPA is optional; CPC limits are
// portfolio-only. Account-default goals are an explicit business choice, not verified measurement or a goal edit.
export const googleConversionRecipes: Record<
  string,
  {name: string; targetCpa: boolean; value?: boolean; targetRoas?: boolean}
> = {
  google_search_conversions: {name: 'Google Search with Maximize Conversions', targetCpa: false},
  google_search_target_cpa: {name: 'Google Search with a target CPA', targetCpa: true},
  google_search_conversion_value: {name: 'Google Search with Maximize Conversion Value', targetCpa: false, value: true},
  google_search_target_roas: {
    name: 'Google Search with a target ROAS',
    targetCpa: false,
    value: true,
    targetRoas: true,
  },
};
/** The Google Search recipes the catalog lists after Meta's. */
export const googleSearchRecipes = [
  ...['google_search', 'google_search_clicks', ...Object.keys(googleConversionRecipes)].map(id => ({
    id,
    name:
      googleConversionRecipes[id]?.name ??
      (id === 'google_search' ? 'Google Search campaign' : 'Google Search with Maximize Clicks'),
    platform: 'google',
    required: [
      'name',
      'account_id',
      'connection_id',
      'currency',
      'daily_budget',
      'country_criterion_ids',
      'language_criterion_ids',
      'keywords',
      'headlines',
      'descriptions',
      'destination_url',
      ...(googleConversionRecipes[id]
        ? [
            'conversion_goal_policy',
            ...(googleConversionRecipes[id].targetCpa ? ['target_cpa'] : []),
            ...(googleConversionRecipes[id].value ? ['conversion_value_policy'] : []),
            ...(googleConversionRecipes[id].targetRoas ? ['target_roas'] : []),
          ]
        : [id === 'google_search' ? 'cpc_bid' : 'cpc_bid_ceiling']),
      'contains_eu_political_advertising',
    ],
    // The schedule is optional: days of the advertising account's own time zone (the lead's review S3-4).
    optional: ['start_date', 'end_date'],
    // The values these inputs accept (AMCP-08): `recipes` and `recipe_context` say them, and the builder reads the brief by them.
    inputs: {
      ...(googleConversionRecipes[id] ? {conversion_goal_policy: googleConversionGoalPolicy} : {}),
      ...(googleConversionRecipes[id]?.value ? {conversion_value_policy: googleConversionValuePolicy} : {}),
      contains_eu_political_advertising: googleEuDeclaration,
      start_date: recipeDateInput,
      end_date: recipeDateInput,
    } as Readonly<Record<string, RecipeInputSpec>>,
    description: googleConversionRecipes[id]?.value
      ? 'Paused Search campaign using recorded conversion values and explicitly chosen account-default goals. An optional target ROAS is a conversion-value-to-spend ratio. Value delivery, historical eligibility and provider acceptance require separate verification; no conversion settings are changed. Activation is separate.'
      : googleConversionRecipes[id]
        ? 'Paused Search campaign using Maximize Conversions with explicitly chosen account-default conversion goals' +
          (googleConversionRecipes[id].targetCpa ? ' and an exact target CPA. ' : ' and no CPA target. ') +
          'Uses a dedicated daily budget and exact keywords. Goal settings, event delivery and provider eligibility require separate verification; no goal settings are changed. Activation is separate.'
        : id === 'google_search'
          ? 'Paused Search campaign, budget, exact keywords, location/language criteria and a responsive search ad. Search network only.'
          : 'Paused Search campaign using Maximize Clicks with an explicit campaign CPC ceiling, dedicated budget, exact keywords and location/language targeting. Optimizes clicks, not conversions. Activation is separate.',
  })),
];
/** The plan of a Google Search recipe, from a brief that passed the catalog's shared checks. */
export function buildGoogleSearchRecipe(id: string, b: JsonObject): JsonObject {
  const definition = googleSearchRecipes.find(r => r.id === id)!;
  assertRecipeAtomic(definition, b);
  // A Google Search recipe is one googleAds:mutate build unless the brief asks for one step per resource (CMP-04).
  const atomic = definition.platform === 'google' && b.atomic !== false;
  const url = recipeDestination(b),
    {steps, ref, add} = recipeSteps(b, 'google_ads_native_action');
  const valueSearch = googleConversionRecipes[id]?.value === true,
    roas = googleConversionRecipes[id]?.targetRoas ? recipeRoas(b.target_roas) : undefined;
  const {headlines, descriptions, keywords} = recipeSearchText(b);
  // The EU declaration, the goal policy and the value policy are the person's own explicit choices: read by their declared values, never
  // defaulted (AMCP-08). An answer left out is required; a value of another type or outside the set is invalid, never "missing".
  const euDeclaration = recipeEnum(
    b,
    'contains_eu_political_advertising',
    definition.inputs.contains_eu_political_advertising!,
  ) as string;
  const clicks = id === 'google_search_clicks',
    conversionSearch = googleConversionRecipes[id];
  let goalPolicy: string | undefined, valuePolicy: string | undefined;
  if (conversionSearch) {
    goalPolicy = recipeEnum(b, 'conversion_goal_policy', definition.inputs.conversion_goal_policy!) as string;
    if (conversionSearch.targetCpa && typeof b.target_cpa !== 'string')
      throw new MirrorError(
        'INVALID_RECIPE_MONEY',
        'Provide the target CPA as exact positive decimal text in account currency.',
      );
    if (valueSearch)
      valuePolicy = recipeEnum(b, 'conversion_value_policy', definition.inputs.conversion_value_policy!) as string;
    const forbidden = [
      'cpc_bid',
      'cpc_bid_ceiling',
      'bidding_strategy',
      'manual_cpc',
      'target_spend',
      'maximize_conversions',
      'maximize_conversion_value',
      'conversion_actions',
      'custom_conversion_goal',
      'campaign_conversion_goals',
      'targetCpa',
      'targetCpaMicros',
      'cpcBid',
      'cpcBidCeiling',
      'targetRoas',
      'biddingStrategy',
      'manualCpc',
      'targetSpend',
      'maximizeConversions',
      'maximizeConversionValue',
      'conversionActions',
      'customConversionGoal',
      'campaignConversionGoals',
      ...(!conversionSearch.targetCpa ? ['target_cpa'] : []),
      ...(!conversionSearch.targetRoas ? ['target_roas'] : []),
      ...(!valueSearch ? ['conversion_value_policy'] : []),
      'conversionValuePolicy',
      'cpc_bid_floor',
      'cpc_bid_floor_micros',
      'cpc_bid_ceiling_micros',
      'target_roas_tolerance_percent_millis',
      'cpcBidFloor',
      'cpcBidFloorMicros',
      'cpcBidCeilingMicros',
      'targetRoasTolerancePercentMillis',
    ];
    if (forbidden.some(key => b[key] !== undefined))
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Choose the matching conversion workflow and its declared bidding inputs only. CPC limits, portfolio strategies and campaign-specific conversion goals require a separate qualified native plan.',
      );
  }
  if (clicks && typeof b.cpc_bid_ceiling !== 'string')
    throw new MirrorError(
      'INVALID_RECIPE_MONEY',
      'Provide the campaign CPC ceiling as exact decimal text in account currency.',
    );
  if (
    clicks &&
    [
      'cpc_bid',
      'target_cpa',
      'target_roas',
      'bidding_strategy',
      'manual_cpc',
      'target_spend',
      'maximize_conversions',
      'maximize_conversion_value',
    ].some(key => b[key] !== undefined)
  )
    throw new MirrorError(
      'RECIPE_INPUT_INVALID',
      'This workflow uses Maximize Clicks and cpc_bid_ceiling only; choose a separate workflow for another bidding strategy.',
    );
  // Budgets and CPC bids in the currency's own precision (WRT-07): Google refuses 500.5 JPY.
  const amount = currencyMicros(b.daily_budget, b.currency, 'daily budget'),
    bid = conversionSearch
      ? conversionSearch.targetCpa
        ? money(b.target_cpa, 1e6, 'target CPA')
        : undefined
      : currencyMicros(clicks ? b.cpc_bid_ceiling : b.cpc_bid, b.currency, clicks ? 'campaign CPC ceiling' : 'CPC bid'),
    response = '/data/results/0/resourceName';
  add('budget', 'google_ads_v23_campaign_budget_mutate_campaign_budgets', {
    operations: [
      {
        create: {
          name: b.name + ' budget',
          amount_micros: amount,
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    ],
  });
  add(
    'campaign',
    'google_ads_v23_campaign_mutate_campaigns',
    {
      operations: [
        {
          create: {
            name: b.name,
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: ref('budget', response),
            ...(conversionSearch
              ? valueSearch
                ? {maximize_conversion_value: roas ? {target_roas: roas.native} : {}}
                : {maximize_conversions: conversionSearch.targetCpa ? {target_cpa_micros: bid} : {}}
              : clicks
                ? {target_spend: {cpc_bid_ceiling_micros: bid}}
                : {manual_cpc: {}}),
            network_settings: {
              target_google_search: true,
              target_search_network: false,
              target_content_network: false,
              target_partner_search_network: false,
            },
            contains_eu_political_advertising: euDeclaration,
          },
        },
      ],
    },
    ['budget'],
  );
  const locations = strings(b.country_criterion_ids, 'country_criterion_ids', 1, 20),
    languages = strings(b.language_criterion_ids, 'language_criterion_ids', 1, 10);
  if ([...locations, ...languages].some(id => !/^\d+$/.test(id)))
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Use native numeric Google geo/language criterion IDs.');
  add(
    'targeting',
    'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
    {
      operations: [
        ...locations.map(id => ({
          create: {
            campaign: ref('campaign', response),
            location: {geo_target_constant: 'geoTargetConstants/' + id},
          },
        })),
        ...languages.map(id => ({
          create: {campaign: ref('campaign', response), language: {language_constant: 'languageConstants/' + id}},
        })),
      ],
    },
    ['campaign'],
  );
  add(
    'adgroup',
    'google_ads_v23_ad_group_mutate_ad_groups',
    {
      operations: [
        {
          create: {
            name: b.name + ' · search',
            campaign: ref('campaign', response),
            status: 'ENABLED',
            type: 'SEARCH_STANDARD',
            ...(!clicks && !conversionSearch ? {cpc_bid_micros: bid} : {}),
          },
        },
      ],
    },
    ['campaign'],
  );
  add(
    'keywords',
    'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    {
      // The campaign alone starts PAUSED; its ad group, keywords and ad start ENABLED under it, so enabling the
      // campaign is the one reviewed activation and no second pass is needed (the owner's item 6).
      operations: keywords.map(text => ({
        create: {ad_group: ref('adgroup', response), status: 'ENABLED', keyword: {text, match_type: 'EXACT'}},
      })),
    },
    ['adgroup'],
  );
  add(
    'ad',
    'google_ads_v23_ad_group_ad_mutate_ad_group_ads',
    {
      operations: [
        {
          create: {
            ad_group: ref('adgroup', response),
            status: 'ENABLED',
            ad: {
              responsive_search_ad: {
                headlines: headlines.map(text => ({text})),
                descriptions: descriptions.map(text => ({text})),
              },
              final_urls: [url.href],
            },
          },
        },
      ],
    },
    ['adgroup'],
  );
  // The maximum recipe permits 30 geo/language criteria. Keep every supplied criterion
  // while respecting the reviewed contract's 25-operation limit per request (a build holds up to 1,000).
  if (!atomic)
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!,
        ops = s.arguments.payload?.operations;
      if (Array.isArray(ops) && ops.length > 25) {
        const chunks: JsonObject[] = [];
        for (let at = 0; at < ops.length; at += 25)
          chunks.push({
            ...s,
            id: at === 0 ? s.id : s.id + '-' + (at / 25 + 1),
            arguments: {...s.arguments, payload: {...s.arguments.payload, operations: ops.slice(at, at + 25)}},
          });
        steps.splice(i, 1, ...chunks);
        i += chunks.length - 1;
      }
    }
  // Date-only search schedules use the account timezone.
  recipeDates(b, k => {
    steps.find(s => s.id === 'campaign')!.arguments.payload.operations[0].create[k + '_time'] =
      b[k] + (k === 'start_date' ? ' 00:00:00' : ' 23:59:59');
  });
  // Every resource of the Search campaign in one request: Google creates all of them or none, so a refused child
  // never leaves an orphan paused parent. Each operation is still checked as its own service would check it.
  const composed = atomic ? steps.map(s => s.id as string) : undefined;
  if (composed)
    steps.splice(0, steps.length, {
      ...composeGoogleBuild(steps, String(b.account_id).replace(/-/g, '')),
      expected_currency: b.currency,
    });
  return recipePlan(
    definition,
    b,
    steps,
    (googleConversionRecipes[id]
      ? 'Uses account-default conversion goals; goal settings and event delivery remain unverified and are not changed by this plan. '
      : '') +
      (valueSearch ? 'Recorded conversion values were explicitly selected without editing their settings. ' : ''),
    {
      id,
      platform: definition.platform,
      currency: b.currency,
      schedule_inputs: ['start_date', 'end_date'],
      atomic,
      ...(composed ? {build: {all_or_nothing: true, steps: composed}} : {}),
      ...(googleConversionRecipes[id]
        ? {
            bidding_strategy: valueSearch ? 'MAXIMIZE_CONVERSION_VALUE' : 'MAXIMIZE_CONVERSIONS',
            conversion_goal_policy: goalPolicy,
            ...(valueSearch ? {conversion_value_policy: valuePolicy} : {}),
            ...(roas ? {target_roas: roas.text} : {}),
            ...(googleConversionRecipes[id].targetCpa
              ? {target_cpa_micros: money(b.target_cpa, 1e6, 'target CPA')}
              : {}),
            bidding_effect: valueSearch
              ? 'Maximize Conversion Value uses the daily budget to seek recorded conversion value. A target ROAS is an average value-to-spend ratio, not a minimum guaranteed return or spending cap. Activation is separate.'
              : 'Maximize Conversions uses the daily budget to seek conversions. A target CPA is an average optimization target, not a per-conversion spending cap or guaranteed result. Activation is separate.',
            measurement_acceptance: valueSearch
              ? 'The plan leaves conversion goals and values unchanged. Current primary goals, delivered values, conversion history and provider objective acceptance require separate verification before activation.'
              : 'The plan leaves account-default conversion goals unchanged. Current goal settings, primary actions, event delivery and provider objective acceptance remain unverified before activation.',
          }
        : {}),
      ...(id === 'google_search_clicks'
        ? {
            bidding_strategy: 'TARGET_SPEND',
            cpc_bid_ceiling_micros: currencyMicros(b.cpc_bid_ceiling, b.currency, 'campaign CPC ceiling'),
            bidding_effect:
              'Maximize Clicks uses the campaign budget and CPC ceiling to seek clicks. It does not optimize conversions or guarantee results. Review provider eligibility before activation.',
          }
        : {}),
      geo_warning: null,
    },
  );
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of each Search recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
const googleValueContext: RecipeContextFacts = Object.freeze({
    limitations: Object.freeze([
      'Uses recorded conversion values and account-default goals without editing either. Inspect current primary-action value defaults and reported activity dates, then verify delivered values, conversion history and provider eligibility before activation. A target ROAS is an average ratio, not guaranteed return or a spending cap.',
    ]),
  }),
  googleConversionContext: RecipeContextFacts = Object.freeze({
    limitations: Object.freeze([
      'Uses account-default conversion goals without changing them. Verify current biddable goals, primary conversion actions, event delivery and provider eligibility before activation. A target CPA is an average optimization target, not a spending cap or guarantee.',
    ]),
  });
/** A Search recipe's context: a value recipe's, a conversion recipe's, or none (Search with CPC or Maximize Clicks). */
export function googleSearchRecipeContext(id: string): RecipeContextFacts | undefined {
  return googleConversionRecipes[id]?.value
    ? googleValueContext
    : googleConversionRecipes[id]
      ? googleConversionContext
      : undefined;
}

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`).
/** A Google Search recipe's explicit bidding settings, as the brief compiled them. */
export function googleSearchDependencyEvidence(
  id: string,
  {business, recipe}: DependencyEvidenceContext,
): JsonObject | undefined {
  if (id === 'campaign_cpc_ceiling')
    return {
      status: 'ready',
      evidence: {kind: 'compiled_explicit_setting', ceiling: business.cpc_bid_ceiling},
      meaning: 'The explicit ceiling passed exact native-unit compilation. Provider acceptance occurs during review.',
    };
  if (id === 'conversion_value_policy')
    return {
      status: 'ready',
      evidence: {kind: 'compiled_explicit_setting', policy: recipe.conversion_value_policy},
      meaning:
        'The operator explicitly chose recorded account values. This does not establish configured or delivered conversion values.',
    };
  if (id === 'campaign_target_roas')
    return {
      status: 'ready',
      evidence: {kind: 'compiled_explicit_setting', ratio: recipe.target_roas},
      meaning:
        'The explicit ratio passed local validation. Provider acceptance, historical eligibility and actual return remain unverified.',
    };
  if (id === 'campaign_target_cpa')
    return {
      status: 'ready',
      evidence: {kind: 'compiled_explicit_setting', target_cpa_micros: recipe.target_cpa_micros},
      meaning:
        'The explicit target CPA passed exact native-unit compilation. It is an average optimization target; provider acceptance and performance remain unverified.',
    };
  return undefined;
}

// Writes and campaigns (wave 4c): moved verbatim from CampaignRunner.recipeLookup (src/campaign-runner.ts), after the
// runner's query and kind checks.
/** recipe_lookup's Google country and language constants, read through the selected Google Ads login. */
export async function googleRecipeLookup({store, call, actor, input, query}: RecipeLookupContext): Promise<JsonObject> {
  store.resolveConnection(actor, 'google_ads_native_action', input.account_id, input.connection_id);
  const country = input.lookup_kind === 'country',
    gaql = country
      ? "SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND " +
        (query.length === 2
          ? "geo_target_constant.country_code = '" + query.toUpperCase() + "'"
          : "geo_target_constant.name LIKE '%" + query + "%'") +
        ' LIMIT 100'
      : 'SELECT language_constant.id, language_constant.name, language_constant.code FROM language_constant LIMIT 1000';
  const out = await call(
    'google_ads_native_action',
    {
      action: 'google_ads_v23_google_ads_search',
      connection_id: input.connection_id,
      account_id: input.account_id,
      payload: {query: gaql},
    },
    actor,
  );
  if (!out.success) throw new MirrorError(out.error.code, out.error.message, out.error.details);
  if (out.data.truncated) throw new MirrorError('INCOMPLETE_LOOKUP', 'This lookup is incomplete. Narrow the search.');
  // A lookup that matches nothing is a successful answer without `results`: Google's REST API omits the field when a search has no
  // rows (the owner's field report of 2026-11-21, package r25-field2-google, G4). That is an empty list. A body that is not an object,
  // or a `results` that is present and not a list, is still an invalid answer.
  const answer = out.data.data;
  if (
    !answer ||
    typeof answer !== 'object' ||
    Array.isArray(answer) ||
    (answer.results !== undefined && !Array.isArray(answer.results))
  )
    throw new MirrorError('UPSTREAM_RESPONSE_INVALID', 'Google did not return targeting constants.');
  const rows: JsonObject[] = answer.results ?? [];
  return {
    kind: input.lookup_kind,
    results: rows
      .map((r: JsonObject) => (country ? r.geoTargetConstant : r.languageConstant))
      .filter(
        (r: JsonObject) =>
          r &&
          typeof r.id === 'string' &&
          (country ||
            String(r.name ?? '')
              .toLowerCase()
              .includes(query.toLowerCase()) ||
            String(r.code ?? '').toLowerCase() === query.toLowerCase()),
      )
      .slice(0, 50)
      .map((r: JsonObject) => ({id: r.id, name: r.name, code: r.code ?? r.countryCode})),
    provider_mutations: 0,
  };
}
