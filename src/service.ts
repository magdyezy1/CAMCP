import {metaReportReadResult, observeMetaReportRead, runMetaReportRead} from './meta-insights-jobs.js';
import {xReportRoute, xReportStatus, xReportStatusData, observeXReport, xReportIdentity} from './x-report-jobs.js';
import {downloadXReport, xReportPage} from './x-report-download.js';
import {tiktokReportRoute, tiktokReportReadResult, runTiktokReportRead} from './tiktok-report-jobs.js';
import {criteoReportReadResult, observeCriteoReportRead, runCriteoReportRead} from './criteo-report-jobs.js';
import {connectionDiagnosticKind, connectionDiagnostics, redactConnectionInput} from './connection-diagnostics.js';
import {connectionDisconnectKind, connectionDisconnect} from './connection-disconnect.js';
import {measurementConnectionSyncKind, syncMeasurementConnection} from './measurement-connection-sync.js';
import {businessConnectionSyncKind, syncBusinessConnection} from './google-business-sync.js';
import {adjustReportingKind, adjustReporting} from './adjust-reporting.js';
import {nativeAuthority} from './native-authority.js';
import {
  placeActionReadKind,
  validatePlaceActionRead,
  placeActionReadResult,
  runPlaceActionDiscovery,
} from './google-place-action-discovery.js';
import {campaignPreflight} from './campaign-preflight.js';
import {inspectGoogleRecipeGoals} from './google-goal-inspection.js';
import {searchMetaAdLibrary} from './meta-ad-library.js';
import {fetchMetaExistingPosts, redactMetaPostInput} from './meta-existing-posts.js';
import {assertNotPersonalDataRead, withoutPeople} from './personal-data.js';
import {reviewedFamilies} from './reviewed-families.js';
/** Requests that carry people: their arguments are scrubbed from the error audit (src/personal-data.ts). */
let personalActions: ReadonlySet<string> | undefined;
const personalDataActions = () =>
  (personalActions ??= new Set(reviewedFamilies().flatMap(f => f.personalData?.actions ?? [])));
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {checkSnapchatByIdsResult, validateSnapchatByIds} from './snapchat-by-ids.js';
import {keepResultIds, snapchatResultIds} from './snapchat-result-ids.js';
import {WriteGroups, groupLimitRefusal, needsGroup} from './write-groups.js';
import {gtmDiagnosticOperations, gtmDiagnostics} from './gtm-diagnostics.js';
import {withEffects, workflowOutcome, writeErrorOutcome} from './workflow-outcomes.js';
import {actionArgumentCheck} from './first-party-contracts.js';
import {conditionalProgramDescription} from './conditional-programs.js';
import {amcpNote, listedDescription, mediaListing} from './tool-notes.js';
import {unavailableRefusal} from './unavailable-operations.js';
import {amcpDescribed} from './execution-status.js';
import {checkContextOptions, contextOperation} from './context-operations.js';
import {unqualifiedUsage, usageKind} from './native-usage.js';
import {fitCapturedDescription, routingSummary} from './tool-summaries.js';
import {surfaceRevision, toolHelp} from './tool-help.js';
import {serverIdentity} from './server-identity.js';
import {toolPresentation} from './tool-annotations.js';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {ServiceTimingCategory} from './service-timings.js';
import type {Actor, CallOptions, CompiledRequest, JsonObject} from './types.js';
import {Registry, listsActions} from './catalog.js';
import {Compiler} from './compiler.js';
import {Introspection} from './introspection.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {authorizeExecution, readOnlyPolicy, type ExecutionPolicy} from './preflight.js';
import {redactPlaceActionInput, placeActionSafeError} from './google-place-action-links.js';
import {connectorReadOnly, errorResult, MirrorError, readOnlyDeployment, untrustedProviderContent} from './errors.js';
import {recordSqliteFailure, sqliteRefusal} from './sqlite-diagnostics.js';
import {currentRequestId} from './request-context.js';
import {runWithQuotaPurpose} from './provider-quota.js';
import {guardInput, redactUrlSecrets, sha256, stable} from './security.js';
import {nextPageCall, paginate} from './pagination.js';
import {legacyLimitDisclosure} from './google-legacy.js';
import {ScopeGuard, snapchatScopedResource} from './scope.js';
import {DelegatedNativeCompiler, delegatedParameterMatches} from './delegated-native.js';
import {WorkflowEngine} from './workflows.js';
import {ReportingService, reportingOperations} from './reporting.js';
import {redactReportingRecord} from './report-query-access.js';
import {applyExecutionRisk} from './execution-risk.js';
import {projectResponse} from './projection.js';
import {WriteReviewService, readOnlyWriteTool, writeTool} from './write-review.js';
import {validateAppleResponse} from './apple-native.js';
import {microsoftGateway, validateMicrosoftResponse} from './microsoft-native.js';
import {
  downloadReportArchive,
  parseMicrosoftReport,
  microsoftReportKey,
  microsoftReportPage,
} from './microsoft-report-download.js';
import {WorkspaceService, workspaceTool} from './workspace.js';
import {CampaignRunner, campaignTool} from './campaign-runner.js';
import {DecisionReporting, decisionTool} from './decision-reporting.js';
import {ReportingOverview, overviewTool} from './reporting-overview.js';
import {AdPreviews, previewTool} from './ad-previews.js';
import {WriteVerifier} from './write-verification.js';
import {validateProviderRequest} from './provider-validation.js';
import {MediaUploadService, mediaTool, readOnlyMediaTool} from './media-upload.js';
import type {LinkRequest} from './media-link.js';
import {
  nativeMediaInput,
  workflowMediaInput,
  mediaPreview,
  mediaNext,
  inspectDrive,
  mediaDiscovery,
  mediaInstructions,
} from './media-routing.js';
import {ContractMemory, evidenceForm} from './contract-evidence.js';
import {accountKind, accountMetadataView, resolveAccountMetadata} from './account-metadata.js';
import {readinessContract} from './readiness.js';
import {assertGatewayOffered, gatewayOffered} from './provider-offering.js';
import {googleGenerationKind, googleGenerationResult, validateGoogleGeneration} from './google-generation.js';
import {
  dv360TargetingSearchRoute,
  validateDV360TargetingSearch,
  runDV360TargetingSearch,
} from './dv360-targeting-search.js';
import {xAudienceEstimateRoute, validateXAudienceEstimate, runXAudienceEstimate} from './x-audience-estimate.js';
import {metaAssetUsage} from './meta-asset-usage.js';
import {googleImageUsage} from './google-image-usage.js';
import {snapchatAssetUsage} from './snapchat-asset-usage.js';
import {creativeAssetView} from './creative-library.js';
import {wooCommerceStoreDiscovery, type WooCommerceRequest} from './woocommerce-source.js';
import {connectWooCommerce} from './woocommerce-connection.js';
import {sameLogin} from './connection-authority.js';
export const strictOptions: CallOptions = {mode: 'strict', flags: {}};
/**
 * The amcp_write inspect call for a change a native gateway will not send (MCP-09): the caller's arguments without the
 * execution flags (dry_run, confirmed, idempotency_key), which only a review's execute takes.
 */
function reviewInspection(gateway: string, args: JsonObject): JsonObject {
  const strip = (a: JsonObject) => {
    const {dry_run: _dry, confirmed: _confirmed, idempotency_key: _key, ...rest} = a;
    return rest;
  };
  const outer = strip(args ?? {}),
    nested = outer.arguments;
  return {
    tool: 'amcp_write',
    arguments: {
      action: 'inspect',
      gateway,
      arguments:
        nested && typeof nested === 'object' && !Array.isArray(nested) ? {...outer, arguments: strip(nested)} : outer,
    },
  };
}
/** Content without a captured top-level success flag: the envelope carries success once (MCP-05). */
function withoutSuccess(content: JsonObject): JsonObject {
  if (content?.success !== true) return content;
  const {success: _flag, ...rest} = content;
  return rest;
}
/**
 * A LIST_ACTIONS page with one set of paging fields on every gateway (MCP-05): total, offset, limit, has_more and
 * next_offset. The captured fields stay as they were (total_actions; Snapchat's next_cursor), as aliases.
 */
