import {
  plainGetRead,
  type CompileDraft,
  type CompileHooks,
  type ContractHooks,
  type ContractNote,
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
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
import {tiktokPreviewPlan, tiktokPreviewRoute, tiktokPreviewVariantPath} from './tiktok-preview-reads.js';
import {tiktokCommentScope} from './tiktok-ad-comments.js';
import {
  tiktokIntegratedReport,
  tiktokReportGrain,
  tiktokReportPage,
  tiktokReportRowKey,
} from './tiktok-report-pagination.js';
// Writes and campaigns (wave 4c).
import {
  buildTiktokLaunchRecipe,
  tiktokConversionContext,
  tiktokConversionRecipe,
  tiktokDependencyEvidence,
  tiktokRecipePrerequisites,
  tiktokTrafficContext,
  tiktokTrafficRecipe,
} from './tiktok-launch-recipes.js';
import {tiktokAdgroupConversionPrerequisites} from './tiktok-adgroup-conversions.js';
import {tiktokCtaPortfolioPrerequisites} from './tiktok-cta-portfolios.js';
import {tiktokManualAdIdentityPrerequisites} from './tiktok-manual-ad-identities.js';
import {tiktokInstantFormFollowUps} from './tiktok-instant-forms.js';
import {tiktokStateReads} from './tiktok-state-reads.js';
import {tiktokClone} from './tiktok-campaign-clone.js';
import {tiktokActivationSteps} from './tiktok-recipe-activation.js';
import {object} from './write-common.js';
import type {CampaignPreflightContext, MutationResponse} from './provider-adapter.js';
import {tiktokReportRoute} from './tiktok-report-jobs.js';
import {tiktokAdPreviews} from './tiktok-ad-previews.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});

// TikTok's return codes, from TikTok API for Business "Return codes"
// (https://business-api.tiktok.com/portal/docs/return-codes/v2.0, read 2026-11-06). AMCP calls API v1.3: the page labelled
// v1.3 covers Business Messaging only, and the three codes it shares with this table agree. TikTok reports a code in the
// body of an HTTP 200 answer (and in the body of an HTTP error). Only the codes of these sets are mapped; every other code,
// the parameter and business-logic ones included (40000, 40002, 40006 to 40008 and the rest), keeps the generic
// classification: PLATFORM_ERROR in a 200 body, with layer `unknown`.
const tiktokCredentialCodes: ReadonlySet<number> = new Set([
  40101, 40102, 40103, 40104, 40105, 40106, 40107, 40110, 40131,
]);
/** Role or asset access (the login cannot act on this advertiser or object). */
const tiktokRoleCodes: ReadonlySet<number> = new Set([40001, 40119]);
/** A permission the login has not granted. */
const tiktokConsentCodes: ReadonlySet<number> = new Set([40125]);
/** An eligibility the app or account lacks. */
const tiktokEligibilityCodes: ReadonlySet<number> = new Set([40118]);
const tiktokThrottleCodes: ReadonlySet<number> = new Set([40100, 40132, 40133]);
/** TikTok's own side failed. */
const tiktokServerCodes: ReadonlySet<number> = new Set([50000, 50002, 51305]);
/**
 * A TikTok refusal, classified from its return code (PRV-01). The classes use the codes the other providers' profiles use
 * for their layers (a credential failure is AUTH_EXPIRED, a missing permission PROVIDER_PERMISSION_MISSING, an access
 * denial PROVIDER_ACCESS_DENIED, a throttle PLATFORM_RATE_LIMIT). A read the table calls transient (a throttle, a failure
 * on TikTok's side) is retryable; a write never is, as for every provider. Anything else is classified generically.
 */
function classifyTikTokError(input: ProviderErrorInput, context: ProviderErrorContext): ProviderErrorClass | undefined {
  const code = errorInteger(errorObject(input.body).code);
  if (code === undefined) return undefined;
  const {base, legacyCode, layerOf} = context;
  if (tiktokCredentialCodes.has(code))
    return {...base, code: 'AUTH_EXPIRED', layer: 'credential', retryable: false, documented: true};
  if (tiktokRoleCodes.has(code))
    return {...base, code: 'PROVIDER_ACCESS_DENIED', layer: 'role_or_asset_access', retryable: false, documented: true};
  if (tiktokConsentCodes.has(code))
    return {...base, code: 'PROVIDER_PERMISSION_MISSING', layer: 'consent', retryable: false, documented: true};
  if (tiktokEligibilityCodes.has(code))
    return {...base, code: 'PROVIDER_ACCESS_DENIED', layer: 'app_eligibility', retryable: false, documented: true};
  if (tiktokThrottleCodes.has(code))
    return {...base, code: 'PLATFORM_RATE_LIMIT', layer: 'rate_limit', retryable: input.readOnly, documented: true};
  if (tiktokServerCodes.has(code))
    return {...base, code: legacyCode, layer: layerOf(legacyCode), retryable: input.readOnly, documented: true};
  return undefined;
}
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
 * This only establishes HTTP semantics; credentials and object scope are separate (authorizeQualifiedTikTokRead, the
 * tiktok_qualified_read read authorizer that ScopeGuard consults).
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

// Wave 4c (transport and catalog): TikTok's part of the catalog compiler (src/compiler.ts).
const plain = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? {...v} : {});
/**
 * Each preview type's required fields are its plan step's to check (the catalog lists every variant's together); a
 * request names its advertiser in the query or the body and may carry a lead region; a comment status update rides
 * beside its reviewed comment list read; preview reads are planned after the report job's controls.
 */
