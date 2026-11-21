import {assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {tiktokPortfolioGetPath, tiktokCtaPortfolioCheck} from './tiktok-cta-portfolios.js';
import {
  tiktokAdPixel,
  tiktokAdPixelImpact,
  tiktokAdPixelPrerequisites,
  tiktokAdPixelRead,
  tiktokHeldPixel,
  tiktokPixelGroupKind,
  tiktokQuotedId,
  tiktokRefuseEditedPixel,
} from './tiktok-smart-plus-pixels.js';
import {
  tiktokSmartPlusAdGetPath,
  checkSparkCreatives,
  checkLandingPage,
  checkAdConfiguration,
  collect,
  refuse,
  assertUtmMatch,
  sparkReads,
  sparkPrerequisites,
  tiktokSmartPlusAdProjection,
} from './tiktok-smart-plus-ads.js';
import type {Violation} from './tiktok-smart-plus-ads.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';

/**
 * Edits of Upgraded Smart+ Spark Ads, per API for Business v1.3 "Update an Upgraded Smart+ Ad" (checked 2026-09-26):
 * incremental, except that creative_list is replaced in full, so posts left out are removed; ad_material_id is
 * allowlist-only and makes TikTok ignore creative_info; TRANSLATE_AND_DUB cannot change after creation. Status
 * changes use the Smart+ status family.
 */
export const tiktokSmartPlusAdUpdatePath = '/v1.3/smart_plus/ad/update/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const emoji = /\p{Extended_Pictographic}/u;
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);
// `ad_configuration_patch` (r25-m4-smartedits, QUESTIONS L4 (a)) is no key of TikTok's request: AMCP merges it into the ad's current
// configuration at review and hands the whole configuration back, so it never reaches TikTok.
const editable = ['ad_name', 'creative_list', 'landing_page_url_list', 'ad_configuration', 'ad_configuration_patch'],
  content = ['creative_list', 'landing_page_url_list', 'ad_configuration', 'ad_configuration_patch'];

export const tiktokSmartPlusAdUpdateKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokSmartPlusAdUpdatePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_SMART_PLUS_AD', message, {field});
}

/**
 * Validates the request before review; nothing here reads or contacts TikTok. Every independent rule is run, and an edit that
 * breaks several is refused once with all of them, as a create is (`refuse` in src/tiktok-smart-plus-ads.ts; r25-field-tiktok, #6).
 */
export function assertTiktokSmartPlusAdUpdate(plan: CompiledRequest, body: JsonObject): void {
  const found: Violation[] = [];
  for (const extra of Object.keys(body).filter(k => !['advertiser_id', 'smart_plus_ad_id', ...editable].includes(k)))
    collect(found, () =>
      invalid(
        extra,
        '"' +
          extra +
          '" is outside the qualified Smart+ Spark Ad edit contract' +
          (extra === 'operation_status' ? '; pause or enable the ad through the Smart+ status family.' : '.'),
      ),
    );
  collect(found, () => {
    if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
      invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  });
  collect(found, () => {
    if (!numeric(body.smart_plus_ad_id))
      invalid('smart_plus_ad_id', 'smart_plus_ad_id must be the numeric ID of an Upgraded Smart+ ad.');
  });
  collect(found, () => {
    if (!editable.some(k => body[k] !== undefined))
      invalid('ad_name', 'Send at least one of ad_name, creative_list, landing_page_url_list and ad_configuration.');
  });
  collect(found, () => {
    if (
      body.ad_name !== undefined &&
      (typeof body.ad_name !== 'string' ||
        !body.ad_name.trim() ||
        width(body.ad_name) > 512 ||
        emoji.test(body.ad_name))
    )
      invalid(
        'ad_name',
        'ad_name must be nonempty, at most 512 characters (Chinese and Japanese count twice) and without emoji.',
      );
  });
  if (body.creative_list !== undefined) checkSparkCreatives(body.creative_list, found);
  const url =
    body.landing_page_url_list !== undefined ? checkLandingPage(body.landing_page_url_list, found) : undefined;
  if (body.ad_configuration !== undefined) checkAdConfiguration(body.ad_configuration, url, found);
  if (body.ad_configuration_patch !== undefined) {
    collect(found, () => {
      if (body.ad_configuration !== undefined)
        invalid(
          'ad_configuration_patch',
          'Send ad_configuration_patch or ad_configuration, not both: AMCP merges the patch into the ad’s current ad_configuration and hands the whole configuration back.',
        );
    });
    checkAdConfiguration(body.ad_configuration_patch, undefined, found, true);
  }
  refuse(found);
}

