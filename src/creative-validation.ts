/**
 * The Meta creative contract's fields and destination, which its provider contract states (src/provider-contracts.ts)
 * and its check reads. The check, validateMetaCreative, moved to src/meta-creative-features.ts with the feature checks
 * it calls (ARC-01 wave 4c round 6, w4c-arc6-versions), so that this module imports no Meta module.
 */
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
