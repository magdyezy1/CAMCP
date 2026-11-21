import {responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {tiktokPortfolioGetPath, tiktokCtaPortfolioCheck} from './tiktok-cta-portfolios.js';
import {tiktokInstantFormRead, tiktokInstantFormCheck} from './tiktok-instant-forms.js';
import {
  tiktokAdPixel,
  tiktokAdPixelImpact,
  tiktokAdPixelPrerequisites,
  tiktokAdPixelRead,
  tiktokPixelGroupKind,
  tiktokRefuseCreatedPixel,
} from './tiktok-smart-plus-pixels.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';
import {activeUnderServingParent, pausedParentChildStatuses} from './paused-parents.js';
import {
  assetAnswer,
  assetReads,
  assetState,
  creativeKey,
  creativeKind,
  darkPostMeaning,
  formatOf,
  identityTypes,
  imageId,
  imagesOf,
  keysOf,
  listKind,
  maxAdTexts,
  maxCarouselImages,
  materialIdPattern,
  maxCreatives,
  maxMaterialName,
  musicIdPattern,
  musicOf,
  pushReadOf,
  uploadKeys,
  videoIdPattern,
  videoOf,
} from './tiktok-smart-plus-push.js';
import type {AssetRead, ListKind, Marked, PushRead} from './tiktok-smart-plus-push.js';

/**
 * Paused Upgraded Smart+ website and Instant Form lead generation Spark Ads from existing TikTok posts, per API for
 * Business v1.3 "Create an Upgraded Smart+ Lead Generation Campaign with Location as Instant Form", "Create an Upgraded
 * Smart+ Ad", "Upgraded Smart+ ad creative combinations by identity and ad type", "Create a regular Upgraded Smart+ Web
 * Campaign", "Get info about an identity", "Get info about TikTok posts" and "Get Upgraded Smart+ Ads" (checked
 * 2026-09-26). Non-Spark ads no longer run on the TikTok placement, Spark identities there need a dynamic CTA portfolio,
 * an ad group holds at most 30 ads, and the automatic creative switches default by allowlist status, so this contract
 * sets them explicitly. Uploads (Spark Ads Push), authorization-code posts and custom identities stay out.
 *
 * The website ad groups this contract creates ads in (r25-field-tiktok, #1; "Create a regular Upgraded Smart+ Web
 * Campaign", https://business-api.tiktok.com/portal/docs/create-a-regular-upgraded-smart-web-campaign/v1.3, and "Get
 * Upgraded Smart+ Ad Groups", checked 2026-11-19): `promotion_type` WEBSITE with the goal CONVERT, CLICK (CPC) or
 * TRAFFIC_LANDING_PAGE_VIEW. TikTok documents no pixel for the last two, and the ad step, `/smart_plus/ad/create/`, asks the
 * same of an ad for every goal (one landing page, optional matching UTM parameters, Spark identities with a dynamic CTA), so
 * no ad-level gate depends on the goal. VALUE is documented too and stays out until someone asks for it. A website ad group
 * whose row carries a `catalog_id` (TikTok returns it only for a catalog campaign) stays out: catalog web campaigns are not
 * qualified.
 *
 * The contract runs every independent rule and refuses once with all a request broke (`collect`, `refuse`: r25-field-tiktok,
 * #6), the first violation as the message and every one in `details.violations`. TikTok returns
 * `ad_configuration.product_info_enabled` (UNSET, NON_CATALOG or CATALOG; "Create an Upgraded Smart+ Ad" and "Get Upgraded
 * Smart+ Ads", checked 2026-11-19) with every ad, UNSET being the default that switches product information off, so a body
 * copied from a read carries it: UNSET is accepted, and the other modes stay outside the contract until they are qualified.
 *
 * The ad-level pixel (r25-m4-smartedits, T5): `ad_configuration.tracking_info.tracking_pixel_id` is documented by TikTok only for app
 * promotion ads and Instant Form lead generation ads, so an Instant Form ad may name one and a website ad takes none of its own (its
 * pixel is its ad group's); the rule is src/tiktok-smart-plus-pixels.ts, and the edit of it src/tiktok-smart-plus-ad-updates.ts. The two
 * keys TikTok returns with every ad at their default, `product_specific_type` UNSET and `dark_post_status` ON, are accepted at that value.
 */
export const tiktokSmartPlusAdPath = '/v1.3/smart_plus/ad/create/';
export const tiktokSmartPlusAdGetPath = '/v1.3/smart_plus/ad/get/';
export const tiktokIdentityVideoInfoPath = '/v1.3/identity/video/info/';
export const tiktokSmartPlusAdSource = 'https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad/v1.3';
const identityInfoPath = '/v1.3/identity/info/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const emoji = /\p{Extended_Pictographic}/u;
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);
const order = (a: unknown, b: unknown) => {
  const x = JSON.stringify(a),
    y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
// A1 (r25-m4b-smartpush): "Create an Upgraded Smart+ Ad" and "Update an Upgraded Smart+ Ad" give creative_list "Size range: 1-50" (read
// 2026-11-21: maxCreatives of src/tiktok-smart-plus-push.ts), where AMCP held 20. "Get info about TikTok posts" takes at most 20 item_ids
// per read, so the posts of one identity are read in chunks of that size.
const maxAds = 30,
  postsPerRead = 20;
/** The optimization goals of the website ad groups this contract creates ads in (the module comment: r25-field-tiktok, #1). */
const websiteGoals = ['CONVERT', 'CLICK', 'TRAFFIC_LANDING_PAGE_VIEW'];
/** A provider token (a promotion type, a goal) as a message may quote it: capitals, digits and underscores only. */
const token = (v: unknown) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? v : undefined);
/** The post type each ad format uses. */
const formats: Record<string, string> = {SINGLE_VIDEO: 'VIDEO', CAROUSEL_ADS: 'CAROUSEL'};
const enhancements = ['TRANSLATE_AND_DUB', 'MUSIC_REFRESH', 'VIDEO_QUALITY', 'IMAGE_QUALITY', 'IMAGE_RESIZE'];
const topKeys = [
  'advertiser_id',
  'adgroup_id',
  'ad_name',
  'operation_status',
  'creative_list',
  'landing_page_url_list',
  'page_list',
  'ad_configuration',
];
const configKeys = [
  'call_to_action_id',
  'creative_auto_add_toggle',
  'creative_auto_enhancement_strategy_list',
  'product_info_enabled',
  'utm_params',
  // r25-m4-smartedits (T5 and the restated read defaults, below): the tracking pixel, and the keys TikTok returns with every ad
  // at their defaults, which a body copied from a read carries.
  'tracking_info',
  'product_specific_type',
  'dark_post_status',
  'catalog_creative_toggle',
];

export const tiktokSmartPlusAdKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusAdPath;

/**
 * The default of a Spark Ad Push, set where the request is compiled (r25-m4b-smartpush; the owner's O1, 2026-11-21): an upload is published as a post
 * of its identity, and dark_post_status ON keeps it off the identity's profile (TikTok's default since 2026-01-27, which the Create Spark Ads
 * guide says it changed from OFF; read 2026-11-21). AMCP sends it, so that "ads only by default" does not depend on TikTok's default. The review
 * then shows it in the request, and only a request that says OFF puts the post on the profile. An ad of posts is left as it was.
 */
export function tiktokSmartPlusAdDefaults(path: string, body: unknown): void {
  if (path !== tiktokSmartPlusAdPath || !obj(body) || listKind(body.creative_list) !== 'push') return;
  if (obj(body.ad_configuration) && body.ad_configuration.dark_post_status === undefined)
    body.ad_configuration = {...body.ad_configuration, dark_post_status: 'ON'};
}

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', message, {field});
}
const webUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 2048 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !!u.hostname;
  } catch {
    return false;
  }
};
const creatives = (b: JsonObject) => infos(b.creative_list as JsonObject[]);
/** The Business Center of a creative's identity, as the review shows it (only a Business Center identity has one). */
const bcOf = (c: JsonObject) =>
  c.identity_authorized_bc_id !== undefined ? {identity_authorized_bc_id: c.identity_authorized_bc_id} : {};
/** The creative_info of each creative of a list; an update's creative that is kept by its ad_material_id has none (A16). */
const infos = (list: JsonObject[]) =>
  list.filter(c => obj(c) && obj(c.creative_info)).map(c => c.creative_info as JsonObject);
