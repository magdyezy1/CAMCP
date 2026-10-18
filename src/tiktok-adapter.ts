import {
  plainGetRead,
  type ExpectState,
  type ProviderHooks,
  type ProviderVerificationRead,
  type ScopeContext,
  type StateTarget,
} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
// The write-shape and state refusals keep the write stages' own helper (src/write-common.ts).
import {fail} from './write-common.js';
import {pausedParentChildStatuses} from './paused-parents.js';
import {tiktokAdgroupConversion, tiktokConversionEligibility} from './tiktok-adgroup-conversions.js';
import {
  tiktokCtaPortfolioProjection,
  tiktokCtaPortfolioState,
  tiktokCtaReferences,
  tiktokPortfolioGetPath,
  validateTiktokCtaPortfolioState,
} from './tiktok-cta-portfolios.js';
import {tiktokImageInfoPath, tiktokImageState} from './tiktok-identities.js';
import {tiktokAudienceGetPath, tiktokAudienceState} from './tiktok-lookalikes.js';
import {
  tiktokConversionGetPath,
  tiktokConversionListPath,
  tiktokConversionListState,
  tiktokCustomConversionProjection,
  tiktokPixelListPath,
  tiktokPixelState,
  validateTiktokConversionState,
} from './tiktok-custom-conversions.js';
import {
  tiktokSavedAudienceProjection,
  tiktokSavedAudienceRead,
  validateTiktokSavedAudienceState,
} from './tiktok-saved-audiences.js';
import {validateTiktokSmartPlusState} from './tiktok-smart-plus-status.js';
import {
  tiktokSmartPlusAdGetPath,
  tiktokSmartPlusAdProjection,
  tiktokSmartPlusAdState,
  validateTiktokSmartPlusAdState,
} from './tiktok-smart-plus-ads.js';
import {
  tiktokSmartPlusAdgroupCampaignState,
  validateTiktokSmartPlusAdgroupCampaignState,
} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokInstantFormState, validateTiktokInstantFormState} from './tiktok-instant-forms.js';
import {tiktokSmartPlusCampaignProjection} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupProjection} from './tiktok-smart-plus-adgroups.js';
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

const qualifiedTikTokRead = (p: CompiledRequest) =>
  (!p.origin || p.origin === 'https://business-api.tiktok.com') && Object.hasOwn(qualifiedTikTokReadPaths, p.path);
/** The report, campaign and ad group lists the Overview reads (RPT-04), scoped by the selected advertiser. */
const advertiserLists = ['/v1.3/report/integrated/get/', '/v1.3/campaign/get/', '/v1.3/adgroup/get/'];
/**
 * TikTok's resource scope, after the account path: its reads name the selected advertiser in advertiser_id (the
 * advertiser info read in a list of one), and a route whose vendor schema requires advertiser_id is bound by it; some
 * Business Center routes ignore advertiser_id, so only that declared requirement establishes the boundary.
 */
function tiktokResourceScope(
  plan: CompiledRequest,
  _c: Connection,
  id: string,
  {decoded, compare, registry}: ScopeContext,
) {
  if (
    plan.readOnly &&
    plan.method === 'GET' &&
    // The ad group list is the Overview's optimization-event read (RPT-04), scoped like the campaign list.
    advertiserLists.includes(decoded) &&
    plan.query.advertiser_id === id
  )
    return true;
  if (
    plan.readOnly &&
    decoded === '/v1.3/advertiser/info/' &&
    Array.isArray(plan.query.advertiser_ids) &&
    plan.query.advertiser_ids.length === 1
  ) {
    compare(plan.query.advertiser_ids, 'advertiser_ids');
    return true;
  }
  // /page/get/ takes advertiser_id or a Business Center library_id; only the advertiser's own pages are in scope.
  if (
    plan.readOnly &&
    plan.method === 'GET' &&
    decoded === '/v1.3/page/get/' &&
    plan.query.advertiser_id === id &&
    plan.query.library_id === undefined
  )
    return true;
  const action = registry.action(plan.gateway, plan.action);
  return !!(
    action?.required.includes('advertiser_id') &&
    (plan.query.advertiser_id === id || (plan.body as JsonObject)?.advertiser_id === id)
  );
}

