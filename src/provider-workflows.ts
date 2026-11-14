import {performance} from 'node:perf_hooks';
import type {ContractRow} from './provider-adapter.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {CredentialProvider} from './auth.js';
import {MirrorError} from './errors.js';
import {gtmDiagnosticOperations, gtmDiagnostics} from './gtm-diagnostics.js';
import {measurementConnectionSyncKind, syncMeasurementConnection} from './measurement-connection-sync.js';
import {businessConnectionSyncKind, syncBusinessConnection} from './google-business-sync.js';
import {adjustReportingKind, adjustReporting} from './adjust-reporting.js';
import {metaAdIdentityRefusal} from './meta-adapter.js';
import {fetchMetaExistingPosts, metaPostActions, redactMetaPostInput} from './meta-existing-posts.js';
import {searchMetaAdLibrary} from './meta-ad-library.js';
import {
  placeActionReadKind,
  placeActionReadResult,
  runPlaceActionDiscovery,
  validatePlaceActionRead,
} from './google-place-action-discovery.js';
import {placeActionSafeError, redactPlaceActionInput} from './google-place-action-links.js';
import {wooCommerceStoreDiscovery} from './woocommerce-source.js';
import {connectWooCommerce} from './woocommerce-connection.js';
import {inspectGoogleRecipeGoals} from './google-goal-inspection.js';
import {microsoftLocationLookup} from './microsoft-locations.js';
import {metaAssetUsage} from './meta-asset-usage.js';
import {googleImageUsage} from './google-image-usage.js';
import {snapchatAssetUsage} from './snapchat-asset-usage.js';
import {checkSnapchatByIdsResult, validateSnapchatByIds} from './snapchat-by-ids.js';
import {keepResultIds, snapchatResultIds, type ResultIds} from './snapchat-result-ids.js';
import {googleGenerationKind, googleGenerationResult, validateGoogleGeneration} from './google-generation.js';
import {
  dv360TargetingSearchRoute,
  runDV360TargetingSearch,
  validateDV360TargetingSearch,
} from './dv360-targeting-search.js';
import {runXAudienceEstimate, validateXAudienceEstimate, xAudienceEstimateRoute} from './x-audience-estimate.js';
import {validateAppleResponse} from './apple-native.js';
import {projectRedditAccountHistory, redditAccountHistoryRead} from './reddit-extensions.js';
import {microsoftGateway, validateMicrosoftResponse} from './microsoft-native.js';
import {legacyLimitDisclosure} from './google-legacy.js';
// Wave 4c round 6 (w4c-arc6-workspace): the providers' actions of the workspace tool.
import {measurementEvents} from './measurement-events.js';
import {createConsentPlan, previewConsentPlan} from './gtm-consent-plans.js';
import {measurementEventIdentity} from './measurement-event-identity.js';
import {linkedInConversionEvidence} from './linkedin-conversion-evidence.js';
import {measurementGoogleGoals} from './measurement-google-goals.js';
import {googleChangeHistory} from './google-change-history.js';
import {ga4AdminConfig} from './ga4-admin-config.js';
import {measurementLedger} from './measurement-ledger.js';
import {wooCommerceSource, type WooCommerceRequest} from './woocommerce-source.js';
import {wooCommerceInventory} from './woocommerce-inventory.js';
import {wooCommerceSourceList, wooCommerceSourcePath} from './woocommerce-workspace.js';
import {createCatalogRemoval, previewCatalogRemoval} from './x-catalog-removal.js';
import {gtmMeasurementAudit} from './gtm-measurement-audit.js';
// Wave 4c round 6 (w4c-arc6-catalog).
import {metaCatalogComparison} from './meta-catalog-comparison.js';
import {xCatalogComparison, xCatalogListedSelection} from './x-catalog-comparison.js';
import {snapchatCatalogComparison} from './snapchat-catalog-comparison.js';
import {catalogInventoryRequested, listedSelectionRequested} from './x-catalog-selection-inventory.js';
// Wave 4c round 6 (w4c-arc6-reporting): the Overview's Sheets delivery (sheetsDelivery, at the end).
import {
  GoogleSheetsExports,
  abandonSheetsDelivery,
  assertSheetsSettled,
  deliveryProjection,
  sheetsDeliveriesForReport,
  unresolvedSheetsDelivery,
  unresolvedStates,
} from './google-sheets.js';
export type {WooCommerceRequest} from './woocommerce-source.js';
export type {ResultIds} from './snapchat-result-ids.js';

