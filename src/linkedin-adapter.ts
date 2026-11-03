import {
  plainGetRead,
  type CompileDraft,
  type CompileHooks,
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
import {linkedinPlanningAccount, linkedinPlanningPlan, linkedinPlanningRoute} from './linkedin-planning-reads.js';
import {linkedinConversionPlan} from './linkedin-conversion-links.js';
import {linkedinDomainPlan} from './linkedin-insight-domains.js';
import {linkedinTrackingPlan} from './linkedin-tracking-parameters.js';
import {linkedinMessagePlan} from './linkedin-message-ads.js';
import {authorizeLinkedInConversionEvidenceRead} from './linkedin-conversion-evidence.js';
import {
  authorizeLinkedInAdPreview,
  linkedinAdPreviewRead,
  observeLinkedInCreatives,
  linkedInPreviewLinks,
} from './linkedin-ad-previews.js';
import {authorizeLinkedInSpecial, linkedinSpecialRequest} from './linkedin-posts.js';
import {linkedInAnalyticsRows} from './linkedin-reporting.js';
import {linkedinDefaultVersion, linkedinVersion} from './linkedin-version.js';
import {
  currentLinkedInCapture,
  extendLinkedInTool,
  linkedinActionVersion,
  linkedinDescribedVersion,
} from './linkedin-version.js';
import {linkedinQuery} from './linkedin-restli.js';
// Wave 4c round 6 (w4c-arc6-versions): the reviewed versions, a stored request's version and the owner's status view.
import {linkedinStoredVersion, linkedinVersionStatus, linkedinVersions} from './linkedin-version.js';
import {errorInteger, errorObject, errorToken, providerReference} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
// Writes and campaigns (wave 4c).
import {
  buildLinkedinLeadRecipe,
  linkedinDependencyEvidence,
  linkedinLeadContext,
  linkedinLeadRecipe,
  linkedinRecipePrerequisites,
} from './linkedin-lead-recipe.js';
import {linkedinClone} from './linkedin-campaign-clone.js';
import {
  linkedinActivationGates,
  linkedinActivationRecord,
  linkedinActivationSteps,
} from './linkedin-recipe-activation.js';
import type {CampaignPreflightContext, MutationResponse} from './provider-adapter.js';
// Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables.
import {linkedinPrograms} from './linkedin-programs.js';
// Wave 4c round 6 (w4c-arc6-workspace): its steps of the reviewed media upload.
import {assertLinkedInOrganization} from './linkedin-posts.js';
import {
  assertLinkedInResume,
  assertLinkedInWaiting,
  linkedInPartId,
  linkedInResumeReason,
  linkedInTransfer,
} from './linkedin-media-resume.js';
// Wave 4c round 6 (w4c-arc6-catalog).
import {linkedinConditionalPrograms} from './linkedin-conditional-programs.js';

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

/**
 * Wave 4c (transport and catalog): LinkedIn's part of the catalog compiler (src/compiler.ts). Its parameters go in
 * the query whatever the method; every request carries the LinkedIn-Version and Rest.li protocol headers, and may
 * name a Rest.li method or tunnel an HTTP method (a read stays a read only for a reading method); its keyed paths
 * take their Rest.li encoding before the report job's controls, its planning reads, message ads and insight domains
 * after them.
 */
const linkedinCompile: CompileHooks = Object.freeze({
  queryParameters: true as const,
  request(draft: CompileDraft, input: JsonObject) {
    draft.headers['LinkedIn-Version'] = linkedinVersion(input.api_version);
    draft.headers['X-Restli-Protocol-Version'] = '2.0.0';
    if (input.restli_method) {
      const restli = String(input.restli_method).toUpperCase();
      if (
        ![
          'GET',
          'BATCH_GET',
          'FINDER',
          'GET_ALL',
          'CREATE',
          'BATCH_CREATE',
          'UPDATE',
          'BATCH_UPDATE',
          'PARTIAL_UPDATE',
          'BATCH_PARTIAL_UPDATE',
          'DELETE',
          'BATCH_DELETE',
          'ACTION',
        ].includes(restli)
      )
        throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported REST.li method.');
      draft.headers['X-RestLi-Method'] = String(input.restli_method);
      draft.readOnly = draft.readOnly && ['GET', 'BATCH_GET', 'FINDER', 'GET_ALL'].includes(restli);
    }
    if (input.http_method_override) {
      const override = String(input.http_method_override).toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(override))
        throw new MirrorError('INVALID_METHOD_OVERRIDE', 'Unsupported HTTP method override.');
      draft.headers['X-HTTP-Method-Override'] = override;
      draft.method = 'POST';
      draft.readOnly = draft.readOnly && ['GET', 'HEAD'].includes(override);
    }
    return undefined;
  },
  beforeJob: (plan: CompiledRequest) => linkedinTrackingPlan(linkedinConversionPlan(plan)),
  afterJob: (plan: CompiledRequest) => linkedinDomainPlan(linkedinMessagePlan(linkedinPlanningPlan(plan))),
});