/**
 * TikTok's write shape after the generic checks: a new campaign or ad group starts disabled unless its parent is read
 * as paused (paused-parents.ts), an ad group's conversion and an ad's CTA portfolio references are checked, and an ad
 * is created from exactly one native creatives record that carries its operation_status.
 */
function tiktokWriteShape(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
  if (/^\/v1\.3\/(?:campaign|adgroup)\/create\/$/.test(plan.path))
    expect(body, 'operation_status', pausedParentChildStatuses(plan) ?? ['DISABLE']);
  tiktokAdgroupConversion(plan);
  tiktokCtaReferences(plan);
  if (plan.path === '/v1.3/ad/create/') {
    if (
      !Array.isArray(body.creatives) ||
      body.creatives.length !== 1 ||
      !body.creatives[0] ||
      Array.isArray(body.creatives[0]) ||
      typeof body.creatives[0] !== 'object'
    )
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.',
      );
    if (Object.hasOwn(body, 'operation_status'))
      fail(
        'INVALID_ARGUMENT',
        'TikTok ad creation uses creatives[0].operation_status; a top-level status does not pause the creative.',
      );
    expect(body.creatives[0], 'operation_status', pausedParentChildStatuses(plan) ?? ['DISABLE']);
  }
}
/** A TikTok state read confirms success and lists exactly its requested targets, however each read names them. */
function tiktokStateTarget(read: CompiledRequest, _result: TransportResult, data: JsonObject, context: StateTarget) {
  const {id, sameIds} = context;
  if (read.path === '/v1.3/identity/info/') {
    const info = data.data?.identity_info;
    if (data.code !== 0 || !info || typeof info !== 'object' || Array.isArray(info))
      fail('STATE_READ_FAILED', 'TikTok identity info must confirm success and contain identity_info.');
    sameIds([info.identity_id], [read.query.identity_id]);
    return;
  }
  if (
    validateTiktokConversionState(read, data, sameIds) ||
    validateTiktokSavedAudienceState(read, data, sameIds) ||
    validateTiktokSmartPlusAdState(read, data, sameIds) ||
    validateTiktokSmartPlusAdgroupCampaignState(read, data) ||
    validateTiktokSmartPlusState(read, data, sameIds) ||
    validateTiktokCtaPortfolioState(read, data, sameIds)
  )
    return;
  if (data.code !== 0 || !Array.isArray(data.data?.list))
    fail('STATE_READ_FAILED', 'TikTok state must confirm success and contain its native list.');
  if (read.path === tiktokImageInfoPath) {
    sameIds(
      data.data.list.map((r: JsonObject) => r.image_id),
      read.query.image_ids,
    );
    return;
  }
  if (read.path === tiktokAudienceGetPath) {
    sameIds(
      data.data.list.map((r: JsonObject) => r?.audience_details?.audience_id),
      read.query.custom_audience_ids,
    );
    return;
  }
  const kind = read.path.split('/')[2]!,
    key = kind === 'advertiser' ? 'advertiser_id' : kind + '_id';
  sameIds(
    data.data.list.map((r: JsonObject) => r[key]),
    kind === 'advertiser' ? [id] : read.query.filtering[kind + '_ids'],
  );
}

/**
 * The state a review keeps of a TikTok read: the pixels, the Smart+ and Instant Form states, a CTA portfolio and a
 * custom conversion's eligibility in their own projections, and a native list (the image, audience and conversion
 * lists in theirs); any other response whole.
 */