type Identity = {type: string; id: string; bc?: string; items: string[]; push: boolean};
/** One entry per identity named by the creatives, with the posts it must own and whether an upload is published under it. */
function identities(list: JsonObject[]): Identity[] {
  const out = new Map<string, Identity>();
  for (const c of infos(list)) {
    const bc = c.identity_authorized_bc_id as string | undefined,
      key = c.identity_type + ':' + c.identity_id + ':' + (bc ?? '');
    const i = out.get(key) ?? {
      type: c.identity_type as string,
      id: c.identity_id as string,
      ...(bc !== undefined ? {bc} : {}),
      items: [],
      push: false,
    };
    if (typeof c.tiktok_item_id === 'string') i.items.push(c.tiktok_item_id);
    else i.push = true;
    out.set(key, i);
  }
  return [...out.values()];
}

/**
 * One rule of the contract that a request breaks: the field it names and AMCP's own sentence (r25-field-tiktok, #6).
 */
export interface Violation {
  field: string;
  message: string;
}
/**
 * Runs one rule of the contract. A refusal of this family (`invalid`) is recorded and the contract goes on to its next rule, so a
 * request that breaks several rules hears of all of them at once and not one per call (r25-field-tiktok, #6); true when the rule
 * held. Any other error is no rule of the contract and stands.
 */
export function collect(found: Violation[], rule: () => void): boolean {
  try {
    rule();
    return true;
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code !== 'INVALID_TIKTOK_SMART_PLUS_AD') throw e;
    found.push({field: String(e.details.field), message: e.message});
    return false;
  }
}
/** The most violations an answer lists; `violations_count` counts them all, and `violations_omitted` the rest. */
const maxViolations = 20;
/**
 * Refuses once with everything a request broke. One violation is raised as it always was, with its own sentence and field. Several
 * are raised as the first one, with its own sentence as the message and its field as `details.field`, so that the answer reads, and
 * is translated, exactly as a refusal of that one rule: the website looks a message up in its catalogue as it is, and a message
 * built as a template around the sentence reached an Arabic page in English (the lead's review, S3-1). Every violation is in
 * `details.violations`, each with its own sentence, and `details.violations_count` counts them all; that there are more is said
 * by the remedy of this code (src/tiktok-remedies.ts), written for people, which has its own Arabic (r25-field-tiktok, #6).
 */
export function refuse(found: Violation[]): void {
  const [first, ...rest] = found;
  if (!first) return;
  if (!rest.length) invalid(first.field, first.message);
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', first.message, {
    field: first.field,
    violations: found.slice(0, maxViolations),
    violations_count: found.length,
    ...(found.length > maxViolations ? {violations_omitted: found.length - maxViolations} : {}),
  });
}

/**
 * Validates the request before review; nothing here reads or contacts TikTok. Every independent rule is run, and a request that
 * breaks several is refused once with all of them (`refuse`); the rules that need another's answer (the UTM parameters need the
 * landing page) wait for it.
 */
export function assertTiktokSmartPlusAd(plan: CompiledRequest, body: JsonObject): void {
  const found: Violation[] = [],
    // A post-based ad takes no ad texts (it uses the post's own); an upload takes them (r25-m4b-smartpush, A5).
    pull = listKind(body.creative_list) === 'pull',
    allowed = pull ? topKeys : [...topKeys, 'ad_text_list'];
  for (const extra of Object.keys(body).filter(k => !allowed.includes(k)))
    collect(found, () =>
      invalid(
        extra,
        '"' +
          extra +
          '" is outside the qualified Smart+ Spark Ad contract' +
          (extra === 'ad_text_list'
            ? '; Spark Ads from existing posts use the post text.'
            : extra === 'call_to_action_list'
              ? '; Spark Ads use a dynamic CTA through ad_configuration.call_to_action_id.'
              : '.'),
      ),
    );
  collect(found, () => {
    if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
      invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  });
  collect(found, () => {
    if (!numeric(body.adgroup_id))
      invalid('adgroup_id', 'adgroup_id must be the numeric ID of an Upgraded Smart+ ad group.');
  });
  // DISABLE, or ENABLE under an ad group or campaign the review reads DISABLE (Q14, owner 2026-11-15; R2.5 M4, L1-05): the paused-parent
  // rule of src/paused-parents.ts decides that on the state it reads, at prepare and again at execute, so this shape check allows what its
  // level does.
  collect(found, () => {
    if (!(pausedParentChildStatuses(plan) ?? ['DISABLE']).includes(body.operation_status))
      invalid(
        'operation_status',
        'Set operation_status to DISABLE, or to ENABLE under a Smart+ ad group or campaign the review reads DISABLE (TikTok defaults to ENABLE).',
      );
  });
  collect(found, () => {
    if (
      typeof body.ad_name !== 'string' ||
      !body.ad_name.trim() ||
      width(body.ad_name) > 512 ||
      emoji.test(body.ad_name)
    )
      invalid(
        'ad_name',
        'ad_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.',
      );
  });
  const kind = checkSparkCreatives(body.creative_list, found);
  checkAdTexts(body.ad_text_list, kind, found, true);
  // The profile choice is for Spark Ads Push: an ad of posts takes ON only, as before (a read returns it).
  const darkPost = kind === 'pull' ? 'on' : 'any';
  if (body.page_list !== undefined) {
    collect(found, () => {
      if (body.landing_page_url_list !== undefined)
        invalid('landing_page_url_list', 'An Instant Form ad takes page_list and no landing_page_url_list.');
    });
    collect(found, () => assertInstantFormPages(body.page_list));
    checkAdConfiguration(body.ad_configuration, undefined, found, false, darkPost);
    collect(found, () => {
      if (obj(body.ad_configuration) && body.ad_configuration.utm_params !== undefined)
        invalid(
          'ad_configuration.utm_params',
          'utm_params record landing page parameters; Instant Form ads have no landing page.',
        );
    });
  } else
    checkAdConfiguration(
      body.ad_configuration,
      checkLandingPage(body.landing_page_url_list, found),
      found,
      false,
      darkPost,
    );
  refuse(found);
}
/** Exactly one Instant Form as the destination of a lead generation ad. */
export function assertInstantFormPages(pages: unknown): string {
  if (
    !Array.isArray(pages) ||
    pages.length !== 1 ||
    !obj(pages[0]) ||
    Object.keys(pages[0]).some(k => k !== 'page_id') ||
    !numeric(pages[0].page_id)
  )
    invalid('page_list', 'page_list must hold exactly one {page_id} of a published Instant Form.');
  return pages[0].page_id;
}
/**
 * A Spark creative list (r25-m4b-smartpush; "Create an Upgraded Smart+ Ad" and "Upgraded Smart+ ad creative combinations by identity and
 * ad type", read 2026-11-21): 1-50 creatives, each naming an existing post (Spark Ads Pull: TT_USER, BC_AUTH_TT or AUTH_CODE), an uploaded
 * video with its cover, or carousel images with music (Spark Ads Push: TT_USER or BC_AUTH_TT). A list is all posts or all uploads: no
 * combination of the appendix mixes them. Every rule of every creative is run, and each violation is recorded in `found` (r25-field-tiktok,
 * #6). Returns what the list is, for the rules that depend on it (the ad texts, the dark-post choice).
 */
