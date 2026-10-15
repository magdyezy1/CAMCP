import {MirrorError} from './errors.js';
import {metaShopDestinationImpact} from './meta-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Advantage+ creative features chosen one by one (PRV-06 C). Meta's Standard Enhancements page (read by the engineering
 * review on 2026-10-08): from Marketing API v22.0 the standard_enhancements bundle is no longer switched on or off as a
 * whole; a creative opts in to or out of each Advantage+ creative feature in degrees_of_freedom_spec.creative_features_spec,
 * as {<feature>: {enroll_status: OPT_IN | OPT_OUT}}. The page does not say what a creative made through the API gets for
 * a feature it does not list (a hypothesis the owner confirms with Meta), so AMCP never chooses for the user and never
 * adds a feature, or the field, on its own. The review lists each choice; verification reads the creative back and
 * compares every listed choice, and reports what Meta shows for the features the request left out.
 *
 * Only the single features in metaCreativeFeatures are accepted: fields of AdCreativeFeaturesSpec in Meta's official
 * Python Business SDK at 26.0.2, the release that describes Graph API v26.0. tests/fixtures/meta-creative-features-sdk-v26.json
 * pins the list, and `node tools/meta-creative-features.mjs --source-dir <the 26.0.2 adobjects files>` checks it against
 * the SDK files and records their hashes. Feature names change between versions, so a request to another Graph API
 * version may not set degrees_of_freedom_spec. Bundles, catalog and shop features, feature customizations and the older
 * transformation fields of degrees_of_freedom_spec stay refused: each needs its own qualified contract.
 */
export const metaCreativeFeatureSdkTag = '26.0.2';
const reviewedVersion = 26;
export const metaCreativeFeatures: readonly string[] = Object.freeze([
  'adapt_to_placement',
  'add_text_overlay',
  'audio',
  'description_automation',
  'enhance_cta',
  'image_animation',
  'image_background_gen',
  'image_brightness_and_contrast',
  'image_templates',
  'image_touchups',
  'image_uncrop',
  'inline_comment',
  'reveal_details_over_time',
  'site_extensions',
  'text_optimizations',
  'video_auto_crop',
]);
/** Feature bundles: from Marketing API v22.0 Meta takes these choices feature by feature instead. */
export const metaCreativeFeatureBundles: readonly string[] = Object.freeze([
  'advantage_plus_creative',
  'standard_enhancements',
  'standard_enhancements_catalog',
]);
export const metaEnrollStatuses: readonly string[] = Object.freeze(['OPT_IN', 'OPT_OUT']);
export const metaCreativeFeaturesSource =
  'https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-catalog-ads/standard-enhancements';
const sdkSource =
  'https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adcreativefeaturesspec.py';
const field = 'degrees_of_freedom_spec.creative_features_spec';
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** The Graph API major version a Meta path names: 26 for /v26.0/…. */
const pathVersion = (path?: string) => Number(/^\/v(\d+)\.0\//.exec(path ?? '')?.[1] ?? 0);
const creativeCreate = (plan: CompiledRequest) =>
  plan.gateway === 'meta_native_action' &&
  plan.method === 'POST' &&
  /^\/v[^/]+\/act_[^/]+\/adcreatives$/.test(plan.path);
/** The feature choices a request or a read holds, or undefined when it holds none. */
function choices(value: unknown): JsonObject | undefined {
  return isObject(value) && isObject(value.creative_features_spec) ? value.creative_features_spec : undefined;
}

/**
 * The creative contract's check of degrees_of_freedom_spec: only creative_features_spec, only at Graph API v26.0, only
 * reviewed single features, and for each an explicit enroll_status of OPT_IN or OPT_OUT and nothing else.
 */
export function validateMetaCreativeFeatures(value: unknown, path?: string): void {
  if (value === undefined) return;
  if (!isObject(value) || Object.keys(value).join() !== 'creative_features_spec')
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'A reviewed creative may set degrees_of_freedom_spec only to {creative_features_spec: {<feature>: {enroll_status: OPT_IN or OPT_OUT}}}.',
      {
        field: 'degrees_of_freedom_spec',
        ...(isObject(value)
          ? {
              unsupported_fields: Object.keys(value)
                .filter(key => key !== 'creative_features_spec')
                .map(key => 'degrees_of_freedom_spec.' + key),
            }
          : {}),
        allowed: ['creative_features_spec'],
        source: metaCreativeFeaturesSource,
      },
    );
  if (pathVersion(path) !== reviewedVersion)
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      "Advantage+ creative feature names are reviewed against Meta's SDK 26.0.2, which describes Graph API v26.0; this request goes to another version.",
      {field: 'degrees_of_freedom_spec', sdk_tag: metaCreativeFeatureSdkTag, source: sdkSource},
    );
  const features = value.creative_features_spec;
  if (!isObject(features) || !Object.keys(features).length)
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'creative_features_spec names at least one Advantage+ creative feature, each with its own enroll_status.',
      {field, supported_features: [...metaCreativeFeatures]},
    );
  const unknown = Object.keys(features)
    .filter(key => !metaCreativeFeatures.includes(key))
    .sort();
  if (unknown.length) {
    const bundles = unknown.filter(key => metaCreativeFeatureBundles.includes(key));
    throw new MirrorError(
      'META_ADVANTAGE_CREATIVE_FEATURE_UNAVAILABLE',
      'An Advantage+ creative feature the request names is not one this contract reviews.',
      {
        field: field + '.' + unknown[0],
        unsupported_features: unknown,
        ...(bundles.length ? {bundles} : {}),
        supported_features: [...metaCreativeFeatures],
        sdk_tag: metaCreativeFeatureSdkTag,
        source: sdkSource,
      },
    );
  }
  const unchosen = Object.entries(features)
    .filter(
      ([, choice]) =>
        !isObject(choice) ||
        Object.keys(choice).join() !== 'enroll_status' ||
        !metaEnrollStatuses.includes(choice.enroll_status as string),
    )
    .map(([key]) => key)
    .sort();
  if (unchosen.length)
    throw new MirrorError(
      'META_ADVANTAGE_CREATIVE_CHOICE_REQUIRED',
      'Each Advantage+ creative feature the request lists needs an explicit choice, {enroll_status: OPT_IN} or {enroll_status: OPT_OUT}, and nothing else.',
      {
        field: field + '.' + unchosen[0] + '.enroll_status',
        features: unchosen,
        allowed: [...metaEnrollStatuses],
        source: metaCreativeFeaturesSource,
        next_action:
          'Ask the user, for each feature in details.features, whether Meta may apply it to this creative: set its enroll_status to OPT_IN or OPT_OUT, or leave the feature out, and prepare a new review. Never choose for them.',
      },
    );
}

