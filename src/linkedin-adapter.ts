import {plainGetRead, type ProviderHooks, type ScopeCallBuilder, type ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {linkedinPlanningAccount, linkedinPlanningRoute} from './linkedin-planning-reads.js';
import {authorizeLinkedInConversionEvidenceRead} from './linkedin-conversion-evidence.js';
import {authorizeLinkedInAdPreview, linkedinAdPreviewRead, observeLinkedInCreatives} from './linkedin-ad-previews.js';
import {authorizeLinkedInSpecial, linkedinSpecialRequest} from './linkedin-posts.js';
import {linkedInAnalyticsRows} from './linkedin-reporting.js';
import {linkedinDefaultVersion, linkedinVersion} from './linkedin-version.js';
import {linkedinQuery} from './linkedin-restli.js';
import {errorInteger, errorObject, errorToken, providerReference} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/**
 * LinkedIn's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the audience
 * insight and forecast POSTs, and the share-authorization permission check, a documented read whose path holds
 * "authorization", with its authorization.
 */
const denied = (message: string): never => {
  throw new MirrorError('RESOURCE_SCOPE_REQUIRED', message, {}, 403);
};
/** The permission check names the selected sponsored account as its agent and an administrator bound the tuple. */
function authorizeShareAuthorizationRead(p: CompiledRequest, c: Connection, account: string): boolean {
  const path = decodeURIComponent(p.path),
    key = path.split('/').at(-1)!,
    parts = key.split('&').map(s => s.split('='));
  if (parts.length !== 3 || parts.some(p => p.length !== 2) || new Set(parts.map(p => p[0])).size !== 3)
    denied('Use the documented owner, loggedInMember and agent composite key.');
  const values = Object.fromEntries(parts);
  if (
    !/^urn:li:(?:company|organization):\d+$/.test(values.owner ?? '') ||
    !/^urn:li:person:[A-Za-z0-9_-]+$/.test(values.loggedInMember ?? '') ||
    values.agent !== 'urn:li:sponsoredAccount:' + account
  )
    denied('The exact company/member permission check must identify the selected sponsored account.');
  if (!c.scopes.includes('rw_ads'))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      'LinkedIn share-authorization diagnostics require rw_ads; reading this status does not grant publishing permission.',
      {},
      403,
    );
  if (
    !c.resourceBindings?.some(
      b => b.accountId === account && b.pathPrefix === path && Object.keys(b.query ?? {}).length === 0,
    )
  )
    denied(
      'An administrator must bind this exact company/member/account permission-check tuple before it can be queried.',
    );
  return true;
}

const shareAuthorizationRead = (p: CompiledRequest) =>
  (!p.origin || p.origin === 'https://api.linkedin.com') &&
  /^\/rest\/organizationalEntityCreateShareAuthorizations\/[^/]+$/.test(p.path);
/**
 * LinkedIn's resource scope, after the account path: the reporting reads and adBudgetPricing (read-only, an account's
 * daily budget limits for allocation drafts, WRT-07) name exactly one sponsored account, which must be the bound one,
 * and a planning read names its account in its request.
 */
function linkedinResourceScope(
  plan: CompiledRequest,
  _c: Connection,
  _id: string,
  {decoded, compare, mismatch}: ScopeContext,
) {
  if (
    ['/rest/adAnalytics', '/rest/audienceCounts'].includes(decoded) ||
    (plan.readOnly && plan.method === 'GET' && decoded === '/rest/adBudgetPricing')
  ) {
    const value = plan.query.accounts ?? plan.query.account;
    if (typeof value === 'string') {
      let decodedValue: string;
      try {
        decodedValue = decodeURIComponent(value);
      } catch {
        return mismatch('account filter');
      }
      const filter = /^(?:List\()?urn:li:sponsoredAccount:(\d+)\)?$/.exec(decodedValue);
      if (filter) {
        compare(filter[1], 'account filter');
        return true;
      }
    }
  }
  if (plan.readOnly && linkedinPlanningRoute(plan)) {
    const planned = linkedinPlanningAccount(plan);
    if (planned !== undefined) {
      compare(planned, 'request account');
      return true;
    }
  }
  return false;
}

