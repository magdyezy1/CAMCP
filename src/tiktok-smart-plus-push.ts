import {createHash} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Spark Ads Push in an Upgraded Smart+ ad (package r25-m4b-smartpush; matrix A1, A3, A5). The pure parts of it: what a creative
 * names, the limits and key lists of each kind, and (in the sections below) the library reads, the review's projection of them and the
 * read-back of a Push creative. The refusals and the prerequisites are src/tiktok-smart-plus-ads.ts's, and the edits are
 * src/tiktok-smart-plus-ad-updates.ts's. A leaf: it imports no other module of the family.
 *
 * What the pages say (API for Business v1.3, read 2026-11-21):
 * - "Create an Upgraded Smart+ Ad": a creative is `creative_info`; "Size range: 1-50"; for Spark Ads Push `video_info` {video_id} and
 *   `image_info` [{web_uri}] "You need to specify a video cover", or "one to 35 carousel images" and `music_info` {music_id};
 *   `web_uri` is the "Image ID" of /file/image/ad/upload/ and /file/image/ad/search/; `ad_text_list` is "Required when tiktok_item_id
 *   is not specified", "Max size: 5"; `material_name` is "Valid only when ad_format is CAROUSEL_ADS", 255 characters, each Chinese or
 *   Japanese one counting two; `dark_post_status` ON or OFF, "Valid only when you create Spark Ads through Spark Ads Push".
 * - "Upgraded Smart+ ad creative combinations by identity and ad type": Push is TT_USER or BC_AUTH_TT, with "Do not specify
 *   tiktok_item_id", in videos only, carousels only, or both; Pull is TT_USER, BC_AUTH_TT or AUTH_CODE, with "Do not specify
 *   video_info, image_info, music_info, and ad_text_list". No combination mixes the two.
 * - "Search for videos" and "Search for images": the library reads (at most 100 IDs a read; a video that cannot be used in ads is
 *   not returned; `is_carousel_usable` is false for an image a carousel cannot use).
 */
/** What a creative names: an existing post (Spark Ads Pull), an uploaded video with its cover, or carousel images with music (Push). */
export type CreativeKind = 'pull' | 'video' | 'carousel';
/** What a list of creatives is as a whole: all posts, all uploads, or both (which no combination of the appendix allows). */
export type ListKind = 'pull' | 'push' | 'mixed';

/** TikTok's limit: creative_list "Size range: 1-50". */
export const maxCreatives = 50;
/** "Max size: 5" of ad_text_list. */
export const maxAdTexts = 5;
/** "one to 35 carousel images". */
export const maxCarouselImages = 35;
/** The length limit of a carousel's own name, each Chinese or Japanese character counting two. */
export const maxMaterialName = 255;
/** At most 100 IDs a library search takes ("Search for videos", "Search for images"). */
export const assetsPerRead = 100;

/** The IDs `amcp_media` returns for an upload (src/media-upload.ts) and the library's searches list. */
export const videoIdPattern = /^[A-Za-z0-9_/-]{1,512}$/;
const imageIdShape = /^[A-Za-z0-9_./-]{1,512}$/;
export const imageId = (v: unknown): v is string => typeof v === 'string' && imageIdShape.test(v) && !v.includes('..');
export const musicIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

/** The keys of a creative_info, by what it names. */
export const keysOf: Record<CreativeKind, readonly string[]> = {
  pull: ['ad_format', 'tiktok_item_id', 'identity_type', 'identity_id', 'identity_authorized_bc_id'],
  video: ['ad_format', 'video_info', 'image_info', 'identity_type', 'identity_id', 'identity_authorized_bc_id'],
  carousel: [
    'ad_format',
    'image_info',
    'music_info',
    'material_name',
    'identity_type',
    'identity_id',
    'identity_authorized_bc_id',
  ],
};
/** The keys only an upload has: a post names none of them ("Do not specify video_info, image_info, music_info, and ad_text_list"). */
export const uploadKeys = ['video_info', 'image_info', 'music_info', 'material_name'] as const;
/** The identities each kind may use: an authorization-code identity names an existing post, and a video is published under an account. */
export const identityTypes: Record<CreativeKind, readonly string[]> = {
  pull: ['TT_USER', 'BC_AUTH_TT', 'AUTH_CODE'],
  video: ['TT_USER', 'BC_AUTH_TT'],
  carousel: ['TT_USER', 'BC_AUTH_TT'],
};
/** The ad format each kind has. */
export const formatOf: Record<'video' | 'carousel', string> = {video: 'SINGLE_VIDEO', carousel: 'CAROUSEL_ADS'};

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * What a creative_info names: a `tiktok_item_id` is a post, whatever else is in it (the other keys are then refused as not going with
 * it); otherwise `video_info` is a video, and `image_info` or `music_info` a carousel. Undefined when it names none of them.
 */
