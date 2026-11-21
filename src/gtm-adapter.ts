import type {ProviderHooks} from './provider-adapter.js';
import type {CompiledRequest, DeclaredOperation, JsonObject} from './types.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';
import type {TransportResult} from './transport.js';
import {assertMeasurementWrite, validateMeasurementState} from './measurement-writes.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
// Writes and campaigns (wave 4c).
import type {VendorRoute} from './delegated-native.js';
import {assertMeasurementScopes} from './measurement-writes.js';
import {fail, object} from './write-common.js';
import {assertConsentStep, consentCreationBinding} from './gtm-consent-plans.js';
import {usageNotExposed} from './provider-usage.js';

/**
 * The resource collections of the Tag Manager API v2 a POST creates a member of (R2.5 S2-2): its reference names each
 * `…/{collection}` of accounts, containers, workspaces and their entities, and a custom method (…:create_version, …/revert,
 * …/bulk_update, …/sync) is none of them. The workspace write families match these routes themselves; the summary asks
 * them by the one structure the API shares.
 */
const gtmCollections =
  /\/(?:tags|triggers|variables|folders|templates|zones|clients|transformations|gtag_config|built_in_variables|containers|workspaces|environments|user_permissions)$/;
/** A POST to a collection creates a member of it; any other Tag Manager write acts on what exists, or is a custom method. */
function gtmOperation(plan: CompiledRequest): DeclaredOperation | undefined {
  return plan.method === 'POST' && gtmCollections.test(plan.path) ? {operation: 'create'} : undefined;
}

/**
 * Google Tag Manager's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a
 * folder's entity listing is a POST read. Readiness reads the selected Tag Manager account (CON-03). Its writes follow
 * the measurement resource contract (src/measurement-writes.ts) and may carry the workspace fingerprint; a resource's
 * 404, or its status read, is its documented state, and the resource checks every state read's target.
 */
