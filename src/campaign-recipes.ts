import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeMoney as money, recipeRoas} from './recipe-values.js';
import {
  snapchatTrafficRecipe,
  snapchatLeadRecipe,
  buildSnapchatTrafficRecipe,
  buildSnapchatLeadRecipe,
} from './snapchat-traffic-recipe.js';
const metaRequired = [
  'name',
  'account_id',
  'connection_id',
  'currency',
  'daily_budget',
  'country_codes',
  'page_id',
  'destination_url',
  'message',
  'headline',
  'drive_url',
  'special_ad_categories',
];
/**
 * The Meta image comes from exactly one source (CMP-06): a Google Drive link (drive_url, the listed input), an upload
 * (source_id), a public link (source_url) or an image already in the ad account (image_hash, whose ownership preflight
 * reads). Age targeting is optional and defaults to 18–65, which the plan states.
 */
const metaImageAlternatives: Record<string, string[]> = {drive_url: ['source_id', 'source_url', 'image_hash']};
const metaOptional = ['start_time', 'end_time', 'age_min', 'age_max', 'drive_connection_id'];
export const metaImageSources = ['drive_url', 'source_id', 'source_url', 'image_hash'];
/** The required inputs a brief still lacks; an input satisfied by one of its listed alternatives is not missing. */
export function recipeMissing(definition: JsonObject, b: JsonObject): string[] {
  const given = (key: string) => b[key] !== undefined && b[key] !== '';
  return definition.required.filter(
    (k: string) => !given(k) && !(definition.alternatives?.[k] ?? []).some((alternative: string) => given(alternative)),
  );
}
// Native fields/enums: Meta's official Business SDK 26.0.2. Account acceptance remains a preflight/review concern.
export const metaConversionRecipes: Record<string, {objective: string; event: string; cta: string; label: string}> = {
  meta_website_sales: {objective: 'OUTCOME_SALES', event: 'PURCHASE', cta: 'SHOP_NOW', label: 'website purchases'},
  meta_website_leads: {objective: 'OUTCOME_LEADS', event: 'LEAD', cta: 'SIGN_UP', label: 'website leads'},
};
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
export const campaignRecipes = [
  {
    id: 'meta_website_traffic',
    name: 'Meta website traffic with image',
    platform: 'meta',
    required: metaRequired,
    alternatives: metaImageAlternatives,
    optional: metaOptional,
    description:
      'Creates a paused campaign, ad set, image, Page creative and ad. Website click optimization. Every step retains its own review.',
  },
  ...Object.entries(metaConversionRecipes).map(([id, spec]) => ({
    id,
    name: 'Meta ' + spec.label + ' with image',
    platform: 'meta',
    required: [...metaRequired, 'pixel_id', 'click_attribution_days', 'view_attribution_days'],
    alternatives: metaImageAlternatives,
    optional: metaOptional,
    description:
      'Paused campaign for ' +
      spec.label +
      ', optimizing ' +
      spec.event +
      ' on the selected website pixel. Explicit click/view attribution and a separate review for every step. Pixel access does not establish event delivery or objective eligibility.',
  })),
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
  {
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
    ],
    description:
      'Paused Microsoft Search campaign, ad group, exact keywords and responsive search ad. Geography must be provided as qualified native steps or configured in Microsoft before activation.',
  },
  snapchatTrafficRecipe,
  snapchatLeadRecipe,
];
function strings(v: unknown, name: string, min = 1, max = 50): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide ' + name + ' (' + min + '–' + max + ' nonempty items).', {
      missing_fields: [name],
    });
  return v;
}
export function campaignRecipe(id: string, b: JsonObject): JsonObject {
  const definition = campaignRecipes.find(r => r.id === id);
  if (!definition) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  if (!b || typeof b !== 'object') throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide the business inputs.');
  const missing = recipeMissing(definition, b);
  if (missing.length)
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Complete the brief before creating the campaign plan.', {
      missing_fields: missing,
    });
  if (
    !/^[A-Z]{3}$/.test(b.currency) ||
    typeof b.name !== 'string' ||
    b.name.length > 100 ||
    typeof b.account_id !== 'string' ||
    typeof b.connection_id !== 'string'
  )
    throw new MirrorError('RECIPE_INPUT_INVALID', 'Use a name, explicit account/connection and ISO currency.');
  if (definition.platform === 'snapchat')
    return id === snapchatLeadRecipe.id ? buildSnapchatLeadRecipe(b) : buildSnapchatTrafficRecipe(b);
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  const steps: JsonObject[] = [],
    gateway = id.startsWith('meta')
      ? 'meta_native_action'
      : id.startsWith('google')
        ? 'google_ads_native_action'
        : 'microsoft_ads_native_action',
    ref = (step: string, path: string) => ({$ref: step + '#' + path});
  const add = (sid: string, action: string, payload: JsonObject, deps: string[] = []) =>
    steps.push({
      id: sid,
      kind: 'write',
      gateway,
      expected_currency: b.currency,
      account_id: b.account_id,
      connection_id: b.connection_id,
      arguments: {action, payload},
      depends_on: deps,
    });
  let metaAudience: JsonObject | undefined;
  const isMeta = definition.platform === 'meta',
    conversion = metaConversionRecipes[id],
    valueSearch = googleConversionRecipes[id]?.value === true,
    roas = googleConversionRecipes[id]?.targetRoas ? recipeRoas(b.target_roas) : undefined;
  if (isMeta) {
    if (
      typeof b.message !== 'string' ||
      !b.message.trim() ||
      b.message.length > 6000 ||
      typeof b.headline !== 'string' ||
      !b.headline.trim() ||
      b.headline.length > 255
    )
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Supply an ad message up to 6,000 characters and headline up to 255.',
      );
    if (conversion && (typeof b.pixel_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(b.pixel_id)))
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Use the exact website pixel ID assigned to this advertising account.',
      );
    if (
      conversion &&
      (!['string', 'number'].includes(typeof b.click_attribution_days) ||
        !['string', 'number'].includes(typeof b.view_attribution_days) ||
        !['1', '7'].includes(String(b.click_attribution_days)) ||
        !['0', '1'].includes(String(b.view_attribution_days)))
    )
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Choose one or seven click-attribution days, and zero or one view-attribution day.',
      );
    if (!Array.isArray(b.special_ad_categories) || b.special_ad_categories.some((v: unknown) => typeof v !== 'string'))
      throw new MirrorError(
        'RECIPE_INPUT_REQUIRED',
        'Explicitly declare applicable special ad categories (an empty list means none).',
      );
    if (b.special_ad_categories.length)
      throw new MirrorError(
        'RECIPE_PREREQUISITES_REQUIRED',
        'Regulated categories require a tailored native targeting plan; use explicit steps rather than this website recipe.',
      );
    if (!/^\d+$/.test(b.page_id)) throw new MirrorError('RECIPE_INPUT_INVALID', 'Use an explicit Facebook Page ID.');
    const countries = strings(b.country_codes, 'country_codes', 1, 20);
    if (countries.some(v => !/^[A-Z]{2}$/.test(v)))
      throw new MirrorError('RECIPE_INPUT_INVALID', 'Countries must be two-letter ISO codes.');
    let digits: number;
    try {
      digits = new Intl.NumberFormat('en', {style: 'currency', currency: b.currency}).resolvedOptions()
        .maximumFractionDigits!;
    } catch {
      throw new MirrorError('INVALID_RECIPE_MONEY', 'Unknown account currency.');
    }
    const budget = money(b.daily_budget, 10 ** digits, 'daily budget');
    const sources = metaImageSources.filter(k => b[k] !== undefined && b[k] !== '');
    if (sources.length !== 1)
      throw new MirrorError(
        sources.length ? 'RECIPE_INPUT_INVALID' : 'RECIPE_INPUT_REQUIRED',
        'Choose exactly one image source: a Google Drive link, an upload (source_id), a public HTTPS link (source_url) or an image already in this ad account (image_hash).',
        {image_sources: sources, ...(sources.length ? {} : {missing_fields: ['drive_url']})},
      );
    const source = sources[0]!,
      value = b[source];
    if (
      typeof value !== 'string' ||
      (source === 'source_id' && !/^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
      (source === 'image_hash' && !/^[A-Za-z0-9]{8,64}$/.test(value)) ||
      (source === 'source_url' && !/^https:\/\/\S{1,2040}$/.test(value)) ||
      (source !== 'drive_url' && b.drive_connection_id !== undefined && b.drive_connection_id !== '')
    )
      throw new MirrorError(
        'RECIPE_INPUT_INVALID',
        'Use an upload ID, an HTTPS link, a Google Drive link or an account image hash exactly as given; a Drive login applies to a Drive link only.',
        {field: source},
      );
    const age = (key: 'age_min' | 'age_max', fallback: number) => {
      const raw = b[key];
      if (raw === undefined || raw === '') return fallback;
      const n = typeof raw === 'number' ? raw : /^\d{1,2}$/.test(String(raw)) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 13 || n > 65)
        throw new MirrorError('RECIPE_INPUT_INVALID', 'Ages are whole years from 13 to 65.', {field: key});
      return n;
    };
    const ageMin = age('age_min', 18),
      ageMax = age('age_max', 65);
    if (ageMin > ageMax)
      throw new MirrorError('RECIPE_INPUT_INVALID', 'The minimum age must not exceed the maximum age.', {
        field: 'age_min',
      });
    if (source !== 'image_hash')
      steps.push({
        id: 'image',
        kind: 'media',
        expected_currency: b.currency,
        account_id: b.account_id,
        connection_id: b.connection_id,
        arguments: {
          platform: 'meta',
          [source]: value,
          name: b.name + ' image',
          ...(source === 'drive_url' && b.drive_connection_id ? {drive_connection_id: b.drive_connection_id} : {}),
        },
        depends_on: [],
      });
    metaAudience = {
      age_min: ageMin,
      age_max: ageMax,
      source: b.age_min !== undefined || b.age_max !== undefined ? 'brief' : 'recipe_default',
      image_source: source,
    };
    // The budget sits on the ad set, so from Graph API v24.0 Meta refuses the campaign without an explicit
    // is_adset_budget_sharing_enabled (error 4834011). With one ad set, false changes nothing about delivery.
    add('campaign', 'meta_campaign_create', {
      name: b.name,
      objective: conversion?.objective ?? 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: b.special_ad_categories,
      is_adset_budget_sharing_enabled: false,
    });
    add(
      'adset',
      'meta_adset_create',
      {
        name: b.name + ' · ' + (conversion?.label ?? 'traffic'),
        campaign_id: ref('campaign', '/data/id'),
        daily_budget: budget,
        billing_event: 'IMPRESSIONS',
        optimization_goal: conversion ? 'OFFSITE_CONVERSIONS' : 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        destination_type: 'WEBSITE',
        ...(conversion
          ? {
              promoted_object: {
                pixel_id: b.pixel_id,
                custom_event_type: conversion.event,
                ...(conversion.event === 'LEAD' ? {page_id: b.page_id} : {}),
              },
              attribution_spec: [
                {event_type: 'CLICK_THROUGH', window_days: Number(b.click_attribution_days)},
                ...(Number(b.view_attribution_days) === 1 ? [{event_type: 'VIEW_THROUGH', window_days: 1}] : []),
              ],
            }
          : {}),
        targeting: {geo_locations: {countries}, age_min: ageMin, age_max: ageMax},
        // Under the paused campaign, the ad set and ad start ACTIVE; enabling the campaign is the one activation.
        status: 'ACTIVE',
      },
      ['campaign'],
    );
    add(
      'creative',
      'meta_creative_create',
      {
        name: b.name + ' · creative',
        object_story_spec: {
          page_id: b.page_id,
          link_data: {
            image_hash: source === 'image_hash' ? value : ref('image', '/image_hash'),
            link: url.href,
            message: b.message,
            name: b.headline,
            call_to_action: {type: conversion?.cta ?? 'LEARN_MORE', value: {link: url.href}},
          },
        },
      },
      source === 'image_hash' ? [] : ['image'],
    );
    add(
      'ad',
      'meta_ad_create',
      {
        name: b.name + ' · ad',
        adset_id: ref('adset', '/data/id'),
        creative: {creative_id: ref('creative', '/data/id')},
        status: 'ACTIVE',
      },
      ['adset', 'creative'],
    );
  } else {
    const headlines = strings(b.headlines, 'headlines', 3, 15),
      descriptions = strings(b.descriptions, 'descriptions', 2, 4),
      keywords = strings(b.keywords, 'keywords', 1, 25);
    if (
      headlines.some(h => h.length > 30) ||
      descriptions.some(d => d.length > 90) ||
      keywords.some(k => k.length > 80)
    )
      throw new MirrorError(
        'AD_TEXT_LIMIT',
        'Use headlines of at most 30 characters, descriptions of at most 90, and keywords of at most 80.',
      );
    if (definition.platform === 'google') {
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
      const amount = money(b.daily_budget, 1e6, 'daily budget'),
        bid = conversionSearch
          ? conversionSearch.targetCpa
            ? money(b.target_cpa, 1e6, 'target CPA')
            : undefined
          : money(clicks ? b.cpc_bid_ceiling : b.cpc_bid, 1e6, clicks ? 'campaign CPC ceiling' : 'CPC bid'),
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
    } else {
      money(b.daily_budget, 1e6, 'daily budget');
      money(b.cpc_bid, 1e6, 'CPC bid');
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
      for (const step of steps.slice(2)) step.arguments.campaign_id = ref('campaign', '/data/CampaignIds/0');
      for (const step of steps.slice(2)) step.depends_on.push('campaign');
    }
  }
  // The maximum recipe permits 30 geo/language criteria. Keep every supplied criterion
  // while respecting the reviewed contract's 25-operation limit per request.
  if (definition.platform === 'google')
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
  // Date-only search schedules use the account timezone; Meta requires an explicit offset.
  if (isMeta) {
    for (const k of ['start_time', 'end_time'])
      if (b[k] !== undefined) {
        if (
          typeof b[k] !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(b[k]) ||
          !Number.isFinite(Date.parse(b[k])) ||
          new Date(b[k].slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== b[k].slice(0, 10)
        )
          throw new MirrorError(
            'RECIPE_DATE_INVALID',
            'Meta schedule timestamps require a valid ISO time and explicit UTC offset.',
          );
        steps.find(s => s.id === 'adset')!.arguments.payload[k] = b[k];
      }
    if (b.start_time && b.end_time && Date.parse(b.end_time) <= Date.parse(b.start_time))
      throw new MirrorError('RECIPE_DATE_INVALID', 'End time must follow start time.');
  } else {
    for (const k of ['start_date', 'end_date'])
      if (b[k] !== undefined) {
        if (
          typeof b[k] !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(b[k]) ||
          !Number.isFinite(Date.parse(b[k] + 'T00:00:00Z')) ||
          new Date(b[k] + 'T00:00:00Z').toISOString().slice(0, 10) !== b[k]
        )
          throw new MirrorError(
            'RECIPE_DATE_INVALID',
            'Use valid YYYY-MM-DD dates in the advertising account timezone.',
          );
        if (definition.platform === 'google')
          steps.find(s => s.id === 'campaign')!.arguments.payload.operations[0].create[k + '_time'] =
            b[k] + (k === 'start_date' ? ' 00:00:00' : ' 23:59:59');
        else {
          const [Year, Month, Day] = b[k].split('-').map(Number);
          steps.find(s => s.id === 'adgroup')!.arguments.payload.AdGroups[0][
            k === 'start_date' ? 'StartDate' : 'EndDate'
          ] = {Year, Month, Day};
        }
      }
    if (b.start_date && b.end_date && b.end_date < b.start_date)
      throw new MirrorError('RECIPE_DATE_INVALID', 'End date must be on or after start date.');
  }
  return {
    action: 'create',
    name: b.name,
    brief:
      definition.name +
      ' in ' +
      b.currency +
      '. The campaign starts paused. ' +
      (googleConversionRecipes[id]
        ? 'Uses account-default conversion goals; goal settings and event delivery remain unverified and are not changed by this plan. '
        : '') +
      (valueSearch ? 'Recorded conversion values were explicitly selected without editing their settings. ' : '') +
      'Confirm destination, identity, policy eligibility and native prerequisites during whole-plan preflight; activation is a separate reviewed change.',
    steps,
    recipe: {
      id,
      platform: definition.platform,
      currency: b.currency,
      schedule_inputs: isMeta ? ['start_time', 'end_time'] : ['start_date', 'end_date'],
      ...(metaAudience ? {audience: metaAudience} : {}),
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
            cpc_bid_ceiling_micros: money(b.cpc_bid_ceiling, 1e6, 'campaign CPC ceiling'),
            bidding_effect:
              'Maximize Clicks uses the campaign budget and CPC ceiling to seek clicks. It does not optimize conversions or guarantee results. Review provider eligibility before activation.',
          }
        : {}),
      ...(isMeta
        ? {
            budget_level: 'ADSET',
            is_adset_budget_sharing_enabled: false,
            budget_sharing:
              'The daily budget is set on the one ad set and is not shared: Meta requires this explicit choice from Graph API v24.0 when budgets are set on ad sets.',
          }
        : {}),
      ...(conversion
        ? {
            conversion_event: conversion.event,
            pixel_id: b.pixel_id,
            measurement_acceptance:
              'Pixel access is checked during preflight; actual event delivery and provider objective acceptance remain unverified.',
          }
        : {}),
      geo_warning:
        id === 'microsoft_search'
          ? 'Set geographical targeting in Microsoft before activation; this recipe does not create location criteria.'
          : null,
    },
  };
}
