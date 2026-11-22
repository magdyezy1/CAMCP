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
  tiktokRefuseUndocumentedGroup,
} from './tiktok-smart-plus-pixels.js';
import {
  tiktokSmartPlusAdGetPath,
  checkSparkCreatives,
  checkAdTexts,
  checkEndCards,
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
import {
  adKindMark,
  assetReads,
  creativeKey,
  creativeKind,
  darkPostMeaning,
  identityTypes,
  imagesOf,
  keptMaterials,
  listKind,
  musicOf,
  tiktokMaterialAllowlistNotice,
  videoOf,
  withAllowlistHint,
} from './tiktok-smart-plus-push.js';
import type {AssetRead, Marked, PushRead} from './tiktok-smart-plus-push.js';
import {checkEndCardState, endCardImpact, endCardProjection, endCardReads} from './tiktok-smart-plus-end-cards.js';
import type {EndCardMarked} from './tiktok-smart-plus-end-cards.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {defineFamily} from './family-kit.js';

/**
 * Edits of Upgraded Smart+ Spark Ads, per API for Business v1.3 "Update an Upgraded Smart+ Ad" (checked 2026-09-26, and read again
 * 2026-11-21 by r25-m4b-smartpush): incremental, except that creative_list is replaced in full, so creatives left out are removed;
 * ad_material_id is allowlist-only and makes TikTok ignore creative_info; TRANSLATE_AND_DUB cannot change after creation. Status
 * changes use the Smart+ status family.
 *
 * Since r25-m4b-smartpush (E12) an ad built from uploads (Spark Ads Push) is edited as an ad of posts is: its creatives (all uploads,
 * checked against the library), its ad texts (`ad_text_list`, 1 to 5; the page states no merge rule for the list, so the read-back says
 * what TikTok did with it) and its configuration, `dark_post_status` included. An edit keeps the ad's kind: an ad of uploads takes no
 * posts, and an ad of posts takes no ad texts. Custom identities (non-Spark ads) are another package's, and stay name-only.
 *
 * Since r25-m4b-endcards an edit may replace the end cards an ad holds (`end_card_list`, read 2026-11-22: "You can only use this field to
 * update existing end cards in your ads"), so an ad that holds none is refused with that sentence and is created with its end cards instead.
 * The page says nothing of whether the list is merged or replaced: AMCP sends the whole list the caller names, and the read-back, compared as
 * a set of IDs, shows what TikTok did.
 */
export const tiktokSmartPlusAdUpdatePath = '/v1.3/smart_plus/ad/update/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const emoji = /\p{Extended_Pictographic}/u;
const width = (s: string) => [...s].reduce((n, c) => n + (/[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(c) ? 2 : 1), 0);
// `ad_configuration_patch` (r25-m4-smartedits, QUESTIONS L4 (a)) is no key of TikTok's request: AMCP merges it into the ad's current
// configuration at review and hands the whole configuration back, so it never reaches TikTok.
const editable = [
    'ad_name',
    'creative_list',
    'ad_text_list',
    // r25-m4b-endcards: "Update an Upgraded Smart+ Ad" (read 2026-11-22) takes `end_card_list` ("You can only use this field to update
    // existing end cards in your ads"): it replaces the end cards an ad holds (src/tiktok-smart-plus-end-cards.ts).
    'end_card_list',
    'landing_page_url_list',
    'ad_configuration',
    'ad_configuration_patch',
  ],
  content = [
    'creative_list',
    'ad_text_list',
    'end_card_list',
    'landing_page_url_list',
    'ad_configuration',
    'ad_configuration_patch',
  ];

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
      invalid(
        'ad_name',
        'Send at least one of ad_name, creative_list, ad_text_list, end_card_list, landing_page_url_list and ad_configuration.',
      );
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
  const kind = body.creative_list !== undefined ? checkSparkCreatives(body.creative_list, found, true) : undefined;
  // The ad texts of an upload; an ad of posts uses the post's own (r25-m4b-smartpush, A5). Which kind the ad is, when no creatives are
  // sent, is the prerequisites': the ad is read there.
  if (body.ad_text_list !== undefined) {
    if (kind === 'pull')
      collect(found, () =>
        invalid(
          'ad_text_list',
          '"ad_text_list" is outside the qualified Smart+ Spark Ad edit contract; Spark Ads from existing posts use the post text.',
        ),
      );
    else checkAdTexts(body.ad_text_list, kind, found, false);
  }
  if (body.end_card_list !== undefined) checkEndCards(body.end_card_list, found);
  // The profile choice is a Push's: an edit that names posts takes ON only, and one that names no creatives leaves it to the ad it edits.
  const darkPost = kind === 'pull' ? 'on' : 'any';
  const url =
    body.landing_page_url_list !== undefined ? checkLandingPage(body.landing_page_url_list, found) : undefined;
  if (body.ad_configuration !== undefined) checkAdConfiguration(body.ad_configuration, url, found, false, darkPost);
  if (body.ad_configuration_patch !== undefined) {
    collect(found, () => {
      if (body.ad_configuration !== undefined)
        invalid(
          'ad_configuration_patch',
          'Send ad_configuration_patch or ad_configuration, not both: AMCP merges the patch into the ad’s current ad_configuration and hands the whole configuration back.',
        );
    });
    checkAdConfiguration(body.ad_configuration_patch, undefined, found, true, darkPost);
  }
  refuse(found);
}

/** The configuration an edit names: the whole one, or the patch of it. The CTA portfolio and the pixel it names are read either way. */
const namedConfiguration = (b: JsonObject): JsonObject | undefined =>
  obj(b.ad_configuration) ? b.ad_configuration : obj(b.ad_configuration_patch) ? b.ad_configuration_patch : undefined;

type Read = {path: string; query: JsonObject; action: string; push?: PushRead; endCards?: true};
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
  // The creatives an edit sends are read as a create's are: each identity and post, and the library of each upload (r25-m4b-smartpush).
  // One kept by its ad_material_id is the ad's own and is not read again (A16).
  if (b.creative_list !== undefined)
    reads.push(...sparkReads(id, b.creative_list as JsonObject[]), ...(assetReads(id, b.creative_list) as AssetRead[]));
  // The end cards an edit names are read as a create's are, from the advertiser's own portfolio list (r25-m4b-endcards).
  reads.push(...endCardReads(id, b.end_card_list));
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
/** The name TikTok gives a carousel the request names none for ("Image carousel X", "Update an Upgraded Smart+ Ad"): no one's choice. */
const automaticName = /^Image carousel \d+$/;
/**
 * A carousel's own name is not lost by an edit (r25-m4b-smartpush; "Update an Upgraded Smart+ Ad", read 2026-11-21): "the system overwrites
 * your custom name with an auto-generated one" when a restated carousel names none, so a carousel the ad has under a custom name of its own
 * must restate it, in `material_name` (an empty one accepts TikTok's). The name is not repeated in the refusal: it is TikTok's data.
 */
function carouselNames(row: JsonObject, list: JsonObject[]): void {
  const held = new Map(
    postsOf(row)
      .filter(ci => creativeKind(ci) === 'carousel' || (videoOf(ci) === undefined && imagesOf(ci).length > 0))
      .map(ci => [creativeKey(ci, true), typeof ci.material_name === 'string' ? ci.material_name : ''] as const),
  );
  list.forEach((c, n) => {
    const ci = c.creative_info;
    // A creative kept by its ad_material_id keeps its name with it (A16).
    if (!obj(ci) || creativeKind(ci) !== 'carousel') return;
    const name = held.get(creativeKey(ci));
    if (name && !automaticName.test(name) && ci.material_name === undefined)
      invalid(
        'creative_list[' + n + '].creative_info.material_name',
        'A carousel of this ad has a custom name, which TikTok replaces with an automatic one when a restated carousel names none: restate it in material_name (an empty material_name accepts TikTok’s).',
      );
  });
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
/** The creatives an ad holds by their material IDs, as its read returns them (A16): what an update may keep by naming the ID. */
const materialsOf = (row: JsonObject): Map<string, JsonObject> =>
  new Map(
    (Array.isArray(row.creative_list) ? row.creative_list : [])
      .filter(
        (c: JsonObject) =>
          obj(c) &&
          obj(c.creative_info) &&
          c.ad_material_id !== undefined &&
          c.ad_material_id !== null &&
          c.ad_material_id !== '',
      )
      .map((c: JsonObject) => [String(c.ad_material_id), c.creative_info as JsonObject] as const),
  );
const landingPagesOf = (row: JsonObject) => (Array.isArray(row.landing_page_url_list) ? row.landing_page_url_list : []);
/**
 * What an ad's creatives are, as its read shows them (r25-m4b-smartpush): posts of an account or an authorized creator (Spark Ads Pull),
 * or uploads published under a TikTok account (Spark Ads Push: TT_USER or BC_AUTH_TT); undefined for anything else, a custom identity's
 * ad included. The creatives say which: a post names a post and no upload (Spark Ads Pull, as "Create an Upgraded Smart+ Ad" shows its
 * response), an upload names a video or images and no post (Spark Ads Push). The ad texts, which an ad of uploads has and a request for an ad
 * of posts sends none of ("Upgraded Smart+ ad creative combinations by identity and ad type"), are only the tie-break for a creative that
 * carries both kinds of keys, as a read does that also carries the post TikTok generated for an upload: no page says what a read of an ad of
 * posts returns in `ad_text_list`, so a text there is no reason to take an ad of posts for anything else (the lead's review S2-1).
 */
const creativesOf = (row: JsonObject): 'pull' | 'push' | undefined => {
  const infos = postsOf(row);
  if (!infos.length) return undefined;
  const hasUpload = (ci: JsonObject) => videoOf(ci) !== undefined || imagesOf(ci).length > 0,
    uploads = (ci: JsonObject) => hasUpload(ci) && identityTypes.video.includes(ci.identity_type),
    posts = (ci: JsonObject) =>
      typeof ci.tiktok_item_id === 'string' &&
      ci.tiktok_item_id !== '' &&
      identityTypes.pull.includes(ci.identity_type),
    // An upload that names no post: its read has no post ID, or an empty one.
    noPost = (ci: JsonObject) =>
      ci.tiktok_item_id === undefined || ci.tiktok_item_id === null || ci.tiktok_item_id === '';
  if (infos.every(ci => posts(ci) && !hasUpload(ci))) return 'pull';
  if (infos.every(ci => uploads(ci) && noPost(ci))) return 'push';
  // A creative with both kinds of keys: the ad texts decide, which only an ad of uploads has.
  if (Array.isArray(row.ad_text_list) && row.ad_text_list.length) return infos.every(uploads) ? 'push' : undefined;
  return infos.every(posts) ? 'pull' : undefined;
};
/**
 * An ad this contract edits beyond its name: Spark creatives and a CTA portfolio, as the create contract makes them (posts, or uploads
 * since r25-m4b-smartpush), and one destination: one landing page (a website ad), or, since r25-m4-smartedits (T5), one Instant Form and
 * no landing page (a lead ad: its read carries `page_list`, and a landing page list that is empty or absent). Before that, every ad
 * had to have a landing page, which an Instant Form ad has none of, so only its name could be edited.
 */
const sparkAd = (row: JsonObject): {dest: 'website' | 'form'; kind: 'pull' | 'push'} | undefined => {
  const kind = creativesOf(row);
  if (!(kind && obj(row.ad_configuration) && !!row.ad_configuration.call_to_action_id)) return undefined;
  const pages = landingPagesOf(row),
    forms = Array.isArray(row.page_list) ? row.page_list : [];
  if (pages.length === 1) return {dest: 'website', kind};
  return pages.length === 0 && forms.length === 1 && obj(forms[0]) && numeric(String(forms[0].page_id))
    ? {dest: 'form', kind}
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
 * M4 LV-20 (b), the PROBE of r25-m4-smartedits (QUESTIONS L19, the lead's decision of 2026-11-21): TikTok documents no ad-level pixel
 * for a website ad (its pixel is its ad group's: src/tiktok-smart-plus-pixels.ts), and the White Friday pixel attach of a website ad was
 * made in TikTok's UI. So an edit of a website ad's pixel is sent only as an experiment, and says so in its review (`note`). It is done
 * only when TikTok accepts it AND the read-back shows the pixel: TikTok's refusal applies nothing and is recorded as a definitive
 * refusal (the nine codes of src/tiktok-write-rejection.ts), and a read-back without the pixel is a verification mismatch, never a
 * success (the family's ordinary verification compares the edited keys). An edit only: a created website ad takes no pixel of its own.
 * Qualified website ad groups only: WEBSITE, and no catalog (its row carries no catalog_id).
 *
 * To remove the probe if live check LV-20 (b) shows that TikTok refuses or drops the pixel: delete this function and its two uses (the
 * condition in `pixelPrerequisites`, and `note` in the impact). A website ad's pixel edit is then the local refusal of the other kinds,
 * which names the documented scenarios. Mind that a website ad that already holds a pixel (one attached in TikTok's UI, as the White Friday
 * ad was) is then no longer editable in its configuration at all, by a whole configuration or a patch: the guard above refuses leaving
 * the pixel out, and the refusal of a website ad's pixel refuses naming it (S4-3 of the lead's review; record it in the removal note of
 * QUESTIONS L19 and the gap report).
 */
const websitePixelNote =
  'TikTok documents an ad-level pixel only for app promotion and Instant Form ads. For this website ad TikTok decides: if it refuses, nothing is applied; if the read-back does not show the pixel, the edit is not verified.';
function websitePixelProbe(group: JsonObject): string | undefined {
  const catalog =
    group.catalog_id !== undefined && group.catalog_id !== null && !['', '0'].includes(String(group.catalog_id));
  return tiktokPixelGroupKind(group) === 'website' && !catalog ? websitePixelNote : undefined;
}
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
  if (tiktokPixelGroupKind(group) !== 'instant_form' && websitePixelProbe(group) === undefined)
    tiktokRefuseUndocumentedGroup();
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
  spark: {dest: 'website' | 'form'; kind: 'pull' | 'push'},
): void {
  const current = row.ad_configuration as JsonObject,
    push = spark.kind === 'push';
  // S2-1: an ad that holds a setting AMCP cannot restate is not edited here, whether the configuration is whole or a merged patch.
  refuse(unrestatable(current, ad, push));
  // r25-m4b-smartpush: the posts of an ad of uploads are on the identity's profile only with OFF, which "Update an Upgraded Smart+ Ad"
  // gives for Spark Ads Push alone. And a new configuration that leaves the key out could set an OFF back to ON, as one that leaves out
  // `utm_params` could clear them, so an ad that holds OFF has it restated.
  if (!push && config.dark_post_status === 'OFF')
    invalid(
      'ad_configuration.dark_post_status',
      'Set dark_post_status to ON or leave it out: ON is its default, and other values are outside the qualified Smart+ Spark Ad contract.',
    );
  if (push && current.dark_post_status === 'OFF' && config.dark_post_status === undefined)
    invalid(
      'ad_configuration.dark_post_status',
      'Restate dark_post_status: ad ' +
        ad +
        ' has OFF (its posts also appear on the identity’s profile), and a new ad_configuration could set it back to ON.',
    );
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
  if (spark.dest === 'form' && config.utm_params !== undefined)
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
/**
 * The values of the two keys a read returns with every ad that the contract restates at their own value (r25-m4-smartedits): UNSET, and
 * ON. An ad of uploads (Spark Ads Push) may also hold OFF, which a Push create accepts when it says so (r25-m4b-smartpush; the owner's
 * O1), so for it OFF is restated as well; for an ad of posts the key is valid for no other value than the ON a read returns.
 */
const restatable = (push: boolean): Record<string, string[]> => ({
  product_specific_type: ['UNSET'],
  dark_post_status: push ? ['ON', 'OFF'] : ['ON'],
});
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
function unrestatable(current: JsonObject, ad: unknown, push = false): Violation[] {
  const found: Violation[] = [],
    allowed = restatable(push);
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
    if (Object.hasOwn(allowed, key)) {
      if (!allowed[key]!.includes(value as string) && !unset(value))
        found.push({
          field: 'ad_configuration.' + key,
          message:
            'Ad ' +
            ad +
            ' has ' +
            key +
            (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? ' ' + value : ' with a value') +
            ', which an ad_configuration sent from here cannot restate: only ' +
            allowed[key]!.join(' or ') +
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
function mergedConfiguration(current: JsonObject, patch: JsonObject, ad: unknown, push = false): JsonObject {
  const found: Violation[] = unrestatable(current, ad, push),
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
  for (const [key, values] of Object.entries(restatable(push)))
    if (values.includes(current[key] as string)) merged[key] = current[key];
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
  checkAdConfiguration(merged, undefined, contract, false, push ? 'any' : 'on');
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
  const spark = sparkAd(row);
  if (!spark)
    invalid(
      'smart_plus_ad_id',
      'Smart+ ad ' +
        ad +
        ' is not an ad from existing TikTok posts or uploaded creatives (Spark Ads) with one landing page and a CTA portfolio; only its name can be edited under this contract.',
    );
  // An Instant Form ad's posts and destination are not edited here (r25-m4-smartedits): only its name and its ad_configuration, where its pixel is
  // (and, for an ad of uploads, its ad texts).
  if (spark.dest === 'form' && (b.creative_list !== undefined || b.landing_page_url_list !== undefined))
    invalid(
      'smart_plus_ad_id',
      'Smart+ ad ' +
        ad +
        ' collects leads with an Instant Form; under this contract its name and its ad_configuration can be edited, not its posts or a landing page.',
    );
  const push = spark.kind === 'push';
  // An edit keeps the ad's kind (r25-m4b-smartpush): an ad of uploads takes no posts, an ad of posts takes no uploads, and the texts of an
  // ad are an upload's ("Upgraded Smart+ ad creative combinations by identity and ad type": an ad of posts has none).
  // A list that keeps every creative by its material ID names no kind (A16): they are the ad's own.
  const sentKind = b.creative_list !== undefined ? listKind(b.creative_list) : undefined;
  if (sentKind !== undefined && sentKind !== spark.kind)
    invalid(
      'creative_list',
      push
        ? 'Smart+ ad ' +
            ad +
            ' is built from uploads (Spark Ads Push): its creatives stay uploaded videos and carousels, and an edit does not turn it into an ad of posts.'
        : 'Smart+ ad ' +
            ad +
            ' is built from existing posts (Spark Ads Pull): its creatives stay posts, and an edit does not turn it into an ad of uploads.',
    );
  if (b.ad_text_list !== undefined && !push)
    invalid(
      'ad_text_list',
      'Smart+ ad ' +
        ad +
        ' is built from existing posts (Spark Ads Pull), which use the post text: its ad texts are not edited.',
    );
  if (b.creative_list !== undefined) {
    const list = b.creative_list as JsonObject[],
      held = materialsOf(row);
    // A creative kept by its ad_material_id is one the ad holds now (A16); TikTok would otherwise answer for an ID it does not know.
    list.forEach((c, n) => {
      if (c.creative_info === undefined && typeof c.ad_material_id === 'string' && !held.has(c.ad_material_id))
        invalid(
          'creative_list[' + n + '].ad_material_id',
          'Smart+ ad ' +
            ad +
            ' holds no creative with ad_material_id ' +
            c.ad_material_id +
            ': keep only the creatives the ad holds now, by the ad_material_id its read returns.',
        );
    });
    // And a creative kept by its ID is not also sent by its content: it would be in the ad twice.
    const keys = list.map(c =>
      c.creative_info === undefined
        ? creativeKey(held.get(String(c.ad_material_id))!, push)
        : creativeKey(c.creative_info as JsonObject),
    );
    if (new Set(keys).size !== keys.length)
      invalid(
        'creative_list',
        'A creative appears twice in creative_list: once by its ad_material_id and once by its content.',
      );
    sparkPrerequisites(
      list,
      values.map(v => (obj(v) && obj(v.data) ? v.data : undefined)).filter((d): d is JsonObject => !!d),
    );
    if (push) carouselNames(row, list);
  }
  // The end cards (r25-m4b-endcards): "You can only use this field to update existing end cards in your ads", so an ad that holds none is not
  // given one by an edit; the ones an edit names are the advertiser's and are end cards.
  if (b.end_card_list !== undefined) {
    if (!endCardProjection(row.end_card_list).length)
      invalid(
        'end_card_list',
        'TikTok’s page for the update says end_card_list can only update the end cards an ad already holds, and this ad holds none: create an ad with its end cards instead.',
      );
    checkEndCardState(
      b.end_card_list,
      values.map(v => (obj(v) && obj(v.data) ? v.data : undefined)).filter((d): d is JsonObject => !!d),
    );
  }
  const current = row.ad_configuration as JsonObject,
    patch = obj(b.ad_configuration_patch) ? b.ad_configuration_patch : undefined,
    config = obj(b.ad_configuration)
      ? b.ad_configuration
      : patch
        ? mergedConfiguration(current, patch, ad, push)
        : undefined;
  if (config) configurationPrerequisites(row, config, values, ad, spark);
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
    // The ad's kind: an ad of uploads is told by its texts when a read also carries a generated post ID (r25-m4b-smartpush).
    push = creativesOf(row) === 'push',
    before = postsOf(row).map(ci => creativeKey(ci, push));
  let removed: string[] = [];
  if (b.ad_name !== undefined) changes.ad_name = {before: row.ad_name ?? null, after: b.ad_name};
  if (b.creative_list !== undefined) {
    // A creative kept by its ad_material_id is the ad's own creative with that ID, as it is (A16).
    const held = materialsOf(row),
      list = b.creative_list as JsonObject[],
      sent = list.map(c => c.creative_info as JsonObject | undefined),
      after = list.map((c, n) =>
        sent[n] ? creativeKey(sent[n]!) : creativeKey(held.get(String(c.ad_material_id)) ?? {}, push),
      ),
      kept = after.filter(i => before.includes(i));
    removed = before.filter(i => !after.includes(i));
    const retained = keptMaterials(list);
    changes.creative_list = {
      kept,
      added: after.filter(i => !before.includes(i)),
      removed,
      // A kept upload under another cover, or a kept carousel under another name (an ad of posts has nothing to change in a kept post).
      ...(push
        ? {
            changed: kept.filter(key => {
              const now = sent.find(ci => ci && creativeKey(ci) === key),
                was = postsOf(row).find(ci => creativeKey(ci, true) === key)!;
              return (
                !!now &&
                JSON.stringify([imagesOf(now), musicOf(now) ?? null, now.material_name ?? '']) !==
                  JSON.stringify([imagesOf(was), musicOf(was) ?? null, was.material_name ?? ''])
              );
            }),
          }
        : {}),
      ...(retained.length ? {retained} : {}),
    };
  }
  // The ad texts as a list, in one order: before and after (TikTok states no rule for merging the list, so the read-back says which it did).
  if (b.ad_text_list !== undefined)
    changes.ad_text_list = {
      before: (Array.isArray(row.ad_text_list) ? row.ad_text_list : [])
        .map((t: JsonObject) => t?.ad_text ?? null)
        .sort(),
      after: (b.ad_text_list as JsonObject[]).map(t => t.ad_text).sort(),
    };
  // The end cards before and after, each as a set of IDs (TikTok states no order for the list; r25-m4b-endcards).
  if (b.end_card_list !== undefined)
    changes.end_card_list = {before: endCardProjection(row.end_card_list), after: endCardProjection(b.end_card_list)};
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
    pixel = tiktokAdPixel(b.ad_configuration),
    group = pixel !== undefined ? groupRowOf(row, state).group : undefined,
    note = group ? websitePixelProbe(group) : undefined;
  if (live && removed.length && !override)
    throw new MirrorError(
      'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
      'This edit removes ' +
        removed.length +
        (push ? ' creative(s)' : ' post(s)') +
        ' from enabled ad ' +
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
        ? 'Changes an enabled ad; TikTok reviews the modifications (AD_STATUS_DELIVERY_AND_REAUDIT) before they deliver, and removed ' +
          (push ? 'creatives' : 'posts') +
          ' stop delivering in this ad.'
        : 'Changes a paused ad; nothing delivers until it is enabled.',
    ad: {
      smart_plus_ad_id: b.smart_plus_ad_id,
      adgroup_id: row.adgroup_id ?? null,
      operation_status: row.operation_status ?? null,
    },
    changes,
    // Keeping a creative by its ad_material_id is TikTok's allowlist-only feature: the review says what TikTok decides (A16).
    ...(keptMaterials(b.creative_list).length ? {allowlist: tiktokMaterialAllowlistNotice} : {}),
    // The end cards the edit names, with their own allowlist sentence (r25-m4b-endcards; the ad's ad group is not read for an edit, so there is
    // no placement note).
    ...endCardImpact(b.end_card_list),
    // The pixel the edit names, with whether the advertiser owns it (r25-m4-smartedits, T5; a shared pixel is reported), and, for a website ad,
    // the note that TikTok decides (the probe).
    ...(pixel !== undefined ? {tracking_pixel: tiktokAdPixelImpact(pixel, state)} : {}),
    ...(note !== undefined ? {note} : {}),
    // The profile choice of an ad of uploads, when the edit names it (the owner's O1).
    ...(push && obj(b.ad_configuration) && b.ad_configuration.dark_post_status !== undefined
      ? {
          dark_post: {
            dark_post_status: b.ad_configuration.dark_post_status,
            meaning: darkPostMeaning(b.ad_configuration.dark_post_status === 'OFF' ? 'OFF' : 'ON'),
          },
        }
      : {}),
    creative_edit_confirmed: override,
    source: 'https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad/v1.3',
  };
}
export function tiktokSmartPlusAdUpdateVerification(plan: CompiledRequest, before: unknown[] = []) {
  const b = plan.body as JsonObject,
    id = b.smart_plus_ad_id as string,
    expected: JsonObject = {smart_plus_ad_id: id};
  if (b.ad_name !== undefined) expected.ad_name = b.ad_name;
  // A creative kept by its ad_material_id is read back as the creative the ad held (A16), and without its ID: the projection of a list that
  // names material IDs would expect each one's status, which no request sent.
  const row = adOf(plan, before) ?? {},
    held = materialsOf(row),
    // The kind of the ad, as its review read it (the lead's review S2-1): the read-back is read as that kind, never by the row's own ad texts.
    kind = creativesOf(row),
    source: JsonObject = Object.fromEntries(content.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
  if (Array.isArray(source.creative_list))
    source.creative_list = source.creative_list
      .map((c: JsonObject) => (c.creative_info !== undefined ? c : {creative_info: held.get(String(c.ad_material_id))}))
      .filter((c: JsonObject) => c.creative_info !== undefined)
      .map((c: JsonObject) => ({creative_info: c.creative_info}));
  Object.assign(expected, tiktokSmartPlusAdProjection(source, kind));
  return [
    {
      path: tiktokSmartPlusAdGetPath,
      query: {advertiser_id: plan.accountId, filtering: {smart_plus_ad_ids: [id]}, page_size: 100},
      expected,
      id,
      kind,
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
  files: [
    'src/tiktok-smart-plus-ad-updates.ts',
    [
      'tests/tiktok-smart-plus-ad-updates.test.mjs',
      'tests/tiktok-smart-plus-push.test.mjs',
      'tests/tiktok-smart-plus-material-reuse.test.mjs',
      'tests/tiktok-smart-plus-end-cards.test.mjs',
    ],
  ],
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
      // The library reads and the identity of an upload keep what they compare, never the signed links (r25-m4b-smartpush); so does the end
      // card read (r25-m4b-endcards).
      if (r.push) (read as Marked).tiktokPush = r.push;
      if (r.endCards) (read as EndCardMarked).tiktokEndCards = true;
      return read;
    }),
  followUps: (plan, read, data) => tiktokSmartPlusAdUpdateFollowUp(plan, read, data),
  prerequisites: (plan, state) => tiktokSmartPlusAdUpdatePrerequisites(plan, state),
  impact: (plan, state, review) => tiktokSmartPlusAdUpdateImpact(plan, state, review.creativeEditConfirmed),
  verification: (plan, result, before, verificationRead) =>
    tiktokSmartPlusAdUpdateVerification(plan, before).map(({kind, ...v}) => ({
      ...v,
      // The read-back is read as the kind of ad the edit was of (the lead's review S2-1), never by the row's own ad texts.
      read: {...verificationRead(v.path, v.query), action: 'tiktok_smart_plus_ad_get', ...adKindMark(kind)},
    })),
  creativeEditConfirmation: () => true,
  // TikTok's 40118 on an edit that keeps a creative by its ad_material_id (A16) or uses end cards says what to ask TikTok.
  safeError: withAllowlistHint,
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