function actionPage(page: JsonObject, input: JsonObject): JsonObject {
  const rest = withoutSuccess(page),
    total = rest.total ?? rest.total_actions,
    offset = rest.offset ?? Number(input.cursor ?? input.offset ?? 0),
    limit = rest.limit ?? (typeof rest.next_cursor === 'number' ? rest.next_cursor - offset : rest.returned),
    more = rest.has_more ?? rest.next_cursor !== undefined;
  return {
    ...rest,
    total,
    offset,
    limit,
    has_more: more,
    next_offset: more ? offset + (Array.isArray(rest.actions) ? rest.actions.length : limit) : null,
  };
}
/**
 * Tools whose results are composed entirely on this server from the static catalog, and so
 * cannot carry provider-authored text. Everything else is labelled, which means a tool added
 * later is labelled by default rather than silently exempt.
 */
const localOnlyTools = new Set(['amcp_tool_help']);
/**
 * The audit record of a completed read: its status, pages and headers, and the size, hash and row counts of what the
 * provider returned, but not the content. Report rows, lead details and ad copy stay in the response and in the
 * documents that deliberately keep them, not in the permanent audit trail (F-18).
 */
/**
 * Provider links that are unusable without their signature, which a read returns for the caller to use: Google's
 * generated-image download links (AssetGenerationService.GenerateImages, imageTemporaryUrl).
 */
const signedLinkFields = new Set(['imageTemporaryUrl']);
export function auditedRead(outcome: JsonObject): JsonObject {
  const {data, generation, ...rest} = outcome,
    text = stable(data) ?? 'null';
  const arrays =
    data && typeof data === 'object' && !Array.isArray(data)
      ? Object.entries(data)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, (v as unknown[]).length])
      : [];
  return {
    ...rest,
    data_summary: {
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      ...(Array.isArray(data) ? {rows: data.length} : {}),
      ...(arrays.length ? {arrays: Object.fromEntries(arrays)} : {}),
      content_retained: false,
    },
    ...(generation ? {generation_retained: false} : {}),
  };
}
export const carriesProviderContent = (tool: string) => !localOnlyTools.has(tool);
/** The read that renews a lapsed ownership observation, when AMCP may run it itself: the refused call is a native read
 * or a write's prepare or inspect, and the read is the same gateway's account list narrowed to one ID. */
function narrowedOwnershipRead(tool: string, input: JsonObject, result: JsonObject) {
  const error = result.success === false ? (result.error as JsonObject) : undefined,
    next = error?.code === 'RESOURCE_SCOPE_REQUIRED' ? (error.details?.next_call as JsonObject | undefined) : undefined,
    args = next?.arguments as JsonObject | undefined;
  const native = /^[a-z0-9]+(?:_[a-z0-9]+)*_native_action$/.test(tool) && tool !== 'amcp_native_action',
    write = tool === 'amcp_write' && ['prepare', 'inspect'].includes(input.action);
  if (!next || !args || (!native && !write)) return undefined;
  if (next.tool !== error!.details.gateway || !/_list$/.test(String(args.action))) return undefined;
  if (!Array.isArray(args.result_ids) || args.result_ids.length !== 1) return undefined;
  return {tool: String(next.tool), arguments: args};
}
/**
 * PRV-05: a native read returns 64-bit integers exactly (TransportResult.exactData) only to a call made through
 * withExactIntegers, which the MCP server uses for its callers. Tools called from inside that call, and every other
 * caller (workers, composite tools, tests), keep the provider's JSON numbers, which their checks expect.
 */
const exactIntegerScope = new AsyncLocalStorage<{requested: boolean; active: boolean}>();
export const withExactIntegers = <T>(run: () => Promise<T>): Promise<T> =>
  exactIntegerScope.run({requested: true, active: false}, run);