export function creativeKind(ci: unknown): CreativeKind | undefined {
  if (!obj(ci)) return undefined;
  if (ci.tiktok_item_id !== undefined) return 'pull';
  if (ci.video_info !== undefined) return 'video';
  if (ci.image_info !== undefined || ci.music_info !== undefined) return 'carousel';
  return undefined;
}
/** The creative_info of each creative that is a record; the rest is for the shape rules to refuse. */
const creativeInfos = (list: unknown): unknown[] =>
  Array.isArray(list) ? list.map(c => (obj(c) ? c.creative_info : undefined)) : [];
/** What a list of creatives is, from the creatives that name something; undefined when none does. */
export function listKind(list: unknown): ListKind | undefined {
  const kinds = creativeInfos(list)
    .map(creativeKind)
    .filter((k): k is CreativeKind => k !== undefined);
  if (!kinds.length) return undefined;
  const pull = kinds.some(k => k === 'pull'),
    push = kinds.some(k => k !== 'pull');
  return pull && push ? 'mixed' : pull ? 'pull' : 'push';
}

/** The creative_info of each creative of a list that is a record (the shape rules have refused the others). */
export const infosOf = (list: unknown): JsonObject[] => creativeInfos(list).filter(obj);
/**
 * An ad material ID as TikTok's reads return it ("Get Upgraded Smart+ Ads": `ad_material_id` of each creative), which an update may name
 * to keep that creative as it is (matrix A16; "Update an Upgraded Smart+ Ad", read 2026-11-21).
 */
export const materialIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
/** The ad_material_id of each creative an update keeps as it is (it names nothing else), in the list's order. */
export const keptMaterials = (list: unknown): string[] =>
  Array.isArray(list)
    ? list
        .filter(c => obj(c) && c.creative_info === undefined && typeof c.ad_material_id === 'string')
        .map(c => c.ad_material_id)
    : [];
/** The video ID of a Push video creative, and its cover. */
export const videoOf = (ci: JsonObject): string | undefined =>
  obj(ci.video_info) && typeof ci.video_info.video_id === 'string' ? ci.video_info.video_id : undefined;
/** The image IDs of a creative's `image_info`, in the order the creative lists them. */
export const imagesOf = (ci: JsonObject): string[] =>
  Array.isArray(ci.image_info)
    ? ci.image_info.map(e => (obj(e) && typeof e.web_uri === 'string' ? e.web_uri : '')).filter(Boolean)
    : [];
export const musicOf = (ci: JsonObject): string | undefined =>
  obj(ci.music_info) && typeof ci.music_info.music_id === 'string' ? ci.music_info.music_id : undefined;

/**
 * What identifies a creative in the lists of an edit that replaces them (kept, added, removed): a post by its ID as before, a video by
 * its ID, and a carousel by a hash of its images in order and its music, since a carousel has no ID of its own. `uploads` says which kind
 * the ad is where the creative is a read-back's (it may carry a generated post ID, which does not make it a post).
 */
export function creativeKey(ci: JsonObject, uploads?: boolean): string {
  const kind = uploads === true ? (videoOf(ci) !== undefined ? 'video' : 'carousel') : creativeKind(ci);
  if (kind === 'video') return 'video:' + String(videoOf(ci));
  if (kind === 'carousel')
    return (
      'carousel:' +
      createHash('sha256')
        .update(JSON.stringify([imagesOf(ci), musicOf(ci) ?? null]))
        .digest('hex')
        .slice(0, 12)
    );
  return String(ci.tiktok_item_id);
}

/** What the review says of the dark-post choice of a Spark Ad Push (the owner's O1, 2026-11-21): ads only, or the profile too. */
export const darkPostMeaning = (status: 'ON' | 'OFF'): string =>
  status === 'OFF'
    ? 'The posts will also appear on the identity’s TikTok profile and can earn organic views. TikTok allows this only if neither the identity nor the ad account enforces ads-only mode, and refuses it otherwise.'
    : 'Ads only: the posts are shown through this ad and not on the identity’s TikTok profile (TikTok’s default, sent explicitly).';

/**
 * What the review says of keeping a creative by its ad_material_id, and what a refusal of it says to do (matrix A16, and the rule of the
 * allowlist-gated capabilities of r25-m4b-COMMON: built and gated, never refused locally; TikTok's code 40118 is one of the nine
 * definitive refusals of src/tiktok-write-rejection.ts). "Update an Upgraded Smart+ Ad": "Using ad_material_id to update Upgraded Smart+
 * Ads is currently an allowlist-only feature." One fixed sentence each, with its Arabic in web/locales/ar.json.
 */
export const tiktokMaterialAllowlistNotice =
  'Keeping a creative by its ad_material_id is an allowlist-only feature of TikTok: an advertiser that is not on its allowlist is refused with code 40118, and nothing is changed.';
export const tiktokAllowlistRefusal =
  'TikTok refused this request with code 40118: the advertiser is not on its allowlist for a feature the request uses, and nothing was changed. If the request keeps a creative by its ad_material_id, that feature is allowlist-only: ask TikTok to allowlist this advertiser for it.';
/** The refusal of a write with the allowlist sentence beside TikTok's own code, in details; any other error is returned as it is. */
export function withAllowlistHint(e: unknown): unknown {
  return e instanceof MirrorError && e.details?.provider_code === 40118
    ? new MirrorError(e.code, e.message, {...e.details, allowlist: tiktokAllowlistRefusal}, e.status, e.retryable)
    : e;
}