export function checkSparkCreatives(list: unknown, found: Violation[], keep = false): ListKind | undefined {
  const listed = collect(found, () => {
    if (!Array.isArray(list) || !list.length || list.length > maxCreatives)
      invalid(
        'creative_list',
        'creative_list must hold 1-50 creatives: existing TikTok posts, or uploaded videos with their covers and carousels of images with music.',
      );
  });
  if (!listed) return undefined;
  const items = new Set<string>(),
    uploads = new Set<string>(),
    materials = new Set<string>();
  (list as unknown[]).forEach((c: unknown, i: number) => {
    const at = 'creative_list[' + i + '].creative_info',
      material = 'creative_list[' + i + '].ad_material_id',
      byId = obj(c) && Object.hasOwn(c, 'ad_material_id');
    // "Create an Upgraded Smart+ Ad" has no ad_material_id in its request, only in its answer: a create names each creative.
    if (byId && !keep)
      collect(found, () =>
        invalid(
          material,
          'The create request has no ad_material_id (TikTok lists it for an update only): name each creative in creative_info.',
        ),
      );
    // An update may keep a creative the ad holds by its ad_material_id, alone (matrix A16; "Update an Upgraded Smart+ Ad": "either
    // creative_info ... or ad_material_id (if you want to retain the existing material ID)"). It is the ad's own creative, so the rules of
    // a new one do not apply to it; the ad's read decides that the ID is its (src/tiktok-smart-plus-ad-updates.ts).
    if (byId && keep) {
      const id = (c as JsonObject).ad_material_id;
      if (typeof id === 'string' && materialIdPattern.test(id)) {
        const again = materials.has(id);
        materials.add(id);
        if (again) collect(found, () => invalid(material, 'Creative ' + id + ' appears more than once.'));
      } else
        collect(found, () =>
          invalid(
            material,
            'ad_material_id must be the ID of a creative the ad holds, as the ad’s own read returns it.',
          ),
        );
      if (Object.hasOwn(c as JsonObject, 'creative_info'))
        collect(found, () =>
          invalid(
            material,
            'TikTok ignores creative_info when ad_material_id is sent: send a creative as its ad_material_id to keep it, or as creative_info to replace it, not both.',
          ),
        );
      else {
        collect(found, () => {
          if (Object.keys(c as JsonObject).some(k => k !== 'ad_material_id'))
            invalid('creative_list[' + i + ']', 'A creative kept by its material ID is {ad_material_id} alone.');
        });
        return;
      }
    }
    // The material ID is the rules above's: it is not counted again as a stray key of the creative.
    const record = collect(found, () => {
      if (!obj(c) || Object.keys(c).some(k => k !== 'creative_info' && k !== 'ad_material_id') || !obj(c.creative_info))
        invalid(
          'creative_list[' + i + ']',
          'Each creative is {creative_info:{...}} naming an existing TikTok post, an uploaded video with its cover, or carousel images with music.',
        );
    });
    if (!record) return;
    const ci = (c as JsonObject).creative_info as JsonObject,
      named = creativeKind(ci),
      // A creative that names nothing is still held to the identity rules of a post, so that all that it lacks is listed at once.
      kind = named ?? 'pull';
    if (!named)
      collect(found, () =>
        invalid(
          at,
          'A creative names an existing TikTok post (tiktok_item_id), an uploaded video with its cover (video_info and image_info), or carousel images with music (image_info and music_info).',
        ),
      );
    for (const key of Object.keys(ci).filter(k => !keysOf[kind].includes(k)))
      collect(found, () =>
        invalid(
          at + '.' + key,
          kind === 'pull' && (uploadKeys as readonly string[]).includes(key)
            ? '"' +
                key +
                '" cannot go with tiktok_item_id: a creative is an existing post (Spark Ads Pull) or an upload (Spark Ads Push), never both.'
            : '"' +
                key +
                '" is outside Spark Ads from posts and uploads: a post takes tiktok_item_id, a video takes video_info and image_info, a carousel takes image_info, music_info and material_name; custom identities are not qualified.',
        ),
      );
    if (named)
      collect(found, () => {
        if (kind === 'pull') {
          if (typeof ci.ad_format !== 'string' || !Object.hasOwn(formats, ci.ad_format))
            invalid(
              at + '.ad_format',
              'ad_format must be SINGLE_VIDEO for a video post or CAROUSEL_ADS for a photo post.',
            );
        } else if (ci.ad_format !== formatOf[kind])
          invalid(
            at + '.ad_format',
            kind === 'video'
              ? 'ad_format must be SINGLE_VIDEO for an uploaded video.'
              : 'ad_format must be CAROUSEL_ADS for carousel images.',
          );
      });
    if (!named) {
      // Nothing it names: the sentence above says so, and the rules of a post that follow are the identity's.
    } else if (named === 'pull') {
      const post = collect(found, () => {
        if (!numeric(ci.tiktok_item_id))
          invalid(at + '.tiktok_item_id', 'tiktok_item_id must be the numeric ID of an existing TikTok post.');
      });
      if (post) {
        collect(found, () => {
          if (items.has(ci.tiktok_item_id as string))
            invalid(at + '.tiktok_item_id', 'Post ' + ci.tiktok_item_id + ' appears more than once.');
        });
        items.add(ci.tiktok_item_id as string);
      }
    } else checkUpload(ci, named, at, found, uploads);
    collect(found, () => {
      if (typeof ci.identity_type !== 'string' || !identityTypes[kind].includes(ci.identity_type))
        invalid(
          at + '.identity_type',
          kind === 'pull'
            ? 'identity_type must be TT_USER, BC_AUTH_TT or AUTH_CODE for an existing post; custom identities are not qualified.'
            : 'identity_type must be TT_USER or BC_AUTH_TT for an upload (Spark Ads Push); custom identities are not qualified, and an authorization-code identity names an existing post.',
        );
    });
    collect(found, () => {
      if (typeof ci.identity_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ci.identity_id))
        invalid(
          at + '.identity_id',
          kind === 'pull'
            ? 'identity_id must be the TikTok account identity that owns the post.'
            : 'identity_id must be the TikTok account identity the upload is published under.',
        );
    });
    collect(found, () => {
      if (
        (ci.identity_type === 'BC_AUTH_TT') !== (ci.identity_authorized_bc_id !== undefined) ||
        (ci.identity_authorized_bc_id !== undefined && !numeric(ci.identity_authorized_bc_id))
      )
        invalid(
          at + '.identity_authorized_bc_id',
          'identity_authorized_bc_id is the Business Center ID, required for BC_AUTH_TT and only for it.',
        );
    });
  });
  const kind = listKind(list);
  collect(found, () => {
    if (kind === 'mixed')
      invalid(
        'creative_list',
        'creative_list mixes existing posts (Spark Ads Pull) with uploads (Spark Ads Push); TikTok’s combinations are all posts, or uploaded videos and carousels.',
      );
  });
  return kind;
}
/** The video, cover, images and music of an upload (Spark Ads Push), and a repeat of one already in the list. */
function checkUpload(
  ci: JsonObject,
  kind: 'video' | 'carousel',
  at: string,
  found: Violation[],
  seen: Set<string>,
): void {
  const images = Array.isArray(ci.image_info) ? ci.image_info : undefined,
    imagesOk = collect(found, () => {
      const only = (e: unknown) => obj(e) && Object.keys(e).every(k => k === 'web_uri') && imageId(e.web_uri);
      if (kind === 'video') {
        if (!images || images.length !== 1 || !only(images[0]))
          invalid(
            at + '.image_info',
            'A video needs its cover: image_info with exactly one {web_uri}, the ID of an image in the advertiser’s library.',
          );
      } else if (!images || !images.length || images.length > maxCarouselImages || !images.every(only))
        invalid(
          at + '.image_info',
          'A carousel needs 1-35 images: image_info with one {web_uri} each, the ID of an image in the advertiser’s library.',
        );
    });
  if (kind === 'video') {
    const ok = collect(found, () => {
      const v = ci.video_info;
      if (
        !obj(v) ||
        Object.keys(v).some(k => k !== 'video_id') ||
        typeof v.video_id !== 'string' ||
        !videoIdPattern.test(v.video_id)
      )
        invalid(
          at + '.video_info',
          'video_info is {video_id}: the ID of a video in the advertiser’s library (from amcp_media or the library search).',
        );
    });
    if (ok && imagesOk) {
      const key = 'video:' + (ci.video_info as JsonObject).video_id + ':' + (images![0] as JsonObject).web_uri;
      collect(found, () => {
        if (seen.has(key))
          invalid(
            at + '.video_info',
            'Video ' + (ci.video_info as JsonObject).video_id + ' with this cover appears more than once.',
          );
      });
      seen.add(key);
    }
    return;
  }
  const music = collect(found, () => {
    const m = ci.music_info;
    if (
      !obj(m) ||
      Object.keys(m).some(k => k !== 'music_id') ||
      typeof m.music_id !== 'string' ||
      !musicIdPattern.test(m.music_id)
    )
      invalid(at + '.music_info', 'A carousel needs its music: music_info is {music_id}.');
  });
  collect(found, () => {
    const n = ci.material_name;
    if (n !== undefined && (typeof n !== 'string' || width(n) > maxMaterialName))
      invalid(
        at + '.material_name',
        'material_name is the carousel’s own name: at most 255 characters (Chinese and Japanese count twice).',
      );
  });
  if (music && imagesOk) {
    const key =
      'carousel:' +
      (images as JsonObject[]).map(e => e.web_uri).join(',') +
      ':' +
      (ci.music_info as JsonObject).music_id;
    collect(found, () => {
      if (seen.has(key)) invalid(at + '.image_info', 'A carousel of the same images and music appears more than once.');
    });
    seen.add(key);
  }
}
/**
 * The ad texts of a Spark Ad Push ("Create an Upgraded Smart+ Ad", read 2026-11-21): "Required when tiktok_item_id is not specified",
 * "Max size: 5", each `ad_text` a text. The page states no length for an ad text, so none is invented here. A post-based ad takes none
 * ("Do not specify ... ad_text_list"), which `assertTiktokSmartPlusAd` refuses where it refused it before. `required`: a create needs
 * them for an upload, and an edit only checks what it sends.
 */
