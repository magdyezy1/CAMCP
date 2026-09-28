import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * TikTok preview and Smart Text reads, per API for Business v1.3 "Preview an ad or a creative"
 * (POST /creative/ads_preview/create/), "Preview Upgraded Smart+ Ads" (POST /smart_plus/ad/preview/) and "Get Smart Text
 * recommendations" (POST /creative/smart_text/generate/), checked 2026-09-27. They use POST and the preview path says
 * "create", but they return a preview link or suggested ad texts and change nothing in the ad account. A preview link is
 * valid for 30 days (24 hours for add-on, instant page, video and image previews) and opens for anyone who has it.
 */
type Kind = 'ads_preview' | 'smart_plus_preview' | 'smart_text';
type Variant = {keys: string[]; required: string[]};
const gateway = 'tiktok_native_action',
  origin = 'https://business-api.tiktok.com',
  maxBytes = 64 * 1024;
const routes: Record<string, Kind> = {
  '/v1.3/creative/ads_preview/create/': 'ads_preview',
  '/v1.3/smart_plus/ad/preview/': 'smart_plus_preview',
  '/v1.3/creative/smart_text/generate/': 'smart_text',
};
const creation = [
  'objective_type',
  'is_smart_performance_campaign',
  'placement',
  'tiktok_subplacement',
  'preview_format',
  'shopping_ads_type',
  'product_source',
  'store_id',
  'store_authorized_bc_id',
  'showcase_products',
  'promotion_type',
  'identity_id',
  'identity_type',
  'identity_authorized_bc_id',
  'ad_format',
  'video_id',
  'image_ids',
  'end_card_cta',
  'music_id',
  'tiktok_item_id',
  'carousel_image_index',
  'ad_text',
  'call_to_action',
  'call_to_action_id',
  'card_id',
  'landing_page_url',
  'page_id',
  'catalog_id',
  'product_specific_type',
  'item_group_ids',
  'product_set_id',
  'sku_ids',
  'hotel_ids',
  'flight_ids',
  'destination_ids',
  'vehicle_ids',
  'auto_disclaimer_types',
  'catalog_authorized_bc_id',
  'dynamic_format',
  'vertical_video_strategy',
  'shopping_ads_video_template_id',
  'shopping_ads_fallback_type',
  'dynamic_destination',
  'instant_product_page_used',
];
const creative = ['display_name', 'ad_text', 'call_to_action', 'call_to_action_id', 'placements', 'device', 'language'];
// Each preview_type takes its own fields ("Preview ads that you plan to create", "Preview existing ads", add-ons, instant pages, videos, images).
const adsPreview: Record<string, Variant> = {
  ADS_CREATION: {keys: creation, required: ['objective_type', 'identity_id', 'identity_type', 'ad_format']},
  AD: {keys: ['ad_id', 'device', 'language', 'placement'], required: ['ad_id']},
  CARD: {keys: ['card_id'], required: ['card_id']},
  PAGE: {keys: ['page_id'], required: ['page_id']},
  SINGLE_VIDEO: {
    keys: ['video_id', 'thumbnail', 'profile_image', ...creative],
    required: ['video_id', 'display_name', 'ad_text', 'placements'],
  },
  SINGLE_IMAGE: {keys: ['image_id', ...creative], required: ['image_id', 'display_name', 'ad_text', 'placements']},
};
const smartPlusPreview: Record<string, Variant> = {
  ADS_CREATION: {
    keys: [
      'catalog_enabled',
      'catalog_id',
      'catalog_authorized_bc_id',
      'creative_list',
      'ad_text_list',
      'call_to_action_list',
      'ad_configuration',
    ],
    required: ['creative_list'],
  },
  AD: {keys: ['smart_plus_ad_id'], required: ['smart_plus_ad_id']},
};
const objectives = [
  'REACH',
  'TRAFFIC',
  'VIDEO_VIEWS',
  'ENGAGEMENT',
  'APP_PROMOTION',
  'LEAD_GENERATION',
  'WEB_CONVERSIONS',
  'PRODUCT_SALES',
  'RF_REACH',
];
const identities = ['CUSTOMIZED_USER', 'AUTH_CODE', 'TT_USER', 'BC_AUTH_TT'],
  formats = ['SINGLE_VIDEO', 'SINGLE_IMAGE', 'CAROUSEL_ADS', 'CATALOG_CAROUSEL', 'LIVE_CONTENT'];
const placements = ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE', 'PLACEMENT_GLOBAL_APP_BUNDLE', 'ALL'],
  languages = ['EN', 'JA', 'RU', 'VI'];