/** The configuration an edit names: the whole one, or the patch of it. The CTA portfolio and the pixel it names are read either way. */
const namedConfiguration = (b: JsonObject): JsonObject | undefined =>
  obj(b.ad_configuration) ? b.ad_configuration : obj(b.ad_configuration_patch) ? b.ad_configuration_patch : undefined;

type Read = {path: string; query: JsonObject; action: string};
export function tiktokSmartPlusAdUpdateReads(plan: CompiledRequest): Read[] {
  const b = plan.body as JsonObject,
    id = plan.accountId;
  const reads: Read[] = [
    {
      path: tiktokSmartPlusAdGetPath,
      query: {advertiser_id: id, filtering: {smart_plus_ad_ids: [b.smart_plus_ad_id]}, page_size: 100},
      action: 'tiktok_smart_plus_ad_get',
    },
  ];
  if (b.creative_list !== undefined) reads.push(...sparkReads(id, b.creative_list as JsonObject[]));
  // The CTA portfolio the edit names (a patch names one only when it changes it), and the pixel list when it names a pixel (r25-m4-smartedits, T5);
  // the ad's ad group is read after the ad (`followUps`).
  const named = namedConfiguration(b);
  if (named && named.call_to_action_id !== undefined)
    reads.push({
      path: tiktokPortfolioGetPath,
      query: {advertiser_id: id, creative_portfolio_id: named.call_to_action_id},
      action: 'tiktok_creative_portfolio_get',
    });
  const pixel = tiktokAdPixel(named);
  if (pixel !== undefined) reads.push(tiktokAdPixelRead(id, pixel));
  return reads;
}
/**
 * What the review reads once it has the ad (r25-m4-smartedits). A read of this module's own ad only.
 * - The ad's ad group, when the configuration the edit ends with names a pixel (T5): its kind decides where an ad-level pixel is
 *   documented, and its own pixel is the one the ad's must match. It is the ad's PARENT, as for a create (src/tiktok-smart-plus-ads.ts).
 * - For a patch (S3-1 of the lead's review, probe P1), what the patch carries from the ad, because the whole edit it becomes judges both
 *   and a patch is not handed back that its own next call would refuse: the pixel list read of the pixel the ad holds, when the patch names
 *   none, and the CTA portfolio the ad holds, when the patch leaves the CTA.
 */
export function tiktokSmartPlusAdUpdateFollowUp(
  plan: CompiledRequest,
  read: CompiledRequest,
  data: unknown,
): CompiledRequest[] {
  const b = plan.body as JsonObject,
    filtering = read.query?.filtering as JsonObject | undefined;
  if (
    !tiktokSmartPlusAdUpdateKind(plan) ||
    read.path !== tiktokSmartPlusAdGetPath ||
    !Array.isArray(filtering?.smart_plus_ad_ids)
  )
    return [];
  const row = (obj(data) && obj(data.data) && Array.isArray(data.data.list) ? data.data.list : []).find(
    (r: JsonObject) => String(r?.smart_plus_ad_id) === b.smart_plus_ad_id,
  ) as JsonObject | undefined;
  const patch = obj(b.ad_configuration_patch) ? b.ad_configuration_patch : undefined,
    held = obj(row?.ad_configuration) ? row.ad_configuration : undefined,
    named = tiktokAdPixel(namedConfiguration(b)),
    reads: CompiledRequest[] = [];
  const cta =
    held?.call_to_action_id === undefined || held.call_to_action_id === null ? '' : String(held.call_to_action_id);
  if (patch && patch.call_to_action_id === undefined && numeric(cta))
    reads.push({
      ...read,
      path: tiktokPortfolioGetPath,
      query: {advertiser_id: plan.accountId, creative_portfolio_id: cta},
      action: 'tiktok_creative_portfolio_get',
    });
  // The pixel the edit ends with: the one it names, or, for a patch that names none, the one the ad holds.
  const patchNamesPixel = obj(patch?.tracking_info) && patch.tracking_info.tracking_pixel_id !== undefined,
    kept = patch && !patchNamesPixel ? tiktokHeldPixel(held) : undefined,
    pixel = named ?? (numeric(kept) ? kept : undefined);
  if (pixel === undefined) return reads;
  if (named === undefined) reads.push({...read, ...tiktokAdPixelRead(plan.accountId, pixel)});
  const group = String(row?.adgroup_id);
  if (numeric(group))
    reads.push({
      ...read,
      path: '/v1.3/smart_plus/adgroup/get/',
      query: {advertiser_id: plan.accountId, filtering: {adgroup_ids: [group]}, page_size: 100},
      action: 'tiktok_smart_plus_adgroup_get',
      stateRole: 'parent',
    });
  return reads;
}
const adOf = (plan: CompiledRequest, values: unknown[]) =>
  values
    .flatMap(v => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : []))
    .find((r: JsonObject) => String(r?.smart_plus_ad_id) === (plan.body as JsonObject).smart_plus_ad_id) as
    JsonObject | undefined;
