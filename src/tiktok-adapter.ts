import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {errorInteger, errorObject} from './provider-error-core.js';
import {tiktokPreviewRoute} from './tiktok-preview-reads.js';
import {
  tiktokIntegratedReport,
  tiktokReportGrain,
  tiktokReportPage,
  tiktokReportRowKey,
} from './tiktok-report-pagination.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
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
  paging: Object.freeze({
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response),
        data = obj(d.data);
      if (tiktokIntegratedReport(plan)) {
        const page = tiktokReportPage(response, plan.query);
        if (page.page >= page.pages) return null;
        next.query.page = page.page + 1;
        return next;
      }
      const info = data.page_info ?? d.page_info;
      if (info) {
        if (Number(info.page) >= Number(info.total_page)) return null;
        next.query.page = Number(info.page) + 1;
        return next;
      }
      // Business, identity, mention and TTO lists page by cursor: {cursor, has_more} (13 catalogued reads declare a
      // cursor). The cursor is opaque, a number or a string by endpoint; has_more without one cannot be continued.
      if (data.has_more !== true) return null;
      const cursor = data.cursor;
      if (!((typeof cursor === 'string' && cursor) || (Number.isSafeInteger(cursor) && cursor >= 0)))
        throw new MirrorError('UNKNOWN_PAGINATION', 'TikTok reports more results but supplies no usable cursor.');
      next.query.cursor = cursor;
      return next;
    },
    // Integrated reports are collected whole from page one: their counts and native rows are checked across the
    // collection, and the merged result keeps the first page's counts, which describe the whole verified collection.
    whole: Object.freeze({
      claims: tiktokIntegratedReport,
      start(plan: CompiledRequest) {
        const dimensions = tiktokReportGrain(plan.query),
          nativeRows = new Set<string>();
        if ((plan.query.page ?? 1) !== 1)
          throw new MirrorError('REPORT_INCOMPLETE', 'Start a complete TikTok report collection at page one.');
        let expectedTotal: number | undefined;
        return (request: CompiledRequest, response: unknown) => {
          const page = tiktokReportPage(response, request.query);
          if (expectedTotal !== undefined && page.total !== expectedTotal)
            throw new MirrorError(
              'REPORT_INCOMPLETE',
              'TikTok report counts changed during collection. Capture again.',
            );
          expectedTotal = page.total;
          for (const row of page.rows) {
            const key = tiktokReportRowKey(row, dimensions);
            if (nativeRows.has(key))
              throw new MirrorError('REPORT_DUPLICATE_ROWS', 'TikTok repeated a native reporting dimension tuple.');
            nativeRows.add(key);
          }
        };
      },
      pages: (data: unknown) => Number(obj(obj(obj(data).data).page_info).total_page),
      meaning:
        'TikTok reports are collected whole from page one: this repeats the collection with max_pages covering every page.',
    }),
  }),
  // The advertiser info read takes a list of one advertiser and returns it in data.list.
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/v1.3/advertiser/info/';
      read.query = {advertiser_ids: [id]};
      return read;
    },
    account: (data: JsonObject) => data.data?.list?.[0],
  }),
  // Requests go under /open_api with the access token in Access-Token; a failed result is a non-zero code in an HTTP
  // 200 body, and the report reads carry their own deadline.
  wire: Object.freeze({
    path: (path: string) => (path.startsWith('/open_api/') ? path : '/open_api' + path),
    tokenHeader: 'Access-Token',
    deadline: (plan: CompiledRequest) =>
      plan.readOnly && plan.method === 'GET' ? plan.tiktokReportDeadline : undefined,
    csv: (plan: CompiledRequest) =>
      plan.tiktokReportRead?.kind === 'download' &&
      plan.method === 'GET' &&
      plan.path === '/v1.3/report/task/download/',
    reportData: (plan: CompiledRequest) => /\/report\/integrated\/get\/$/.test(plan.path),
    failedResult: (data: JsonObject) => data.code !== undefined && data.code !== 0,
    errors: Object.freeze({code: (body: unknown) => errorInteger(errorObject(body).code)}),
  }),
});
