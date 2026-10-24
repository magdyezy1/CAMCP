import {
  plainGetRead,
  type ExpectState,
  type ProviderHooks,
  type ProviderVerificationRead,
  type ScopeCallBuilder,
  type ScopeContext,
  type StateTarget,
} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
// The write-shape and state refusals keep the write stages' own helper (src/write-common.ts).
import {fail} from './write-common.js';
import {linkedinPlanningAccount, linkedinPlanningRoute} from './linkedin-planning-reads.js';
import {authorizeLinkedInConversionEvidenceRead} from './linkedin-conversion-evidence.js';
import {authorizeLinkedInAdPreview, linkedinAdPreviewRead, observeLinkedInCreatives} from './linkedin-ad-previews.js';
import {authorizeLinkedInSpecial, linkedinSpecialRequest} from './linkedin-posts.js';
import {linkedInAnalyticsRows} from './linkedin-reporting.js';
import {linkedinDefaultVersion, linkedinVersion} from './linkedin-version.js';
import {linkedinQuery} from './linkedin-restli.js';
import {errorInteger, errorObject, errorToken, providerReference} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
// Writes and campaigns (wave 4c).
import {buildLinkedinLeadRecipe, linkedinLeadRecipe} from './linkedin-lead-recipe.js';
import {linkedinClone} from './linkedin-campaign-clone.js';
import {
  linkedinActivationGates,
  linkedinActivationRecord,
  linkedinActivationSteps,
} from './linkedin-recipe-activation.js';

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

/** A state read names one entity, whose URN (or its ID) the response must repeat. */
function linkedinStateTarget(read: CompiledRequest, _result: TransportResult, data: JsonObject, context: StateTarget) {
  const target = context.target(),
    exact = decodeURIComponent(read.path.split('/').at(-1)!);
  if (exact.startsWith('urn:li:') && data.id !== exact)
    fail('STATE_TARGET_MISMATCH', 'LinkedIn returned a different resource URN.');
  context.sameIds(
    [
      String(data.id ?? '')
        .split(':')
        .at(-1),
    ],
    [target],
  );
}

/** The read that shows a LinkedIn write took effect: the created entity, by the ID LinkedIn returned, or the written one. */
function linkedinVerification(
  plan: CompiledRequest,
  result: JsonObject,
  read: (path: string, query?: JsonObject) => CompiledRequest,
): ProviderVerificationRead[] {
  const b = (plan.body ?? {}) as JsonObject;
  const id = String(result.created_id ?? result.headers?.['x-restli-id'] ?? plan.path.split('/').at(-1)),
    expected = b.patch?.$set ?? b;
  return [
    {
      read: read(
        plan.method === 'POST' && result.status === 201 ? plan.path + '/' + encodeURIComponent(id) : plan.path,
      ),
      expected,
      id: id.split(':').at(-1)!,
    },
  ];
}

export const linkedinHooks: ProviderHooks = Object.freeze({
  gateway: 'linkedin_native_action',
  checks: Object.freeze({
    shape: Object.freeze({
      // An entity POST is a native PARTIAL_UPDATE patch.
      afterQuery(plan: CompiledRequest, body: JsonObject) {
        if (
          plan.method === 'POST' &&
          /^\/rest\/adAccounts\/[^/]+\/[^/]+\/[^/]+$/.test(plan.path) &&
          (!body.patch || plan.headers['X-RestLi-Method']?.toUpperCase() !== 'PARTIAL_UPDATE')
        )
          fail(
            'WRITE_CONTRACT_UNAVAILABLE',
            'LinkedIn entity POST requires a native patch and restli_method PARTIAL_UPDATE.',
          );
      },
      // New campaign groups, campaigns and creatives start paused or as drafts; creatives use intendedStatus.
      after(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
        if (
          !/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(plan.path) ||
          plan.method !== 'POST'
        )
          return;
        const creative = plan.path.endsWith('/creatives');
        if (creative && Object.hasOwn(body, 'status'))
          fail('INVALID_ARGUMENT', 'LinkedIn creatives use intendedStatus; remove the unsupported status field.');
        expect(body, creative ? 'intendedStatus' : 'status', ['PAUSED', 'DRAFT']);
      },
    }),
    state: Object.freeze({target: linkedinStateTarget}),
  }),
  review: Object.freeze({
    // A verification read keeps the write's versioning headers: its API version and Rest.li protocol.
    verificationHeaders: (plan: CompiledRequest) =>
      Object.fromEntries(
        Object.entries(plan.headers).filter(([k]) => ['LinkedIn-Version', 'X-Restli-Protocol-Version'].includes(k)),
      ),
    verification: linkedinVerification,
  }),
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
  // Writes and campaigns (wave 4c): the guided lead generation recipe.
  campaign: Object.freeze({
    recipes: Object.freeze([Object.freeze({definition: linkedinLeadRecipe, build: buildLinkedinLeadRecipe})]),
    // A campaign group, its campaigns and their creatives, read and recreated paused (src/campaign-clone.ts).
    clone: Object.freeze({build: linkedinClone}),
    // A lead launch's campaign group, campaign and creative activated in turn, gated on its lead form's state.
    activation: Object.freeze({
      steps: linkedinActivationSteps,
      record: linkedinActivationRecord,
      gates: linkedinActivationGates,
    }),
  }),
  // A create on an ad account reads the account (src/write-snapshots.ts).
  writes: Object.freeze({accountPath: /^\/rest\/adAccounts\/[^/]+/}),
});