const postsOf = (row: JsonObject) =>
  (Array.isArray(row.creative_list) ? row.creative_list : []).map((c: JsonObject) =>
    obj(c) && obj(c.creative_info) ? c.creative_info : {},
  ) as JsonObject[];
const landingPagesOf = (row: JsonObject) => (Array.isArray(row.landing_page_url_list) ? row.landing_page_url_list : []);
/**
 * An ad this contract edits beyond its name: existing-post Spark creatives and a CTA portfolio, as the create contract makes them, and
 * one destination: one landing page (a website ad), or, since r25-m4-smartedits (T5), one Instant Form and no landing page (a lead ad:
 * its read carries `page_list`, and a landing page list that is empty or absent). Before that, every ad had to have a landing page,
 * which an Instant Form ad has none of, so only its name could be edited.
 */
const sparkAd = (row: JsonObject): 'website' | 'form' | undefined => {
  const posts = postsOf(row);
  if (!(
    posts.length > 0 &&
    posts.every(
      ci =>
        typeof ci.tiktok_item_id === 'string' &&
        ci.tiktok_item_id !== '' &&
        ['TT_USER', 'BC_AUTH_TT'].includes(ci.identity_type),
    ) &&
    obj(row.ad_configuration) &&
    !!row.ad_configuration.call_to_action_id
  ))
    return undefined;
  const pages = landingPagesOf(row),
    forms = Array.isArray(row.page_list) ? row.page_list : [];
  if (pages.length === 1) return 'website';
  return pages.length === 0 && forms.length === 1 && obj(forms[0]) && numeric(String(forms[0].page_id))
    ? 'form'
    : undefined;
};
/** The ad group row an ad's pixel is judged against: the row among the review's reads that carries a group's kind (an ad row has none). */
const groupRowOf = (row: JsonObject, values: unknown[]): {id: string; group?: JsonObject} => {
  const id = String(row.adgroup_id);
  return {
    id,
    group: numeric(id)
      ? (values
          .flatMap(v => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : []))
          .find((r: JsonObject) => String(r?.adgroup_id) === id && Object.hasOwn(r, 'promotion_type')) as
          JsonObject | undefined)
      : undefined,
  };
};
/**
 * The probe of M4 LV-20 (b) (r25-m4-smartedits, QUESTIONS L19) is gone (r25-field3-livefix, item 4): it sent an edit of a website ad's pixel as an
 * experiment, and the live check showed that TikTok accepts `ad_configuration.tracking_info.tracking_pixel_id` on a website Smart+ Spark ad and keeps
 * "0" (checked 2026-11-21; only the read-back caught it). An edit that names a pixel for a website ad is now refused before any request, with the
 * sentence of `tiktokRefuseEditedPixel` (src/tiktok-smart-plus-pixels.ts): TikTok applies an ad-level pixel only to Instant Form lead ads and app
 * promotion ads. An ad group of a catalog campaign keeps the refusal it had, which names the documented scenarios. A website ad that already holds
 * a pixel (one attached in TikTok's UI) is therefore no longer editable in its configuration, by a whole configuration or a patch: the guard
 * below refuses leaving the pixel out, and restating it is refused as a pixel for a website ad (S4-3 of the lead's review of smartedits).
 */
const catalogGroup = (group: JsonObject): boolean =>
  group.catalog_id !== undefined && group.catalog_id !== null && !['', '0'].includes(String(group.catalog_id));
/**
 * T5 (r25-m4-smartedits): the pixel of an ad's new `ad_configuration`, at review and again before execution.
 * - A restated configuration never clears the pixel the ad holds. TikTok documents an update as incremental ("Update an Upgraded
 *   Smart+ Ad", read 2026-11-20) and says nothing of whether the keys of `ad_configuration` are merged or replaced, so a
 *   configuration that leaves `tracking_info` out, or names no pixel in it, is refused when the ad has one, as one that leaves out
 *   `utm_params` is. An ad that reads "0" has none, and may restate its configuration freely.
 * - A pixel the edit names is judged against the ad's ad group (read after the ad): the Instant Form lead group AMCP creates is the
 *   documented scenario; any other group is refused, naming the scenarios (src/tiktok-smart-plus-pixels.ts).
 * A patch is judged as the whole configuration it is merged into (S3-1 of the lead's review): it carries the pixel the ad holds, and the
 * review reads that pixel's list entry and the ad's ad group as it does for a pixel an edit names (`tiktokSmartPlusAdUpdateFollowUp`).
 */
