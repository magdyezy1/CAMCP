import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeChoices, recipeCurrencyMicros as currencyMicros, recipeEnum, recipeValueType} from './recipe-values.js';
import {pmaxAssetRequirements} from './google-pmax-build.js';
import {googleConversionGoalPolicy, googleEuDeclaration} from './google-search-recipes.js';
import type {DependencyEvidenceContext, RecipeContextFacts, RecipeInputSpec} from './provider-adapter.js';

/** The name of the recipe's one asset group (AMCP-08): 1 to 128 characters, "unique under a campaign" (pinned v25 AssetGroup.name). */
const groupNameInput: RecipeInputSpec = Object.freeze({type: 'text', min: 1, max: 128});
/** An optional list of existing image assets (AMCP-08): at most 20 IDs, none required. */
const imageListInput: RecipeInputSpec = Object.freeze({type: 'list', min: 0, max: 20});
/**
 * google_performance_max (CMP-07, a pack owner decision P7 of 2026-10-11 names): a guided paused
 * Performance Max launch compiled to the one reviewed all-or-nothing build that Google requires for an asset group and
 * its minimum assets (google-atomic-builds.ts, google-pmax-build.ts). Maximize Conversions with explicitly chosen
 * account-default conversion goals, as the Google Search conversion packs use them; brand guidelines off, so the
 * business name and logos link to the asset group. Text assets are created in the build; images and logos are existing
 * assets of the account (uploaded with amcp_media), whose type the review reads. The campaign starts PAUSED and its
 * asset group ENABLED under it; enabling the campaign is the one activation.
 */
export const googlePmaxRecipe = {
  id: 'google_performance_max',
  name: 'Google Performance Max with account-default conversion goals',
  platform: 'google',
  required: [
    'name',
    'account_id',
    'connection_id',
    'currency',
    'daily_budget',
    'country_criterion_ids',
    'language_criterion_ids',
    'destination_url',
    'business_name',
    'headlines',
    'long_headlines',
    'descriptions',
    'marketing_image_asset_ids',
    'square_image_asset_ids',
    'logo_asset_ids',
    'conversion_goal_policy',
    'contains_eu_political_advertising',
  ],
  optional: [
    'start_date',
    'end_date',
    'asset_group_name',
    'positive_geo_target_type',
    'portrait_image_asset_ids',
    'tall_portrait_image_asset_ids',
    'final_url_expansion',
  ],
  // The values these inputs accept (AMCP-08): `recipes` and `recipe_context` say them, and the builder below reads the brief by them. The four
  // optional ones are the owner's session of 2026-11-21 (AMCP-08, F8-3); their v25 names are in the pinned Discovery document
  // (.mirror/VENDOR/google-ads-v25.json: AssetGroup.name, Campaign.geo_target_type_setting.positive_geo_target_type, and the AssetGroupAsset
  // field types PORTRAIT_MARKETING_IMAGE and TALL_PORTRAIT_MARKETING_IMAGE).
  inputs: {
    conversion_goal_policy: googleConversionGoalPolicy,
    contains_eu_political_advertising: googleEuDeclaration,
    asset_group_name: groupNameInput,
    // SEARCH_INTEREST is not listed: v25 says it "can only be used with Search and standard Shopping campaigns".
    positive_geo_target_type: recipeChoices(['PRESENCE_OR_INTEREST', 'PRESENCE']),
    // Google takes 20 images in all across the landscape, square and portrait lists (the pinned combined cap), so a list is bounded by 20 and
    // the three together are checked below. A tall portrait image is counted nowhere (google-pmax-build.ts pmaxUncountedFieldTypes; its count
    // and ratio are UNVERIFIED, live check LV-14): its bound is only this recipe's own sanity bound, like the other lists'.
    portrait_image_asset_ids: imageListInput,
    tall_portrait_image_asset_ids: imageListInput,
    // Final URL expansion (the lead's addition of 2026-11-21: the owner's session also tried `url_expansion_opt_out`, a Campaign field Google
    // removed in v22). v25 keeps it as an entry of Campaign.asset_automation_settings, {asset_automation_type:
    // FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION, asset_automation_status: OPTED_IN | OPTED_OUT} (pinned Discovery; Google's page "Asset automation
    // settings", read 2026-11-21: a campaign-level type, on by default for Performance Max and off for Search, and opting in also enables text
    // asset automation). Left out, Google's default applies, as before.
    final_url_expansion: recipeChoices(['OPTED_IN', 'OPTED_OUT']),
  },
  description:
    'One all-or-nothing build of a paused Performance Max campaign with Maximize Conversions on explicitly chosen account-default goals, a dedicated budget, location and language criteria, and one asset group with its minimum text, image and logo assets. Images and logos are existing account assets; their type is read before sending. Goal settings, asset approval and provider eligibility remain unverified. Activation is separate.',
};
function invalid(message: string, field: string, details: JsonObject = {}): never {
  throw new MirrorError('RECIPE_INPUT_INVALID', message, {field, ...details});
}
function list(b: JsonObject, key: string, min: number, max: number): string[] {
  const v = b[key];
  if (!Array.isArray(v) || v.length < min || v.length > max || v.some(x => typeof x !== 'string' || !x.trim()))
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Provide ' + key + ' (' + min + '–' + max + ' nonempty items).', {
      missing_fields: [key],
    });
  if (new Set(v).size !== v.length) invalid('Each item of ' + key + ' must be distinct.', key);
  return v;
}
/** Text a field type takes, within the pinned length (code points; Google counts some scripts wider). */
function texts(b: JsonObject, key: string, type: string): string[] {
  const rule = pmaxAssetRequirements.fields[type]!,
    v = list(b, key, Math.max(1, rule.min), rule.max);
  if (v.some(t => [...t].length > rule.max_length! || /[\x00-\x1f\x7f]/.test(t)))
    throw new MirrorError(
      'AD_TEXT_LIMIT',
      'Performance Max ' + key + ' take at most ' + rule.max_length + ' characters each, as plain text.',
      {field: key, max_length: rule.max_length},
    );
  return v;
}