/**
 * The provider workflows registry (ARC-01 phase B, wave 4c): the AMCP workflows that answer an operation of a
 * provider's delegated tool, or of AMCP's native tool on a provider's behalf, without a native route of their own
 * (WooCommerce's store listing, Tag Manager's diagnostics, GA4's and Search Console's sync, Business Profile's sync,
 * Adjust's reporting, Meta's Ad Library and existing posts) and the provider rules of their action contract rows; and
 * the providers' steps of the service (src/service.ts MirrorService): those of a native read, the asset usage readers,
 * the campaign runner's provider steps, the audit redactors of a refused call's arguments and the website's store
 * connection. It imports the providers' modules so that the shared modules consult it instead (the architecture
 * ratchet, tools/architecture-map.mjs, counts it with the providers), and it never decides: each shared stage keeps its
 * own rules and order and asks it only where it named a provider before.
 */

/**
 * Where the action contract ledger (src/action-contracts.ts) applies a workflow's row among its own rules, in its
 * order: before the connection diagnostics, before the disconnect rule, or after it.
 */
export type ContractStage = 'before_diagnostics' | 'before_disconnect' | 'after_disconnect';

/** A workflow's action contract row: where the ledger applies it, which operations and actions it lists, and its row. */
export interface WorkflowContract {
  readonly stage: ContractStage;
  /** Whether the row of this operation and action of the workflow's tool is the workflow's, given the row so far. */
  listed(operation: string, action: string, row: {readonly status: string}): boolean;
  readonly row: ContractRow;
}

/**
 * Where MirrorService.delegated consults a workflow among its own steps, in its order: before the connection
 * disconnect and diagnostics, after them, or after the Drive inspection and the platform upload.
 */
export type DispatchStage = 'before_connection' | 'after_connection' | 'after_media';

/** What a provider step is given by the service: its store, catalog, transport and credentials. */
export interface WorkflowContext {
  readonly store: Store;
  readonly registry: Registry;
  readonly transport: NativeTransport;
  readonly credentials: CredentialProvider;
  /** The fetcher the service was given in place of the global fetch, else undefined. */
  readonly fetcher?: typeof fetch;
}
/** One call a workflow answers: the tool's gateway, its operation and arguments, the caller and the request ID. */
export interface WorkflowCall {
  readonly gateway: string;
  readonly operation: string;
  readonly args: JsonObject;
  readonly actor: Actor;
  readonly requestId: string;
}
/** Where the service consults a workflow, whether it answers an operation and action of its tool, and how it runs. */
export interface WorkflowDispatch {
  readonly stage: DispatchStage;
  claims(operation: string, action: unknown): boolean;
  run(context: WorkflowContext, call: WorkflowCall): unknown;
}

/** One provider workflow: the provider whose it is (its gateway), the tool whose operations it answers, its row. */
export interface ProviderWorkflow {
  readonly provider: string;
  readonly tool: string;
  readonly dispatch?: WorkflowDispatch;
  readonly contract?: WorkflowContract;
}