function pixelPrerequisites(row: JsonObject, config: JsonObject, values: unknown[], ad: unknown): void {
  const held = tiktokHeldPixel(row.ad_configuration),
    pixel = tiktokAdPixel(config);
  if (held !== undefined && pixel === undefined) {
    if (!obj(config.tracking_info))
      invalid(
        'ad_configuration.tracking_info',
        'Restate tracking_info: ad ' + ad + ' has a tracking pixel, and a new ad_configuration could clear it.',
      );
    invalid(
      'ad_configuration.tracking_info',
      'Ad ' +
        ad +
        ' has ' +
        (tiktokQuotedId(held, '') ? 'tracking pixel ' + held : 'a tracking pixel') +
        ', and this tracking_info would clear it: name a pixel in tracking_pixel_id (removing a pixel is not qualified).',
    );
  }
  if (pixel === undefined) return;
  const {id: groupId, group} = groupRowOf(row, values);
  if (!group)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'The ad group of Smart+ ad ' + ad + ' was not returned for the selected advertiser.',
      {smart_plus_ad_id: ad},
    );
  const kind = tiktokPixelGroupKind(group);
  if (kind !== 'instant_form') tiktokRefuseEditedPixel(kind === 'website' && catalogGroup(group) ? 'other' : kind);
  tiktokAdPixelPrerequisites(pixel, group, groupId, values);
}
/**
 * The product information sentence (r25-field-tiktok, #6; S4-1, r25-m4-smartedits): an ad whose mode is on keeps it, because UNSET
 * would switch it off and no other mode is qualified, so its `ad_configuration` is not edited here.
 */
const productInformationRefusal = (ad: unknown, mode: unknown) =>
  'Ad ' +
  ad +
  ' has product information on (' +
  (typeof mode === 'string' && /^[A-Z_]{1,32}$/.test(mode) ? mode : 'a mode other than UNSET') +
  '); product_info_enabled UNSET would switch it off, and no other mode is qualified, so its ad_configuration is not edited here.';
/**
 * What the checks of an `ad_configuration` an edit sends hold, whether it is the whole configuration or the one a patch was merged
 * into: the settings of the ad that AMCP cannot restate (`unrestatable`: the product information an ad has on is one), the CTA
 * portfolio, the membership of TRANSLATE_AND_DUB, the UTM parameters an ad has, the UTM parameters of an Instant Form ad, and the pixel.
 * A merged patch is judged exactly as the whole edit that is its next call, so none of its checks is skipped for a key the patch leaves
 * out (S3-1 of the lead's review): the CTA and the pixel the ad holds are read for it.
 */
function configurationPrerequisites(
  row: JsonObject,
  config: JsonObject,
  values: unknown[],
  ad: unknown,
  kind: 'website' | 'form',
): void {
  const current = row.ad_configuration as JsonObject;
  // S2-1: an ad that holds a setting AMCP cannot restate is not edited here, whether the configuration is whole or a merged patch.
  refuse(unrestatable(current, ad));
  tiktokCtaPortfolioCheck(config.call_to_action_id as string, values, 'ad_configuration.call_to_action_id');
  const had =
      Array.isArray(current.creative_auto_enhancement_strategy_list) &&
      current.creative_auto_enhancement_strategy_list.includes('TRANSLATE_AND_DUB'),
    wants = (config.creative_auto_enhancement_strategy_list as string[]).includes('TRANSLATE_AND_DUB');
  if (had !== wants)
    invalid(
      'ad_configuration.creative_auto_enhancement_strategy_list',
      'TRANSLATE_AND_DUB cannot be added or removed after creation; ad ' +
        ad +
        ' ' +
        (had ? 'includes' : 'excludes') +
        ' it.',
    );
  if (Array.isArray(current.utm_params) && current.utm_params.length && config.utm_params === undefined)
    invalid(
      'ad_configuration.utm_params',
      'Restate utm_params: ad ' + ad + ' has them, and a new ad_configuration could clear them.',
    );
  if (kind === 'form' && config.utm_params !== undefined)
    invalid(
      'ad_configuration.utm_params',
      'utm_params record landing page parameters; Instant Form ads have no landing page.',
    );
  pixelPrerequisites(row, config, values, ad);
}