/**
 * What the review of a new creative says about Advantage+ creative features: each choice the request makes, or, at
 * v26.0, that it makes none and how to choose. Undefined for every other request.
 */
export function metaCreativeFeaturesImpact(plan: CompiledRequest): JsonObject | undefined {
  if (!creativeCreate(plan) || pathVersion(plan.path) !== reviewedVersion) return undefined;
  const body = isObject(plan.body) ? plan.body : {},
    features = choices(body.degrees_of_freedom_spec);
  if (!features)
    return {
      chosen: false,
      field,
      note: 'This creative chooses no Advantage+ creative feature, so Meta applies its own setting to each, which Meta does not document for creatives made through the API. To choose, ask the user and set an enroll_status of OPT_IN or OPT_OUT for each feature in degrees_of_freedom_spec.creative_features_spec, then prepare a new review.',
      source: metaCreativeFeaturesSource,
    };
  const by = (status: string) =>
    Object.entries(features)
      .filter(([, choice]) => isObject(choice) && choice.enroll_status === status)
      .map(([key]) => key)
      .sort();
  return {
    chosen: true,
    field,
    opted_in: by('OPT_IN'),
    opted_out: by('OPT_OUT'),
    effect:
      'Meta may apply the opted-in Advantage+ creative features when it shows this creative, and does not apply the opted-out ones.',
    unlisted:
      'A feature the request does not list keeps Meta’s own setting, which Meta does not document for creatives made through the API; verification reports what Meta shows for it.',
    sdk_tag: metaCreativeFeatureSdkTag,
    source: metaCreativeFeaturesSource,
  };
}

/** The creative impact of a new Meta creative: its shop destination and its Advantage+ creative feature choices. */
export function metaCreativeImpact(plan: CompiledRequest): JsonObject | undefined {
  const shop = metaShopDestinationImpact(plan),
    features = metaCreativeFeaturesImpact(plan);
  return features ? {...(shop ?? {provider: 'meta'}), creative_features: features} : shop;
}

/**
 * What a creative's read-back shows for the features the request did not list (Meta's own settings), so the review's
 * open question is answered by evidence. Undefined when the request chose no feature or the read shows no other one.
 */
export function metaCreativeFeaturesObserved(expected: JsonObject, actual: unknown): JsonObject | undefined {
  const asked = choices(expected.degrees_of_freedom_spec),
    read = isObject(actual) ? choices(actual.degrees_of_freedom_spec) : undefined;
  if (!asked || !read) return undefined;
  const others = Object.keys(read)
    .filter(key => !Object.hasOwn(asked, key))
    .sort()
    .slice(0, 100)
    .map(key => {
      const choice = read[key];
      return [key, isObject(choice) && typeof choice.enroll_status === 'string' ? choice.enroll_status : null];
    });
  return others.length
    ? {
        provider_creative_features: Object.fromEntries(others),
        provider_creative_features_note:
          'Meta shows these Advantage+ creative features for the creative although the request did not list them; their settings are Meta’s own.',
      }
    : undefined;
}