const measurementSyncRow: ContractRow = Object.freeze({
  status: 'local_workflow' as const,
  implementation: 'src/measurement-connection-sync.ts / src/google-measurement-assets.ts',
  reason:
    'Administrator-scoped GA4 properties or Search Console sites discovery with dry-run default, bounded native GETs and atomic complete metadata persistence. Preserves selections/write grants; scopes, login, concurrent sync and current authority are fenced. No OAuth grant change or provider mutation.',
  tests: Object.freeze(['tests/measurement-connection-sync.test.ts']),
});
const measurementSync = (tool: string): ProviderWorkflow =>
  Object.freeze({
    provider: tool,
    tool,
    dispatch: Object.freeze({
      stage: 'before_connection' as const,
      claims: (operation: string, action: unknown) => measurementConnectionSyncKind(tool, operation, action),
      run: (c: WorkflowContext, {gateway, operation, args, actor, requestId}: WorkflowCall) =>
        syncMeasurementConnection(c.store, c.transport, c.credentials, gateway, operation, args, actor, requestId),
    }),
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) => measurementConnectionSyncKind(tool, operation, action),
      row: measurementSyncRow,
    }),
  });

/**
 * The provider workflows, in the order each shared stage consulted them. Two workflows of one tool answer different
 * operations (tests/provider-action-contracts.test.mjs, tests/provider-workflows.test.mjs), so at most one answers a
 * call or lists a row.
 */