export function checkAdTexts(texts: unknown, kind: ListKind | undefined, found: Violation[], required: boolean): void {
  if (kind === 'pull') return;
  if (texts === undefined) {
    if (required && kind !== undefined)
      collect(found, () =>
        invalid('ad_text_list', 'An uploaded video or carousel needs ad_text_list: 1-5 ad texts, each {ad_text}.'),
      );
    return;
  }
  collect(found, () => {
    if (
      !Array.isArray(texts) ||
      !texts.length ||
      texts.length > maxAdTexts ||
      !texts.every(
        t =>
          obj(t) &&
          Object.keys(t).every(k => k === 'ad_text') &&
          typeof t.ad_text === 'string' &&
          t.ad_text.trim() !== '',
      )
    )
      invalid('ad_text_list', 'ad_text_list holds 1-5 ad texts, each {ad_text} with a nonblank text.');
  });
} /** Exactly one http or https landing page: its URL, or undefined when the list is not that (the violation is recorded in `found`). */
export function checkLandingPage(pages: unknown, found: Violation[]): string | undefined {
  const exact = collect(found, () => {
    if (
      !Array.isArray(pages) ||
      pages.length !== 1 ||
      !obj(pages[0]) ||
      Object.keys(pages[0]).some(k => k !== 'landing_page_url') ||
      !webUrl(pages[0].landing_page_url)
    )
      invalid(
        'landing_page_url_list',
        'landing_page_url_list must hold exactly one {landing_page_url} with an http or https URL.',
      );
  });
  return exact ? ((pages as JsonObject[])[0]!.landing_page_url as string) : undefined;
}
/**
 * The CTA portfolio, both automatic switches and product information; UTM parameters are checked against the landing page when it
 * is known. Every rule is run, and each violation is recorded in `found` (r25-field-tiktok, #6).
 *
 * `patch` (r25-m4-smartedits, the `ad_configuration_patch` of an edit): the object is a subset of these keys that an edit merges into the
 * ad's current configuration, so no key is required, a present key is checked by its own rule, and a violation names its field under
 * `ad_configuration_patch`.
 */
export function checkAdConfiguration(
  ac: unknown,
  url: string | undefined,
  found: Violation[],
  patch = false,
  darkPost: 'on' | 'any' = 'on',
): void {
  const at = patch ? 'ad_configuration_patch.' : 'ad_configuration.';
  // The two sentences are direct arguments of `invalid`, because the localization inventory reads no other form (tools/check-locales.mjs).
  const object = collect(found, () => {
    if (patch) {
      if (!obj(ac) || !Object.keys(ac).length)
        invalid(
          'ad_configuration_patch',
          'ad_configuration_patch must be an object naming at least one key to change.',
        );
    } else if (!obj(ac))
      invalid('ad_configuration', 'ad_configuration must set call_to_action_id and both automatic creative switches.');
  });
  if (!object) return;
  const c = ac as JsonObject;
  for (const akey of Object.keys(c).filter(k => !configKeys.includes(k)))
    collect(found, () => invalid(at + akey, '"' + akey + '" is outside the qualified Smart+ Spark Ad contract.'));
  collect(found, () => {
    if ((!patch || c.call_to_action_id !== undefined) && !numeric(c.call_to_action_id))
      invalid(
        at + 'call_to_action_id',
        'Spark Ads on TikTok need a dynamic CTA: set call_to_action_id to a CTA portfolio ID.',
      );
  });
  collect(found, () => {
    if ((!patch || c.creative_auto_add_toggle !== undefined) && typeof c.creative_auto_add_toggle !== 'boolean')
      invalid(
        at + 'creative_auto_add_toggle',
        'Set creative_auto_add_toggle to true or false; its default depends on allowlist status.',
      );
  });
  collect(found, () => {
    const e = c.creative_auto_enhancement_strategy_list;
    if (
      (!patch || e !== undefined) &&
      (!Array.isArray(e) || !e.every(v => enhancements.includes(v)) || new Set(e).size !== e.length)
    )
      invalid(
        at + 'creative_auto_enhancement_strategy_list',
        'Set creative_auto_enhancement_strategy_list to a list, possibly empty, of ' +
          enhancements.join(', ') +
          '; its default depends on allowlist status.',
      );
  });
  // Product information (r25-field-tiktok, #6): TikTok returns the mode with every ad (UNSET, NON_CATALOG or CATALOG; UNSET is
  // the default and switches it off), so a body copied from a read carries it. Only UNSET is qualified.
  collect(found, () => {
    if (c.product_info_enabled !== undefined && c.product_info_enabled !== 'UNSET')
      invalid(
        at + 'product_info_enabled',
        'Set product_info_enabled to UNSET or leave it out: product information (NON_CATALOG or CATALOG) is outside the qualified Smart+ Spark Ad contract.',
      );
  });
  // The two defaults TikTok returns with every ad (r25-m4-smartedits; "Create an Upgraded Smart+ Ad", read 2026-11-20): without a
  // catalog product_specific_type "can only be set to UNSET", and dark_post_status is ON by default. Each is accepted at that value
  // only, so a body copied from a read passes and any other value stays outside the contract.
  collect(found, () => {
    if (c.product_specific_type !== undefined && c.product_specific_type !== 'UNSET')
      invalid(
        at + 'product_specific_type',
        'Set product_specific_type to UNSET or leave it out: UNSET is its only value without a catalog, and catalogs are outside the qualified Smart+ Spark Ad contract.',
      );
  });
  // r25-m4b-smartpush (A3; the owner's O1, 2026-11-21): ON (ads only: the post is shown through ads and not on the identity's profile) is
  // the default, and OFF (the post also appears on the profile and can earn organic reach) is "Valid only when you create Spark Ads
  // through Spark Ads Push", so it is accepted for an upload when the request states it and for nothing else. `darkPost` is `any` where
  // the creatives are uploads or not yet known (an edit that sends no creatives: the ad it edits decides, in its prerequisites).
  collect(found, () => {
    const status = c.dark_post_status;
    if (status === undefined || status === 'ON' || (darkPost === 'any' && status === 'OFF')) return;
    if (darkPost === 'any')
      invalid(
        at + 'dark_post_status',
        'Set dark_post_status to ON (ads only) or OFF (the post also appears on the identity’s profile), or leave it out.',
      );
    invalid(
      at + 'dark_post_status',
      'Set dark_post_status to ON or leave it out: ON is its default, and other values are outside the qualified Smart+ Spark Ad contract.',
    );
  });
  // catalog_creative_toggle (S3-8, the lead's review; "Create an Upgraded Smart+ Ad", read 2026-11-21): "Whether to enable auto-selection of
  // creatives from your catalog", valid only when catalog_enabled is true at the campaign level, default false. It is accepted at false
  // only, so that a body copied from a read passes and catalogs stay outside the contract.
  collect(found, () => {
    if (c.catalog_creative_toggle !== undefined && c.catalog_creative_toggle !== false)
      invalid(
        at + 'catalog_creative_toggle',
        'Set catalog_creative_toggle to false or leave it out: false is its default, and catalogs are outside the qualified Smart+ Spark Ad contract.',
      );
  });
  // The pixel (T5, r25-m4-smartedits): TikTok documents eleven keys under tracking_info ("Create an Upgraded Smart+ Ad"); only
  // tracking_pixel_id is qualified, and brand_safety_postbid_partner at the UNSET a read returns, so that a body copied from a read
  // passes. Every other key is refused with its own field. Where a pixel is allowed is the state's (src/tiktok-smart-plus-pixels.ts);
  // here it only has to be a pixel ID, or "0" (none, as TikTok reads it).
  if (c.tracking_info !== undefined) {
    const info = c.tracking_info;
    const shaped = collect(found, () => {
      if (!obj(info))
        invalid(
          at + 'tracking_info',
          'tracking_info must be an object with tracking_pixel_id, the only qualified key.',
        );
    });
    if (shaped) {
      const t = info as JsonObject;
      for (const tkey of Object.keys(t).filter(k => !['tracking_pixel_id', 'brand_safety_postbid_partner'].includes(k)))
        collect(found, () =>
          invalid(
            at + 'tracking_info.' + tkey,
            '"tracking_info.' + tkey + '" is outside the qualified Smart+ Spark Ad contract.',
          ),
        );
      collect(found, () => {
        if (t.tracking_pixel_id !== undefined && t.tracking_pixel_id !== '0' && !numeric(t.tracking_pixel_id))
          invalid(
            at + 'tracking_info.tracking_pixel_id',
            'tracking_pixel_id must be the numeric ID of a pixel, or "0" for none.',
          );
      });
      collect(found, () => {
        if (t.brand_safety_postbid_partner !== undefined && t.brand_safety_postbid_partner !== 'UNSET')
          invalid(
            at + 'tracking_info.brand_safety_postbid_partner',
            'Set brand_safety_postbid_partner to UNSET or leave it out: brand safety partners are outside the qualified Smart+ Spark Ad contract.',
          );
      });
    }
  }
  if (c.utm_params !== undefined) {
    const u = c.utm_params;
    const shaped = collect(found, () => {
      if (
        !Array.isArray(u) ||
        !u.length ||
        u.length > 14 ||
        !u.every(
          p =>
            obj(p) &&
            Object.keys(p).every(k => k === 'key' || k === 'value') &&
            typeof p.key === 'string' &&
            p.key.trim() !== '' &&
            [...p.key].length <= 100 &&
            typeof p.value === 'string' &&
            [...p.value].length <= 600,
        )
      )
        invalid(
          at + 'utm_params',
          'utm_params holds 1-14 {key,value} pairs (keys up to 100 characters, values up to 600).',
        );
    });
    if (shaped && url !== undefined) collect(found, () => assertUtmMatch(u, url));
  }
}
/** utm_params only record the parameters already in the landing page URL; TikTok does not append them. */
export function assertUtmMatch(utm: unknown, url: string): void {
  const sent = [...new URL(url).searchParams.entries()].map(([key, value]) => key + '=' + value).sort(),
    listed = (Array.isArray(utm) ? utm : []).map((p: JsonObject) => p?.key + '=' + p?.value).sort();
  if (JSON.stringify(listed) !== JSON.stringify(sent))
    invalid(
      'ad_configuration.utm_params',
      'utm_params only record the parameters already in landing_page_url, exactly; TikTok does not append them.',
    );
}