const textKeys = ['adgroup_id', 'param_type', 'language', 'industry_id', 'keywords', 'limit'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
function invalid(message: string): never {
  throw new MirrorError('INVALID_TIKTOK_PREVIEW_READ', message);
}
export function tiktokPreviewRoute(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin !== undefined && p.origin !== origin)
  )
    return;
  return routes[p.path];
}
/** The captured catalog lists the required fields of every preview variant together (and a nested Smart+ field), so no
 * single valid preview carries them all; tiktokPreviewPlan checks each variant's own required fields instead. */
export function tiktokPreviewVariantPath(gatewayName: string, path: string): boolean {
  return gatewayName === gateway && routes[path] !== undefined && routes[path] !== 'smart_text';
}
function fields(b: JsonObject, variant: Variant, label: string): void {
  const unknown = Object.keys(b).filter(
    k => k !== 'advertiser_id' && k !== 'preview_type' && !variant.keys.includes(k),
  );
  if (unknown.length) invalid(label + ' previews do not take ' + unknown.join(', ') + '.');
  const missing = variant.required.filter(k => b[k] === undefined || b[k] === null || b[k] === '');
  if (missing.length) invalid(label + ' previews need ' + missing.join(', ') + '.');
  for (const [k, v] of Object.entries(b)) {
    if (k.endsWith('_ids') && (!Array.isArray(v) || !v.length || v.length > 100 || v.some(x => !text(x, 128))))
      invalid(k + ' lists 1–100 TikTok IDs as strings.');
    if (k.endsWith('_id') && k !== 'advertiser_id' && !text(v, 128)) invalid(k + ' is a TikTok ID string.');
  }
}
function adsPreviewRead(b: JsonObject): void {
  const variant = adsPreview[String(b.preview_type)];
  if (!variant) invalid('preview_type is ' + Object.keys(adsPreview).join(', ') + '.');
  fields(b, variant, String(b.preview_type));
  if (b.ad_id !== undefined && !numeric(b.ad_id)) invalid('ad_id is the numeric ID of an ad of the advertiser.');
  if (b.preview_type !== 'ADS_CREATION') {
    if (
      b.placements !== undefined &&
      (!Array.isArray(b.placements) ||
        !b.placements.length ||
        b.placements.length > 10 ||
        b.placements.some(x => !text(x, 64)))
    )
      invalid('placements lists 1–10 placements.');
    for (const k of [
      'display_name',
      'ad_text',
      'thumbnail',
      'profile_image',
      'language',
      'call_to_action',
      'placement',
    ])
      if (b[k] !== undefined && !text(b[k], 1024)) invalid(k + ' is a non-empty string.');
    return;
  }
  if (!objectives.includes(b.objective_type)) invalid('objective_type is one of ' + objectives.join(', ') + '.');
  if (!identities.includes(b.identity_type)) invalid('identity_type is ' + identities.join(', ') + '.');
  if (!formats.includes(b.ad_format)) invalid('ad_format is ' + formats.join(', ') + '.');
  if (b.placement !== undefined && !placements.includes(b.placement))
    invalid('placement is ' + placements.join(', ') + '.');
  if (b.identity_type === 'BC_AUTH_TT' && b.identity_authorized_bc_id === undefined)
    invalid('identity_authorized_bc_id is required with BC_AUTH_TT identities.');
  if (b.store_id !== undefined && b.store_authorized_bc_id === undefined)
    invalid('store_authorized_bc_id is required with store_id.');
  if (b.ad_format === 'SINGLE_VIDEO' && b.video_id === undefined && b.tiktok_item_id === undefined)
    invalid('A single video preview needs video_id, or tiktok_item_id for a TikTok post.');
  if (b.ad_format === 'SINGLE_IMAGE' && b.image_ids === undefined) invalid('A single image preview needs image_ids.');
  if (Array.isArray(b.image_ids) && b.image_ids.length > 35) invalid('image_ids lists at most 35 images.');
  if (
    b.showcase_products !== undefined &&
    (!Array.isArray(b.showcase_products) ||
      !b.showcase_products.length ||
      b.showcase_products.length > 20 ||
      b.showcase_products.some(
        x =>
          !obj(x) ||
          !text(x.item_group_id, 128) ||
          !text(x.store_id, 128) ||
          Object.keys(x).some(k => k !== 'item_group_id' && k !== 'store_id'),
      ))
  )
    invalid('showcase_products lists 1–20 products, each with item_group_id and store_id.');
}
function smartPlusPreviewRead(b: JsonObject): void {
  const variant = smartPlusPreview[String(b.preview_type)];
  if (!variant) invalid('preview_type is ADS_CREATION or AD.');
  fields(b, variant, String(b.preview_type));
  if (b.preview_type === 'AD') {
    if (!numeric(b.smart_plus_ad_id))
      invalid('smart_plus_ad_id is the numeric ID of an Upgraded Smart+ ad of the advertiser.');
    return;
  }
  const list = b.creative_list;
  if (!Array.isArray(list) || !list.length || list.length > 31 || list.some(c => !obj(c) || !obj(c.creative_info)))
    invalid('creative_list lists 1–31 creatives, each with a creative_info object.');
  if (
    b.ad_text_list !== undefined &&
    (!Array.isArray(b.ad_text_list) ||
      !b.ad_text_list.length ||
      b.ad_text_list.length > 5 ||
      b.ad_text_list.some(t => !obj(t) || !text(t.ad_text, 1024)))
  )
    invalid('ad_text_list lists 1–5 ad texts.');
  if (
    b.call_to_action_list !== undefined &&
    (!Array.isArray(b.call_to_action_list) ||
      !b.call_to_action_list.length ||
      b.call_to_action_list.length > 3 ||
      b.call_to_action_list.some(t => !obj(t)))
  )
    invalid('call_to_action_list lists 1–3 calls to action.');
  if (b.ad_configuration !== undefined && !obj(b.ad_configuration)) invalid('ad_configuration is an object.');
  if (
    b.call_to_action_list !== undefined &&
    obj(b.ad_configuration) &&
    b.ad_configuration.call_to_action_id !== undefined
  )
    invalid('call_to_action_list and call_to_action_id cannot be set together.');
  if (b.catalog_enabled !== undefined && typeof b.catalog_enabled !== 'boolean')
    invalid('catalog_enabled is true or false.');
  if (b.catalog_enabled === true && b.catalog_id === undefined) invalid('A catalog preview needs catalog_id.');
}
function smartTextRead(b: JsonObject): void {
  const unknown = Object.keys(b).filter(k => k !== 'advertiser_id' && !textKeys.includes(k));
  if (unknown.length) invalid('Smart Text requests do not take ' + unknown.join(', ') + '.');
  if (!numeric(b.adgroup_id)) invalid('adgroup_id is the numeric ID of an ad group of the advertiser.');
  const type = b.param_type ?? 'CUSTOMIZED';
  if (!['RECOMMENDED', 'CUSTOMIZED'].includes(type)) invalid('param_type is RECOMMENDED or CUSTOMIZED.');
  if (b.language !== undefined || type === 'CUSTOMIZED')
    if (!languages.includes(b.language))
      invalid(
        'language is EN, JA, RU or VI' +
          (type === 'CUSTOMIZED' ? ' and is required with CUSTOMIZED parameters' : '') +
          '.',
      );
  if (b.keywords !== undefined || type === 'CUSTOMIZED')
    if (
      !Array.isArray(b.keywords) ||
      !b.keywords.length ||
      b.keywords.length > 50 ||
      b.keywords.some(k => !text(k, 100)) ||
      new Set(b.keywords).size !== b.keywords.length
    )
      invalid(
        'keywords lists 1–50 different keywords of up to 100 characters' +
          (type === 'CUSTOMIZED' ? ' and is required with CUSTOMIZED parameters' : '') +
          '.',
      );
  if (b.industry_id !== undefined && !numeric(b.industry_id)) invalid('industry_id is a numeric TikTok industry ID.');
  if (b.limit !== undefined && (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > 20))
    invalid('limit is 1–20 texts.');
}
export function validateTiktokPreviewRead(p: CompiledRequest): void {
  const kind = tiktokPreviewRoute(p);
  if (!kind) return;
  const b = p.body;
  if (!p.accountId || !obj(b) || String(b.advertiser_id) !== p.accountId)
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (Object.keys(p.query).length) invalid('Send every field in the JSON body; these reads take no query parameters.');
  if (Object.keys(p.headers).length) invalid('These reads take no header overrides.');
  if (Buffer.byteLength(JSON.stringify(b)) > maxBytes)
    invalid("The request exceeds AMCP's 64 KiB bound for preview and Smart Text reads.");
  if (kind === 'ads_preview') adsPreviewRead(b);
  else if (kind === 'smart_plus_preview') smartPlusPreviewRead(b);
  else smartTextRead(b);
}
/** Compiler hook: a valid preview or Smart Text request is a read and never a reviewed mutation. */
export function tiktokPreviewPlan(p: CompiledRequest): CompiledRequest {
  const kind = tiktokPreviewRoute(p);
  if (!kind) return p;
  validateTiktokPreviewRead(p);
  const short =
    kind === 'ads_preview' &&
    ['CARD', 'PAGE', 'SINGLE_VIDEO', 'SINGLE_IMAGE'].includes(String((p.body as JsonObject).preview_type));
  return {
    ...p,
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    warnings: [
      ...p.warnings,
      kind === 'smart_text'
        ? 'TikTok generates suggested ad texts (English, Japanese, Russian or Vietnamese; not for ad accounts in the United States or Canada). Nothing in the ad account changes, and nothing is sent back about which text is used.'
        : 'TikTok returns a preview link and an iframe that stay valid for ' +
          (short ? '24 hours' : '30 days') +
          '; anyone who has the link can open the preview. Nothing in the ad account changes.',
    ],
  };
}