export const providerWorkflows: readonly ProviderWorkflow[] = Object.freeze([
  Object.freeze({
    provider: 'commerce_native_action',
    tool: 'commerce_native_action',
    dispatch: Object.freeze({
      stage: 'before_connection' as const,
      claims: (operation: string) => operation === 'woocommerce_list_stores',
      run: (c: WorkflowContext, {args, actor}: WorkflowCall) => wooCommerceStoreDiscovery(c.store, actor, args),
    }),
    contract: Object.freeze({
      stage: 'before_diagnostics' as const,
      listed: (operation: string) => operation === 'woocommerce_list_stores',
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/woocommerce-source.ts',
        reason:
          'Implemented AMCP workflow; platform and payload support depend on its underlying contracts. This row never enables native writes.',
        tests: Object.freeze([
          'tests/woocommerce-store-discovery.test.mjs',
          'tests/mcp-woocommerce-store-discovery.test.mjs',
        ]),
      }),
    }),
  }),
  Object.freeze({
    provider: 'gtm_native_action',
    tool: 'gtm_native_action',
    dispatch: Object.freeze({
      stage: 'after_media' as const,
      claims: (operation: string) => gtmDiagnosticOperations.has(operation),
      run: (c: WorkflowContext, {operation, args, actor}: WorkflowCall) =>
        gtmDiagnostics(c.store, c.registry, c.transport, c.credentials, operation, args, actor),
    }),
    contract: Object.freeze({
      stage: 'before_diagnostics' as const,
      listed: (operation: string) => gtmDiagnosticOperations.has(operation),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/gtm-diagnostics.ts',
        reason:
          'AMCP scoped read-only configuration audit or local reviewed-write verification job status. This workflow never publishes or resubmits a mutation.',
        tests: Object.freeze(['tests/gtm-diagnostics.test.ts']),
      }),
    }),
  }),
  measurementSync('ga4_native_action'),
  measurementSync('google_search_console_native_action'),
  Object.freeze({
    provider: 'google_business_native_action',
    tool: 'google_business_native_action',
    dispatch: Object.freeze({
      stage: 'before_connection' as const,
      claims: (operation: string, action: unknown) =>
        businessConnectionSyncKind('google_business_native_action', operation, action),
      run: (c: WorkflowContext, {args, actor, requestId}: WorkflowCall) =>
        syncBusinessConnection(c.store, c.transport, c.credentials, args, actor, requestId),
    }),
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) =>
        businessConnectionSyncKind('google_business_native_action', operation, action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/google-business-sync.ts / src/google-business-assets.ts',
        reason:
          'Administrator-scoped Business Profile account and optional location discovery. Bounded native GETs, required read mask, shared location parents, current authority and per-attempt login fencing; complete groups persist atomically without changing selections or grants. Website Connections uses the same discovery; no OAuth grant change or provider mutation.',
        tests: Object.freeze(['tests/google-business-sync.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'adjust_native_action',
    tool: 'adjust_native_action',
    dispatch: Object.freeze({
      stage: 'before_connection' as const,
      claims: (operation: string, action: unknown) => adjustReportingKind(operation, action),
      run: (c: WorkflowContext, {operation, args, actor, requestId}: WorkflowCall) =>
        adjustReporting(c.store, c.transport, c.credentials, operation, args, actor, requestId),
    }),
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) => adjustReportingKind(operation, action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/adjust-reporting.ts',
        reason:
          'Scoped Adjust app/event/filter discovery and bounded native JSON or app-indexed pivot reporting. Encrypted token transport, current grants, exact numeric strings, documented no-content, warning/completeness metadata and no provider writes. Local asset listing describes configured bindings only.',
        source: 'https://dev.adjust.com/en/api/rs-api/',
        tests: Object.freeze(['tests/adjust-reporting.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'meta_native_action',
    tool: 'amcp_native_action',
    dispatch: Object.freeze({
      stage: 'after_connection' as const,
      claims: (operation: string) => operation === 'search_ads_library',
      run: (c: WorkflowContext, {args, actor, requestId}: WorkflowCall) =>
        searchMetaAdLibrary(c.registry, c.store, c.transport, c.credentials, args, actor, requestId),
    }),
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string) => operation === 'search_ads_library',
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/meta-ad-library.ts',
        reason:
          'Bounded public Meta Ad Library search through the sole/default connection. Media format is translated separately from provider ad category. Geographic API coverage and result limits are explicit; no performance inference or token-bearing URLs are returned.',
        source: 'https://www.facebook.com/ads/library/api/',
        tests: Object.freeze(['tests/meta-ad-library.test.ts']),
      }),
    }),
  }),
  Object.freeze({
    provider: 'meta_native_action',
    tool: 'amcp_native_action',
    dispatch: Object.freeze({
      stage: 'after_connection' as const,
      claims: (operation: string) => operation === 'fetch_meta_existing_posts',
      run: (c: WorkflowContext, {args, actor, requestId}: WorkflowCall) =>
        fetchMetaExistingPosts(c.store, c.transport, c.credentials, args, actor, requestId),
    }),
    contract: Object.freeze({
      stage: 'before_disconnect' as const,
      listed: (operation: string, action: string) =>
        operation === 'fetch_meta_existing_posts' && metaPostActions.includes(action),
      row: Object.freeze({
        status: 'local_workflow' as const,
        implementation: 'src/meta-existing-posts.ts',
        reason:
          'Account-scoped Page/Instagram identity discovery, ephemeral server-side Page token and owned content reads. Exact IDs or bounded canonical permalink lookup with encrypted, scoped continuations. No arbitrary URL fetching or automatic creative writes; native eligibility and approval remain unverified.',
        source: 'https://github.com/facebook/facebook-python-business-sdk/tree/25.0.3/facebook_business/adobjects',
        tests: Object.freeze(['tests/meta-existing-posts.test.ts']),
      }),
    }),
  }),
  // Not a workflow of its own: Business Profile's place-action discovery is a native read, whose row names the
  // modules and tests of its contract.
  Object.freeze({
    provider: 'google_business_native_action',
    tool: 'google_business_native_action',
    contract: Object.freeze({
      stage: 'after_disconnect' as const,
      listed: (operation: string, action: string, row: {readonly status: string}) =>
        row.status === 'native_read' &&
        !!placeActionReadKind({
          gateway: 'google_business_native_action',
          action: operation + '/' + action,
        } as CompiledRequest),
      row: Object.freeze({
        implementation: 'src/delegated-native.ts / src/google-place-action-discovery.ts / src/transport.ts',
        reason:
          'Native place-action metadata, complete bounded link lists or exact link read. Location filters bind the selected location grant; global/region metadata does not establish eligibility. Current scope checks, native envelopes, private URL redaction and explicit page continuation; no ownership or write grants are inferred.',
        tests: Object.freeze([
          'tests/google-place-action-discovery.test.ts',
          'tests/google-place-action-links.test.ts',
        ]),
      }),
    }),
  }),
]);