export const gtmHooks: ProviderHooks = Object.freeze({
  gateway: 'gtm_native_action',
  checks: Object.freeze({
    routeWrite: assertMeasurementWrite,
    shape: Object.freeze({queryParameter: 'fingerprint'}),
    state: Object.freeze({
      settled(read: CompiledRequest, result: TransportResult) {
        if (result.status !== 404 && !(read.path.endsWith('/status') && result.status === 200)) return false;
        validateMeasurementState(read, result);
        return true;
      },
      ownTarget: true as const,
      target: (read: CompiledRequest, result: TransportResult) => validateMeasurementState(read, result),
    }),
  }),
  // A review keeps a Tag Manager resource's configuration, its authorization code as a digest and its container
  // access and trigger lists in one order (src/gtm-workflow-writes.ts).
  // Its entities are flat resources: the flat-resource names change by themselves.
  review: Object.freeze({
    snapshot: (_read: CompiledRequest, d: JsonObject) => gtmSafeConfiguration(d),
    volatile: flatResourceTelemetry,
  }),
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) => /\/folders\/[^/:]+:entities$/.test(pathname),
  }),
  accountRead: Object.freeze({
    readiness: (id: string, read: (path: string, origin: string) => CompiledRequest) =>
      read('/tagmanager/v2/accounts/' + id, 'https://tagmanager.googleapis.com'),
    names: (id: string, data: JsonObject) => String(data.accountId) === id,
  }),
  // The account a delegated Tag Manager path names (r25-field2-access, B4): a number, as its account model says
  // (src/provider-adapters.ts). The generic pattern read the literal segment of /accounts/containers:lookup as an account.
  delegated: Object.freeze({
    scope: Object.freeze({
      account: Object.freeze({aliases: Object.freeze([]), path: /\/accounts\/(\d+)(?=[/:]|$)/}),
    }),
  }),
  // A delete answers 200 without a body.
  wire: Object.freeze({
    // Its APIs send no usage header: the rate governor’s view says "not exposed" (R2.5 M2, MT3; src/provider-usage.ts).
    usage: usageNotExposed,
    emptyWrite: (plan: CompiledRequest, response: Response) => response.status === 200 && plan.method === 'DELETE',
  }),
  // Workbook reporting (ARC-01, reporting; src/report-resource-scope.ts): a saved query names its Tag Manager account
  // by an account selector (an account ID or accounts/{id}) or by an accounts/{id}/... resource name.
  reportScope: Object.freeze({
    account(kind: unknown, value: string) {
      if (kind === 'account') return /^(?:accounts\/)?([A-Za-z0-9_-]{1,200})$/.exec(value)?.[1];
      if (kind !== 'resource' || value.split('/').some(part => part === '.' || part === '..')) return undefined;
      return /^accounts\/([A-Za-z0-9_-]{1,200})(?:\/[^/\x00-\x20\\?#%]+)*$/.exec(value)?.[1];
    },
    anchorKind: (anchor: string) => (anchor.startsWith('accounts/') ? 'account' : undefined),
    // Wave 4c round 6 (w4c-arc6-reporting): the selectors src/workbook-repository.ts projects: a path, parent or
    // account ID field of the arguments, their params or path_params; the payload is the body.
    selectors: Object.freeze({
      order: 3,
      groups: Object.freeze([
        Object.freeze({
          paths: Object.freeze(['$', '$.params', '$."path_params"']),
          keys: Object.freeze(['path', 'parent', 'accountid']),
        }),
      ]),
      kinds: Object.freeze({accountid: 'account'}),
      otherwise: 'resource',
      body: 'payload',
    }),
  }),
  // Writes and campaigns (wave 4c): its parts of the reviewed write lifecycle (src/write-review.ts): the Tag Manager
  // permission a write needs, and the workspace fingerprint a route takes from the state read.
  writes: Object.freeze({
    writePermission: assertMeasurementScopes,
    concurrency: gtmConcurrency,
    // A container version's publish takes effect for everyone at once (src/write-effects.ts).
    publishesLive: (plan: CompiledRequest) => plan.method === 'POST' && /:publish$/.test(plan.path),
    // A POST to a resource's collection creates a member of it (R2.5 S2-2); the others act on what exists.
    operation: gtmOperation,
    // An outcome shows the safe configuration of the response and of its failures (src/write-outcome.ts).
    outcomeData: gtmSafeConfiguration,
  }),
  // Writes and campaigns (wave 4c): a consent preview's plan binding, made at creation and checked against the current
  // tag before each step's review and execution (src/campaign-runner.ts).
  campaign: Object.freeze({
    planBinding: Object.freeze({key: 'gtm_consent', create: consentCreationBinding, check: assertConsentStep}),
  }),
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts); its
  // catalog has write actions, which its gateway previews or refuses.
  notes: Object.freeze({
    description:
      'Google Tag Manager gateway: gtm_ops runs one Tag Manager API operation on accounts, containers, workspaces, versions, tags, triggers and variables; gtm_audit_ops audits a workspace’s configuration and consent settings; gtm_action_job_status reads the verification job of a reviewed Tag Manager write.',
    delegatedWrites: true as const,
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables. Its wire contract (src/wire-contracts.ts): each
  // route's request schema in its pinned Google Discovery document.
  wireContract: Object.freeze({routes: Object.freeze({label: 'Google'})}),
});

// Writes and campaigns (wave 4c): moved verbatim from WriteReviewService.prepareReview (src/write-review.ts).
/** A route that takes the workspace fingerprint takes the state read's, refusing a stale one the caller supplied. */
function gtmConcurrency(plan: CompiledRequest, state: unknown[], routes: readonly VendorRoute[]): void {
  const route = routes.find(
      r => r.gateway === plan.gateway && r.operation + (r.action ? '/' + r.action : '') === plan.action,
    ),
    fingerprint = object(state[0]).fingerprint;
  if (route?.parameters.fingerprint && typeof fingerprint === 'string' && fingerprint) {
    if (plan.query.fingerprint !== undefined && plan.query.fingerprint !== fingerprint)
      fail('STATE_CHANGED', 'The supplied Tag Manager fingerprint is stale.');
    plan.query.fingerprint = fingerprint;
  }
}
