import {MirrorError} from './errors.js';
import type {Action, CompiledRequest, JsonObject} from './types.js';
import {metaPrefix} from './meta-version.js';

/** Correct independently documented account scoping without rewriting capture evidence. */
export function metaActionOverride(a: Action): Action {
  if (a.name !== 'meta_ad_account_id_adlabels_get') return a;
  return {...a, path: metaPrefix + 'act_{ad_account_id}/adlabels', evidence: 'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING'};
}

/** Endpoint-specific campaign rules (written against v25.0, unchanged in the v26.0 SDK), not blanket bans on creative fields. */
export function validateMetaCampaign(plan: CompiledRequest) {
  if (plan.gateway !== 'meta_native_action' || plan.method !== 'POST') return;
  const creating = /^\/v[^/]+\/act_[^/]+\/campaigns$/.test(plan.path);
  if (!creating && plan.action !== 'meta_campaign_id_update') return;
  const b = (plan.body ?? {}) as JsonObject,
    fields: string[] = [];
  if (['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'].includes(b.smart_promotion_type))
    fields.push('smart_promotion_type');
  if (creating && Object.hasOwn(b, 'existing_customer_budget_percentage'))
    fields.push('existing_customer_budget_percentage');
  for (const key of [
    'advantage_state',
    'advantage_budget_state',
    'advantage_audience_state',
    'advantage_placement_state',
  ])
    if (Object.hasOwn(b, key)) fields.push(key);
  if (fields.length)
    throw new MirrorError(
      'INVALID_META_CAMPAIGN',
      'The campaign uses deprecated legacy Advantage+ inputs or read-only Advantage+ state fields.',
      {
        fields,
        source: 'https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-campaigns',
        next_action:
          'Build and review a current campaign using its objective, audience, budget and placements. Do not silently translate legacy customer budget percentages or migrate an existing campaign.',
      },
    );
}