/**
 * The ad_configuration patch (r25-m4-smartedits; QUESTIONS L4 (a), the lead 2026-11-20). TikTok documents "Update an Upgraded Smart+ Ad"
 * as incremental (read 2026-11-20) and says nothing of whether the keys of `ad_configuration` are merged or replaced, so AMCP sends
 * none of it partially: a patch is laid over the ad's current configuration here, at review, and the whole configuration goes back to
 * the caller in `details.fix`, to be sent as an ordinary edit (`handBack`). What is merged:
 * - the qualified keys of the read, at their read value (the CTA portfolio, both automatic switches, the UTM parameters, the product
 *   information when it is UNSET, `tracking_info` with its pixel and the brand safety partner when it is UNSET), without the `null`
 *   entries TikTok pads the enhancement list with;
 * - the two keys TikTok returns with every ad at their default, `product_specific_type` UNSET and `dark_post_status` ON, which the
 *   contract accepts at that value only;
 * - then the patch over them, `tracking_info` key by key.
 * A setting of the read that this cannot restate refuses the patch, naming it (`unrestatable`, which a whole configuration answers to
 * as well). A switch or list the read leaves out (a UI-made ad has no `creative_auto_add_toggle`) cannot be restated either: the patch
 * must name it. Every key of the merged configuration then has to be one the contract accepts.
 */
const unset = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  v === 'UNSET' ||
  (Array.isArray(v) && !v.length) ||
  (obj(v) && !Object.keys(v).length);
/** What a message may repeat of a key or value TikTok returned: a name or token of its own alphabet, and otherwise words that name none. */
const keyName = (k: string) => (/^[a-z][a-z0-9_]{0,63}$/.test(k) ? k : 'a key');
const restatable: Record<string, string> = {product_specific_type: 'UNSET', dark_post_status: 'ON'};
const carried = [
  'call_to_action_id',
  'creative_auto_add_toggle',
  'creative_auto_enhancement_strategy_list',
  'product_info_enabled',
  'utm_params',
  'tracking_info',
];
/**
 * The settings of an ad's current `ad_configuration` that AMCP cannot restate with their current value (S2-1 of the lead's review of
 * r25-m4-smartedits). TikTok documents "Update an Upgraded Smart+ Ad" as incremental and says nothing of whether the keys of
 * `ad_configuration` are merged or replaced, so a configuration that leaves out a setting of the ad could clear it. The contract can
 * send the keys of `carried` at their read value, and the two defaults of `restatable` at that default; any other setting that holds a
 * value cannot be sent, so an ad that holds one is not edited here at all, through a whole configuration or a patch (probe P2 of the
 * review: under replace semantics a full edit of one switch silently cleared each of `dark_post_status` OFF, `product_specific_type`
 * ALL, a tracking URL, a viewability partner, a catalog toggle that is on and an end card). What reads as not set is let go, because the
 * default of what is not set is not set: `null`, an empty text, list or object, and UNSET.
 * - Product information (r25-field-tiktok, #6; S4-1): only UNSET is qualified, and UNSET switches the mode off, so an ad whose mode is on
 *   keeps it; a mode that reads null or empty is no mode (S4-5).
 * - The two defaults TikTok returns with every ad are restatable at that default only: `product_specific_type` UNSET and `dark_post_status` ON.
 * - `catalog_creative_toggle` (S3-8; "Create an Upgraded Smart+ Ad", read 2026-11-21: default false, valid only with a catalog campaign): false
 *   is not set, and is let go and never carried; true cannot be restated.
 * - Within `tracking_info`, the pixel is carried at its read value (the restate guard judges it) and the brand safety partner at UNSET.
 */
