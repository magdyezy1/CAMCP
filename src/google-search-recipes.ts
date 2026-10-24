/**
 * Google's guided Search recipes (ARC-04: campaignRecipe's per-recipe builders, declared by Google Ads' adapter hooks):
 * a paused Search campaign with manual CPC, Maximize Clicks, Maximize Conversions (with an optional target CPA) or
 * Maximize Conversion Value (with an optional target ROAS), built in one all-or-nothing step unless the brief asks for
 * one step per resource (CMP-04).
 */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeMoney as money, recipeRoas, recipeCurrencyMicros as currencyMicros} from './recipe-values.js';
import {composeGoogleBuild} from './google-atomic-builds.js';
import {
  assertRecipeAtomic,
  recipeDates,
  recipeDestination,
  recipePlan,
  recipeSearchText,
  recipeSteps,
  recipeStrings as strings,
} from './recipe-steps.js';
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
  if (
    !['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'].includes(
      b.contains_eu_political_advertising,
    )
  )
    throw new MirrorError(
      'RECIPE_INPUT_REQUIRED',
      'Explicitly confirm the Google EU political advertising declaration.',
    );
  const clicks = id === 'google_search_clicks',
    conversionSearch = googleConversionRecipes[id];
  if (conversionSearch) {
    if (b.conversion_goal_policy !== 'ACCOUNT_DEFAULT')
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Explicitly choose ACCOUNT_DEFAULT conversion goals. This workflow does not configure campaign-specific or custom conversion goals.',
      );
    if (conversionSearch.targetCpa && typeof b.target_cpa !== 'string')
      throw new MirrorError(
        'INVALID_RECIPE_MONEY',
        'Provide the target CPA as exact positive decimal text in account currency.',
      );
    if (valueSearch && b.conversion_value_policy !== 'ACCOUNT_RECORDED_VALUES')
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Explicitly choose ACCOUNT_RECORDED_VALUES. This workflow uses recorded conversion values without changing their configuration.',
      );
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
            contains_eu_political_advertising: b.contains_eu_political_advertising,
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
            conversion_goal_policy: 'ACCOUNT_DEFAULT',
            ...(valueSearch ? {conversion_value_policy: 'ACCOUNT_RECORDED_VALUES'} : {}),
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