type Read = {path: string; query: JsonObject; action: string; push?: PushRead};
export function tiktokSmartPlusAdReads(plan: CompiledRequest): Read[] {
  const b = plan.body as JsonObject,
    id = plan.accountId,
    filtering = {adgroup_ids: [b.adgroup_id]};
  const reads: Read[] = [
    {
      path: '/v1.3/smart_plus/adgroup/get/',
      query: {advertiser_id: id, filtering, page_size: 100},
      action: 'tiktok_smart_plus_adgroup_get',
    },
    {
      path: tiktokSmartPlusAdGetPath,
      query: {advertiser_id: id, filtering, page_size: 100},
      action: 'tiktok_smart_plus_ad_get',
    },
  ];
  reads.push(...sparkReads(id, b.creative_list as JsonObject[]), ...(assetReads(id, b.creative_list) as AssetRead[]));
  if (b.page_list !== undefined) reads.push(tiktokInstantFormRead(id));
  reads.push({
    path: tiktokPortfolioGetPath,
    query: {advertiser_id: id, creative_portfolio_id: (b.ad_configuration as JsonObject).call_to_action_id},
    action: 'tiktok_creative_portfolio_get',
  });
  // The pixel list, when the ad names a pixel (r25-m4-smartedits, T5); the ad group it is judged against is read above.
  const pixel = tiktokAdPixel(b.ad_configuration);
  if (pixel !== undefined) reads.push(tiktokAdPixelRead(id, pixel));
  return reads;
}
/** Each identity of a creative list, and its posts (at most `postsPerRead` per read). */
export function sparkReads(accountId: string | undefined, list: JsonObject[]): Read[] {
  return identities(list).flatMap(i => {
    const who = {
      advertiser_id: accountId,
      identity_type: i.type,
      identity_id: i.id,
      ...(i.bc !== undefined ? {identity_authorized_bc_id: i.bc} : {}),
    };
    const items = [...i.items].sort(),
      chunks = Array.from({length: Math.ceil(items.length / postsPerRead)}, (_, n) =>
        items.slice(n * postsPerRead, (n + 1) * postsPerRead),
      );
    return [
      // The identity of an upload also keeps whether it can publish (the review of a post-based ad keeps what it always kept).
      {
        path: identityInfoPath,
        query: who,
        action: 'tiktok_identity_info_get',
        ...(i.push ? {push: 'identity' as const} : {}),
      },
      ...chunks.map(item_ids => ({
        path: tiktokIdentityVideoInfoPath,
        query: {...who, item_ids},
        action: 'tiktok_identity_video_info_get',
      })),
    ];
  });
}
/** The ads of one ad group, read to count them; the status family reads ads by their own IDs instead. */
const adgroupAdsRead = (read: CompiledRequest) =>
  read.gateway === 'tiktok_native_action' &&
  read.path === tiktokSmartPlusAdGetPath &&
  obj(read.query?.filtering) &&
  Array.isArray(read.query.filtering.adgroup_ids) &&
  read.query.filtering.smart_plus_ad_ids === undefined;
export function validateTiktokSmartPlusAdState(
  read: CompiledRequest,
  data: JsonObject,
  sameIds: (actual: unknown[], expected: unknown[]) => void,
): boolean {
  if (adgroupAdsRead(read)) {
    const list = data.data?.list,
      total = data.data?.page_info?.total_number,
      group = String((read.query.filtering as JsonObject).adgroup_ids[0]);
    if (
      data.code !== 0 ||
      !Array.isArray(list) ||
      list.some((r: JsonObject) => String(r?.adgroup_id) !== group) ||
      (total !== undefined && total !== list.length)
    )
      throw new MirrorError('STATE_READ_FAILED', 'TikTok must return every ad of the ad group on one page.');
    return true;
  }
  // The library reads of an upload (r25-m4b-smartpush): every ID asked for comes back, or the asset is not this advertiser's to use.
  const library = assetAnswer(read, data);
  if (library) {
    if (data.code !== 0 || !Array.isArray(data.data?.list))
      throw new MirrorError('STATE_READ_FAILED', 'TikTok must confirm success and list the library assets asked for.');
    const missing = library.requested.filter(id => !library.returned.includes(id));
    if (library.returned.some(id => !library.requested.includes(id)))
      throw new MirrorError('STATE_TARGET_MISMATCH', 'TikTok listed a library asset that was not asked for.');
    if (missing.length)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        (pushReadOf(read) === 'video' ? 'Video ' : 'Image ') +
          missing.slice(0, 5).join(', ') +
          (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : '') +
          (missing.length === 1 ? ' is' : ' are') +
          ' not in the selected advertiser’s library, or cannot be used in ads.',
        {[pushReadOf(read) + '_ids']: missing.slice(0, 20)},
      );
    return true;
  }
  if (read.gateway === 'tiktok_native_action' && read.path === tiktokIdentityVideoInfoPath) {
    if (data.code !== 0 || !Array.isArray(data.data?.video_details))
      throw new MirrorError('STATE_READ_FAILED', 'TikTok post state must confirm success and contain video_details.');
    sameIds(
      data.data.video_details.map((r: JsonObject) => r?.item_id),
      read.query.item_ids as unknown[],
    );
    return true;
  }
  return false;
}
/**
 * What a review keeps of the ads of the ad group a Smart+ ad is created in (r25-field-tiktok, #7): the ad group, and whether it has
 * room for another ad; a full group also keeps its count, so that the refusal can say how many ads it has. It used to keep the
 * sorted IDs of the ads, so another ad created in the group, by this client's other review or by anyone, changed the hash and made
 * every other prepared create STATE_CHANGED. The create depends on its siblings only through TikTok's limit of 30 ads per ad group,
 * which `tiktokSmartPlusAdPrerequisites` checks on a fresh read at prepare and again at execute, before the states are compared; an
 * identical create that completed since prepare is refused by the guard against creating twice (src/write-duplicates.ts), so the
 * sibling IDs protected nothing. The counter in another form is the one M1's rule leaves out of a review's state.
 */