export const linkedinHooks: ProviderHooks = Object.freeze({
  adPreviewLinks: linkedInPreviewLinks,
  gateway: 'linkedin_native_action',
  compile: linkedinCompile,
  // Wave 4c (transport and catalog): its captured catalog reports 202605 (its li-lms-2026-05 snapshot); it is read at
  // the reviewed version AMCP sends (PRV-02, src/catalog-versions.ts), as that version is when it is read.
  catalog: Object.freeze({
    version: Object.freeze({
      get version() {
        return linkedinDescribedVersion();
      },
      action: linkedinActionVersion,
      capture: currentLinkedInCapture,
      tool: extendLinkedInTool,
    }),
  }),
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
    recipes: Object.freeze([
      Object.freeze({definition: linkedinLeadRecipe, build: buildLinkedinLeadRecipe, context: linkedinLeadContext}),
    ]),
    // A campaign group, its campaigns and their creatives, read and recreated paused (src/campaign-clone.ts).
    clone: Object.freeze({build: linkedinClone}),
    // A lead launch's campaign group, campaign and creative activated in turn, gated on its lead form's state.
    activation: Object.freeze({
      steps: linkedinActivationSteps,
      record: linkedinActivationRecord,
      gates: linkedinActivationGates,
    }),
    // The lead generation pack's lead form, read through its owner finder (src/campaign-preflight.ts).
    preflight: Object.freeze({
      prerequisites: (
        plan: CompiledRequest,
        {service, actor, connectionId}: CampaignPreflightContext,
        _deferredPaths: string[],
        declared: string[],
      ) => linkedinRecipePrerequisites(service, actor, plan, connectionId, declared),
    }),
    // The lead generation pack's lead form, as its eligibility shows it (src/recipe-eligibility.ts).
    dependencyEvidence: linkedinDependencyEvidence,
  }),
  // A create on an ad account reads the account (src/write-snapshots.ts).
  writes: Object.freeze({
    // Its response contract for the one mutation (src/write-outcome.ts).
    confirms: linkedinConfirms,
    accountPath: /^\/rest\/adAccounts\/[^/]+/,
    // The owner's spending policy (src/spend-policy.ts): a creative spells activation as its intendedStatus.
    activationRule: (plan: CompiledRequest) =>
      /^\/rest\/adAccounts\/[^/]+\/creatives(?:\/[^/]+)?$/.test(plan.path)
        ? {field: 'intendedStatus', active: ['ACTIVE']}
        : undefined,
  }),
  // Wave 4c round 6 (w4c-arc6-versions): the LinkedIn-Version it sends, each answer src/linkedin-version.ts's own (the
  // explicit, AMCP_LINKEDIN_API_VERSION or default version, read at each call, and the reviewed table).
  versions: Object.freeze({
    current: linkedinDescribedVersion,
    header: 'LinkedIn-Version',
    request: linkedinVersion,
    stored: linkedinStoredVersion,
    reviewed: linkedinVersions,
    status: linkedinVersionStatus,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them).
  // Its programs AMCP lists but never checks (src/discovery-programs.ts).
  programs: linkedinPrograms,
  // Its top-level parameters (src/parameters.ts): its account aliases, its Rest.li controls and JSON bodies only.
  parameters: Object.freeze({
    accountAliases: Object.freeze(['account_id', 'ad_account_id']),
    platformControls: Object.freeze(['restli_method', 'http_method_override', 'body_format', 'api_version']),
    encodedBody: true as const,
    onlyValue: Object.freeze({
      parameter: 'body_format',
      value: 'json',
      refusal: (parameter: string) =>
        new MirrorError(
          'UNSUPPORTED_PARAMETER',
          'LinkedIn form query tunneling is not implemented; use JSON requests.',
          {
            parameter,
          },
        ),
    }),
  }),
  // Wave 4c round 6 (w4c-arc6-workspace): the reviewed media upload's organization owners and resumable video transfers
  // (src/media-upload.ts).
  media: Object.freeze({
    assertOrganization: assertLinkedInOrganization,
    transfer: linkedInTransfer,
    resumeReason: linkedInResumeReason,
    assertResume: assertLinkedInResume,
    assertWaiting: assertLinkedInWaiting,
    partId: linkedInPartId,
  }),
  // Wave 4c round 6 (w4c-arc6-catalog): its conditional programs, Media Planning's forecast and Audience Insights
  // (src/conditional-programs.ts).
  conditionalPrograms: linkedinConditionalPrograms,
});

// Writes and campaigns (wave 4c): moved verbatim from confirmedMutationResult (src/write-outcome.ts).
/** A create returns 201 with its x-restli-id; any other write 204. */
function linkedinConfirms(_plan: CompiledRequest, result: TransportResult, {hasId}: MutationResponse): boolean {
  return result.status === 201 ? hasId(result.headers['x-restli-id']) : result.status === 204;
}