const tiktokCompile: CompileHooks = Object.freeze({
  required: Object.freeze({unchecked: (route: string) => tiktokPreviewVariantPath('tiktok_native_action', route)}),
  request(draft: CompileDraft, input: JsonObject) {
    if (draft.accountId) {
      if (['GET', 'HEAD', 'DELETE'].includes(draft.method)) draft.query.advertiser_id ??= draft.accountId;
      else if (!Array.isArray(draft.body)) draft.body = {advertiser_id: draft.accountId, ...plain(draft.body)};
      if (input.lead_region) draft.headers['X-Lead-Region'] = input.lead_region;
    }
    // The comment list read a comment status update is reviewed against; it rides beside the request, never in it.
    const commentScope = tiktokCommentScope(draft.route, input.comment_scope);
    return commentScope ? {tiktokCommentScope: commentScope} : undefined;
  },
  afterJob: tiktokPreviewPlan,
});
/** Wave 4c (transport and catalog): what TikTok's report task reads add to their action contract rows. */
const reportTaskNote: ContractNote = Object.freeze({
  implementation: 'src/tiktok-report-jobs.ts',
  test: 'tests/tiktok-report-jobs.test.ts',
  reason:
    'Exact original task/advertiser/connection/token binding; bounded untranslated CSV_STRING retrieval with fresh status, row/date checks and explicit pending/failed/cancelled states.',
});
const tiktokContracts: ContractHooks = Object.freeze({
  readNotes: (plan: CompiledRequest) => (tiktokReportRoute(plan) ? [reportTaskNote] : []),
});

