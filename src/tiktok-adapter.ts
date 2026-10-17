import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, Connection} from './types.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {tiktokPreviewRoute} from './tiktok-preview-reads.js';

/**
 * TikTok's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the planning and
 * preview POSTs, the documented reads whose paths hold mutation-like words, and their authorization.
 */

// POST routes that are reads.
const tiktokReads = new Set([
  '/v1.3/ad/audience_size/estimate/',
  '/v1.3/audience/insight/info/',
  '/v1.3/tool/bid/recommend/',
  '/v1.3/tool/targeting/info/',
  '/v1.3/tool/targeting/search/',
  '/v1.3/tool/targeting_category/recommend/',
  '/v1.3/business/message/auto_message/get/',
  '/v1.3/business/message/media/download/',
  '/v1.3/gmv_max/creation/custom_anchor_video_list/get/',
]);
/**
 * Exact documented reads whose resource names contain mutation-like words, with the native identifiers each one takes.
 * This only establishes HTTP semantics; credentials and object scope are separate (authorizeQualifiedRead).
 */
export const qualifiedTikTokReadPaths: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '/v1.3/catalog/set/get/': Object.freeze(['bc_id', 'catalog_id']),
  '/v1.3/catalog/set/product/get/': Object.freeze(['bc_id', 'catalog_id']),
  '/v1.3/business/publish/status/': Object.freeze(['business_id']),
  '/v1.3/business/publish/location/': Object.freeze(['business_id']),
  '/v1.3/business/post/authorize/status/': Object.freeze(['business_id']),
  '/v1.3/business/mention/hashtag/verify/list/': Object.freeze(['business_id']),
  '/v1.3/tool/brand_safety/partner/authorize/status/': Object.freeze(['advertiser_id']),
  '/v1.3/ctm/message_event_set/get/': Object.freeze([
    'advertiser_id',
    'messaging_app_type',
    'messaging_app_account_id',
  ]),
  '/v1.3/gmv_max/exclusive_authorization/get/': Object.freeze(['advertiser_id', 'store_id', 'store_authorized_bc_id']),
  '/v1.3/identity/music/authorization/': Object.freeze(['advertiser_id', 'identity_type', 'identity_id']),
});
const denied = (message: string): never => {
  throw new MirrorError('RESOURCE_SCOPE_REQUIRED', message, {}, 403);
};
/** A qualified TikTok read names the selected advertiser, or an administrator bound its exact identifiers. */
function authorizeQualifiedTikTokRead(p: CompiledRequest, c: Connection, account: string): boolean {
  const fields = qualifiedTikTokReadPaths[p.path]!;
  if (fields.some(k => typeof p.query[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.query[k])))
    denied('Select the exact native business/catalog identifiers for this read.');
  if (fields[0] === 'advertiser_id') {
    if (p.query.advertiser_id !== account) denied('The advertiser must match the selected account.');
    if (fields.length === 1) return true;
  }
  const bound = c.resourceBindings?.some(
    b =>
      b.accountId === account &&
      b.pathPrefix === p.path.slice(0, -1) &&
      fields.every(k => b.query?.[k] === p.query[k]) &&
      Object.entries(b.query ?? {}).every(([k, v]) => stable(v) === stable(p.query[k])),
  );
  if (!bound)
    denied(
      'An administrator must bind this exact read path and its native business/catalog/store/identity/message-account identifiers to the selected account and connection. Advertiser access alone does not grant access to these additional resources.',
    );
  return true;
}

export const tiktokHooks: ProviderHooks = Object.freeze({
  gateway: 'tiktok_native_action',
  reads: Object.freeze({
    // Ad previews are POSTs the catalog marks as writes; they are reviewed reads, and their path words are not edits.
    plannedRead: (p: CompiledRequest) => !!tiktokPreviewRoute(p),
    wordExempt: (p: CompiledRequest) => !!tiktokPreviewRoute(p),
    qualifiedRead: (p: CompiledRequest) =>
      (!p.origin || p.origin === 'https://business-api.tiktok.com') && Object.hasOwn(qualifiedTikTokReadPaths, p.path),
    authorizeQualifiedRead: authorizeQualifiedTikTokRead,
    postRead: (plan: CompiledRequest, pathname: string) =>
      tiktokReads.has(pathname.replace(/^\/open_api/, '')) || !!tiktokPreviewRoute(plan),
  }),
});