/**
 * The library reads of the uploads a list names (r25-m4b-smartpush; "Search for videos" and "Search for images", read 2026-11-21): each
 * video and each image (a cover, or an image of a carousel) is searched by ID in the advertiser's own library, at most 100 IDs a read,
 * before review and again before execution. TikTok ignores a video that cannot be used in ads, so an ID the search does not return is
 * not usable by this advertiser. The reads carry `tiktokPush`, so that the review keeps of them what it compares (the IDs, and
 * `is_carousel_usable` for a carousel image) and not the signed links TikTok adds to every answer.
 */
export type PushRead = 'video' | 'image' | 'identity';
export type Marked = CompiledRequest & {tiktokPush?: PushRead};
export interface AssetRead {
  path: string;
  query: JsonObject;
  action: string;
  push: PushRead;
}
export const videoSearchPath = '/v1.3/file/video/ad/search/',
  imageSearchPath = '/v1.3/file/image/ad/search/';
export function assetReads(accountId: string | undefined, list: unknown): AssetRead[] {
  const infos = infosOf(list),
    videos = [...new Set(infos.map(videoOf).filter((v): v is string => v !== undefined))].sort(),
    images = [...new Set(infos.filter(ci => creativeKind(ci) !== 'pull').flatMap(imagesOf))].sort();
  const chunks = (ids: string[]) =>
    Array.from({length: Math.ceil(ids.length / assetsPerRead)}, (_, n) =>
      ids.slice(n * assetsPerRead, (n + 1) * assetsPerRead),
    );
  return [
    ...chunks(videos).map(video_ids => ({
      path: videoSearchPath,
      query: {advertiser_id: accountId, filtering: {video_ids}, page: 1, page_size: assetsPerRead},
      action: 'tiktok_file_video_ad_search',
      push: 'video' as const,
    })),
    ...chunks(images).map(image_ids => ({
      path: imageSearchPath,
      query: {advertiser_id: accountId, filtering: {image_ids}, page: 1, page_size: assetsPerRead},
      action: 'tiktok_file_image_ad_search',
      push: 'image' as const,
    })),
  ];
}
/** The kind of library read a request is (set where the read is built), or undefined. */
export const pushReadOf = (read: CompiledRequest): PushRead | undefined => (read as Marked).tiktokPush;
/**
 * The kind of ad a read-back is of, where the request knows it (the lead's review S2-1): a create names its creatives, and an edit is of an
 * ad whose kind its review read. The read-back is projected as that kind of ad, and never by the ad texts of the row, which an ad of posts
 * may carry (no page says it does not).
 */
export type AdKind = 'pull' | 'push';
export type KindMarked = CompiledRequest & {tiktokAdKind?: AdKind};
/** The kind of ad a verification read is of (set where the read is built), or undefined. */
export const adKindOf = (read: CompiledRequest): AdKind | undefined => (read as KindMarked).tiktokAdKind;
/** The marker a verification read carries for the kind of ad its request is for (none where the request does not know it). */
export const adKindMark = (kind: string | undefined): {tiktokAdKind?: AdKind} =>
  kind === 'pull' || kind === 'push' ? {tiktokAdKind: kind} : {};
const idOrder = (a: JsonObject, b: JsonObject) =>
  String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
/**
 * What a review keeps of a library read: the IDs it returned (and, for an image, whether a carousel may use it). The signed links
 * (`video_cover_url`, `preview_url`, `image_url`) change at every read and are never part of the compared state.
 */
export function assetState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  const marker = pushReadOf(read);
  if (marker !== 'video' && marker !== 'image') return undefined;
  const saved = obj(d.data) && Array.isArray(d.data[marker + 's']) ? (d.data[marker + 's'] as JsonObject[]) : undefined,
    rows = saved ?? (obj(d.data) && Array.isArray(d.data.list) ? (d.data.list as JsonObject[]) : []);
  const kept = rows
    .filter(obj)
    .map(r =>
      marker === 'video'
        ? {id: String(r.id ?? r.video_id)}
        : {
            id: String(r.id ?? r.image_id),
            is_carousel_usable: r.is_carousel_usable === true ? true : r.is_carousel_usable === false ? false : null,
          },
    )
    .sort(idOrder);
  return {data: {[marker + 's']: kept}};
}
/** The IDs a library read was asked for, and the rows of its answer, for the check that every one came back. */
export function assetAnswer(
  read: CompiledRequest,
  data: JsonObject,
): {requested: string[]; returned: string[]} | undefined {
  const marker = pushReadOf(read);
  if (marker !== 'video' && marker !== 'image') return undefined;
  const filtering = obj(read.query.filtering) ? read.query.filtering : {},
    requested = Array.isArray(filtering[marker + '_ids']) ? (filtering[marker + '_ids'] as unknown[]).map(String) : [],
    rows = obj(data.data) && Array.isArray(data.data.list) ? (data.data.list as JsonObject[]) : [];
  return {requested, returned: rows.map(r => String(obj(r) ? r[marker + '_id'] : undefined))};
}
