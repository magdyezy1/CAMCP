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
const maxCreatives = 20,
  maxAds = 30;
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
const creativeKeys = ['ad_format', 'tiktok_item_id', 'identity_type', 'identity_id', 'identity_authorized_bc_id'];
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
const infos = (list: JsonObject[]) => list.map(c => c.creative_info as JsonObject);
type Identity = {type: string; id: string; bc?: string; items: string[]};
/** One entry per identity named by the creatives, with the posts it must own. */
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
    };
    i.items.push(c.tiktok_item_id as string);
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
  const found: Violation[] = [];
  for (const extra of Object.keys(body).filter(k => !topKeys.includes(k)))
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
  collect(found, () => {
    if (body.operation_status !== 'DISABLE')
      invalid(
        'operation_status',
        'Create Smart+ ads paused: set operation_status to DISABLE (TikTok defaults to ENABLE).',
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
  checkSparkCreatives(body.creative_list, found);
  if (body.page_list !== undefined) {
    collect(found, () => {
      if (body.landing_page_url_list !== undefined)
        invalid('landing_page_url_list', 'An Instant Form ad takes page_list and no landing_page_url_list.');
    });
    collect(found, () => assertInstantFormPages(body.page_list));
    checkAdConfiguration(body.ad_configuration, undefined, found);
    collect(found, () => {
      if (obj(body.ad_configuration) && body.ad_configuration.utm_params !== undefined)
        invalid(
          'ad_configuration.utm_params',
          'utm_params record landing page parameters; Instant Form ads have no landing page.',
        );
    });
  } else checkAdConfiguration(body.ad_configuration, checkLandingPage(body.landing_page_url_list, found), found);
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
 * A Spark creative list: 1-20 existing posts, each with a TT_USER or BC_AUTH_TT identity. Every rule of every creative is run, and
 * each violation is recorded in `found` (r25-field-tiktok, #6).
 */
export function checkSparkCreatives(list: unknown, found: Violation[]): void {
  const listed = collect(found, () => {
    if (!Array.isArray(list) || !list.length || list.length > maxCreatives)
      invalid('creative_list', 'creative_list must hold 1-' + maxCreatives + ' existing TikTok posts.');
  });
  if (!listed) return;
  const items = new Set<string>();
  (list as unknown[]).forEach((c: unknown, i: number) => {
    const at = 'creative_list[' + i + '].creative_info';
    collect(found, () => {
      if (obj(c) && Object.hasOwn(c, 'ad_material_id'))
        invalid(
          'creative_list[' + i + '].ad_material_id',
          'ad_material_id is allowlist-only and makes TikTok ignore creative_info; name the post in creative_info.',
        );
    });
    // The material ID is the rule above's: it is not counted again as a stray key of the creative.
    const record = collect(found, () => {
      if (!obj(c) || Object.keys(c).some(k => k !== 'creative_info' && k !== 'ad_material_id') || !obj(c.creative_info))
        invalid('creative_list[' + i + ']', 'Each creative is {creative_info:{...}} naming one existing TikTok post.');
    });
    if (!record) return;
    const ci = (c as JsonObject).creative_info as JsonObject;
    for (const key of Object.keys(ci).filter(k => !creativeKeys.includes(k)))
      collect(found, () =>
        invalid(
          at + '.' + key,
          '"' +
            key +
            '" is outside Spark Ads from existing posts; uploads (Spark Ads Push) and custom identities are not qualified.',
        ),
      );
    collect(found, () => {
      if (typeof ci.ad_format !== 'string' || !Object.hasOwn(formats, ci.ad_format))
        invalid(at + '.ad_format', 'ad_format must be SINGLE_VIDEO for a video post or CAROUSEL_ADS for a photo post.');
    });
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
    collect(found, () => {
      if (ci.identity_type !== 'TT_USER' && ci.identity_type !== 'BC_AUTH_TT')
        invalid(
          at + '.identity_type',
          'identity_type must be TT_USER or BC_AUTH_TT; authorization-code posts and custom identities are not qualified.',
        );
    });
    collect(found, () => {
      if (typeof ci.identity_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ci.identity_id))
        invalid(at + '.identity_id', 'identity_id must be the TikTok account identity that owns the post.');
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
}
/** Exactly one http or https landing page: its URL, or undefined when the list is not that (the violation is recorded in `found`). */
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
export function checkAdConfiguration(ac: unknown, url: string | undefined, found: Violation[], patch = false): void {
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
  collect(found, () => {
    if (c.dark_post_status !== undefined && c.dark_post_status !== 'ON')
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

type Read = {path: string; query: JsonObject; action: string};
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
  reads.push(...sparkReads(id, b.creative_list as JsonObject[]));
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
/** Each identity of a creative list, and its posts. */
export function sparkReads(accountId: string | undefined, list: JsonObject[]): Read[] {
  return identities(list).flatMap(i => {
    const who = {
      advertiser_id: accountId,
      identity_type: i.type,
      identity_id: i.id,
      ...(i.bc !== undefined ? {identity_authorized_bc_id: i.bc} : {}),
    };
    return [
      {path: identityInfoPath, query: who, action: 'tiktok_identity_info_get'},
      {
        path: tiktokIdentityVideoInfoPath,
        query: {...who, item_ids: [...i.items].sort()},
        action: 'tiktok_identity_video_info_get',
      },
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
    if (info.available_status !== 'AVAILABLE')
      invalid(field, 'Identity ' + i.id + ' is not available (' + (info.available_status ?? 'no status') + ').');
    if (info.can_pull_video !== true)
      invalid(field, 'Identity ' + i.id + ' cannot use its existing posts in ads (can_pull_video is not true).');
    if (info.is_gpppa === true)
      invalid(
        field,
        'Identity ' + i.id + ' is a government, politician or political party account, which cannot run Spark Ads.',
      );
    const posts = data.find(d => d.identity_id === i.id && d.identity_type === i.type && Array.isArray(d.video_details))
      ?.video_details as JsonObject[] | undefined;
    for (const c of infos(list).filter(c => c.identity_id === i.id && c.identity_type === i.type)) {
      const post = posts?.find(p => p.item_id === c.tiktok_item_id);
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
    }
  }
}
export function tiktokSmartPlusAdImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const b = plan.body as JsonObject,
    ac = b.ad_configuration as JsonObject,
    data = state.map(v => (obj(v) && obj(v.data) ? v.data : undefined));
  const group = data
    .flatMap(d => (Array.isArray(d?.list) ? d.list : []))
    .find((r: JsonObject) => String(r?.adgroup_id) === b.adgroup_id) as JsonObject | undefined;
  const ads = data.find(d => obj(d?.adgroup_ads))?.adgroup_ads as JsonObject | undefined;
  return {
    provider: 'tiktok',
    scope: 'smart_plus_ads',
    may_affect_serving: false,
    effect:
      'Creates a paused Upgraded Smart+ ad from ' +
      creatives(b).length +
      ' existing TikTok post(s); nothing delivers until the ad is enabled.',
    ad_group: {
      adgroup_id: b.adgroup_id,
      operation_status: group?.operation_status ?? null,
      placement_type: group?.placement_type ?? null,
      // Whether the ad group has room for this ad (the review keeps that, not the number of its ads: r25-field-tiktok, #7).
      at_limit: typeof ads?.at_limit === 'boolean' ? ads.at_limit : null,
      limit: maxAds,
    },
    creatives: creatives(b).map(c => ({
      tiktok_item_id: c.tiktok_item_id,
      ad_format: c.ad_format,
      identity_type: c.identity_type,
      identity_id: c.identity_id,
    })),
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
/** The ad in comparable form: selected posts, landing pages and UTM parameters as sets. Other fields stay for status checks. */
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
  if (Array.isArray(row.creative_list))
    out.creative_list = row.creative_list
      .map((c: JsonObject) => {
        const ci = obj(c) && obj(c.creative_info) ? c.creative_info : {};
        return {
          ad_format: ci.ad_format ?? null,
          tiktok_item_id: blank(ci.tiktok_item_id),
          identity_type: ci.identity_type ?? null,
          identity_id: blank(ci.identity_id),
          identity_authorized_bc_id: blank(ci.identity_authorized_bc_id),
        };
      })
      .sort(order);
  if (Array.isArray(row.landing_page_url_list))
    out.landing_page_url_list = row.landing_page_url_list
      .map((p: JsonObject) => (obj(p) ? (p.landing_page_url ?? null) : null))
      .sort();
  if (Array.isArray(row.page_list))
    out.page_list = row.page_list.map((p: JsonObject) => (obj(p) ? blank(p.page_id) : null)).sort();
  if (obj(row.ad_configuration)) {
    const ac: JsonObject = {...row.ad_configuration};
    if (Array.isArray(ac.creative_auto_enhancement_strategy_list))
      ac.creative_auto_enhancement_strategy_list = [...ac.creative_auto_enhancement_strategy_list].sort();
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
    ...(b.page_list !== undefined ? {page_list: b.page_list} : {landing_page_url_list: b.landing_page_url_list}),
    ad_configuration: b.ad_configuration,
  })!;
  const expected: JsonObject = {
    smart_plus_ad_id: id,
    adgroup_id: b.adgroup_id,
    ad_name: b.ad_name,
    operation_status: 'DISABLE',
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
    ['tests/tiktok-smart-plus-ads.test.mjs', 'tests/tiktok-smart-plus-lead-ads.test.mjs'],
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