function unrestatable(current: JsonObject, ad: unknown): Violation[] {
  const found: Violation[] = [];
  const cannot = (path: string) =>
    found.push({
      field: 'ad_configuration.' + path,
      message:
        'Ad ' +
        ad +
        ' has ' +
        path +
        ' in its ad_configuration, and AMCP does not restate it, so an ad_configuration sent from here could clear it: this ad’s ad_configuration is not edited here.',
    });
  for (const [key, value] of Object.entries(current)) {
    if (key === 'product_info_enabled') {
      if (!unset(value))
        found.push({field: 'ad_configuration.product_info_enabled', message: productInformationRefusal(ad, value)});
      continue;
    }
    if (carried.includes(key)) continue;
    // S3-8: a catalog toggle that reads false is TikTok's documented default (valid only with a catalog campaign): it is not set, so it is let
    // go and never carried; one that reads true cannot be restated.
    if (key === 'catalog_creative_toggle' && value === false) continue;
    if (Object.hasOwn(restatable, key)) {
      if (value !== restatable[key] && !unset(value))
        found.push({
          field: 'ad_configuration.' + key,
          message:
            'Ad ' +
            ad +
            ' has ' +
            key +
            (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? ' ' + value : ' with a value') +
            ', which an ad_configuration sent from here cannot restate: only ' +
            restatable[key] +
            ' is qualified, so this ad’s ad_configuration is not edited here.',
        });
      continue;
    }
    if (!unset(value)) cannot(keyName(key));
  }
  if (obj(current.tracking_info))
    for (const [k, v] of Object.entries(current.tracking_info)) {
      if (k === 'tracking_pixel_id' || (k === 'brand_safety_postbid_partner' && v === 'UNSET')) continue;
      if (!unset(v)) cannot('tracking_info.' + keyName(k));
    }
  return found;
}
function mergedConfiguration(current: JsonObject, patch: JsonObject, ad: unknown): JsonObject {
  const found: Violation[] = unrestatable(current, ad),
    merged: JsonObject = {};
  if (current.call_to_action_id !== undefined && current.call_to_action_id !== null && current.call_to_action_id !== '')
    merged.call_to_action_id = String(current.call_to_action_id);
  if (typeof current.creative_auto_add_toggle === 'boolean')
    merged.creative_auto_add_toggle = current.creative_auto_add_toggle;
  if (Array.isArray(current.creative_auto_enhancement_strategy_list))
    merged.creative_auto_enhancement_strategy_list = current.creative_auto_enhancement_strategy_list.filter(
      v => v !== null,
    );
  if (current.product_info_enabled === 'UNSET') merged.product_info_enabled = 'UNSET';
  if (Array.isArray(current.utm_params) && current.utm_params.length) merged.utm_params = current.utm_params;
  if (obj(current.tracking_info)) {
    const info: JsonObject = {};
    for (const [k, v] of Object.entries(current.tracking_info)) {
      if (k === 'tracking_pixel_id') {
        if (v !== undefined && v !== null && v !== '') info.tracking_pixel_id = String(v);
      } else if (k === 'brand_safety_postbid_partner' && v === 'UNSET') info[k] = v;
    }
    if (Object.keys(info).length) merged.tracking_info = info;
  }
  for (const [key, value] of Object.entries(restatable)) if (current[key] === value) merged[key] = value;
  for (const [key, value] of Object.entries(patch))
    merged[key] =
      key === 'tracking_info' && obj(value)
        ? {...(obj(merged.tracking_info) ? merged.tracking_info : {}), ...value}
        : value;
  for (const key of ['creative_auto_add_toggle', 'creative_auto_enhancement_strategy_list'])
    if (merged[key] === undefined)
      found.push({
        field: 'ad_configuration_patch.' + key,
        message:
          'Ad ' +
          ad +
          ' reads no ' +
          key +
          ', so a patch cannot restate it: name it in ad_configuration_patch, or send the whole ad_configuration.',
      });
  refuse(found);
  // The merged configuration is what the next call sends, so it must be one the contract accepts.
  const contract: Violation[] = [];
  checkAdConfiguration(merged, undefined, contract);
  refuse(contract);
  return merged;
}
/**
 * The answer to a patch that was merged: this family's refusal, with the whole configuration in `details.fix` and the call that prepares it
 * (`details.next_call`). `fix` is a list of `{path, value}`: JSON pointers into the PAYLOAD of this edit (`details.fix_base` says so), for a
 * caller that applies them itself: each sets the field it names, and a `null` value removes it. It is not recover_step's patch (S3-5 of the
 * lead's review), whose pointers start at a step's arguments (`/payload/...`), which names only fields the step already has, and whose `null`
 * sets the field to null (src/campaign-amendment.ts): a plan step is corrected with recover_step and `arguments` equal to the call's own
 * arguments, which `next_call` holds. The hook is given no connection, so the call is without a connection_id, as the route refusal of a
 * classic ad create is (src/tiktok-manual-ad-identities.ts), and none of the other options of the call (S4-6: `creative_edit_confirmed`, the
 * flags) is carried either; `next_call.meaning` says so. Nothing partial is ever sent, and nothing was sent: the second prepare is an
 * ordinary full edit.
 */