/** Compiles a Performance Max brief to one reviewed build step; nothing is read or sent. */
export function buildGooglePmaxRecipe(b: JsonObject): JsonObject {
  const account = String(b.account_id).replace(/-/g, '');
  if (!/^[1-9][0-9]{0,18}$/.test(account)) invalid('Use the exact numeric Google customer ID.', 'account_id');
  // The goal policy and the EU declaration are the person's own explicit choices: read by their declared values, never defaulted (AMCP-08).
  const goalPolicy = recipeEnum(b, 'conversion_goal_policy', googlePmaxRecipe.inputs.conversion_goal_policy) as string,
    euDeclaration = recipeEnum(
      b,
      'contains_eu_political_advertising',
      googlePmaxRecipe.inputs.contains_eu_political_advertising,
    ) as string;
  for (const key of ['target_cpa', 'target_roas', 'cpc_bid', 'cpc_bid_ceiling', 'bidding_strategy', 'atomic'])
    if (b[key] !== undefined && !(key === 'atomic' && b.atomic === true))
      invalid(
        'This workflow uses Maximize Conversions without a target and is always one all-or-nothing build; choose a native plan for another bidding strategy.',
        key,
      );
  let url: URL;
  try {
    url = new URL(b.destination_url);
  } catch {
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a full HTTPS landing page URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new MirrorError('DESTINATION_REQUIRED', 'Use a public HTTPS landing page URL without credentials.');
  const headlines = texts(b, 'headlines', 'HEADLINE'),
    longHeadlines = texts(b, 'long_headlines', 'LONG_HEADLINE'),
    descriptions = texts(b, 'descriptions', 'DESCRIPTION');
  // Google's short description: at least one description of at most 60 characters (google-pmax-build.ts).
  const short = pmaxAssetRequirements.short_description;
  if (descriptions.filter(t => [...t].length <= short.max_length).length < short.min)
    throw new MirrorError(
      'AD_TEXT_LIMIT',
      'Performance Max needs at least one description of at most 60 characters (Google’s short description). Shorten one of the descriptions.',
      {field: 'descriptions', short_max_length: short.max_length},
    );
  if (typeof b.business_name !== 'string' || !b.business_name.trim() || [...b.business_name].length > 25)
    invalid('Use a business name of at most 25 characters.', 'business_name');
  const asset = (key: string, min: number, max: number) =>
    list(b, key, min, max).map(id => {
      if (!/^[1-9][0-9]{0,18}$/.test(id))
        invalid('Use the numeric IDs of image assets already in this Google account.', key);
      return 'customers/' + account + '/assets/' + id;
    });
  // An optional list of image assets (AMCP-08): left out, blank or empty is none; any other shape is invalid and says the size it takes, never "missing".
  const optionalAssets = (key: 'portrait_image_asset_ids' | 'tall_portrait_image_asset_ids'): string[] => {
    const v = b[key],
      spec = googlePmaxRecipe.inputs[key];
    if (v === undefined || v === '') return [];
    const shape = {received_type: recipeValueType(v), min: spec.min, max: spec.max};
    if (
      !Array.isArray(v) ||
      v.length > spec.max! ||
      v.some(x => typeof x !== 'string' || !x.trim()) ||
      new Set(v).size !== v.length
    )
      invalid('Use a list of nonempty text items, each once, within the size the details give.', key, shape);
    if (v.some(id => !/^[1-9][0-9]{0,18}$/.test(id)))
      invalid('Use the numeric IDs of image assets already in this Google account.', key, shape);
    return v.map(id => 'customers/' + account + '/assets/' + id);
  };
  const images = asset('marketing_image_asset_ids', 1, 20),
    squares = asset('square_image_asset_ids', 1, 20),
    logos = asset('logo_asset_ids', 1, 5),
    portraits = optionalAssets('portrait_image_asset_ids'),
    tallPortraits = optionalAssets('tall_portrait_image_asset_ids');
  // Google takes 20 images in all across the landscape, square and portrait lists (the pinned combined cap, google-pmax-build.ts); the tall
  // portrait list is counted nowhere.
  if (images.length + squares.length + portraits.length > 20)
    invalid('Performance Max takes at most 20 images per asset group.', 'marketing_image_asset_ids');
  const locations = list(b, 'country_criterion_ids', 1, 20),
    languages = list(b, 'language_criterion_ids', 1, 10);
  if ([...locations, ...languages].some(id => !/^\d+$/.test(id)))
    invalid('Use native numeric Google geo/language criterion IDs.', 'country_criterion_ids');
  const amount = currencyMicros(b.daily_budget, b.currency, 'daily budget');
  // The asset group's name: the campaign's name with a suffix unless the brief names it (AMCP-08); 1 to 128 characters as Google counts them. The
  // control characters are refused whole (the C0 and C1 controls and the line and paragraph separators, the lead's review S4-7); the quote and the
  // backslash are not controls, and a campaign name allows them too.
  const named = b.asset_group_name !== undefined && b.asset_group_name !== '',
    groupName: string = named ? b.asset_group_name : (b.name + ' · asset group').slice(0, 128);
  if (
    named &&
    (typeof groupName !== 'string' ||
      !groupName.trim() ||
      [...groupName].length > groupNameInput.max! ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(groupName))
  )
    invalid('Use an asset group name of 1 to 128 characters, without control characters.', 'asset_group_name', {
      received_type: recipeValueType(b.asset_group_name),
      min: groupNameInput.min,
      max: groupNameInput.max,
    });
  // Presence-only (or presence or interest) location targeting; left out, Google's default applies, as before (AMCP-08). Read by its declared values.
  const geoType = recipeEnum(b, 'positive_geo_target_type', googlePmaxRecipe.inputs.positive_geo_target_type, true) as
    string | undefined;
  // Final URL expansion, opted in or out; left out, Google's default applies (the lead's addition, AMCP-08). Read by its declared values.
  const expansion = recipeEnum(b, 'final_url_expansion', googlePmaxRecipe.inputs.final_url_expansion, true) as
    string | undefined;
  const name = (kind: string, n: number) => 'customers/' + account + '/' + kind + '/-' + n,
    budget = name('campaignBudgets', 1),
    campaign = name('campaigns', 2),
    group = name('assetGroups', 3);
  const campaignCreate: JsonObject = {
    resource_name: campaign,
    name: b.name,
    status: 'PAUSED',
    advertising_channel_type: 'PERFORMANCE_MAX',
    campaign_budget: budget,
    maximize_conversions: {},
    brand_guidelines_enabled: false,
    contains_eu_political_advertising: euDeclaration,
    ...(geoType ? {geo_target_type_setting: {positive_geo_target_type: geoType}} : {}),
    ...(expansion
      ? {
          asset_automation_settings: [
            {asset_automation_type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', asset_automation_status: expansion},
          ],
        }
      : {}),
  };
  for (const k of ['start_date', 'end_date'])
    if (b[k] !== undefined && b[k] !== '') {
      if (
        typeof b[k] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b[k]) ||
        new Date(b[k] + 'T00:00:00Z').toISOString().slice(0, 10) !== b[k]
      )
        throw new MirrorError('RECIPE_DATE_INVALID', 'Use valid YYYY-MM-DD dates in the advertising account timezone.');
      campaignCreate[k + '_time'] = b[k] + (k === 'start_date' ? ' 00:00:00' : ' 23:59:59');
    }
  if (b.start_date && b.end_date && b.end_date < b.start_date)
    throw new MirrorError('RECIPE_DATE_INVALID', 'End date must be on or after start date.');
  const textAssets: [string, string][] = [
    ...headlines.map(t => ['HEADLINE', t] as [string, string]),
    ...longHeadlines.map(t => ['LONG_HEADLINE', t] as [string, string]),
    ...descriptions.map(t => ['DESCRIPTION', t] as [string, string]),
    ['BUSINESS_NAME', b.business_name],
  ];
  const ops: JsonObject[] = [
    {
      campaign_budget_operation: {
        create: {
          resource_name: budget,
          name: b.name + ' budget',
          amount_micros: amount,
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {campaign_operation: {create: campaignCreate}},
    ...locations.map(id => ({
      campaign_criterion_operation: {
        create: {campaign, location: {geo_target_constant: 'geoTargetConstants/' + id}},
      },
    })),
    ...languages.map(id => ({
      campaign_criterion_operation: {
        create: {campaign, language: {language_constant: 'languageConstants/' + id}},
      },
    })),
    ...textAssets.map(([, text], i) => ({
      asset_operation: {create: {resource_name: name('assets', 100 + i), text_asset: {text}}},
    })),
    {
      asset_group_operation: {
        create: {
          resource_name: group,
          name: groupName,
          campaign,
          final_urls: [url.href],
          // Under the paused campaign the asset group starts ENABLED; enabling the campaign is the one activation.
          status: 'ENABLED',
        },
      },
    },
    ...textAssets.map(([field_type], i) => ({
      asset_group_asset_operation: {create: {asset_group: group, asset: name('assets', 100 + i), field_type}},
    })),
    ...images.map(a => ({
      asset_group_asset_operation: {create: {asset_group: group, asset: a, field_type: 'MARKETING_IMAGE'}},
    })),
    ...squares.map(a => ({
      asset_group_asset_operation: {create: {asset_group: group, asset: a, field_type: 'SQUARE_MARKETING_IMAGE'}},
    })),
    ...portraits.map(a => ({
      asset_group_asset_operation: {create: {asset_group: group, asset: a, field_type: 'PORTRAIT_MARKETING_IMAGE'}},
    })),
    ...tallPortraits.map(a => ({
      asset_group_asset_operation: {
        create: {asset_group: group, asset: a, field_type: 'TALL_PORTRAIT_MARKETING_IMAGE'},
      },
    })),
    ...logos.map(a => ({
      asset_group_asset_operation: {create: {asset_group: group, asset: a, field_type: 'LOGO'}},
    })),
  ];
  return {
    action: 'create',
    name: b.name,
    brief:
      googlePmaxRecipe.name +
      ' in ' +
      b.currency +
      '. The campaign starts paused. One all-or-nothing build: Google creates the budget, campaign, criteria, text assets, asset group and its asset links together or not at all. Uses account-default conversion goals; goal settings, asset approval and event delivery remain unverified and are not changed by this plan. Activation is a separate reviewed change.',
    steps: [
      {
        id: 'build',
        kind: 'write',
        gateway: 'google_ads_native_action',
        connection_id: b.connection_id,
        account_id: b.account_id,
        expected_currency: b.currency,
        description: 'Every resource of the Performance Max launch, created together or not at all.',
        arguments: {
          action: 'google_ads_v23_google_ads_mutate',
          payload: {mutate_operations: ops, partial_failure: false},
        },
        depends_on: [],
      },
    ],
    recipe: {
      id: googlePmaxRecipe.id,
      platform: 'google',
      currency: b.currency,
      schedule_inputs: ['start_date', 'end_date'],
      atomic: true,
      build: {all_or_nothing: true, steps: ['build']},
      daily_budget_micros: amount,
      bidding_strategy: 'MAXIMIZE_CONVERSIONS',
      conversion_goal_policy: goalPolicy,
      brand_guidelines_enabled: false,
      // What the brief chose beyond the minimum, when it chose it (AMCP-08): a reviewer reads it here beside the build.
      ...(named ? {asset_group_name: groupName} : {}),
      ...(geoType ? {positive_geo_target_type: geoType} : {}),
      ...(expansion ? {final_url_expansion: expansion} : {}),
      // The count of every field type the build links; a portrait list left out links none and is not shown (the website's preview prints
      // every count and checks that they add up to the links).
      asset_counts: {
        HEADLINE: headlines.length,
        LONG_HEADLINE: longHeadlines.length,
        DESCRIPTION: descriptions.length,
        BUSINESS_NAME: 1,
        MARKETING_IMAGE: images.length,
        SQUARE_MARKETING_IMAGE: squares.length,
        ...(portraits.length ? {PORTRAIT_MARKETING_IMAGE: portraits.length} : {}),
        ...(tallPortraits.length ? {TALL_PORTRAIT_MARKETING_IMAGE: tallPortraits.length} : {}),
        LOGO: logos.length,
      },
      bidding_effect:
        'Maximize Conversions uses the daily budget to seek conversions across Google’s channels. It does not guarantee a cost per conversion or result. Activation is separate.',
      measurement_acceptance:
        'The plan leaves account-default conversion goals unchanged. Current goal settings, primary actions, event delivery and provider objective acceptance remain unverified before activation.',
      asset_acceptance:
        'Asset counts and text lengths are checked locally against the pinned Performance Max minimums, and the linked images and logos are read for their type. Image ratios, policy review and ad strength stay with Google; read them with amcp_reporting serving_diagnostics after the build.',
      source: pmaxAssetRequirements.source,
    },
  };
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of the recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
export const googlePmaxContext: RecipeContextFacts = Object.freeze({
  limitations: Object.freeze([
    'One all-or-nothing build: Google creates the paused campaign, its asset group and every asset link together or not at all. Images and logos are existing account assets read for their type; uses account-default conversion goals without changing them. Asset approval, ad strength, event delivery and provider eligibility remain unverified before activation.',
  ]),
  prerequisite: 'existing account image and logo assets with explicit text assets, location and language inputs',
});

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`).
/** CMP-07: the counts and text lengths the build compiled passed the pinned Performance Max minimums. */
export function googlePmaxDependencyEvidence(id: string, {recipe}: DependencyEvidenceContext): JsonObject | undefined {
  if (id !== 'pmax_asset_minimums') return undefined;
  return {
    status: 'ready',
    evidence: {kind: 'compiled_explicit_setting', asset_counts: recipe.asset_counts},
    meaning:
      'The asset counts and text lengths meet the pinned Performance Max minimums. Image ratios, policy review and ad strength remain with Google.',
  };
}
