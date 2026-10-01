import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
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
// Native fields/enums: Meta's official Business SDK 26.0.2. Account acceptance remains a preflight/review concern.
export const metaConversionRecipes: Record<string, {objective: string; event: string; cta: string; label: string}> = {
  meta_website_sales: {objective: 'OUTCOME_SALES', event: 'PURCHASE', cta: 'SHOP_NOW', label: 'website purchases'},
  meta_website_leads: {objective: 'OUTCOME_LEADS', event: 'LEAD', cta: 'SIGN_UP', label: 'website leads'},
};
export const campaignRecipes = [
  {
    id: 'meta_website_traffic',
    name: 'Meta website traffic with image',
    platform: 'meta',
    required: metaRequired,
    description:
      'Creates a paused campaign, ad set, image, Page creative and ad. Website click optimization. Every step retains its own review.',
  },
  ...Object.entries(metaConversionRecipes).map(([id, spec]) => ({
    id,
    name: 'Meta ' + spec.label + ' with image',
    platform: 'meta',
    required: [...metaRequired, 'pixel_id', 'click_attribution_days', 'view_attribution_days'],
    description:
      'Paused campaign for ' +
      spec.label +
      ', optimizing ' +
      spec.event +
      ' on the selected website pixel. Explicit click/view attribution and a separate review for every step. Pixel access does not establish event delivery or objective eligibility.',
  })),
  {
    id: 'google_search',
    name: 'Google Search campaign',
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
      'cpc_bid',
      'contains_eu_political_advertising',
    ],
    description:
      'Paused Search campaign, budget, exact keywords, location/language criteria and a responsive search ad. Search network only.',
  },
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
];
function strings(v: unknown, name: string, min = 1, max = 50): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide ' + name + ' (' + min + '–' + max + ' nonempty items).', {
      missing_fields: [name],
    });
  return v;
}
function money(v: unknown, scale: number, name: string) {
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d+(\.\d{1,6})?$/.test(String(v)) || Number(v) <= 0)
    throw new MirrorError('INVALID_RECIPE_MONEY', 'Use a positive decimal ' + name + ' in account currency.');
  const [whole, fraction = ''] = String(v).split('.'),
    digits = String(scale).length - 1;
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits)))
    throw new MirrorError('INVALID_RECIPE_MONEY', 'This currency/API cannot represent that budget precision.');
  const n = BigInt(whole!) * BigInt(scale) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0');
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new MirrorError('INVALID_RECIPE_MONEY', 'Budget is too large.');
  return n.toString();
}
export function campaignRecipe(id: string, b: JsonObject): JsonObject {
  const definition = campaignRecipes.find(r => r.id === id);
  if (!definition) throw new MirrorError('RECIPE_NOT_FOUND', 'Choose an available campaign recipe.');
  if (!b || typeof b !== 'object') throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide the business inputs.');
  const missing = definition.required.filter(k => b[k] === undefined || b[k] === '');
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
  const isMeta = definition.platform === 'meta',
    conversion = metaConversionRecipes[id];
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
    steps.push({
      id: 'image',
      kind: 'media',
      expected_currency: b.currency,
      account_id: b.account_id,
      connection_id: b.connection_id,
      arguments: {
        platform: 'meta',
        drive_url: b.drive_url,
        name: b.name + ' image',
        ...(b.drive_connection_id ? {drive_connection_id: b.drive_connection_id} : {}),
      },
      depends_on: [],
    });
    add('campaign', 'meta_campaign_create', {
      name: b.name,
      objective: conversion?.objective ?? 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: b.special_ad_categories,
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
        targeting: {geo_locations: {countries}, age_min: 18, age_max: 65},
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
            image_hash: ref('image', '/image_hash'),
            link: url.href,
            message: b.message,
            name: b.headline,
            call_to_action: {type: conversion?.cta ?? 'LEARN_MORE', value: {link: url.href}},
          },
        },
      },
      ['image'],
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
    if (id === 'google_search') {
      if (
        !['CONTAINS_EU_POLITICAL_ADVERTISING', 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'].includes(
          b.contains_eu_political_advertising,
        )
      )
        throw new MirrorError(
          'RECIPE_INPUT_REQUIRED',
          'Explicitly confirm the Google EU political advertising declaration.',
        );
      const amount = money(b.daily_budget, 1e6, 'daily budget'),
        bid = money(b.cpc_bid, 1e6, 'CPC bid'),
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
                manual_cpc: {},
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
                cpc_bid_micros: bid,
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
  if (id === 'google_search')
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
        if (id === 'google_search')
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
      '. The campaign starts paused. Confirm destination, identity, policy eligibility and native prerequisites during whole-plan preflight; activation is a separate reviewed change.',
    steps,
    recipe: {
      id,
      platform: definition.platform,
      currency: b.currency,
      schedule_inputs: isMeta ? ['start_time', 'end_time'] : ['start_date', 'end_date'],
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