const adsOfGroup = (adgroup: string, count: number): JsonObject => ({
  adgroup_id: adgroup,
  at_limit: count >= maxAds,
  ...(count >= maxAds ? {ad_count: count} : {}),
});
/** Review state without signed media URLs, which change on every read, so an unchanged post or identity compares equal. */
export function tiktokSmartPlusAdState(read: CompiledRequest, d: JsonObject): JsonObject | undefined {
  const asset = assetState(read, d);
  if (asset) return asset;
  if (adgroupAdsRead(read)) {
    const group = String((read.query.filtering as JsonObject).adgroup_ids[0]),
      saved = obj(d.data) && obj(d.data.adgroup_ads) ? d.data.adgroup_ads : undefined;
    // A review prepared before this projection saved the sorted IDs of the ads: it is mapped to the same two facts, so that it
    // still executes after the upgrade (execute projects the saved state again).
    if (saved && Array.isArray(saved.smart_plus_ad_ids))
      return {data: {adgroup_ads: adsOfGroup(String(saved.adgroup_id ?? group), saved.smart_plus_ad_ids.length)}};
    if (saved) return {data: {adgroup_ads: saved}};
    if (!Array.isArray(d.data?.list)) return;
    return {data: {adgroup_ads: adsOfGroup(group, d.data.list.length)}};
  }
  if (read.gateway === 'tiktok_native_action' && read.path === identityInfoPath && obj(d.data?.identity_info)) {
    const i = d.data.identity_info;
    return {
      data: {
        identity_info: {
          identity_id: i.identity_id ?? null,
          identity_type: i.identity_type ?? null,
          identity_authorized_bc_id: i.identity_authorized_bc_id ?? null,
          available_status: i.available_status ?? null,
          can_pull_video: i.can_pull_video ?? null,
          is_gpppa: i.is_gpppa ?? null,
          // Only for an identity an upload is published under (r25-m4b-smartpush; "Get info about an identity", read 2026-11-21).
          ...(pushReadOf(read) === 'identity' ? {can_push_video: i.can_push_video ?? null} : {}),
        },
      },
    };
  }
  if (
    read.gateway === 'tiktok_native_action' &&
    read.path === tiktokIdentityVideoInfoPath &&
    Array.isArray(d.data?.video_details)
  ) {
    return {
      data: {
        identity_type: String(read.query.identity_type),
        identity_id: String(read.query.identity_id),
        video_details: d.data.video_details
          .map((r: JsonObject) => ({
            item_id: String(r?.item_id),
            item_type: r?.item_type ?? null,
            status: r?.status ?? null,
            // "Get info about TikTok posts" returns `auth_info` only for an AUTH_CODE identity: the authorization the post is used under.
            ...(obj(r?.auth_info) || r?.ad_auth_status !== undefined
              ? {ad_auth_status: (obj(r?.auth_info) ? r.auth_info.ad_auth_status : r.ad_auth_status) ?? null}
              : {}),
          }))
          .sort(order),
      },
    };
  }
}
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdPrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (!tiktokSmartPlusAdKind(plan)) return;
  const b = plan.body as JsonObject,
    data = values.map(v => (obj(v) && obj(v.data) ? v.data : undefined)).filter((d): d is JsonObject => !!d);
  const group = data
    .flatMap(d => (Array.isArray(d.list) ? d.list : []))
    .find((r: JsonObject) => String(r?.adgroup_id) === b.adgroup_id && Object.hasOwn(r, 'promotion_type')) as
    JsonObject | undefined;
  if (!group)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ ad group ' + b.adgroup_id + ' was not returned for the selected advertiser.',
      {adgroup_id: b.adgroup_id},
    );
  // A row that carries a catalog is a catalog campaign's (an empty or zero catalog_id is none).
  const catalog =
      group.catalog_id !== undefined && group.catalog_id !== null && !['', '0'].includes(String(group.catalog_id)),
    website =
      group.promotion_type === 'WEBSITE' && websiteGoals.includes(group.optimization_goal as string) && !catalog,
    lead =
      group.promotion_type === 'LEAD_GENERATION' &&
      group.promotion_target_type === 'INSTANT_PAGE' &&
      group.optimization_goal === 'LEAD_GENERATION';
  if (!website && !lead)
    invalid(
      'adgroup_id',
      'adgroup_id ' +
        b.adgroup_id +
        ' is not an ad group these Spark Ads can be created in. The qualified kinds are a website ad group (WEBSITE) that optimizes for ' +
        websiteGoals.join(', ').replace(/, ([A-Z_]+)$/, ' or $1') +
        ' and uses no catalog, and an Instant Form lead generation ad group (LEAD_GENERATION, INSTANT_PAGE); this one is ' +
        (catalog
          ? 'a catalog ad group (its row has a catalog_id), which is not qualified'
          : (token(group.promotion_type) ?? 'of an unknown kind') +
            (token(group.promotion_target_type) ? ' (' + token(group.promotion_target_type) + ')' : '') +
            (token(group.optimization_goal) ? ' with the goal ' + token(group.optimization_goal) : '')) +
        '.',
    );
  if (website && b.page_list !== undefined)
    invalid(
      'page_list',
      'Ad group ' + b.adgroup_id + ' is a website ad group; its ads need landing_page_url_list, not an Instant Form.',
    );
  if (lead && b.page_list === undefined)
    invalid(
      'page_list',
      'Ad group ' +
        b.adgroup_id +
        ' collects leads with an Instant Form; its ads need page_list with the form, not a landing page.',
    );
  // T5 (r25-m4-smartedits): an Instant Form lead ad may name a pixel; a website ad takes none of its own, as its pixel is its ad group's.
  const pixel = tiktokAdPixel(b.ad_configuration);
  if (pixel !== undefined) tiktokRefuseCreatedPixel(tiktokPixelGroupKind(group));
  if (
    group.placement_type === 'PLACEMENT_TYPE_NORMAL' &&
    !(Array.isArray(group.placements) && group.placements.includes('PLACEMENT_TIKTOK'))
  )
    invalid(
      'adgroup_id',
      'Ad group ' + b.adgroup_id + ' excludes the TikTok placement; the Spark Ads in this contract deliver on TikTok.',
    );
  const ads = data.find(d => obj(d.adgroup_ads))?.adgroup_ads as JsonObject | undefined;
  if (!ads) throw new MirrorError('STATE_READ_FAILED', 'The ads of ad group ' + b.adgroup_id + ' were not read.');
  if (ads.at_limit === true)
    invalid(
      'adgroup_id',
      'Ad group ' +
        b.adgroup_id +
        ' already has ' +
        ads.ad_count +
        ' ads; an Upgraded Smart+ ad group holds at most ' +
        maxAds +
        '.',
    );
  sparkPrerequisites(b.creative_list as JsonObject[], data);
  if (b.page_list !== undefined)
    tiktokInstantFormCheck((b.page_list as JsonObject[])[0]!.page_id as string, values, invalid);
  tiktokCtaPortfolioCheck(
    (b.ad_configuration as JsonObject).call_to_action_id as string,
    values,
    'ad_configuration.call_to_action_id',
  );
  if (pixel !== undefined) tiktokAdPixelPrerequisites(pixel, group, b.adgroup_id as string, values);
}
/** Each identity is available, may use its posts, is not a political account and is in the stated Business Center; each post is its own, of the matching type. */
export function sparkPrerequisites(list: JsonObject[], data: JsonObject[]): void {
  for (const i of identities(list)) {
    const info = data
        .map(d => d.identity_info)
        .find((r: JsonObject) => obj(r) && String(r.identity_id) === i.id && r.identity_type === i.type) as
        JsonObject | undefined,
      field = 'creative_list.identity_id';
    if (!info)
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Identity ' + i.id + ' (' + i.type + ') was not returned for the selected advertiser.',
        {identity_id: i.id},
      );
    if (i.bc !== undefined && String(info.identity_authorized_bc_id) !== i.bc)
      invalid(
        field,
        'Identity ' + i.id + ' belongs to Business Center ' + info.identity_authorized_bc_id + ', not ' + i.bc + '.',
      );
    // "Get info about an identity" (read 2026-11-21): available_status and can_pull_video are valid for TT_USER and BC_AUTH_TT only, so an
    // authorization-code identity is judged by the authorization of its posts (below). An upload needs can_push_video, not can_pull_video.
    if (i.type !== 'AUTH_CODE') {
      if (info.available_status !== 'AVAILABLE')
        invalid(field, 'Identity ' + i.id + ' is not available (' + (info.available_status ?? 'no status') + ').');
      if (i.items.length && info.can_pull_video !== true)
        invalid(field, 'Identity ' + i.id + ' cannot use its existing posts in ads (can_pull_video is not true).');
      if (i.push && info.can_push_video !== true)
        invalid(field, 'Identity ' + i.id + ' cannot publish uploads in ads (can_push_video is not true).');
    }
    if (info.is_gpppa === true)
      invalid(
        field,
        'Identity ' + i.id + ' is a government, politician or political party account, which cannot run Spark Ads.',
      );
    // The posts of one identity may be read in several chunks (A1: up to 50 posts, 20 per read).
    const posts = data
      .filter(d => d.identity_id === i.id && d.identity_type === i.type && Array.isArray(d.video_details))
      .flatMap(d => d.video_details as JsonObject[]);
    for (const c of infos(list).filter(
      c => c.identity_id === i.id && c.identity_type === i.type && typeof c.tiktok_item_id === 'string',
    )) {
      const post = posts.find(p => p.item_id === c.tiktok_item_id);
      if (!post)
        throw new MirrorError(
          'STATE_TARGET_MISMATCH',
          'Post ' + c.tiktok_item_id + ' was not returned for identity ' + i.id + '.',
          {tiktok_item_id: c.tiktok_item_id},
        );
      if (post.item_type !== formats[c.ad_format as string])
        invalid(
          'creative_list.ad_format',
          'Post ' +
            c.tiktok_item_id +
            ' is a ' +
            (post.item_type ?? 'unknown') +
            ' post; ' +
            c.ad_format +
            ' needs a ' +
            formats[c.ad_format as string] +
            ' post.',
        );
      // An authorization-code post is used under the authorization its post read carries (P12: auth_info, AUTH_CODE only).
      if (i.type === 'AUTH_CODE' && post.ad_auth_status !== 'AUTHORIZED')
        invalid(
          'creative_list.tiktok_item_id',
          'Post ' +
            c.tiktok_item_id +
            ' is not authorized to this advertiser (authorization status ' +
            (typeof post.ad_auth_status === 'string' && /^[A-Z_]{1,32}$/.test(post.ad_auth_status)
              ? post.ad_auth_status
              : 'unknown') +
            ').',
        );
    }
  }
  // A carousel image TikTok marks unusable in a carousel ("Search for images": is_carousel_usable false) is refused with the carousel it is in.
  const usable = new Map<string, unknown>();
  for (const d of data)
    for (const r of Array.isArray(d.images) ? d.images : []) if (obj(r)) usable.set(String(r.id), r.is_carousel_usable);
  list.forEach((c, n) => {
    const flat =
      creativeKind(c.creative_info) === 'carousel'
        ? imagesOf(c.creative_info).filter(id => usable.get(id) === false)
        : [];
    if (flat.length)
      invalid(
        'creative_list[' + n + '].creative_info.image_info',
        'Image ' +
          flat.slice(0, 3).join(', ') +
          (flat.length === 1 ? ' is' : ' are') +
          ' not usable in a carousel (is_carousel_usable is false in the advertiser’s library).',
      );
  });
}
export function tiktokSmartPlusAdImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    ac = b.ad_configuration as JsonObject,
    data = state.map(v => (obj(v) && obj(v.data) ? v.data : undefined));
  const group = data
    .flatMap(d => (Array.isArray(d?.list) ? d.list : []))
    .find((r: JsonObject) => String(r?.adgroup_id) === b.adgroup_id) as JsonObject | undefined;
  const ads = data.find(d => obj(d?.adgroup_ads))?.adgroup_ads as JsonObject | undefined;
  // What the ad is made of (r25-m4b-smartpush): existing posts as before, or uploads published as posts of the identity (Spark Ads Push).
  const push = listKind(b.creative_list) === 'push',
    dark = ac.dark_post_status === 'OFF' ? 'OFF' : 'ON',
    what = push
      ? creatives(b).length + ' uploaded creative(s) (Spark Ads Push)'
      : creatives(b).length + ' existing TikTok post(s)',
    // The post of an upload is published under the identity: ads only keeps it off the profile, and OFF puts it there too (the owner's O1).
    profile = push
      ? dark === 'OFF'
        ? ' The posts will also appear on the identity’s TikTok profile and can earn organic views (dark_post_status OFF).'
        : ' The posts are shown through ads only, not on the identity’s TikTok profile (dark_post_status ON).'
      : '';
  return {
    provider: 'tiktok',
    scope: 'smart_plus_ads',
    // An ad created ENABLE under an ad group and campaign the review reads serving (Q1, owner 2026-11-15; R2.5 M4, r25-m4-smartops) starts
    // serving at once, so execute asks for spend_change_confirmed (src/tiktok-serving-children.ts).
    may_affect_serving: activeUnderServingParent(plan, state),
    // An ad created ENABLE (Q14, L1-05) under an ad group or campaign the review read paused delivers nothing until that ad group is
    // enabled, or, when the ad group serves, until its campaign is. Under parents that serve it serves at once (Q1); under a parent the
    // review could not read it is refused before this is shown (PARENT_SERVING).
    effect: activeUnderServingParent(plan, state)
      ? 'Creates an enabled Upgraded Smart+ ad from ' +
        what +
        ' in an ad group and campaign the review reads as serving: it starts serving at once (Q1), so execute needs spend_change_confirmed.' +
        profile
      : b.operation_status === 'ENABLE'
        ? 'Creates an enabled Upgraded Smart+ ad from ' +
          what +
          '; nothing delivers until ' +
          (group?.operation_status === 'DISABLE' ? 'its ad group' : 'the campaign') +
          ' is enabled.' +
          profile
        : 'Creates a paused Upgraded Smart+ ad from ' + what + '; nothing delivers until the ad is enabled.' + profile,
    ad_group: {
      adgroup_id: b.adgroup_id,
      operation_status: group?.operation_status ?? null,
      placement_type: group?.placement_type ?? null,
      // Whether the ad group has room for this ad (the review keeps that, not the number of its ads: r25-field-tiktok, #7).
      at_limit: typeof ads?.at_limit === 'boolean' ? ads.at_limit : null,
      limit: maxAds,
    },
    // A post is shown as it always was; an upload by what it is made of (its video and cover, or its images and music).
    creatives: creatives(b).map(c => {
      const kind = creativeKind(c),
        who = {ad_format: c.ad_format, identity_type: c.identity_type, identity_id: c.identity_id};
      return kind === 'video'
        ? {kind, video_id: videoOf(c), cover_image_id: imagesOf(c)[0], ...who, ...bcOf(c)}
        : kind === 'carousel'
          ? {
              kind,
              image_count: imagesOf(c).length,
              image_ids: imagesOf(c),
              music_id: musicOf(c),
              ...(typeof c.material_name === 'string' && c.material_name !== ''
                ? {material_name: c.material_name}
                : {}),
              ...who,
              ...bcOf(c),
            }
          : {tiktok_item_id: c.tiktok_item_id, ...who};
    }),
    ...(push
      ? {
          ad_texts: (b.ad_text_list as JsonObject[]).map(t => t.ad_text),
          // The owner's O1 (2026-11-21): ads only unless the request says otherwise.
          dark_post: {
            dark_post_status: dark,
            meaning: darkPostMeaning(dark),
          },
        }
      : {}),
    destination:
      b.page_list !== undefined
        ? {instant_form: (b.page_list as JsonObject[])[0]!.page_id}
        : {landing_page_url: (b.landing_page_url_list as JsonObject[])[0]!.landing_page_url},
    call_to_action_id: ac.call_to_action_id,
    automatic_creative: {
      creative_auto_add_toggle: ac.creative_auto_add_toggle,
      creative_auto_enhancement_strategy_list: ac.creative_auto_enhancement_strategy_list,
      fixed_after_creation:
        'TRANSLATE_AND_DUB cannot be added or removed later (' +
        ((ac.creative_auto_enhancement_strategy_list as string[]).includes('TRANSLATE_AND_DUB')
          ? 'included'
          : 'excluded') +
        ').',
    },
    source: tiktokSmartPlusAdSource,
  };
}
export const tiktokSmartPlusAdId = (d: JsonObject) =>
  obj(d.data) && numeric(d.data.smart_plus_ad_id) ? d.data.smart_plus_ad_id : undefined;
