import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {validateMetaCreativeFeatures} from './meta-creative-features.js';
const numeric = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
export const metaCreativeFields = [
  'name',
  'object_story_spec',
  'object_story_id',
  'source_instagram_media_id',
  'instagram_user_id',
  'url_tags',
  'destination_spec',
  // Advantage+ creative feature choices, one explicit enroll_status per listed feature (PRV-06 C).
  'degrees_of_freedom_spec',
];
/**
 * The one destination a creative may choose (the owner's decision of 2026-09-29). Meta's v26.0 changelog
 * (https://developers.facebook.com/docs/graph-api/changelog/version26.0, read 2026-09-29): "Starting in API v26.0,
 * eligible ad creatives will automatically default to destination_spec.destination_type = WEBSITE_AND_SHOP when the
 * advertiser has a shop. Advertisers can opt out by explicitly setting destination_type to WEBSITE_AND_SHOP_OPT_OUT."
 * Meta's Business SDK types destination_type as a free string at 25.0.3 and 26.0.2, so the value is known from v26.0
 * only: a request at v25.0 (AMCP_META_API_VERSION=v25.0) may not set it. AMCP never sets it on its own.
 */
export const metaCreativeDestinations = ['WEBSITE_AND_SHOP_OPT_OUT'];
export const metaShopChangelog = 'https://developers.facebook.com/docs/graph-api/changelog/version26.0';
/** Separate existing Instagram media from Facebook post IDs; never invent an identity. `path` names the Graph version. */
export function validateMetaCreative(body: JsonObject, path?: string) {
  const supported = metaCreativeFields;
  const unsupported = Object.keys(body).filter(key => !supported.includes(key));
  if (unsupported.length)
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'This creative contract supports owned Page stories, exact Facebook posts and existing Instagram media. Additional source/actor overrides and advanced creative fields need their own qualified contract.',
      {unsupported_fields: unsupported, supported_fields: supported},
    );
  if (
    body.destination_spec !== undefined &&
    (!body.destination_spec ||
      typeof body.destination_spec !== 'object' ||
      Array.isArray(body.destination_spec) ||
      Object.keys(body.destination_spec).join() !== 'destination_type' ||
      !metaCreativeDestinations.includes(body.destination_spec.destination_type))
  )
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      'A reviewed creative may set destination_spec only to {destination_type: WEBSITE_AND_SHOP_OPT_OUT}, which keeps it off the shop.',
      {field: 'destination_spec', allowed: metaCreativeDestinations, source: metaShopChangelog},
    );
  if (body.destination_spec !== undefined && Number(/^\/v(\d+)\.0\//.exec(path ?? '')?.[1] ?? 0) < 26)
    throw new MirrorError(
      'WRITE_CONTRACT_UNAVAILABLE',
      "destination_spec WEBSITE_AND_SHOP_OPT_OUT is documented from Graph API v26.0 only (Meta's v26.0 changelog); this request goes to an earlier version.",
      {field: 'destination_spec', source: metaShopChangelog},
    );
  validateMetaCreativeFeatures(body.degrees_of_freedom_spec, path);
  const story =
    body.object_story_spec && typeof body.object_story_spec === 'object' && !Array.isArray(body.object_story_spec)
      ? body.object_story_spec
      : {};
  const missing: string[] = [];
  if (
    body.object_story_spec !== undefined &&
    (typeof body.object_story_spec !== 'object' ||
      body.object_story_spec === null ||
      Array.isArray(body.object_story_spec))
  )
    throw new MirrorError('CREATIVE_INPUT_REQUIRED', 'object_story_spec must be a native object.');
  const identities = [body.instagram_user_id, story.instagram_user_id, story.instagram_actor_id].filter(
    v => v !== undefined,
  );
  if (identities.some(v => !numeric(v))) missing.push('instagram_user_id');
  if (new Set(identities).size > 1 || (body.object_story_id && Object.keys(story).length))
    throw new MirrorError(
      'CREATIVE_IDENTITY_CONFLICT',
      'Use one consistent Instagram identity and one existing post or new Page story.',
    );
  if (body.source_instagram_media_id !== undefined) {
    if (!numeric(body.source_instagram_media_id)) missing.push('source_instagram_media_id');
    if (!numeric(body.instagram_user_id)) missing.push('instagram_user_id');
    if (body.object_story_id || Object.keys(story).length)
      throw new MirrorError(
        'CREATIVE_IDENTITY_CONFLICT',
        'Choose existing Instagram media, a Facebook post, or a new Page story; do not combine these sources.',
      );
  } else {
    if (!body.object_story_id && !Object.keys(story).length)
      missing.push('object_story_spec.page_id or object_story_id');
    if (
      body.object_story_id !== undefined &&
      (typeof body.object_story_id !== 'string' || !/^[1-9][0-9]*_[1-9][0-9]*$/.test(body.object_story_id))
    )
      missing.push('object_story_id (Facebook pageId_postId)');
    if (Object.keys(story).length && !numeric(story.page_id)) missing.push('object_story_spec.page_id');
    if (story.link_data && !story.link_data.link) missing.push('object_story_spec.link_data.link');
  }
  if (missing.length)
    throw new MirrorError(
      'CREATIVE_INPUT_REQUIRED',
      'A Meta creative needs a verified identity: Page story, Facebook post, or existing Instagram media with its Instagram user. Link stories also need a destination URL.',
      {missing_fields: missing},
    );
}
