/**
 * Meta's guided website recipes (ARC-04: one of campaignRecipe's per-recipe builders, declared by Meta's adapter hooks):
 * a paused campaign, ad set, image, Page creative and ad for website traffic, purchases or leads.
 */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
import {recipeEnum, recipeMoney as money, recipeNumbers, recipeValueType} from './recipe-values.js';
import type {DependencyEvidenceContext, RecipeContextFacts, RecipeInputSpec} from './provider-adapter.js';
import {
  assertRecipeAtomic,
  recipeDestination,
  recipePlan,
  recipeSteps,
  recipeStrings as strings,
} from './recipe-steps.js';
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
// Native fields/enums: Meta's official Business SDK 26.0.2. Account acceptance remains a preflight/review concern.
export const metaConversionRecipes: Record<string, {objective: string; event: string; cta: string; label: string}> = {
  meta_website_sales: {objective: 'OUTCOME_SALES', event: 'PURCHASE', cta: 'SHOP_NOW', label: 'website purchases'},
  meta_website_leads: {objective: 'OUTCOME_LEADS', event: 'LEAD', cta: 'SIGN_UP', label: 'website leads'},
};
/**
 * The special ad categories a website recipe declares (AMCP-08): an empty list means none apply, and that is the only list a recipe takes,
 * because a regulated category needs a tailored native targeting plan. The declaration is the person's own and is never defaulted.
 */
const specialAdCategories: RecipeInputSpec = Object.freeze({type: 'list', min: 0, max: 0});
/** The Meta recipes the catalog lists first: website traffic, then each conversion recipe. */
export const metaWebsiteRecipes = [
  {
    id: 'meta_website_traffic',
    name: 'Meta website traffic with image',
    platform: 'meta',
    required: metaRequired,
    alternatives: metaImageAlternatives,
    optional: metaOptional,
    inputs: {special_ad_categories: specialAdCategories} as Readonly<Record<string, RecipeInputSpec>>,
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
    // The attribution windows are the person's explicit choice, read by their declared values (AMCP-08): one or seven days after a click,
    // none or one day after a view.
    inputs: {
      special_ad_categories: specialAdCategories,
      click_attribution_days: recipeNumbers([1, 7]),
      view_attribution_days: recipeNumbers([0, 1]),
    } as Readonly<Record<string, RecipeInputSpec>>,
    description:
      'Paused campaign for ' +
      spec.label +
      ', optimizing ' +
      spec.event +
      ' on the selected website pixel. Explicit click/view attribution and a separate review for every step. Pixel access does not establish event delivery or objective eligibility.',
  })),
];
/** The plan of a Meta website recipe, from a brief that passed the catalog's shared checks. */
export function buildMetaWebsiteRecipe(id: string, b: JsonObject): JsonObject {
  const definition = metaWebsiteRecipes.find(r => r.id === id)!;
  assertRecipeAtomic(definition, b);
  const url = recipeDestination(b),
    {steps, ref, add} = recipeSteps(b, 'meta_native_action');
  let metaAudience: JsonObject | undefined;
  const conversion = metaConversionRecipes[id];
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
  const clickDays = conversion
      ? (recipeEnum(b, 'click_attribution_days', definition.inputs.click_attribution_days!) as number)
      : undefined,
    viewDays = conversion
      ? (recipeEnum(b, 'view_attribution_days', definition.inputs.view_attribution_days!) as number)
      : undefined;
  // A list of strings, empty for none: another type is invalid, not "missing" (AMCP-08); a regulated category is refused below.
  if (!Array.isArray(b.special_ad_categories) || b.special_ad_categories.some((v: unknown) => typeof v !== 'string'))
    throw new MirrorError(
      'RECIPE_INPUT_INVALID',
      'Explicitly declare applicable special ad categories (an empty list means none).',
      {field: 'special_ad_categories', received_type: recipeValueType(b.special_ad_categories), min: 0, max: 0},
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
              {event_type: 'CLICK_THROUGH', window_days: clickDays},
              ...(viewDays === 1 ? [{event_type: 'VIEW_THROUGH', window_days: 1}] : []),
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
  // An existing account image is read back by preflight before anything is created.
  if (source === 'image_hash') steps.at(-1)!.prerequisites = ['meta_image_hash'];
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
  // Meta requires an explicit offset.
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
  return recipePlan(definition, b, steps, '', {
    id,
    platform: definition.platform,
    currency: b.currency,
    schedule_inputs: ['start_time', 'end_time'],
    ...(metaAudience ? {audience: metaAudience} : {}),
    budget_level: 'ADSET',
    is_adset_budget_sharing_enabled: false,
    budget_sharing:
      'The daily budget is set on the one ad set and is not shared: Meta requires this explicit choice from Graph API v24.0 when budgets are set on ad sets.',
    ...(conversion
      ? {
          conversion_event: conversion.event,
          pixel_id: b.pixel_id,
          measurement_acceptance:
            'Pixel access is checked during preflight; actual event delivery and provider objective acceptance remain unverified.',
        }
      : {}),
    geo_warning: null,
  });
}

// Writes and campaigns (ARC-04, wave 4c): what recipe_context says of each website recipe, moved verbatim from
// src/recipe-context.ts, which asks the recipe's provider (its adapter's `campaign.recipes`).
/** A conversion recipe's pixel event and what stays unverified; none for website traffic. */
export function metaWebsiteRecipeContext(id: string): RecipeContextFacts | undefined {
  return metaConversionRecipes[id]
    ? Object.freeze({
        limitations: Object.freeze([
          'Uses the selected website pixel with ' +
            metaConversionRecipes[id]!.event +
            '. Pixel/Page access is checked during preflight; active event delivery, provider objective eligibility and landing-page policy acceptance require separate evidence.',
        ]),
      })
    : undefined;
}

// Writes and campaigns (wave 4c): moved verbatim from recipeEligibility (src/recipe-eligibility.ts), which asks the
// recipe's provider (its adapter's `campaign.dependencyEvidence`); the pixel is Meta's for a Meta recipe.
/** A Meta recipe's Page and pixel, as its preflight read them, and its explicit attribution windows. */
export function metaDependencyEvidence(id: string, {assets, steps}: DependencyEvidenceContext): JsonObject | undefined {
  if (['page_identity', 'account_owned_pixel'].includes(id)) {
    const proof = assets.find(
      a =>
        a.asset_type === (id === 'page_identity' ? 'Facebook Page' : 'Meta pixel') &&
        a.status === 'provider_read_checked',
    );
    return proof
      ? {
          status: 'ready',
          evidence: proof,
          meaning: 'The account-scoped native collection confirmed access to this exact resource.',
        }
      : undefined;
  }
  if (id === 'attribution_window')
    return {
      status: 'ready',
      evidence: {
        kind: 'compiled_explicit_settings',
        windows: steps.find((step: JsonObject) => step.id === 'adset')?.arguments.payload.attribution_spec,
      },
      meaning:
        'The explicit settings match the local recipe contract. Historical attribution and event delivery remain unverified.',
    };
  return undefined;
}
