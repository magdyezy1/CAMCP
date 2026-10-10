import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** The uploads whose current use in ads AMCP can read (MCP-10): one reader each, chosen by the asset's usage kind. */
export const qualifiedUsageKinds = [
  {platform: 'meta', media_types: ['image', 'video'], native_usage_kind: 'meta_scalar_references'},
  {platform: 'google_ads', media_types: ['image'], native_usage_kind: 'google_image_links'},
  {platform: 'snapchat', media_types: ['image', 'video'], native_usage_kind: 'snapchat_top_snap'},
] as const;
/**
 * The usage kind that covers this asset's provider and media type, or undefined (MCP-10). The reader it names still
 * checks the asset's own receipt and account, and refuses with its own reason when they are missing.
 */
export const usageKind = (asset: JsonObject) =>
  qualifiedUsageKinds.find(
    k => k.platform === asset.platform && (k.media_types as readonly string[]).includes(String(asset.media_type)),
  )?.native_usage_kind;
/**
 * The provider-neutral refusal for an asset no usage reader covers (a TikTok, LinkedIn, X or DV360 upload, or a Google
 * video): it lists what is covered, and no provider request is made.
 */
export function unqualifiedUsage(asset: JsonObject): MirrorError {
  return new MirrorError(
    'ASSET_USAGE_UNQUALIFIED',
    'Current native usage can be read for Meta images and videos, Google images and Snapchat images and videos; this asset is none of these, so its use in ads stays unknown.',
    {
      platform: asset.platform ?? null,
      media_type: asset.media_type ?? null,
      qualified_kinds: qualifiedUsageKinds.map(k => ({platform: k.platform, media_types: [...k.media_types]})),
      provider_requests: 0,
    },
  );
}