/** Meta's v26.0 changelog: https://developers.facebook.com/docs/graph-api/changelog/version26.0 (read 2026-09-29). */
const v26Changelog = 'https://developers.facebook.com/docs/graph-api/changelog/version26.0';
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** The Graph API major version a Meta path names: 26 for /v26.0/…. */
const pathVersion = (path: string) => Number(/^\/v(\d+)\.0\//.exec(path)?.[1] ?? 0);
/** 2026-10-27, when Meta refuses poll components on every Marketing API version. */
export const metaPollEndAllVersions = Date.UTC(2026, 9, 27);
const adSetCreate = (plan: CompiledRequest) => /^\/v[^/]+\/act_[^/]+\/adsets$/.test(plan.path);
const adSetUpdate = (plan: CompiledRequest) => ['meta_ad_set_id_update', 'meta_adset_update'].includes(plan.action);
const adUpdate = (plan: CompiledRequest) => ['meta_ad_id_update', 'meta_ad_update'].includes(plan.action);
const adOrCreativeCreate = (plan: CompiledRequest) => /^\/v[^/]+\/act_[^/]+\/(?:adcreatives|ads)$/.test(plan.path);

/** The first poll component in a creative specification, as a field path. Form posts may carry JSON-encoded objects. */
function pollField(value: unknown, path: string, depth = 0): string | undefined {
  if (depth > 12) return undefined;
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      return pollField(JSON.parse(value), path, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = pollField(item, path + '[' + i + ']', depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const at = path ? path + '.' + key : key;
    if (key === 'poll_spec') return at;
    if (key === 'interactive_components_spec' && isObject(item) && Array.isArray(item.components)) {
      const i = item.components.findIndex(c => isObject(c) && String(c.type).toLowerCase() === 'poll');
      if (i >= 0) return at + '.components[' + i + '].type';
    }
    const found = pollField(item, at, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Requests Meta refuses from v26.0 on, refused here before any read: the Instagram Explore Feed placement in ad set
 * placements, and poll components in creatives and ads (on every version from 2026-10-27).
 */
export function validateMetaV26(plan: CompiledRequest, now = Date.now()) {
  if (plan.gateway !== 'meta_native_action' || plan.method !== 'POST') return;
  const body = isObject(plan.body) ? plan.body : {},
    v26 = pathVersion(plan.path) >= 26;
  if (v26 && (adSetCreate(plan) || adSetUpdate(plan))) {
    const positions = isObject(body.targeting) ? body.targeting.instagram_positions : undefined;
    if (Array.isArray(positions) && positions.includes('explore'))
      throw new MirrorError(
        'META_PLACEMENT_UNAVAILABLE',
        'Meta no longer offers the Instagram Explore Feed placement from Graph API v26.0 and refuses requests that name it.',
        {
          field: 'targeting.instagram_positions',
          value: 'explore',
          source: v26Changelog,
          next_action:
            'Remove explore from targeting.instagram_positions (explore_home and the other positions remain) and prepare a new review.',
        },
      );
  }
  if ((v26 || now >= metaPollEndAllVersions) && (adOrCreativeCreate(plan) || adUpdate(plan))) {
    const field = pollField(body, '');
    if (field)
      throw new MirrorError(
        'META_POLL_UNAVAILABLE',
        'Meta no longer accepts poll components when creating or updating ads and creatives (Graph API v26.0, and every version from 2026-10-27).',
        {
          field,
          source: v26Changelog,
          next_action:
            'Remove poll_spec and any poll component of interactive_components_spec from the creative and prepare a new review.',
        },
      );
  }
}

/** Relaxable targeting: custom audiences and detailed targeting, which Advantage+ Audience may widen. */
const relaxableTargeting = [
  'custom_audiences',
  'flexible_spec',
  'interests',
  'behaviors',
  'life_events',
  'industries',
  'income',
  'family_statuses',
  'work_positions',
  'work_employers',
  'education_schools',
  'education_majors',
  'education_statuses',
  'relationship_statuses',
];
const specialCategories = ['HOUSING', 'EMPLOYMENT', 'FINANCIAL_PRODUCTS_SERVICES', 'CREDIT'];

/**
 * From Graph API v26.0 Meta refuses a new Housing, Employment or Financial Products and Services ad set with relaxable
 * targeting unless it chooses Advantage+ Audience explicitly (ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG).
 * The review reads the campaign's special ad categories; `states` are the review's state reads.
 */
export function metaAdSetAudienceChoice(plan: CompiledRequest, states: unknown[]) {
  if (plan.gateway !== 'meta_native_action' || plan.method !== 'POST' || !adSetCreate(plan)) return;
  if (pathVersion(plan.path) < 26) return;
  const body = isObject(plan.body) ? plan.body : {},
    targeting = isObject(body.targeting) ? body.targeting : {};
  const campaign = states.find(
    (s): s is JsonObject => isObject(s) && body.campaign_id !== undefined && String(s.id) === String(body.campaign_id),
  );
  const categories = Array.isArray(campaign?.special_ad_categories) ? campaign.special_ad_categories : [];
  const category = categories.find((c: unknown) => specialCategories.includes(String(c)));
  if (category === undefined) return;
  const relaxable = relaxableTargeting.filter(k =>
    Array.isArray(targeting[k])
      ? targeting[k].length > 0
      : isObject(targeting[k]) && Object.keys(targeting[k]).length > 0,
  );
  if (!relaxable.length) return;
  const choice = isObject(targeting.targeting_automation)
    ? targeting.targeting_automation.advantage_audience
    : undefined;
  if (choice === 0 || choice === 1) return;
  throw new MirrorError(
    'META_ADVANTAGE_AUDIENCE_REQUIRED',
    'Meta requires an explicit Advantage+ Audience choice for a ' +
      String(category) +
      ' ad set with custom audiences or detailed targeting (Graph API v26.0).',
    {
      field: 'targeting.targeting_automation.advantage_audience',
      special_ad_category: category,
      relaxable_targeting: relaxable,
      allowed: [0, 1],
      source: v26Changelog,
      next_action:
        'Ask the user whether Meta may widen this audience: set targeting.targeting_automation.advantage_audience to 1 (Advantage+ Audience on) or 0 (off), and prepare a new review.',
    },
  );
}

/**
 * From Graph API v26.0, an eligible creative defaults to destination_spec.destination_type WEBSITE_AND_SHOP when the
 * advertiser has a shop. AMCP cannot read shop eligibility, so a review of a creative without a chosen destination says so.
 */
export function metaShopDestinationImpact(plan: CompiledRequest): JsonObject | undefined {
  if (plan.gateway !== 'meta_native_action' || plan.method !== 'POST' || !adOrCreativeCreate(plan)) return undefined;
  if (pathVersion(plan.path) < 26) return undefined;
  const body = isObject(plan.body) ? plan.body : {};
  let creative: unknown = plan.path.endsWith('/ads') ? body.creative : body;
  if (typeof creative === 'string') {
    try {
      creative = JSON.parse(creative);
    } catch {
      return undefined;
    }
  }
  // An ad that names an existing creative keeps that creative's destination.
  if (!isObject(creative) || creative.creative_id !== undefined) return undefined;
  if (isObject(creative.destination_spec) && creative.destination_spec.destination_type !== undefined) return undefined;
  return {
    provider: 'meta',
    warning:
      'From Graph API v26.0 Meta sends an eligible creative to the website and the shop (destination_spec.destination_type WEBSITE_AND_SHOP) when the advertiser has a shop. To keep this creative on the website only, set destination_spec.destination_type to WEBSITE_AND_SHOP_OPT_OUT and prepare a new review.',
    field: 'destination_spec.destination_type',
    source: v26Changelog,
  };
}