export class MirrorService {
  readonly compiler: Compiler;
  readonly introspection: Introspection;
  readonly credentials: CredentialProvider;
  readonly delegatedCompiler = new DelegatedNativeCompiler();
  /** Which caller has received which provider contract whole (F-89). */
  contractMemory = new ContractMemory();
  /**
   * Receives one metadata-only entry per tool failure that needs an operator (OPS-02): internal and storage failures
   * and failed audit appends. Never messages, SQL, arguments or identities.
   */
  onToolFailure?: (entry: JsonObject) => void;
  /** The AMCP-authored tools, with their full descriptions (amcp_tool_help returns them whole). */
  firstPartyTools() {
    return [
      workspaceTool,
      campaignTool,
      decisionTool,
      overviewTool,
      previewTool,
      // A read-only deployment lists amcp_write with inspect only (owner decision D15, MCP-09).
      ...(this.policy.allowWrites ? [writeTool, mediaTool] : [readOnlyWriteTool, readOnlyMediaTool]),
    ];
  }
  /** tools/list: each tool with its title and reviewed annotations (MCP-06). */
  listTools() {
    const readOnly = !this.policy.allowWrites;
    return this.listedTools().map(t => ({...t, ...toolPresentation(t.name, readOnly)}));
  }
  private listedTools() {
    const compact = this.options.flags.compactDescriptions !== false,
      // A provider this deployment does not offer is not listed (CON-06, src/provider-offering.ts).
      offered = this.registry.listTools(this.options).filter(t => gatewayOffered(t.name));
    return [
      ...offered.map(t => {
        const definition = this.registry.tools.get(t.name)!,
          media = mediaDiscovery(t.name) ? mediaInstructions : undefined;
        if (!compact) return {...t, ...(media ? {description: t.description + ' ' + media} : {})};
        const note = amcpNote(definition);
        // AMCP's own description where the captured one is untrue, and a short media sentence (MCP-10).
        return {
          ...t,
          description: fitCapturedDescription(t.name, listedDescription(definition), [
            note ?? '',
            media ? mediaListing(t.name) : '',
          ]),
        };
      }),
      ...this.firstPartyTools().map(t => {
        const summary = compact ? routingSummary(t.name, !this.policy.allowWrites) : undefined;
        return summary ? {...t, description: summary} : t;
      }),
    ];
  }
  constructor(
    readonly registry: Registry,
    readonly store: Store,
    readonly transport = new NativeTransport(),
    readonly options: CallOptions = strictOptions,
    readonly policy: ExecutionPolicy = readOnlyPolicy,
    private mediaFetcher: typeof fetch = fetch,
    private mediaLinkRequest?: LinkRequest,
    private wooCommerceRequest?: WooCommerceRequest,
  ) {
    this.compiler = new Compiler(registry);
    this.introspection = new Introspection(registry);
    this.credentials = new CredentialProvider(store);
  }
  /** Website administrator setup only; provider requests use the same guarded WooCommerce GET transport. */
  connectWooCommerce(actor: Actor, input: unknown, signal?: AbortSignal) {
    return connectWooCommerce(this.store, actor, input, {request: this.wooCommerceRequest, signal});
  }
  /**
   * One tool call. An ownership observation lasts five minutes (F-70); when a read, or a write's prepare or inspect,
   * is refused only because it lapsed, and the refusal names the account's own list narrowed to the one refused ID,
   * AMCP runs that read and retries once (the owner's decision 7, 2026-09-29). Ownership still comes only from the
   * account's list: an ID it does not list stays refused, no request names it, and execute is never retried.
   */
  async call(tool: string, input: JsonObject, actor: Actor): Promise<JsonObject> {
    const exact = exactIntegerScope.getStore()?.requested === true;
    return exactIntegerScope.run({requested: false, active: exact}, () => this.callRenewing(tool, input, actor));
  }
  private async callRenewing(tool: string, input: JsonObject, actor: Actor): Promise<JsonObject> {
    const first = await this.callOnce(tool, input, actor),
      renew = narrowedOwnershipRead(tool, input, first);
    if (!renew || !this.ownershipLapsed(actor, (first.error as JsonObject).details, renew.arguments)) return first;
    const read = await this.callOnce(renew.tool, renew.arguments, actor),
      found = read.success === true && (read.data as JsonObject)?.result_ids?.found;
    if (!Array.isArray(found) || !found.length) return first;
    const again = await this.callOnce(tool, input, actor);
    return {
      ...again,
      meta: {
        ...(again.meta as JsonObject),
        ownership_refreshed: {tool: renew.tool, action: renew.arguments.action, result_ids: renew.arguments.result_ids},
      },
    };
  }
  /** Whether the refused resource was observed through this connection and the observation merely expired. A resource
   * never observed, or whose observations re-provisioning cleared, is not renewed automatically. */
  private ownershipLapsed(actor: Actor, details: JsonObject, read: JsonObject): boolean {
    const resource =
      details.gateway === 'snapchat_native_action' && typeof details.path === 'string'
        ? snapchatScopedResource(details.path)
        : undefined;
    if (!resource) return false;
    try {
      const connection = this.store.resolveConnection(actor, details.gateway, details.account_id, read.connection_id);
      return this.store.ownershipLapsed(connection, details.account_id, resource);
    } catch {
      return false;
    }
  }
  private async callOnce(tool: string, input: JsonObject, actor: Actor): Promise<JsonObject> {
    const requestId = randomUUID(),
      start = Date.now(),
      timingStart = performance.now();
    let actorChecked = false,
      failed = false;
    try {
      this.store.assertActorActive(actor);
      actorChecked = true;
      // A provider this deployment does not offer is refused before its arguments are read (CON-06).
      assertGatewayOffered(tool);
      if (tool === 'amcp_tool_help' || tool === 'amcp_write') assertGatewayOffered(input?.gateway);
      // Each action of an AMCP tool takes its own arguments (MCP-07): one it does not read is a meta warning, or with
      // MIRROR_FLAGS {"actionArguments":"enforce"} an INVALID_ARGUMENT naming it, before the action runs.
      const own = this.firstPartyTools().find(t => t.name === tool);
      if (own) {
        const warnings = actionArgumentCheck(
          own,
          input,
          this.options.flags.actionArguments === 'enforce' ? 'enforce' : 'report',
        );
        if (warnings.length) this.argumentWarnings.set(requestId, warnings);
      }
      if (tool === overviewTool.name)
        return this.wrap(
          await new ReportingOverview(this, this.mediaFetcher).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        );
      const call = (t: string, a: JsonObject, u: Actor) => this.call(t, a, u);
      if (tool === previewTool.name)
        return this.wrap(await new AdPreviews(call).handle(input, actor), requestId, start, tool);
      if (tool === workspaceTool.name)
        return this.wrap(
          await new WorkspaceService(
            this.store,
            this.registry,
            this.transport,
            this.credentials,
            call,
            this.policy.allowWrites,
            this.wooCommerceRequest,
            this.options.flags,
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        );
      if (tool === campaignTool.name)
        return this.wrap(
          await new CampaignRunner(
            this.store,
            call,
            (a, id) => this.verifyWrite(a, id),
            (a, i) => validateProviderRequest(this, a, i),
            (a, steps) => campaignPreflight(this, a, steps),
            (g, op) => this.registry.acceptsArgument(g, 'account_id', op),
            (a, scope, current) =>
              inspectGoogleRecipeGoals(this.store, this.registry, this.transport, this.credentials, a, scope, current),
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        );
      if (tool === decisionTool.name)
        return this.wrap(
          await new DecisionReporting(
            this.store,
            async (t, a, u) => {
              this.registry.validate(t, a, this.options);
              const p =
                this.registry.tools.get(t)?.mode === 'delegated'
                  ? this.delegatedCompiler.compile(t, a)
                  : this.compiler.compile(t, a, this.options);
              if (!applyExecutionRisk(p).readOnly)
                throw new MirrorError(
                  'REPORT_READ_REQUIRED',
                  'Reporting accepts independently qualified native reads only.',
                );
              return this.wrap(await this.runPlan(p, a.operation ? a.arguments : a, u), requestId, start, tool);
            },
            (plan, u) => call('amcp_campaign', {...plan, action: 'create'}, u),
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        );
      if (tool === mediaTool.name)
        return this.wrap(
          mediaNext(
            input.action === 'asset_usage'
              ? await this.assetUsage(input, actor, call)
              : await this.media().call(input, actor),
          ),
          requestId,
          start,
          tool,
          input.action,
        );
      if (tool === writeTool.name) {
        const result: any = await this.reviewed(input, actor);
        return {
          ...this.wrap(result, requestId, start, tool, input.action),
          ...(result.success === false
            ? {
                success: false,
                error: errorResult(
                  new MirrorError(
                    'WRITE_PARTIAL_OR_FAILED',
                    'Provider reported an incomplete or failed mutation; inspect the retained outcome before further action.',
                  ),
                  requestId,
                  Date.now() - start,
                ).error,
              }
            : {}),
        };
      }
      // Help and introspection share the one envelope {success, data, meta} (MCP-05); a captured success flag inside
      // the content is dropped, and the captured content itself is kept verbatim under data.
      if (tool === 'amcp_tool_help')
        return this.wrap(
          withoutSuccess(
            toolHelp(
              {
                registry: this.registry,
                options: this.options,
                listed: () => this.listTools(),
                firstParty: () => this.firstPartyTools(),
                release: () => serverIdentity(),
              },
              input,
            ),
          ),
          requestId,
          start,
          tool,
        );
      const catalogListing = listsActions.has(tool) && ['LIST_ACTIONS', 'DESCRIBE_ACTION'].includes(input.action);
      // An operation listed only for catalog compatibility is refused before its arguments are checked, since
      // correcting them would not help, and before anything is sent (MCP-10).
      if (this.registry.tools.get(tool)?.mode === 'delegated') {
        guardInput(input);
        const unavailable = unavailableRefusal(tool, input);
        if (unavailable) throw this.listedAlternatives(unavailable);
      }
      if (catalogListing) guardInput(input);
      else this.validated(tool, input);
      if (input.action === 'LIST_ACTIONS')
        return this.wrap(
          actionPage(
            catalogListing
              ? this.introspection.catalogRequest(tool, input)
              : this.introspection.list(tool, input, this.options),
            input,
          ),
          requestId,
          start,
          tool,
        );
      if (input.action === 'DESCRIBE_ACTION') {
        const description = catalogListing
            ? this.introspection.catalogRequest(tool, input)
            : this.introspection.describe(tool, input),
          media = mediaDiscovery(tool),
          program = conditionalProgramDescription(this.registry, tool, input.target_action);
        // read_only is AMCP's contract classification and api_version the version sent; captured values that differ
        // stay under captured_catalog, and amcp_execution says whether AMCP runs the action (MCP-10).
        return this.wrap(
          {
            ...amcpDescribed(this.registry, tool, String(input.target_action), withoutSuccess(description)),
            ...(program ? {amcp_conditional_program: program} : {}),
            amcp_write_inspection: {
              tool: 'amcp_write',
              action: 'inspect',
              gateway: tool,
              usage:
                'Supply the intended native arguments to check local review-contract support without provider calls. Media routes use amcp_media.',
            },
            ...(media ? {amcp_media_import: media} : {}),
          },
          requestId,
          start,
          tool,
        );
      }
      if (this.registry.tools.get(tool)?.mode === 'delegated')
        return this.wrap(
          await this.delegated(tool, input.operation, input.arguments ?? {}, actor, requestId),
          requestId,
          start,
          tool,
        );
      const plan = this.compiler.compile(tool, input, this.options);
      const hasMediaSource = ['drive_url', 'url', 'image_url', 'video_url', 'file_url', 'source'].some(
        k => plan.body && typeof plan.body === 'object' && (plan.body as JsonObject)[k] !== undefined,
      );
      const media =
        input.dry_run === false || hasMediaSource ? nativeMediaInput(plan, this.connectionId(input)) : undefined;
      if (media)
        return this.wrap(
          input.dry_run === false ? mediaNext(await this.media().call(media, actor)) : mediaPreview(media),
          requestId,
          start,
          tool,
        );
      return this.wrap(await this.runPlan(plan, input, actor, requestId), requestId, start, tool);
    } catch (e) {
      failed = true;
      // A genuine SQLite capacity or contention failure becomes its AMCP refusal (OPS-02), not INTERNAL_ERROR.
      const database = recordSqliteFailure(e, 'mcp'),
        refusal = sqliteRefusal(e) ?? e;
      let result: JsonObject = errorResult(refusal, requestId, Date.now() - start),
        auditRecorded = true;
      try {
        this.store.appendAudit(actor.tenantId, requestId, {
          tool,
          input: redactReportingRecord(
            redactConnectionInput(
              tool,
              redactPlaceActionInput(
                tool,
                redactMetaPostInput(tool, withoutPeople(tool, input, personalDataActions())),
              ),
            ),
          ),
          outcome: result,
        });
      } catch (auditError) {
        // The envelope must not promise an audit record that was never written.
        auditRecorded = false;
        recordSqliteFailure(auditError, 'mcp');
        if (!(refusal instanceof MirrorError)) {
          const internal = errorResult(
            new MirrorError(
              'INTERNAL_ERROR',
              'The request failed and its audit record could not be written. Report this request ID to the deployment operator.',
              {},
              500,
            ),
            requestId,
            Date.now() - start,
          );
          result = {
            ...internal,
            error: {...internal.error, next_action: 'Report this request ID to the deployment operator.'},
          };
        }
        result = {...result, meta: {...result.meta, audit_recorded: false}};
      }
      // A refused call keeps its argument findings (MCP-07): an argument the action does not read is most useful to
      // see exactly when the call failed.
      const warnings = this.argumentWarnings.get(requestId);
      if (warnings) result = {...result, meta: {...result.meta, argument_warnings: warnings}};
      // An execute that did not complete says whether anything may have been sent (MCP-07): uncertain writes are
      // attention_required with a read of their history, never a retry.
      if (tool === writeTool.name && refusal instanceof MirrorError) {
        const workflow = writeErrorOutcome(input, refusal, this.writeClaim(actor, input));
        if (workflow) {
          if (workflow.next_call && !this.listed(workflow.next_call.tool)) delete workflow.next_call;
          result = {...result, meta: {...result.meta, workflow}};
        }
      }
      const status = refusal instanceof MirrorError ? refusal.status : 500;
      if (database || !auditRecorded || status >= 500)
        try {
          const ingress = currentRequestId();
          this.onToolFailure?.({
            level: status >= 500 || !auditRecorded ? 'error' : 'warn',
            event: 'mcp_tool_failed',
            requestId,
            // The HTTP request's X-AMCP-Request-Id (OPS-08); requestId above is the audit record's request ID.
            ...(ingress ? {http_request_id: ingress} : {}),
            tool_category: this.timingCategory(tool),
            code: result.error.code,
            status,
            audit_recorded: auditRecorded,
            at: new Date().toISOString(),
            ...(database ? {database} : {}),
          });
        } catch {
          // Diagnostic delivery never replaces the envelope.
        }
      return result;
    } finally {
      this.argumentWarnings.delete(requestId);
      if (actorChecked) {
        try {
          this.store.serviceTiming(actor.tenantId, this.timingCategory(tool), performance.now() - timingStart, !failed);
        } catch {
          // Observability cannot replace an accepted receipt or retry a native operation.
          this.store.noteServiceTimingFailure();
        }
      }
    }
  }
  /**
   * amcp_media asset_usage, routed by usage kind (MCP-10): the reader for the asset's provider and media type checks its
   * own receipt; an asset no reader covers (another provider, or a Google video) gets the provider-neutral refusal
   * listing what can be read, before any provider request.
   */
  private assetUsage(
    input: JsonObject,
    actor: Actor,
    call: (t: string, a: JsonObject, u: Actor) => Promise<JsonObject>,
  ) {
    const asset = creativeAssetView(this.store, actor, input.asset_id),
      kind = usageKind(asset);
    if (kind === 'google_image_links')
      return googleImageUsage(this.store, this.registry, this.transport, this.credentials, actor, input);
    if (kind === 'snapchat_top_snap')
      return snapchatAssetUsage(this.store, this.registry, this.transport, this.credentials, actor, input);
    if (kind === 'meta_scalar_references') return metaAssetUsage(this.store, call, actor, input);
    throw unqualifiedUsage(asset);
  }
  /** The state of an execute's idempotency claim after the call (MCP-07): none when nothing was claimed or it was released. */
  private writeClaim(actor: Actor, input: JsonObject): 'none' | 'pending' | 'uncertain' | 'complete' | undefined {
    if (input?.action !== 'execute') return undefined;
    const key = input.idempotency_key ?? input.review_id;
    if (typeof key !== 'string' || !key) return undefined;
    try {
      const row = this.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, key) as {state?: string} | undefined;
      if (!row) return 'none';
      return ['pending', 'uncertain', 'complete'].includes(String(row.state))
        ? (row.state as 'pending' | 'uncertain' | 'complete')
        : undefined;
    } catch {
      return undefined;
    }
  }
  /** Captured validation; an unknown action also names the surface revision, since stale tool definitions send them. */
  private validated(tool: string, input: JsonObject) {
    try {
      this.registry.validate(tool, input, this.options);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'INVALID_ARGUMENT' && e.details.list_call && tool !== 'amcp_tool_help')
        e.details.surface_revision = surfaceRevision(this.listTools());
      throw e;
    }
  }
  private timingCategory(tool: string): ServiceTimingCategory {
    for (const [name, category] of [
      [workspaceTool.name, 'workspace'],
      [campaignTool.name, 'campaign'],
      [decisionTool.name, 'analysis'],
      [overviewTool.name, 'overview'],
      [previewTool.name, 'preview'],
      [mediaTool.name, 'media'],
      [writeTool.name, 'write'],
    ] as [string, ServiceTimingCategory][])
      if (tool === name) return category;
    return 'native_other';
  }
  /**
   * The website's public origin on an HTTP deployment, set where the website is mounted, so a handoff carries an
   * absolute website_url beside its relative website_path (MCP-09). Unset on stdio, which serves no website.
   */
  websiteOrigin?: string;
  private listedNames?: Set<string>;
  /** Whether this deployment lists the tool; a workflow next_call naming any other tool is withheld (MCP-09). */
  private listed(name: unknown) {
    this.listedNames ??= new Set(this.listedTools().map(t => t.name));
    return typeof name === 'string' && this.listedNames.has(name);
  }
  /**
   * An unavailable operation's refusal keeps only the alternatives this deployment can run (MCP-10): a website page, or
   * a call whose tool is listed here and whose action or operation is in that listed tool's enum. On a read-only
   * deployment amcp_media lists its reads only, so `amcp_media prepare` is not offered there.
   */
  private listedAlternatives(error: MirrorError): MirrorError {
    const alternatives = error.details.alternatives;
    if (!Array.isArray(alternatives)) return error;
    const tools = new Map(this.listedTools().map(t => [t.name, t]));
    error.details.alternatives = alternatives.filter((alternative: JsonObject) => {
      if (typeof alternative?.tool !== 'string') return true;
      const tool = tools.get(alternative.tool);
      if (!tool) return false;
      const properties = (tool.inputSchema as JsonObject)?.properties ?? {};
      return ['action', 'operation'].every(key => {
        const value = alternative.arguments?.[key],
          values = properties[key]?.enum;
        return value === undefined || !Array.isArray(values) || values.includes(value);
      });
    });
    return error;
  }
  /**
   * Campaign names, ad copy, creative and media metadata, report rows and account labels are
   * written by whoever can edit the advertising account — agency staff, clients, and on Reddit
   * and X the wider public. They arrive here as data and are handed to a language model that can
   * go on to prepare provider mutations, which is the shape of a prompt-injection channel.
   *
   * Nothing is rewritten or stripped: altering a campaign name would corrupt the reporting it
   * feeds. Responses that can carry third-party text are labelled instead, so the model is told
   * at the point of use that the content is data rather than instruction. The reviewed-write
   * protocol remains the control that stops an injected instruction from reaching a provider;
   * this makes the risk legible to the model and to the person approving a plan.
   */

  /** Report-only argument findings of the call in flight, by request ID (MCP-07); wrap puts them under meta. */
  private argumentWarnings = new Map<string, JsonObject[]>();
  private wrap(data: unknown, requestId: string, start: number, tool?: string, action?: unknown) {
    const meta: JsonObject = {requestId, latencyMs: Date.now() - start};
    const warnings = this.argumentWarnings.get(requestId);
    if (warnings) meta.argument_warnings = warnings;
    const workflow = workflowOutcome(tool, data as JsonObject, action);
    if (workflow) {
      if (workflow.next_call && !this.listed(workflow.next_call.tool)) delete workflow.next_call;
      const path = workflow.website_path;
      if (this.websiteOrigin && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'))
        workflow.website_url = new URL(path, this.websiteOrigin).href;
      meta.workflow = workflow;
    }
    // Everything under data may be provider text; meta, and any error message, remedy or next step, are AMCP's own.
    if (tool && carriesProviderContent(tool)) {
      meta.untrusted_provider_content = untrustedProviderContent;
      meta.untrusted_paths = ['data'];
    }
    return {success: true, data, meta};
  }
  /** Prepare inputs being tried whole before any split (see reviewed). */
  private ungrouped = new WeakSet<JsonObject>();
  private writeGroups() {
    return new WriteGroups(
      this.store,
      (input, actor) => this.reviewed(input, actor),
      (actor, id, flags) =>
        new WriteReviewService(
          this.registry,
          this.compiler,
          this.store,
          this.transport,
          this.credentials,
          this.options,
          this.policy,
          this.delegatedCompiler,
        ).admit(actor, id, flags),
    );
  }
  async verifyWrite(actor: Actor, id: string): Promise<JsonObject> {
    // A verification read-back may use the reserved slice of a shared provider app quota (OPS-08).
    return runWithQuotaPurpose('reserved', () => {
      const groups = this.writeGroups();
      if (groups.group(actor, id)) return groups.verify(actor, id, part => this.verifyWrite(actor, part));
      return new WriteVerifier(this.store, this.registry, this.transport, this.credentials).verify(actor, id);
    });
  }
  async verificationJob(tenant: string, kind: string, input: JsonObject) {
    if (kind !== 'write_verification') throw new MirrorError('UNKNOWN_JOB_KIND', 'No worker handles this job.');
    const actor = this.store.restoreJobActor(tenant, input.review_id, input.actor_binding);
    if (input.__job_id)
      this.store.bindActorCheck(actor, () => {
        const job = this.store.db
          .prepare('SELECT state,lease_token,lease_until FROM jobs WHERE tenant_id=? AND id=?')
          .get(tenant, input.__job_id) as JsonObject | undefined;
        if (!job || job.state !== 'running' || job.lease_token !== input.__lease_token || job.lease_until <= Date.now())
          throw new MirrorError('STALE_JOB_LEASE', 'This worker no longer owns the verification job.', {}, 409);
      });
    return this.verifyWrite(actor, input.review_id);
  }
  private media() {
    return new MediaUploadService(
      this.registry,
      this.store,
      this.transport,
      this.credentials,
      this.policy,
      this.mediaFetcher,
      this.mediaLinkRequest,
    );
  }
  /** Files uploaded to AMCP or imported from a link, for the website's upload routes. */
  mediaSources() {
    return this.media().sources;
  }
  private connectionId(input: JsonObject, outer?: string) {
    const ids = [outer, input.connection_id, input.connectionId].filter(v => v !== undefined);
    if (ids.some(v => typeof v !== 'string' || v !== ids[0]))
      throw new MirrorError('CONFLICTING_PARAMETER', 'Connection ID aliases must identify the same connection.');
    return ids[0];
  }
  private async reviewed(input: JsonObject, actor: Actor): Promise<unknown> {
    // Who may change anything is decided before the payload is checked (MCP-09): a read-only deployment or a read-only
    // client learns that first, instead of after correcting arguments that could never run.
    if (input.action === 'prepare' || input.action === 'execute') {
      if (!this.policy.allowWrites)
        throw readOnlyDeployment(
          input.action === 'prepare' &&
            typeof input.gateway === 'string' &&
            input.arguments &&
            typeof input.arguments === 'object' &&
            !Array.isArray(input.arguments)
            ? {next_call: reviewInspection(input.gateway, input.arguments)}
            : {},
        );
      if (actor.role === 'reader') throw connectorReadOnly(actor);
    }
    for (const key of Object.keys(input))
      if (!Object.hasOwn(writeTool.inputSchema.properties, key))
        throw new MirrorError('INVALID_ARGUMENT', 'Unknown write-tool parameter.', {parameter: key});
    // Media reviews carry no provider contract, but a wrong form is refused on every route alike.
    evidenceForm(input.evidence);
    if (
      input.action === 'execute' &&
      typeof input.review_id === 'string' &&
      this.store.db
        .prepare('SELECT 1 FROM documents WHERE tenant_id=? AND kind=? AND id=?')
        .get(actor.tenantId, 'media_review', input.review_id)
    ) {
      if (
        input.gateway !== undefined ||
        input.arguments !== undefined ||
        input.connection_id !== undefined ||
        input.spend_change_confirmed !== undefined
      )
        throw new MirrorError('INVALID_ARGUMENT', 'Media execution uses only its frozen review and confirmation.');
      return this.media().call(input, actor);
    }
    // One approval for a list longer than one native call takes: parts of 25, each an ordinary review (owner item 4).
    const groups = this.writeGroups();
    if (input.action === 'execute' && groups.group(actor, input.review_id)) return groups.execute(input, actor);
    // The request as sent first: a family whose own limit is larger takes it whole. Only a refusal of the 25-record
    // limit itself turns it into a group.
    if (input.action === 'prepare' && !this.ungrouped.has(input) && needsGroup(input.gateway, input.arguments)) {
      this.ungrouped.add(input);
      try {
        return await this.reviewed(input, actor);
      } catch (e) {
        if (groupLimitRefusal(e)) return groups.prepare(input, actor);
        throw e;
      } finally {
        this.ungrouped.delete(input);
      }
    }
    if (
      input.action === 'prepare' &&
      typeof input.gateway === 'string' &&
      input.arguments &&
      typeof input.arguments === 'object' &&
      !Array.isArray(input.arguments)
    ) {
      const args = input.arguments;
      this.registry.validate(input.gateway, args, this.options);
      if (input.gateway === 'amcp_native_action' && args.operation === 'platform_media_upload')
        return mediaNext(await this.media().call(workflowMediaInput(args.arguments, input.connection_id), actor));
      if (this.registry.tools.get(input.gateway)?.mode !== 'delegated') {
        const plan = this.compiler.compile(input.gateway, args, this.options),
          media = nativeMediaInput(plan, this.connectionId(args, input.connection_id));
        if (media) return mediaNext(await this.media().call(media, actor));
      }
    }
    // A caller that does not choose receives each provider contract whole once per session, then a reference to it.
    const session = this.store.sessionIdentity(actor) ?? actor.tenantId + '\0' + actor.userId,
      gateway = typeof input.gateway === 'string' ? input.gateway : undefined;
    const result = (await new WriteReviewService(
      this.registry,
      this.compiler,
      this.store,
      this.transport,
      this.credentials,
      this.options,
      this.policy,
      this.delegatedCompiler,
    ).call(input, actor, gateway ? this.contractMemory.form(session, gateway) : undefined)) as JsonObject;
    if (gateway && result?.contract_evidence?.provider?.write_scope !== undefined)
      this.contractMemory.delivered(session, gateway);
    return result;
  }
  /** `review` is the gateway input as the caller sent it, when `input` is only its nested arguments (delegated tools). */
  async runPlan(
    plan: CompiledRequest,
    input: JsonObject,
    actor: Actor,
    requestId: string = randomUUID(),
    review?: JsonObject,
  ): Promise<unknown> {
    assertProviderActionAvailable(plan);
    assertNotPersonalDataRead(plan);
    // Checked before any request: result_ids reads an account list, whose path establishes ownership (Snapchat S3).
    const wantedIds = snapchatResultIds(plan, input);
    if (input.connection_id && input.connectionId && input.connection_id !== input.connectionId)
      throw new MirrorError(
        'CONFLICTING_PARAMETER',
        'Connection ID aliases must identify the same connection.',
        {},
        403,
      );
    plan = applyExecutionRisk(plan);
    validateGoogleGeneration(plan);
    validateDV360TargetingSearch(plan);
    validateSnapchatByIds(plan);
    validateXAudienceEstimate(plan);
    if (xAudienceEstimateRoute(plan)) {
      if (input.aggregate_pages || input.paginate || input.allPages)
        throw new MirrorError(
          'INVALID_X_AUDIENCE_ESTIMATE',
          'An audience range is not paginated or additive. Request one complete criteria set.',
        );
      plan = {...plan, xAudienceDeadline: performance.now() + 60000};
    }
    validatePlaceActionRead(plan, input);
    if (xReportRoute(plan) && (input.aggregate_pages || input.paginate || input.allPages))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Poll explicit job_ids. Download one original job with offset/limit; do not aggregate job discovery.',
      );
    if (xReportRoute(plan) === 'status') plan = {...plan, xReportDeadline: performance.now() + 60000};
    if (tiktokReportRoute(plan) && (input.aggregate_pages || input.paginate || input.allPages))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'TikTok asynchronous tasks are not paginated. Resume the same task using status/download.',
      );
    if (googleGenerationKind(plan) && (input.aggregate_pages || input.paginate || input.allPages))
      throw new MirrorError('INVALID_ARGUMENT', 'Google generation is one bounded request, not a paginated query.');
    if (input.dry_run === true || (!plan.readOnly && input.dry_run !== false)) {
      const result = {success: true, dry_run: true, action: plan.action, request: plan, executed: false};
      this.store.appendAudit(actor.tenantId, requestId, {event: 'preview', request: plan, outcome: 'not_executed'});
      return result;
    }
    // A native gateway never writes, so a write with dry_run:false is refused first, with the call that reviews it
    // (MCP-09). The execution checks below were written for a review and named one that does not exist here.
    if (!plan.readOnly) {
      const next_call = reviewInspection(plan.gateway, review ?? input);
      if (!this.policy.allowWrites) throw readOnlyDeployment({next_call});
      if (actor.role === 'reader') throw connectorReadOnly(actor);
      throw new MirrorError('WRITE_REVIEW_REQUIRED', 'Use amcp_write prepare and execute for a reviewed mutation.', {
        next_call,
      });
    }
    authorizeExecution(actor, plan, input, this.policy);
    const connection = this.store.resolveConnection(
      actor,
      plan.gateway,
      plan.accountId,
      input.connection_id ?? input.connectionId,
    );
    if (!plan.accountId && connection.accounts.length !== 1)
      throw new MirrorError('ACCOUNT_REQUIRED', 'Specify an account_id for this connection.');
    const scope = new ScopeGuard(this.registry, this.store),
      scopedId = scope.authorize(plan, connection);
    if (placeActionReadKind(plan) && !plan.accountId) plan = {...plan, accountId: scopedId};
    const credentials = await this.credentials.get(connection);
    this.store.appendAudit(actor.tenantId, requestId, {event: 'request_started', actor: actor.userId, request: plan});
    try {
      const reportAccess = (p: CompiledRequest) => {
        if (p.criteoReportRead || p.tiktokReportRead || p.xReportRead) {
          this.store.assertActorActive(actor);
          if (!sameLogin(credentials, this.store.credentials(actor.tenantId, connection.id)))
            throw new MirrorError(
              'CONNECTION_AUTHORITY_CHANGED',
              'The selected login changed during report retrieval.',
              {},
              409,
            );
        }
      };
      const fetchPage = async (p: CompiledRequest) => {
        const current = this.store.resolveConnection(actor, p.gateway, p.accountId, connection.id);
        scope.authorize(p, current);
        reportAccess(p);
        const access = nativeAuthority(this.store, this.registry, actor, p, current, credentials, () =>
          reportAccess(p),
        );
        const result = await this.transport.request(p, access(), credentials, undefined, {beforeAttempt: access}),
          {data, status} = result;
        access();
        const active = this.store.resolveConnection(actor, p.gateway, p.accountId, current.id);
        const activeAccount = scope.authorize(p, active);
        reportAccess(p);
        checkSnapchatByIdsResult(p, data, activeAccount);
        if ((xAudienceEstimateRoute(p) || p.action === 'AMCP_X_AUDIENCE_REFERENCE') && status !== 200)
          throw new MirrorError(
            'X_AUDIENCE_RESPONSE_INVALID',
            'X did not return HTTP 200 for this bounded estimate read.',
            {},
            502,
          );
        this.delegatedCompiler.validateResponse(p, data, status);
        validateAppleResponse(p, data);
        if (p.gateway === microsoftGateway) validateMicrosoftResponse(p, result);
        if (placeActionReadKind(p)) return placeActionReadResult(p, data, status);
        if (p.xReportRead) {
          const rows = xReportStatus(p, result);
          observeXReport(p, active, this.store, rows);
          if (p.reportDownload) return this.xDownload(p, rows[0]!, actor, active.id, credentials);
          return xReportStatusData(p, result);
        }
        const tiktokData = tiktokReportReadResult(p, result);
        if (tiktokData) return tiktokData;
        const criteoData = criteoReportReadResult(p, result);
        if (criteoData) {
          observeCriteoReportRead(p, active, this.store, criteoData);
          return criteoData;
        }
        const reportData = metaReportReadResult(p, result);
        if (reportData) {
          observeMetaReportRead(p, active, this.store, reportData);
          return reportData;
        }
        scope.observe(p, active, data);
        if (p.gateway === microsoftGateway && p.reportDownload)
          return this.microsoftDownload(p, data as JsonObject, actor, active.id);
        // PRV-05: an MCP caller receives 64-bit integers exactly; every check above saw the provider's JSON numbers.
        return exactIntegerScope.getStore()?.active ? (result.exactData ?? data) : data;
      };
      const result = xAudienceEstimateRoute(plan)
        ? await runXAudienceEstimate(plan, fetchPage)
        : plan.tiktokReportRead
          ? await runTiktokReportRead(plan, fetchPage)
          : plan.criteoReportRead
            ? await runCriteoReportRead(plan, fetchPage)
            : placeActionReadKind(plan)
              ? await runPlaceActionDiscovery(plan, fetchPage, connection.id)
              : plan.metaReportRead
                ? await runMetaReportRead(plan, fetchPage, !!input.aggregate_pages, Number(input.max_pages ?? 25))
                : dv360TargetingSearchRoute(plan)
                  ? await runDV360TargetingSearch(
                      plan,
                      fetchPage,
                      !!(input.aggregate_pages || input.paginate || input.allPages),
                      Number(input.max_pages ?? 25),
                    )
                  : wantedIds || input.aggregate_pages || input.paginate || input.allPages
                    ? await paginate(plan, fetchPage, Number(input.max_pages ?? 25))
                    : {data: await fetchPage(plan), pages: 1, truncated: false};
      // A capped aggregation continues from the first page it did not read (MCP-04), never from a merged page's cursor.
      const continuation = 'continuation' in result ? result.continuation : undefined;
      if ('continuation' in result) delete result.continuation;
      const delegated = this.registry.tools.get(plan.gateway)?.mode === 'delegated',
        nextCall = continuation
          ? nextPageCall(plan, continuation, input, result.data, {
              delegated,
              sameParameter: delegated ? (a, n) => delegatedParameterMatches(plan.gateway, a, n) : undefined,
              compile: call => {
                this.registry.validate(plan.gateway, call, this.options);
                return delegated
                  ? this.delegatedCompiler.compile(plan.gateway, call)
                  : this.compiler.compile(plan.gateway, call, this.options);
              },
            })
          : undefined,
        legacyLimit = legacyLimitDisclosure(plan, result.data, input, call => {
          this.registry.validate(plan.gateway, call, this.options);
          return this.compiler.compile(plan.gateway, call, this.options);
        });
      const kept = wantedIds ? keepResultIds(result.data, wantedIds, result.pages, result.truncated) : undefined;
      if (kept) result.data = kept.data;
      const nativeCsv = plan.tiktokReportRead?.kind === 'download' ? (result.data as JsonObject) : undefined;
      const projected = projectResponse(
        nativeCsv ? {data: nativeCsv.data} : result.data,
        plan.responseControls,
        plan.gateway,
      );
      if (nativeCsv) {
        const rows = (projected.data as JsonObject).data;
        projected.data = {
          data: rows,
          report: {
            ...nativeCsv.report,
            source_complete: nativeCsv.report.complete,
            source_rows: nativeCsv.report.rows,
            returned_rows: rows.length,
            complete: !projected.truncated,
            projection: {
              fields: plan.responseControls?.fields ?? null,
              empty_values_omitted: plan.responseControls?.compact === true,
              rows_omitted: projected.truncated,
            },
          },
        };
      }
      const generation = googleGenerationResult(plan, result.data);
      // Secrets in provider URLs (paging links, permalinks) never reach the caller; other provider text stays verbatim.
      const scrubbed = redactUrlSecrets(projected.data, signedLinkFields);
      const outcome = {
        success: true,
        action: plan.action,
        dry_run: false,
        ...result,
        data: scrubbed.value,
        ...(scrubbed.redacted ? {url_secrets_redacted: scrubbed.redacted} : {}),
        ...(generation ? {generation} : {}),
        truncated: result.truncated || projected.truncated,
        ...(projected.truncated ? {response_truncated: true} : {}),
        ...(kept ? {result_ids: kept.summary} : {}),
        ...(continuation
          ? nextCall
            ? {next_call: nextCall}
            : {
                next_call: null,
                continuation_unavailable:
                  'The next page cannot be requested through this tool. The collection is partial: narrow the read or raise max_pages.',
              }
          : {}),
        ...(legacyLimit && !continuation ? legacyLimit : {}),
      };
      this.store.appendAudit(actor.tenantId, requestId, {
        event: 'request_completed',
        request: plan,
        outcome:
          (plan.reportDownload && plan.xReportRead) || plan.tiktokReportRead?.kind === 'download'
            ? {success: true, action: plan.action, report: (result.data as JsonObject).report, rows_omitted: true}
            : auditedRead(outcome),
      });
      return outcome;
    } catch (e) {
      if (placeActionReadKind(plan)) e = placeActionSafeError(e);
      this.store.appendAudit(actor.tenantId, requestId, {
        event: 'request_failed',
        request: plan,
        error:
          e instanceof MirrorError ? {code: e.code, message: e.message, details: e.details} : {code: 'INTERNAL_ERROR'},
      });
      throw e;
    }
  }
  private async xDownload(
    plan: CompiledRequest,
    row: JsonObject,
    actor: Actor,
    connectionId: string,
    credentials: import('./types.js').Credentials,
  ) {
    const access = () => {
      this.store.assertActorActive(actor);
      const c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId);
      new ScopeGuard(this.registry, this.store).authorize(plan, c);
      if (xReportIdentity(this.store.credentials(actor.tenantId, c.id)) !== xReportIdentity(credentials))
        throw new MirrorError('X_REPORT_LOGIN_CHANGED', 'The X login changed during retrieval.', {}, 403);
    };
    access();
    const b = plan.xReportRead![0]!,
      {offset, limit} = plan.reportDownload!,
      next = (at: number) => ({
        tool: plan.gateway,
        arguments: {
          action: 'x_stats_jobs_accounts_account_id_get',
          account_id: plan.accountId,
          connection_id: connectionId,
          params: {job_ids: b.job_id},
          download_report: true,
          offset: at,
          limit,
          dry_run: false,
        },
      });
    if (row.status === 'PROCESSING')
      return {
        data: [],
        report: {
          job_id: b.job_id,
          account_id: b.account_id,
          status: 'PROCESSING',
          complete: false,
          report_rows_downloaded: false,
          next_call: next(offset),
        },
      };
    if (row.status !== 'SUCCESS')
      throw new MirrorError(
        row.status === 'FAILED' ? 'X_REPORT_FAILED' : 'X_REPORT_CANCELLED',
        'The original X report did not complete. Inspect the retained definition before explicitly preparing a new job.',
        {job_id: b.job_id, provider_status: row.status},
        502,
      );
    if (Date.parse(row.expires_at) <= Date.now())
      throw new MirrorError(
        'X_REPORT_EXPIRED',
        'The native X result expired. This does not authorize another submission.',
        {job_id: b.job_id},
        410,
      );
    const key = sha256(connectionId + ':' + b.job_id),
      lock = 'x-report-result:' + actor.tenantId + ':' + key,
      owner = randomUUID();
    if (!this.store.acquireLock(lock, owner, 120000))
      throw new MirrorError(
        'X_REPORT_DOWNLOAD_BUSY',
        'This original report is already being retrieved. Retry the same read shortly.',
        {retry_after_ms: 1000},
        409,
        true,
      );
    let slot: string | undefined;
    try {
      slot = [0, 1].map(i => 'x-report-memory:' + i).find(k => this.store.acquireLock(k, owner, 120000));
      if (!slot)
        throw new MirrorError(
          'X_REPORT_DOWNLOAD_BUSY',
          'Two report results are already being read in this deployment. Retry this same read shortly.',
          {retry_after_ms: 1000},
          429,
          true,
        );
      let parsed = this.store.xReportResult(actor.tenantId, key);
      if (!parsed) {
        parsed = await downloadXReport(
          row,
          b,
          access,
          this.mediaFetcher === fetch ? undefined : this.mediaFetcher,
          plan.xReportDeadline,
        );
        access();
        // A final native check catches cancellation/replacement/expiry during transfer.
        const check = {...plan, reportDownload: undefined},
          current = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId),
          guard = nativeAuthority(this.store, this.registry, actor, check, current, credentials, access);
        const response = await this.transport.request(check, guard(), credentials, undefined, {beforeAttempt: guard});
        access();
        const final = xReportStatus(check, response)[0]!;
        if (final.status !== 'SUCCESS' || Date.parse(final.expires_at) <= Date.now())
          throw new MirrorError(
            'X_REPORT_STATE_UNVERIFIED',
            'The report stopped being available while its result was downloaded.',
            {},
            502,
          );
        if (
          [lock, slot].some(
            k =>
              !this.store.db
                .prepare('SELECT 1 FROM service_locks WHERE key=? AND owner=? AND expires_at>?')
                .get(k, owner, Date.now()),
          )
        )
          throw new MirrorError(
            'X_REPORT_DOWNLOAD_BUSY',
            'Result retrieval lost its lease. Retry the original read.',
            {},
            409,
            true,
          );
        parsed = {
          ...parsed,
          binding_sha256: sha256(
            stable({definition: b.definition, login: b.login_fingerprint, account: b.account_id, job: b.job_id}),
          ),
        };
        this.store.saveXReportResult(
          actor.tenantId,
          key,
          parsed,
          Math.min(Date.parse(final.expires_at), Date.now() + 6 * 3600000),
        );
      }
      access();
      if (
        parsed.binding_sha256 !==
        sha256(stable({definition: b.definition, login: b.login_fingerprint, account: b.account_id, job: b.job_id}))
      )
        throw new MirrorError(
          'X_REPORT_STATE_UNVERIFIED',
          'The retained report no longer matches the original definition.',
          {},
          502,
        );
      const rows = xReportPage(parsed.data, offset, limit),
        more = offset + rows.length < parsed.data.length;
      return {
        data: rows,
        report: {
          ...parsed.report,
          status: 'SUCCESS',
          source_complete: parsed.report.complete,
          complete: parsed.report.complete && !more && offset === 0,
          download_complete: true,
          source_rows: parsed.data.length,
          returned_rows: rows.length,
          offset,
          limit,
          has_more: more,
          ...(more ? {next_call: next(offset + rows.length)} : {}),
        },
      };
    } finally {
      if (slot) this.store.releaseLock(slot, owner);
      this.store.releaseLock(lock, owner);
    }
  }
  private async microsoftDownload(plan: CompiledRequest, data: JsonObject, actor: Actor, connectionId: string) {
    const access = () => {
      this.store.assertActorActive(actor);
      const c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId);
      new ScopeGuard(this.registry, this.store).authorize(plan, c);
    };
    access();
    const reportId = (plan.body as JsonObject).ReportRequestId,
      status = data.ReportRequestStatus,
      key = microsoftReportKey(connectionId, plan.accountId!, reportId);
    const next = (offset: number) => ({
      tool: microsoftGateway,
      arguments: {
        action: 'PollGenerateReport',
        account_id: plan.accountId,
        connection_id: connectionId,
        payload: {ReportRequestId: reportId},
        download_report: true,
        offset,
        limit: plan.reportDownload!.limit,
      },
    });
    if (status.Status === 'Pending')
      return {
        report_request_id: reportId,
        status: 'Pending',
        complete: false,
        next_call: next(plan.reportDownload!.offset),
      };
    if (status.Status === 'Error')
      throw new MirrorError('REPORT_GENERATION_FAILED', 'Microsoft could not generate this report.', {}, 502);
    let stored: JsonObject;
    try {
      stored = this.store.document(actor.tenantId, 'microsoft_report', key);
    } catch {
      throw new MirrorError(
        'REPORT_METADATA_REQUIRED',
        'Submit this report through AMCP again to record the original format and columns.',
      );
    }
    if (stored.expires_at <= Date.now()) throw new MirrorError('REPORT_EXPIRED', 'Submit a fresh Microsoft report.');
    let parsed = stored.parsed;
    if (!parsed) {
      if (status.ReportDownloadUrl == null || status.ReportDownloadUrl === '')
        parsed = {
          columns: stored.request.Columns,
          rows: [],
          row_count: 0,
          metadata: {},
          potentially_incomplete: stored.request.ReturnOnlyCompleteData === true ? false : null,
          values: 'native_strings',
          format: stored.request.Format ?? 'Csv',
          empty_reason: 'provider_returned_no_download_url',
        };
      else {
        if (!['Csv', 'Tsv'].includes(stored.request.Format ?? 'Csv'))
          throw new MirrorError(
            'REPORT_FORMAT_UNSUPPORTED',
            'Server parsing supports Csv and Tsv. Submit another report in one of those formats.',
          );
        access();
        const bytes = await downloadReportArchive(
          status.ReportDownloadUrl,
          this.mediaFetcher === fetch ? undefined : this.mediaFetcher,
        );
        access();
        parsed = parseMicrosoftReport(bytes, stored.request, plan.accountId!);
      }
      this.store.putDocument(actor.tenantId, 'microsoft_report', key, {...stored, parsed});
    }
    access();
    const {offset, limit} = plan.reportDownload!,
      rows = microsoftReportPage(parsed.rows, offset, limit),
      hasMore = offset + rows.length < parsed.row_count;
    return {
      ...parsed,
      rows,
      status: 'Success',
      report_request_id: reportId,
      download_complete: true,
      offset,
      limit,
      has_more: hasMore,
      ...(hasMore ? {next_call: next(offset + rows.length)} : {}),
    };
  }
  private async delegated(
    gateway: string,
    operation: string,
    args: JsonObject,
    actor: Actor,
    requestId: string,
  ): Promise<unknown> {
    if (gateway === 'commerce_native_action' && operation === 'woocommerce_list_stores')
      return wooCommerceStoreDiscovery(this.store, actor, args);
    if (gateway === 'adjust_native_action' && adjustReportingKind(operation, args.action))
      return adjustReporting(this.store, this.transport, this.credentials, operation, args, actor, requestId);
    if (measurementConnectionSyncKind(gateway, operation, args.action))
      return syncMeasurementConnection(
        this.store,
        this.transport,
        this.credentials,
        gateway,
        operation,
        args,
        actor,
        requestId,
      );
    if (businessConnectionSyncKind(gateway, operation, args.action))
      return syncBusinessConnection(this.store, this.transport, this.credentials, args, actor, requestId);
    if (connectionDisconnectKind(gateway, operation, args.action))
      return connectionDisconnect(this.store, gateway, operation, args, actor);
    if (connectionDiagnosticKind(gateway, operation, args.action))
      return connectionDiagnostics(this.store, gateway, operation, args, actor, this.policy.allowWrites);
    if (gateway === 'amcp_native_action' && operation === 'search_ads_library')
      return searchMetaAdLibrary(this.registry, this.store, this.transport, this.credentials, args, actor, requestId);
    if (gateway === 'amcp_native_action' && operation === 'fetch_meta_existing_posts')
      return fetchMetaExistingPosts(this.store, this.transport, this.credentials, args, actor, requestId);
    if (gateway === 'amcp_native_action' && operation === 'inspect_google_drive_media') {
      this.store.assertActorActive(actor);
      return inspectDrive(args.link, this.mediaFetcher, actor.tenantId);
    }
    if (gateway === 'amcp_native_action' && operation === 'platform_media_upload') {
      if (args.action === 'FINALIZE_UPLOAD_SESSION') {
        if (
          Object.keys(args).some(
            k => !['action', 'upload_session_id', 'idempotency_key', 'confirmed', 'dry_run'].includes(k),
          )
        )
          throw new MirrorError('INVALID_ARGUMENT', 'Finalize uses only the frozen review.');
        if (args.dry_run !== false)
          return {
            dry_run: true,
            executed: false,
            next_call: {
              tool: 'amcp_write',
              arguments: {
                action: 'execute',
                review_id: args.upload_session_id,
                idempotency_key: args.idempotency_key,
                confirmed: true,
              },
            },
          };
        return this.media().call(
          {
            action: 'execute',
            review_id: args.upload_session_id,
            idempotency_key: args.idempotency_key,
            confirmed: args.confirmed,
          },
          actor,
        );
      }
      const media = workflowMediaInput(args);
      return args.dry_run === false ? mediaNext(await this.media().call(media, actor)) : mediaPreview(media);
    }
    if (gateway === 'gtm_native_action' && gtmDiagnosticOperations.has(operation))
      return gtmDiagnostics(this.store, this.registry, this.transport, this.credentials, operation, args, actor);
    if (this.delegatedCompiler.isNativeOperation(gateway, operation))
      return this.runPlan(
        this.delegatedCompiler.compile(gateway, {operation, arguments: args}),
        args,
        actor,
        requestId,
        {operation, arguments: args},
      );
    if (gateway === 'amcp_native_action' && reportingOperations.has(operation))
      return new ReportingService(this.store).handle(operation, args, actor);
    if (['get_workspace_context', 'list_accounts', 'list_workspace_assets'].includes(operation)) {
      // A captured option AMCP does not implement is refused by name instead of being ignored (MCP-10).
      if (contextOperation(gateway, operation)) checkContextOptions(this.registry, operation, args);
      const connections = this.store.listConnections(actor.tenantId).filter(c => c.enabled);
      if (operation === 'get_workspace_context')
        return {
          workspace: {id: actor.tenantId},
          actor: {id: actor.userId, role: actor.role},
          connections: connections.map(c => ({
            id: c.id,
            platform: c.gateway,
            accounts: c.accounts,
            write_accounts: c.writeAccounts ?? [],
            is_default: c.isDefault === true,
          })),
          live_writes_enabled: this.policy.allowWrites,
        };
      if (operation === 'list_accounts') {
        // Report destinations and media sources are not advertising accounts: they are listed only when their platform
        // is asked for (CON-05).
        const platform = !args.platform
          ? undefined
          : (({google: 'google_ads', sheets: 'google_sheets', drive: 'google_drive'} as Record<string, string>)[
              String(args.platform)
            ] ?? String(args.platform));
        return connections
          .filter(c => (platform ? c.gateway.startsWith(platform) : accountKind(c.gateway) !== 'destination'))
          .flatMap(c =>
            c.accounts.map(id => {
              // One resolver (CON-05): the last live read, then the login's cached discovery listing, then nothing;
              // never the connection's label (Snapchat S8).
              const meta = resolveAccountMetadata(this.store, actor.tenantId, c, id),
                live = meta.source === 'live_account_read';
              return {
                id,
                platform: c.gateway,
                connection_id: c.id,
                name: meta.name,
                connection_label: c.label,
                source: 'configured_binding',
                kind: meta.kind,
                currency: meta.currency,
                timezone: meta.timezone,
                metadata: accountMetadataView(meta),
                ...((!live || meta.stale) && readinessContract(c.gateway)
                  ? {
                      // check saves a readiness record and, live, the account's metadata: said with it (MCP-09).
                      next_call: withEffects({
                        tool: 'amcp_workspace',
                        arguments: {action: 'check', connection_id: c.id, account_id: id, live: true},
                      }),
                    }
                  : {}),
                write_enabled:
                  this.policy.allowWrites && actor.role !== 'reader' && c.writeAccounts?.includes(id) === true,
                is_default: c.isDefault === true,
              };
            }),
          );
      }
      return this.store.documents(actor.tenantId, 'workspace_asset');
    }
    if (operation === 'get_creative_generation_job') return this.store.job(actor.tenantId, String(args.job_id));
    if (gateway === 'amcp_native_action')
      return new WorkflowEngine({
        registry: this.registry,
        store: this.store,
        runNative: async (g, input, a) => this.runPlan(this.compiler.compile(g, input, this.options), input, a),
      }).handle(operation, args, actor);
    throw new MirrorError(
      'WORKFLOW_ADAPTER_REQUIRED',
      'This captured workflow still requires its independent implementation.',
      {gateway, operation},
    );
  }
}