export const linkedinHooks: ProviderHooks = Object.freeze({
  gateway: 'linkedin_native_action',
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => !!linkedinPlanningRoute(p),
    qualifiedRead: shareAuthorizationRead,
    postRead: (plan: CompiledRequest) => !!linkedinPlanningRoute(plan),
  }),
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'linkedin_share_authorization_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) =>
          p.gateway === 'linkedin_native_action' && plainGetRead(p) && shareAuthorizationRead(p),
        authorize: authorizeShareAuthorizationRead,
      }),
      Object.freeze({
        name: 'linkedin_conversion_evidence_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) =>
          p.gateway === 'linkedin_native_action' && p.path === '/rest/conversions' && p.method === 'GET' && p.readOnly,
        authorize: authorizeLinkedInConversionEvidenceRead,
      }),
      Object.freeze({
        name: 'linkedin_ad_preview',
        stage: 'after_families' as const,
        claims: linkedinAdPreviewRead,
        authorize: (p: CompiledRequest, c: Connection, account: string, store: Store) =>
          authorizeLinkedInAdPreview(p, c, store, account),
      }),
      Object.freeze({
        name: 'linkedin_dsc_media_and_post_reads',
        stage: 'after_families' as const,
        claims: linkedinSpecialRequest,
        authorize: (p: CompiledRequest, c: Connection, account: string, store: Store) =>
          authorizeLinkedInSpecial(p, c, store, account),
      }),
    ]),
    resource: linkedinResourceScope,
    // An ad preview names its creative, not its account: the account's creatives finder establishes its ownership.
    ownershipReads: (path: string, _a: string, _c: string, _t: string | undefined, call: ScopeCallBuilder) =>
      path === '/rest/adPreviews'
        ? [
            call('linkedin_rest_ad_accounts_ad_account_id_creatives_get', {
              restli_method: 'FINDER',
              query: {q: 'criteria', pageSize: 100},
            }),
          ]
        : [],
    observe: (plan: CompiledRequest, connection: Connection, account: string, data: unknown, store: Store) =>
      observeLinkedInCreatives(plan, connection, store, account, data),
  }),
  paging: Object.freeze({
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      if (plan.path === '/rest/adAnalytics') {
        linkedInAnalyticsRows(response);
        return null;
      }
      // Search and criteria finders page by cursor: the next page's pageToken is metadata.nextPageToken, and a page
      // without one is the last (Microsoft Learn, "Create and Manage Creatives", li-lms-2026-05). Older finders page by
      // start and count against paging.total.
      const token = obj(d.metadata).nextPageToken;
      if (token !== undefined && token !== null && (typeof token !== 'string' || !token))
        throw new MirrorError('UNKNOWN_PAGINATION', 'LinkedIn returned a malformed page cursor.');
      if (typeof token === 'string') {
        if (plan.query.start !== undefined)
          throw new MirrorError('UNKNOWN_PAGINATION', 'LinkedIn returned a page cursor for a read paged by offset.');
        next.query.pageToken = token;
        return next;
      }
      if (plan.query.pageSize !== undefined || plan.query.pageToken !== undefined) return null;
      const paging = d.paging;
      if (!paging || Number(paging.start) + Number(paging.count) >= Number(paging.total)) return null;
      next.query.start = Number(paging.start) + Number(paging.count);
      return next;
    },
  }),
  // The account read is the ad account entity, with the reviewed LinkedIn version and Rest.li 2.0.
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/rest/adAccounts/' + id;
      read.headers = {'LinkedIn-Version': linkedinVersion(), 'X-Restli-Protocol-Version': '2.0.0'};
      return read;
    },
  }),
  // Queries are Rest.li 2.0 encoded. LinkedIn names created entities in x-restli-id and documents only the status of a
  // tracking parameter create (201) or replace (200), keyed by the path; lead form IDs are 64-bit longs. Callers record
  // x-li-uuid (x-li-request-id on older responses) and x-li-fabric, and a refused version names the one sent.
  wire: Object.freeze({
    search: (query: JsonObject) => linkedinQuery(query),
    deadline: (plan: CompiledRequest) =>
      plan.action === 'AMCP_LINKEDIN_TEMPLATE_READ' && plan.readOnly && plan.method === 'GET'
        ? plan.linkedinTemplateDeadline
        : undefined,
    emptyWrite: (plan: CompiledRequest, response: Response) =>
      (response.status === 200 &&
        plan.method === 'POST' &&
        plan.path === '/rest/videos' &&
        plan.query.action === 'finalizeUpload') ||
      (response.status === 201 && response.headers.has('x-restli-id')) ||
      (plan.method === 'PUT' &&
        /^\/rest\/adTrackingParameters\/[^/]+$/.test(plan.path) &&
        [200, 201].includes(response.status)),
    int64: (plan: CompiledRequest) => /^\/rest\/leadForms(?:\/|$)/.test(plan.path),
    reportData: (plan: CompiledRequest) => plan.path === '/rest/adAnalytics',
    fabric: (response: Response) => providerReference(response.headers.get('x-li-fabric')),
    versionSent: (headers: Record<string, string>) => ({
      api_version_sent: headers['LinkedIn-Version'] ?? null,
      default_version: linkedinDefaultVersion,
    }),
    referenceHeaders: Object.freeze(['x-li-uuid', 'x-li-request-id', 'x-li-fabric']),
    errors: Object.freeze({
      requestId: (header: (name: string) => string | undefined) => header('x-li-uuid') ?? header('x-li-request-id'),
      code: (body: unknown) => errorToken(errorObject(body).code) ?? errorInteger(errorObject(body).serviceErrorCode),
      // HTTP 426: LinkedIn no longer serves the version sent (PRV-02).
      classify: (input: ProviderErrorInput, {base}: ProviderErrorContext): ProviderErrorClass | undefined =>
        !input.inBody && input.status === 426
          ? {...base, code: 'PROVIDER_VERSION_UNSUPPORTED', layer: 'api_version', retryable: false, documented: true}
          : undefined,
    }),
  }),
});