export const tiktokHooks: ProviderHooks = Object.freeze({
  gateway: 'tiktok_native_action',
  // Its ads and their previews for amcp_ad_previews (src/ad-previews.ts).
  previews: tiktokAdPreviews,
  compile: tiktokCompile,
  contracts: tiktokContracts,
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
          const page = tiktokReportPage(response, request.query, {
            total: expectedTotal ?? null,
            returned: nativeRows.size,
          });
          expectedTotal = page.total;
          for (const row of page.rows) {
            const key = tiktokReportRowKey(row, dimensions);
            if (nativeRows.has(key))
              throw new MirrorError(
                'REPORT_DUPLICATE_ROWS',
                'TikTok repeated a native reporting dimension tuple.',
                {
                  page_facts: {
                    page: page.page,
                    page_size: page.size,
                    total_number: page.total,
                    total_page: page.pages,
                    list_length: page.rows.length,
                    rule: 'duplicate_tuple',
                  },
                },
                502,
              );
            nativeRows.add(key);
          }
        };
      },
      pages: (data: unknown) => {
        const info = obj(obj(obj(data).data).page_info);
        return info.total_page ?? Math.ceil(info.total_number / info.page_size);
      },
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
    errors: Object.freeze({
      code: (body: unknown) => errorInteger(errorObject(body).code),
      classify: classifyTikTokError,
      // G9: a refusal's code is all TikTok gives structurally (its parameter errors name a field only in free text, which
      // is never parsed here); its message is third-party text, kept in details.provider_message.
      tokens: (body: unknown) => {
        const code = errorInteger(errorObject(body).code);
        return code !== undefined && code !== 0 ? [{code}] : [];
      },
      text: (body: unknown) => errorObject(body).message,
    }),
  }),
  // Writes and campaigns (wave 4c): the guided traffic and conversion packs (CMP-07).
  campaign: Object.freeze({
    recipes: Object.freeze([
      Object.freeze({
        definition: tiktokTrafficRecipe,
        build: (b: JsonObject) => buildTiktokLaunchRecipe(b, false),
        context: tiktokTrafficContext,
      }),
      Object.freeze({
        definition: tiktokConversionRecipe,
        build: (b: JsonObject) => buildTiktokLaunchRecipe(b, true),
        context: tiktokConversionContext,
      }),
    ]),
    // A campaign, its ad groups and their ads, read and recreated disabled (src/campaign-clone.ts).
    clone: Object.freeze({build: tiktokClone}),
    // A launch's campaign enabled; no gate.
    activation: Object.freeze({steps: tiktokActivationSteps}),
    // A launch pack's Spark identity, post and pixel, before any predecessor is created (src/campaign-preflight.ts).
    preflight: Object.freeze({
      prerequisites: (
        plan: CompiledRequest,
        {service, actor, connectionId}: CampaignPreflightContext,
        _deferredPaths: string[],
        declared: string[],
      ) => tiktokRecipePrerequisites(service, actor, plan, connectionId, declared),
    }),
    // A launch pack's identity, post and pixel, as its eligibility shows them (src/recipe-eligibility.ts).
    dependencyEvidence: tiktokDependencyEvidence,
  }),
  // Its parts of the reviewed write lifecycle (src/write-review.ts): Instant Forms cannot be read by ID, so the first
  // page of their read names how many more to read; a custom conversion, a CTA portfolio and a manual ad identity are
  // checked against the state, in that order, after every read.
  writes: Object.freeze({
    // Its response contract for the one mutation (src/write-outcome.ts).
    confirms: tiktokConfirms,
    // A status update to DELETE deletes, though its route is an update (src/write-effects.ts).
    deletes: (plan: CompiledRequest) =>
      /\/status\/update\/$/.test(plan.path) &&
      !!plan.body &&
      typeof plan.body === 'object' &&
      !Array.isArray(plan.body) &&
      (plan.body as JsonObject).operation_status === 'DELETE',
    // A campaign, ad group or ad write's state reads: the advertiser and parent of a create, or its exact targets.
    snapshots: tiktokStateReads,
    morePages: tiktokInstantFormFollowUps,
    prerequisites(plan: CompiledRequest, values: unknown[]) {
      tiktokAdgroupConversionPrerequisites(plan, values);
      tiktokCtaPortfolioPrerequisites(plan, values);
      tiktokManualAdIdentityPrerequisites(plan, values);
    },
  }),
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts).
  notes: Object.freeze({
    description: 'Run one TikTok Business API action by name; LIST_ACTIONS and DESCRIBE_ACTION find it.',
    routing: true as const,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its top-level
  // parameters (src/parameters.ts): its account aliases and its lead region and comment scope controls.
  parameters: Object.freeze({
    accountAliases: Object.freeze(['advertiser_id', 'account_id']),
    platformControls: Object.freeze(['lead_region', 'comment_scope']),
  }),
  // Its report and change-log job families and what each guarantees (src/provider-jobs.ts).
  jobFamilies: Object.freeze([
    Object.freeze({
      family: 'tiktok_report_jobs',
      kind: 'report' as const,
      admission: 'One per second and 500 per hour per app and account (admitTiktokReport).',
      lost_response: 'Uncertain; the original task is checked, never resubmitted.',
      retrieval: 'The original task is checked and its bounded file downloaded with the same login.',
    }),
    Object.freeze({
      family: 'tiktok_change_log_tasks',
      kind: 'change_log' as const,
      admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
      lost_response: 'Uncertain; the original task is checked, never resubmitted.',
      retrieval: 'The original task’s status and bounded download.',
    }),
  ]),
});

// Writes and campaigns (wave 4c): moved verbatim from confirmedMutationResult (src/write-outcome.ts).
/** Code 0, and a create returns the one ad ID, or the created entity IDs. */
function tiktokConfirms(
  plan: CompiledRequest,
  _result: TransportResult,
  {data: d, segments, hasId}: MutationResponse,
): boolean {
  if (d.code !== 0) return false;
  if (!plan.path.endsWith('/create/')) return true;
  const kind = segments[2]!,
    data = object(d.data);
  if (kind === 'ad') {
    const ids = data.ad_ids ?? [data.ad_id];
    return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' && /^\d+$/.test(ids[0]);
  }
  return (
    hasId(data[kind + '_id']) ||
    (Array.isArray(data[kind + '_ids']) && data[kind + '_ids'].length > 0 && data[kind + '_ids'].every(hasId))
  );
}