function handBack(plan: CompiledRequest, merged: JsonObject): never {
  const {advertiser_id: _advertiser, ad_configuration_patch: _patch, ...rest} = plan.body as JsonObject;
  void _advertiser;
  void _patch;
  throw new MirrorError(
    'INVALID_TIKTOK_SMART_PLUS_AD',
    'AMCP merged ad_configuration_patch into the ad’s current ad_configuration and never sends part of a configuration. Send the merged ad_configuration (details.fix) as ad_configuration instead of the patch; details.next_call is that call. Nothing was sent.',
    {
      field: 'ad_configuration_patch',
      fix_base: 'payload',
      fix: [
        {path: '/ad_configuration', value: merged},
        {path: '/ad_configuration_patch', value: null},
      ],
      next_call: {
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway: plan.gateway,
          arguments: {
            action: 'tiktok_smart_plus_ad_update',
            account_id: plan.accountId,
            payload: {...rest, ad_configuration: merged},
          },
        },
        meaning:
          'The same edit with the merged ad_configuration in place of ad_configuration_patch, as an amcp_write prepare. It carries none of the options of this call: add its connection_id and any other it had (creative_edit_confirmed, for one). details.fix holds the same change as JSON pointers into this edit’s payload (details.fix_base is "payload": each sets the field it names, and a null value removes it), for a caller that applies it itself; it is not a recover_step patch, whose pointers start at a step’s arguments. For a plan step, send recover_step with arguments equal to next_call.arguments.arguments.',
      },
    },
  );
}
/** Checked against the state read before review and again before execution. */
export function tiktokSmartPlusAdUpdatePrerequisites(plan: CompiledRequest, values: unknown[]): void {
  if (!tiktokSmartPlusAdUpdateKind(plan)) return;
  const b = plan.body as JsonObject,
    row = adOf(plan, values),
    ad = b.smart_plus_ad_id;
  if (!row)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Smart+ ad ' + ad + ' was not returned for the selected advertiser.',
      {smart_plus_ad_id: ad},
    );
  if (row.operation_status === 'FROZEN') invalid('smart_plus_ad_id', 'Smart+ ad ' + ad + ' is terminated (FROZEN).');
  if (!content.some(k => b[k] !== undefined)) return;
  const kind = sparkAd(row);
  if (!kind)
    invalid(
      'smart_plus_ad_id',
      'Smart+ ad ' +
        ad +
        ' is not an ad from existing TikTok posts with one landing page and a CTA portfolio; only its name can be edited under this contract.',
    );
  // An Instant Form ad's posts and destination are not edited here (r25-m4-smartedits): only its name and its ad_configuration, where its pixel is.
  if (kind === 'form' && (b.creative_list !== undefined || b.landing_page_url_list !== undefined))
    invalid(
      'smart_plus_ad_id',
      'Smart+ ad ' +
        ad +
        ' collects leads with an Instant Form; under this contract its name and its ad_configuration can be edited, not its posts or a landing page.',
    );
  if (b.creative_list !== undefined)
    sparkPrerequisites(
      b.creative_list as JsonObject[],
      values.map(v => (obj(v) && obj(v.data) ? v.data : undefined)).filter((d): d is JsonObject => !!d),
    );
  const current = row.ad_configuration as JsonObject,
    patch = obj(b.ad_configuration_patch) ? b.ad_configuration_patch : undefined,
    config = obj(b.ad_configuration) ? b.ad_configuration : patch ? mergedConfiguration(current, patch, ad) : undefined;
  if (config) configurationPrerequisites(row, config, values, ad, kind);
  // The UTM parameters in effect must still repeat the landing page in effect.
  const url =
    (b.landing_page_url_list as JsonObject[] | undefined)?.[0]?.landing_page_url ??
    (landingPagesOf(row)[0] as JsonObject | undefined)?.landing_page_url;
  const utm = config ? config.utm_params : current.utm_params;
  if (typeof url === 'string' && Array.isArray(utm) && utm.length) assertUtmMatch(utm, url);
  if (patch && config) handBack(plan, config);
}
export function tiktokSmartPlusAdUpdateImpact(plan: CompiledRequest, state: unknown[], override: boolean): JsonObject {
  const b = plan.body as JsonObject,
    row = adOf(plan, state) ?? {},
    changes: JsonObject = {},
    before = postsOf(row).map(ci => String(ci.tiktok_item_id));
  let removed: string[] = [];
  if (b.ad_name !== undefined) changes.ad_name = {before: row.ad_name ?? null, after: b.ad_name};
  if (b.creative_list !== undefined) {
    const after = (b.creative_list as JsonObject[]).map(c => (c.creative_info as JsonObject).tiktok_item_id as string);
    removed = before.filter(i => !after.includes(i));
    changes.creative_list = {
      kept: after.filter(i => before.includes(i)),
      added: after.filter(i => !before.includes(i)),
      removed,
    };
  }
  if (b.landing_page_url_list !== undefined)
    changes.landing_page_url = {
      before: (row.landing_page_url_list as JsonObject[] | undefined)?.[0]?.landing_page_url ?? null,
      after: (b.landing_page_url_list as JsonObject[])[0]!.landing_page_url,
    };
  if (obj(b.ad_configuration)) {
    const current = obj(row.ad_configuration) ? row.ad_configuration : {};
    changes.ad_configuration = Object.fromEntries(
      Object.keys(b.ad_configuration).map(k => [
        k,
        {before: current[k] ?? null, after: (b.ad_configuration as JsonObject)[k]},
      ]),
    );
  }
  const live = row.operation_status === 'ENABLE',
    edits = content.some(k => b[k] !== undefined),
    pixel = tiktokAdPixel(b.ad_configuration);
  if (live && removed.length && !override)
    throw new MirrorError(
      'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
      'This edit removes ' +
        removed.length +
        ' post(s) from enabled ad ' +
        b.smart_plus_ad_id +
        ': ' +
        removed.join(', ') +
        '. Review the list and prepare again with creative_edit_confirmed=true.',
      {smart_plus_ad_id: b.smart_plus_ad_id, removed},
    );
  return {
    provider: 'tiktok',
    scope: 'smart_plus_ad_edits',
    may_affect_serving: live && edits,
    effect: !edits
      ? 'Renames the ad; delivery is unchanged.'
      : live
        ? 'Changes an enabled ad; TikTok reviews the modifications (AD_STATUS_DELIVERY_AND_REAUDIT) before they deliver, and removed posts stop delivering in this ad.'
        : 'Changes a paused ad; nothing delivers until it is enabled.',
    ad: {
      smart_plus_ad_id: b.smart_plus_ad_id,
      adgroup_id: row.adgroup_id ?? null,
      operation_status: row.operation_status ?? null,
    },
    changes,
    // The pixel the edit names, with whether the advertiser owns it (r25-m4-smartedits, T5; a shared pixel is reported).
    ...(pixel !== undefined ? {tracking_pixel: tiktokAdPixelImpact(pixel, state)} : {}),
    creative_edit_confirmed: override,
    source: 'https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad/v1.3',
  };
}
export function tiktokSmartPlusAdUpdateVerification(plan: CompiledRequest) {
  const b = plan.body as JsonObject,
    id = b.smart_plus_ad_id as string,
    expected: JsonObject = {smart_plus_ad_id: id};
  if (b.ad_name !== undefined) expected.ad_name = b.ad_name;
  Object.assign(
    expected,
    tiktokSmartPlusAdProjection(Object.fromEntries(content.filter(k => b[k] !== undefined).map(k => [k, b[k]]))),
  );
  return [
    {
      path: tiktokSmartPlusAdGetPath,
      query: {advertiser_id: plan.accountId, filtering: {smart_plus_ad_ids: [id]}, page_size: 100},
      expected,
      id,
    },
  ];
}