function tiktokSnapshot(read: CompiledRequest, d: JsonObject): unknown {
  if (read.path === tiktokPixelListPath && Array.isArray(d.data?.pixels)) return {data: tiktokPixelState(d)};
  const state =
    tiktokSmartPlusAdState(read, d) ?? tiktokSmartPlusAdgroupCampaignState(read, d) ?? tiktokInstantFormState(read, d);
  if (state) return state;
  if (read.path === tiktokPortfolioGetPath && d.data && typeof d.data === 'object' && !Array.isArray(d.data))
    return {data: tiktokCtaPortfolioState(read, d.data)};
  if (read.path === tiktokConversionGetPath && d.data && typeof d.data === 'object' && !Array.isArray(d.data))
    return {data: tiktokConversionEligibility(d.data)};
  if (Array.isArray(d.data?.list))
    return {
      data:
        read.path === tiktokImageInfoPath
          ? tiktokImageState(d)
          : read.path === tiktokAudienceGetPath
            ? tiktokAudienceState(d)
            : read.path === tiktokConversionListPath
              ? tiktokConversionListState(d)
              : {list: d.data.list},
    };
  return d;
}
/** The reads that show TikTok writes took effect: each returned or written entity, read back from its get route. */
function tiktokVerification(
  plan: CompiledRequest,
  result: JsonObject,
  read: (path: string, query?: JsonObject) => CompiledRequest,
): ProviderVerificationRead[] {
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {};
  const kind = plan.path.split('/')[2]!,
    ids = d.data?.[kind + '_ids'] ?? [d.data?.[kind + '_id'] ?? b[kind + '_id']];
  if (ids.some((id: unknown) => typeof id !== 'string')) return [];
  const expected =
    kind === 'ad' && plan.path === '/v1.3/ad/create/'
      ? {...b.creatives[0], adgroup_id: b.adgroup_id}
      : Object.fromEntries(Object.entries(b).filter(([k]) => !['advertiser_id', kind + '_ids'].includes(k)));
  return ids.map((id: string) => ({
    read: {
      ...read('/v1.3/' + kind + '/get/', {
        advertiser_id: plan.accountId,
        filtering: {[kind + '_ids']: [id]},
        page_size: 100,
      }),
      action: 'tiktok_' + kind + '_get',
    },
    expected,
    id,
  }));
}
/** What a TikTok verification read shows: its record, in its own projection where the read has one. */
function tiktokObserved(plan: CompiledRequest, data: JsonObject): JsonObject {
  if (plan.path === '/v1.3/identity/info/') return data.data?.identity_info;
  if (plan.path === tiktokAudienceGetPath) return data.data?.list?.[0]?.audience_details;
  if (plan.path === tiktokConversionGetPath) return tiktokCustomConversionProjection(data.data);
  if (tiktokSavedAudienceRead(plan)) return tiktokSavedAudienceProjection(data.data?.saved_audiences?.[0]);
  if (plan.path === '/v1.3/smart_plus/campaign/get/')
    return tiktokSmartPlusCampaignProjection(data.data?.list?.[0]) as JsonObject;
  if (plan.path === '/v1.3/smart_plus/adgroup/get/')
    return tiktokSmartPlusAdgroupProjection(data.data?.list?.[0]) as JsonObject;
  if (plan.path === tiktokPortfolioGetPath) return tiktokCtaPortfolioProjection(data.data);
  if (plan.path === tiktokSmartPlusAdGetPath) return tiktokSmartPlusAdProjection(data.data?.list?.[0]) as JsonObject;
  return data.data?.list?.[0];
}

export const tiktokHooks: ProviderHooks = Object.freeze({
  gateway: 'tiktok_native_action',
  checks: Object.freeze({
    shape: Object.freeze({after: tiktokWriteShape}),
    state: Object.freeze({
      // Published Instant Forms cannot be read by ID; every page is read through follow-up reads
      // (src/tiktok-instant-forms.ts), so their page information is expected rather than incomplete.
      complete: validateTiktokInstantFormState,
      target: tiktokStateTarget,
    }),
  }),
  review: Object.freeze({snapshot: tiktokSnapshot, verification: tiktokVerification, observed: tiktokObserved}),
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'tiktok_qualified_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) =>
          p.gateway === 'tiktok_native_action' && plainGetRead(p) && qualifiedTikTokRead(p),
        authorize: authorizeQualifiedTikTokRead,
      }),
    ]),
    resource: tiktokResourceScope,
  }),
  reads: Object.freeze({
    // Ad previews are POSTs the catalog marks as writes; they are reviewed reads, and their path words are not edits.
    plannedRead: (p: CompiledRequest) => !!tiktokPreviewRoute(p),
    wordExempt: (p: CompiledRequest) => !!tiktokPreviewRoute(p),
    qualifiedRead: qualifiedTikTokRead,
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