const blank = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
/**
 * The Business Center of a creative's identity as a read-back shows it: "Create an Upgraded Smart+ Ad" (read 2026-11-21) returns
 * `identity_authorized_bc_id` "0" for an identity that is not a Business Center one (TT_USER, AUTH_CODE), where the request sent none.
 * "0" is no Business Center (an ID AMCP sends starts with 1 to 9), so it reads as none, on the sent side and on the read side alike.
 */
const businessCenterOf = (v: unknown) => {
  const id = blank(v);
  return id === '0' ? null : id;
};
/** The ad in comparable form: selected posts, landing pages and UTM parameters as sets. Other fields stay for status checks. */
/** A creative in comparable form: a post by its ID, an upload by its video, images (a set) and music. */
function projectCreative(ci: JsonObject, uploads: boolean | undefined): JsonObject {
  const video = blank(videoOf(ci)),
    images = imagesOf(ci),
    item = blank(ci.tiktok_item_id),
    who = {
      ad_format: ci.ad_format ?? null,
      identity_type: ci.identity_type ?? null,
      identity_id: blank(ci.identity_id),
      identity_authorized_bc_id: businessCenterOf(ci.identity_authorized_bc_id),
    };
  return (uploads ?? (item === null && (video !== null || images.length > 0)))
    ? {...who, video_id: video, image_ids: [...images].sort(), music_id: blank(musicOf(ci))}
    : {...who, tiktok_item_id: item};
}
export function tiktokSmartPlusAdProjection(row: unknown): JsonObject | undefined {
  if (!obj(row)) return;
  const out: JsonObject = {...row};
  // Each explicitly selected creative's status, by ad material ID, for creative status checks.
  if (
    Array.isArray(row.creative_list) &&
    row.creative_list.some((c: JsonObject) => obj(c) && c.ad_material_id !== undefined)
  )
    out.material_statuses = Object.fromEntries(
      row.creative_list
        .filter((c: JsonObject) => obj(c) && c.ad_material_id !== undefined)
        .map((c: JsonObject) => [String(c.ad_material_id), c.material_operation_status ?? null]),
    );
  // What an ad of uploads is (r25-m4b-smartpush; "Create an Upgraded Smart+ Ad", response example, read 2026-11-21): its creatives read with
  // `video_info`, `image_info` and `music_info` and no `tiktok_item_id`, and it has ad texts, which an ad of posts has none of. The ad's
  // texts say which it is, so that a read-back that also carries a generated post ID, or an ad of posts that carries the post's own video, is
  // still read as the ad it is; where the row says nothing of texts (an edit of the creatives alone), the creative's own keys do.
  const uploads = Array.isArray(row.ad_text_list) ? row.ad_text_list.length > 0 : undefined;
  if (Array.isArray(row.creative_list)) {
    out.creative_list = row.creative_list
      .map((c: JsonObject) => projectCreative(obj(c) && obj(c.creative_info) ? c.creative_info : {}, uploads))
      .sort(order);
    // The carousels' own names, by carousel: the read-back of one the request did not name carries a name of TikTok's, which is never compared.
    const names = Object.fromEntries(
      row.creative_list
        .map((c: JsonObject) => (obj(c) && obj(c.creative_info) ? c.creative_info : {}))
        .filter(
          (ci: JsonObject) =>
            creativeKind(ci) === 'carousel' && typeof ci.material_name === 'string' && ci.material_name !== '',
        )
        .map((ci: JsonObject) => [creativeKey(ci), ci.material_name]),
    );
    if (Object.keys(names).length) out.material_names = names;
  }
  // The ad texts as a set: TikTok returns lists in its own order.
  if (Array.isArray(row.ad_text_list))
    out.ad_text_list = row.ad_text_list
      .map((t: JsonObject) => blank(obj(t) ? t.ad_text : undefined))
      .filter((t: string | null) => t !== null)
      .sort();
  if (Array.isArray(row.landing_page_url_list))
    out.landing_page_url_list = row.landing_page_url_list
      .map((p: JsonObject) => (obj(p) ? (p.landing_page_url ?? null) : null))
      .sort();
  if (Array.isArray(row.page_list))
    out.page_list = row.page_list.map((p: JsonObject) => (obj(p) ? blank(p.page_id) : null)).sort();
  if (obj(row.ad_configuration)) {
    const ac: JsonObject = {...row.ad_configuration};
    // The entries that are not null (S3-2, r25-m4-smartedits): TikTok pads the list of a UI-made ad with null, and the list a merged patch
    // sends has none, so a padded read-back would compare unequal to what was sent.
    if (Array.isArray(ac.creative_auto_enhancement_strategy_list))
      ac.creative_auto_enhancement_strategy_list = ac.creative_auto_enhancement_strategy_list
        .filter((v: unknown) => v !== null)
        .sort();
    if (Array.isArray(ac.utm_params))
      ac.utm_params = ac.utm_params
        .map((p: JsonObject) => ({key: p?.key ?? null, value: p?.value ?? null}))
        .sort(order);
    if (ac.call_to_action_id !== undefined) ac.call_to_action_id = blank(ac.call_to_action_id);
    // The pixel as a string, "0" for none (r25-m4-smartedits, T5): TikTok reads an ad with no pixel as "0", and its read of an ID is
    // compared with the one sent whatever its type. The other tracking_info keys of a read are compared only when they were sent.
    if (obj(ac.tracking_info) && ac.tracking_info.tracking_pixel_id !== undefined)
      ac.tracking_info = {...ac.tracking_info, tracking_pixel_id: blank(ac.tracking_info.tracking_pixel_id) ?? '0'};
    out.ad_configuration = ac;
  }
  return out;
}
export function tiktokSmartPlusAdVerification(plan: CompiledRequest, result: JsonObject) {
  const id = tiktokSmartPlusAdId(obj(result.data) ? result.data : {}),
    b = plan.body as JsonObject;
  if (!id) throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no Smart+ ad ID.');
  const sent = tiktokSmartPlusAdProjection({
    creative_list: b.creative_list,
    ...(b.ad_text_list !== undefined ? {ad_text_list: b.ad_text_list} : {}),
    ...(b.page_list !== undefined ? {page_list: b.page_list} : {landing_page_url_list: b.landing_page_url_list}),
    ad_configuration: b.ad_configuration,
  })!;
  const expected: JsonObject = {
    smart_plus_ad_id: id,
    adgroup_id: b.adgroup_id,
    ad_name: b.ad_name,
    // The status that was sent: DISABLE, or ENABLE under a parent read paused (Q14, L1-05); the read-back compares it as sent.
    operation_status: b.operation_status,
    ...sent,
  };
  return [
    {
      path: tiktokSmartPlusAdGetPath,
      query: {advertiser_id: plan.accountId, filtering: {smart_plus_ad_ids: [id]}, page_size: 100},
      expected,
      id,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusAdFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_ads',
  files: [
    'src/tiktok-smart-plus-ads.ts',
    [
      'tests/tiktok-smart-plus-ads.test.mjs',
      'tests/tiktok-smart-plus-lead-ads.test.mjs',
      'tests/tiktok-smart-plus-enable-children.test.mjs',
      'tests/tiktok-serving-parent-children.test.mjs',
      'tests/tiktok-smart-plus-reconcile.test.mjs',
      'tests/tiktok-smart-plus-push.test.mjs',
    ],
  ],
  kind: tiktokSmartPlusAdKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusAd(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) =>
    tiktokSmartPlusAdReads(plan).map(r => {
      const read = stateRead(r.path, r.query);
      read.action = r.action;
      // The library reads and the identity of an upload keep what they compare, never the signed links (r25-m4b-smartpush).
      if (r.push) (read as Marked).tiktokPush = r.push;
      // The ad group a Smart+ ad is created in is its PARENT (R2.5 M1, S3-5): metadata for the review's ordering and the
      // rotation harness; its state is the family's own projection.
      if (r.path === '/v1.3/smart_plus/adgroup/get/') read.stateRole = 'parent';
      return read;
    }),
  prerequisites: (plan, state) => tiktokSmartPlusAdPrerequisites(plan, state),
  // The pixel an Instant Form ad names, with whether the advertiser owns it, beside the review of the create (r25-m4-smartedits, T5; a shared
  // pixel is reported).
  impact: (plan, state) => {
    const pixel = tiktokAdPixel((plan.body as JsonObject).ad_configuration);
    return {
      ...tiktokSmartPlusAdImpact(plan, state),
      ...(pixel !== undefined ? {tracking_pixel: tiktokAdPixelImpact(pixel, state)} : {}),
    };
  },
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && !!tiktokSmartPlusAdId(d);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusAdVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_ad_get'},
    })),
});