/** The workflow that answers this call of a tool at one of MirrorService.delegated's stages, if any. */
export function providerWorkflow(
  stage: DispatchStage,
  tool: string,
  operation: string,
  action: unknown,
): WorkflowDispatch | undefined {
  for (const {tool: owner, dispatch} of providerWorkflows)
    if (owner === tool && dispatch?.stage === stage && dispatch.claims(operation, action)) return dispatch;
  return undefined;
}

/** One page read of a native read (MirrorService.runPlan's fetchPage). */
export type PageRead = (plan: CompiledRequest) => Promise<unknown>;
const aggregated = (input: JsonObject) => !!(input.aggregate_pages || input.paginate || input.allPages);

/**
 * The providers' steps of a native read (MirrorService.runPlan), at the points where the read named them, each in the
 * order the read called them. Every step is called for every read, as it was, and acts on its own provider's requests
 * only, except Snapchat's result_ids, which refuses the filter on any other read.
 */
export const nativeReadSteps = Object.freeze({
  /** Before the request's execution risk: the IDs a result_ids read keeps (Snapchat's account lists, S3). */
  wanted: (plan: CompiledRequest, input: JsonObject): ResultIds | undefined => snapchatResultIds(plan, input),
  /** After the execution risk, before a report job admits the read: each provider's request checks. */
  prepare(plan: CompiledRequest, input: JsonObject): CompiledRequest {
    validateGoogleGeneration(plan);
    validateDV360TargetingSearch(plan);
    validateSnapchatByIds(plan);
    validateXAudienceEstimate(plan);
    if (xAudienceEstimateRoute(plan)) {
      if (aggregated(input))
        throw new MirrorError(
          'INVALID_X_AUDIENCE_ESTIMATE',
          'An audience range is not paginated or additive. Request one complete criteria set.',
        );
      plan = {...plan, xAudienceDeadline: performance.now() + 60000};
    }
    validatePlaceActionRead(plan, input);
    return plan;
  },
  /** After a report job admitted the read: a request no aggregation may page (Google's draft generation). */
  admitted(plan: CompiledRequest, input: JsonObject): void {
    if (googleGenerationKind(plan) && aggregated(input))
      throw new MirrorError('INVALID_ARGUMENT', 'Google generation is one bounded request, not a paginated query.');
  },
  /** After ScopeGuard: the account a read is scoped by when its request names none (Business Profile's place actions). */
  scoped: (plan: CompiledRequest, scopedId: string): CompiledRequest =>
    placeActionReadKind(plan) && !plan.accountId ? {...plan, accountId: scopedId} : plan,
  /** A page as received, before its vendor schema: Snapchat's by-ID records of the account, X's estimate status. */
  received(p: CompiledRequest, data: unknown, status: number, account: string): void {
    checkSnapchatByIdsResult(p, data, account);
    if ((xAudienceEstimateRoute(p) || p.action === 'AMCP_X_AUDIENCE_REFERENCE') && status !== 200)
      throw new MirrorError(
        'X_AUDIENCE_RESPONSE_INVALID',
        'X did not return HTTP 200 for this bounded estimate read.',
        {},
        502,
      );
  },
  /**
   * A page after its vendor schema: the providers' response contracts (Apple's, Microsoft's), and the data a provider's
   * read returns instead of the page (Reddit's account history without people, PRV-07; Business Profile's place
   * actions); undefined leaves the page to the read.
   */
  page(p: CompiledRequest, result: TransportResult): {readonly data: unknown} | undefined {
    validateAppleResponse(p, result.data);
    // PRV-07: who changed a Reddit account is personal data; it never leaves this function.
    if (redditAccountHistoryRead(p)) return {data: projectRedditAccountHistory(result.data)};
    if (p.gateway === microsoftGateway) validateMicrosoftResponse(p, result);
    if (placeActionReadKind(p)) return {data: placeActionReadResult(p, result.data, result.status)};
    return undefined;
  },
  /** A read its provider runs itself before any report job (X's audience estimate, which no job then reads). */
  first: (plan: CompiledRequest, fetchPage: PageRead) =>
    xAudienceEstimateRoute(plan) ? runXAudienceEstimate(plan, fetchPage) : undefined,
  /** A read its provider runs itself when no report job does (Business Profile's place actions, DV360's search). */
  own: (plan: CompiledRequest, fetchPage: PageRead, input: JsonObject, connectionId: string) =>
    placeActionReadKind(plan)
      ? runPlaceActionDiscovery(plan, fetchPage, connectionId)
      : dv360TargetingSearchRoute(plan)
        ? runDV360TargetingSearch(plan, fetchPage, aggregated(input), Number(input.max_pages ?? 25))
        : undefined,
  /** What a complete result discloses besides it (a defaulted Google Ads legacy list that may hold more rows). */
  disclosed: (
    plan: CompiledRequest,
    data: unknown,
    input: JsonObject,
    compile: (call: JsonObject) => CompiledRequest,
  ): JsonObject | undefined => legacyLimitDisclosure(plan, data, input, compile),
  /** The records a result_ids read asked for, and what was and was not found (Snapchat). */
  keep: keepResultIds,
  /** What a read produced besides its data (Google's generated drafts). */
  produced: (plan: CompiledRequest, data: unknown): JsonObject | undefined => googleGenerationResult(plan, data),
  /**
   * A failed read's refusal as it may be kept and returned (Business Profile's private place-action links; Meta's ad
   * identity probe, whose two refusals are one, NF-2).
   */
  safeError: (plan: CompiledRequest, error: unknown): unknown =>
    placeActionReadKind(plan) ? placeActionSafeError(error) : metaAdIdentityRefusal(plan, error),
});