/**
 * The names a request uses, as the spend rule reads them: every key at any depth (`changedFieldNames` in src/spend-effects.ts, which this
 * module cannot import: that module imports the family registry, and the architecture ratchet refuses the import cycle).
 */
const keyNames = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) for (const x of v) keyNames(x, out);
  else if (obj(v))
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keyNames(x, out);
    }
  return out;
};
/** The words the spend rule matches in a name (`spendWords` in src/spend-effects.ts; a test in tests/tiktok-smart-plus-tracking.test.mjs pins that they are the same). */
const spendWords = /budget|bid|spend/i;
/** The one key whose name the spend rule reads as a bid: "postbid" is no bid. */
const partner = 'brand_safety_postbid_partner';

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokSmartPlusAdUpdateFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_smart_plus_ad_edits',
  files: ['src/tiktok-smart-plus-ad-updates.ts', ['tests/tiktok-smart-plus-ad-updates.test.mjs']],
  kind: tiktokSmartPlusAdUpdateKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokSmartPlusAdUpdate(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) =>
    tiktokSmartPlusAdUpdateReads(plan).map(r => {
      const read = stateRead(r.path, r.query);
      read.action = r.action;
      return read;
    }),
  followUps: (plan, read, data) => tiktokSmartPlusAdUpdateFollowUp(plan, read, data),
  prerequisites: (plan, state) => tiktokSmartPlusAdUpdatePrerequisites(plan, state),
  impact: (plan, state, review) => tiktokSmartPlusAdUpdateImpact(plan, state, review.creativeEditConfirmed),
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusAdUpdateVerification(plan).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_ad_get'},
    })),
  creativeEditConfirmation: () => true,
  // An ad edit changes no budget, bid, schedule or status: the contract refuses every such field. But the match of field names against
  // budget, bid and spend (src/spend-effects.ts) read "bid" in brand_safety_postbid_partner, which TikTok returns with every ad and a
  // configuration copied from a read carries, and asked a pixel edit for spend_change_confirmed (r25-m4-smartedits). The exemption is for
  // that one name (S3-6 of the lead's review): it holds only for a plan that carries the partner and whose every other name is no budget, bid
  // or spend name, so a key that a later package adds to the contract under such a name still asks, as for every other family, and a plan
  // without the partner is judged by the whole rule, its active statuses included.
  exemptFromSpendTextMatch: plan => {
    const names = keyNames({query: plan.query, body: plan.body});
    return names.includes(partner) && names.every(name => name === partner || !spendWords.test(name));
  },
});