/** A tool call the service makes on the person's behalf (a nested call). */
export type ToolCall = (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>;
type AssetUsageReader = (c: WorkflowContext, actor: Actor, input: JsonObject, call: ToolCall) => Promise<JsonObject>;
/** The provider's reader of an asset's current native usage, by usage kind (src/native-usage.ts usageKind). */
const assetUsageReaders: Readonly<Record<string, AssetUsageReader>> = Object.freeze({
  google_image_links: (c: WorkflowContext, actor: Actor, input: JsonObject) =>
    googleImageUsage(c.store, c.registry, c.transport, c.credentials, actor, input),
  snapchat_top_snap: (c: WorkflowContext, actor: Actor, input: JsonObject) =>
    snapchatAssetUsage(c.store, c.registry, c.transport, c.credentials, actor, input),
  meta_scalar_references: (c: WorkflowContext, actor: Actor, input: JsonObject, call: ToolCall) =>
    metaAssetUsage(c.store, call, actor, input),
});
/** The asset usage reader of a usage kind; an own entry only, so an inherited name is no reader. */
export const assetUsageReader = (kind: unknown): AssetUsageReader | undefined =>
  typeof kind === 'string' && Object.hasOwn(assetUsageReaders, kind) ? assetUsageReaders[kind] : undefined;

/** The campaign runner's provider steps (src/campaign-runner.ts): Google's recipe goals, Microsoft's locations. */
export const campaignProviderSteps = Object.freeze({
  goals: (c: WorkflowContext, actor: Actor, scope: JsonObject, current: () => void) =>
    inspectGoogleRecipeGoals(c.store, c.registry, c.transport, c.credentials, actor, scope, current),
  locations: (c: WorkflowContext, actor: Actor, lookup: JsonObject) =>
    microsoftLocationLookup(
      {store: c.store, registry: c.registry, transport: c.transport, credentials: c.credentials, fetcher: c.fetcher},
      actor,
      lookup,
    ),
});

/**
 * The providers' audit redactors of a refused call's arguments, in the order the service applies them between the
 * people of a request and the connection diagnostics (the links and cursors of a Meta existing-post read, private
 * links of a Business Profile place action).
 */
export const providerInputRedactors: readonly ((tool: string, input: JsonObject) => JsonObject)[] = Object.freeze([
  redactMetaPostInput,
  redactPlaceActionInput,
]);

/** The website's administrator setup of a store connection (WooCommerce's, through its guarded GET transport). */
export const connectStore = connectWooCommerce;

// Wave 4c round 6 (w4c-arc6-workspace): the providers' actions of the workspace tool.

/** What a provider's action of the workspace tool is given: the service's context and the tool's nested call. */
export interface WorkspaceContext extends WorkflowContext {
  readonly call: ToolCall;
  /** The WooCommerce store request the service was given in place of the guarded one, else undefined. */
  readonly wooCommerceRequest?: WooCommerceRequest;
}
/** A provider's action of the workspace tool, called with the tool's input once the tool's own checks passed. */
export type WorkspaceAction = (
  c: WorkspaceContext,
  actor: Actor,
  input: JsonObject,
) => Promise<JsonObject> | JsonObject;
/** One provider's actions of the workspace tool, by action name, and the website page of a record they return. */
export interface WorkspaceWorkflow {
  /** The gateway of the provider whose actions they are; `measurement` for the ledger of several providers' assets. */
  readonly provider: string;
  readonly actions: Readonly<Record<string, WorkspaceAction>>;
  /** The page of a record its actions return (src/workflow-outcomes.ts): `{}` for its record without a page. */
  readonly websitePath?: (data: JsonObject) => {readonly path?: string} | undefined;
}
const workspaceEntry = (
  provider: string,
  actions: Record<string, WorkspaceAction>,
  websitePath?: WorkspaceWorkflow['websitePath'],
): WorkspaceWorkflow =>
  Object.freeze({provider, actions: Object.freeze(actions), ...(websitePath ? {websitePath} : {})});

/**
 * The providers' actions of the workspace tool (src/workspace.ts WorkspaceService.handle), which were branches of its
 * dispatch until wave 4c. Each calls its provider's workflow with the arguments its branch gave it; the tool keeps its
 * own checks and their order, and consults this table where it named these actions. An action belongs to one provider
 * (a load-time check below); the tool's own actions are not here.
 */
export const workspaceWorkflows: readonly WorkspaceWorkflow[] = Object.freeze([
  workspaceEntry('ga4_native_action', {
    measurement_events: (c, actor, input) => measurementEvents(c.store, c.call, actor, input),
    measurement_event_identity: (c, actor, input) => measurementEventIdentity(c.store, c.call, actor, input),
    measurement_ga4_config: (c, actor, input) =>
      ga4AdminConfig(c.store, c.registry, c.transport, c.credentials, actor, input),
  }),
  workspaceEntry('gtm_native_action', {
    preview_consent_plan: (c, actor, input) => previewConsentPlan(c.store, c.call, actor, input),
    create_consent_plan: (c, actor, input) => createConsentPlan(c.store, c.call, actor, input),
    measurement_audit: (c, actor, input) => gtmMeasurementAudit(c.store, c.call, actor, input),
  }),
  workspaceEntry('linkedin_native_action', {
    measurement_conversions: (c, actor, input) => linkedInConversionEvidence(c.store, c.call, actor, input),
  }),
  workspaceEntry('google_ads_native_action', {
    measurement_google_goals: (c, actor, input) =>
      measurementGoogleGoals(c.store, c.registry, c.transport, c.credentials, actor, input),
    // PRV-07: a bounded read-only diagnosis read; nothing is saved.
    change_history: (c, actor, input) => googleChangeHistory(c.store, c.call, actor, input),
  }),
  workspaceEntry('measurement', {
    measurement_ledger: (c, actor, input) =>
      measurementLedger(c.store, c.registry, c.transport, c.credentials, c.call, actor, input),
  }),
  workspaceEntry(
    'commerce_native_action',
    {
      // A complete inventory collection is its own read; selected products or variations are the source read.
      catalog_source: (c, actor, input) =>
        input.requirements?.source_kind === 'inventory'
          ? wooCommerceInventory(c.store, actor, input, c.wooCommerceRequest, c.transport.commerceSourceEnvironment())
          : wooCommerceSource(c.store, actor, input, c.wooCommerceRequest, c.transport.commerceSourceEnvironment()),
      catalog_sources: (c, actor, input) => wooCommerceSourceList(c.store, actor, input),
    },
    wooCommerceSourcePath,
  ),
  workspaceEntry('x_ads_native_action', {
    preview_catalog_removal: (c, actor, input) => previewCatalogRemoval(c.store, c.call, actor, input),
    create_catalog_removal: (c, actor, input) => createCatalogRemoval(c.store, c.call, actor, input),
  }),
]);
const workspaceActions = new Map<string, WorkspaceAction>();
for (const {provider, actions} of workspaceWorkflows)
  for (const [action, run] of Object.entries(actions)) {
    if (workspaceActions.has(action))
      throw new Error('Two providers declare the workspace action ' + action + ' (' + provider + ').');
    workspaceActions.set(action, run);
  }

/** The provider's action of this workspace action name, or undefined for the tool's own actions and other names. */
export const workspaceAction = (action: unknown): WorkspaceAction | undefined =>
  typeof action === 'string' ? workspaceActions.get(action) : undefined;

/** The website page of a provider's record of a workspace action, or undefined when no provider's record it is. */
export function workspaceWebsitePath(data: JsonObject): {readonly path?: string} | undefined {
  for (const {websitePath} of workspaceWorkflows) {
    const page = websitePath?.(data);
    if (page) return page;
  }
  return undefined;
}

// Wave 4c round 6 (w4c-arc6-catalog): the catalog comparison's provider steps (src/catalog-comparison.ts), moved with
// their order.
type CatalogComparison = (
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) => Promise<JsonObject>;
export const catalogComparisonSteps = Object.freeze({
  /** First, whatever the gateway: X's check of an explicit inspection of other listed products. */
  inventoryRequested: catalogInventoryRequested,
  /** X's explicit selection of listed products by native key (COM-02 B): its keys, or undefined. */
  listedSelectionRequested,
  /** X's read of a listed selection, which reads only the selected products. */
  listedSelection: xCatalogListedSelection,
  /** Each catalog destination's read-only comparison of supplied products with its current catalog (COM-03). */
  comparisons: Object.freeze({
    meta_native_action: metaCatalogComparison,
    x_ads_native_action: xCatalogComparison,
    // COM-02 D: Snapchat changes products only through feeds, so its comparison names what to fix there.
    snapchat_native_action: snapchatCatalogComparison,
  }) as Readonly<Record<string, CatalogComparison>>,
});

/**
 * Wave 4c round 6 (w4c-arc6-reporting): the Overview's Google Sheets delivery (src/google-sheets.ts), which
 * src/reporting-overview.ts consults instead of importing it: the export client of the service's store and fetcher,
 * the delivery states that stay unresolved, and the delivery receipts the Overview lists, projects, rechecks and
 * releases, each the module's own export under its own name.
 */
export const sheetsDelivery = Object.freeze({
  exports: (store: Store, fetcher: typeof fetch) => new GoogleSheetsExports(store, fetcher),
  unresolvedStates,
  unresolvedSheetsDelivery,
  sheetsDeliveriesForReport,
  deliveryProjection,
  assertSheetsSettled,
  abandonSheetsDelivery,
});
