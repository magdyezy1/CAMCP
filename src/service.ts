import {reportJob} from './report-jobs.js';
import type {ReportJobPage} from './report-job.js';
import {connectionDiagnosticKind, connectionDiagnostics, redactConnectionInput} from './connection-diagnostics.js';
import {connectionDisconnectKind, connectionDisconnect} from './connection-disconnect.js';
import {nativeAuthority} from './native-authority.js';
import {campaignPreflight} from './campaign-preflight.js';
import {
  assetUsageReader,
  campaignProviderSteps,
  connectStore,
  nativeReadSteps,
  providerInputRedactors,
  providerWorkflow,
  type DispatchStage,
  type WooCommerceRequest,
  type WorkflowContext,
} from './provider-workflows.js';
import {providerHooks} from './provider-hooks.js';
import {assertNotPersonalDataRead, withoutPeople} from './personal-data.js';
import {reviewedFamilies} from './reviewed-families.js';
/** Requests that carry people: their arguments are scrubbed from the error audit (src/personal-data.ts). */
let personalActions: ReadonlySet<string> | undefined;
const personalDataActions = () =>
  (personalActions ??= new Set(reviewedFamilies().flatMap(f => f.personalData?.actions ?? [])));
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {WriteGroups, groupLimitRefusal, needsGroup} from './write-groups.js';
import {withEffects, workflowOutcome, writeErrorOutcome} from './workflow-outcomes.js';
import {actionArgumentCheck} from './first-party-contracts.js';
import {conditionalProgramDescription} from './conditional-programs.js';
import {amcpNote, listedDescription, mediaListing, readOnlyTail} from './tool-notes.js';
import {unavailableRefusal} from './unavailable-operations.js';
import {amcpDescribed} from './execution-status.js';
import {checkContextOptions, contextOperation} from './context-operations.js';
import {unqualifiedUsage, usageKind} from './native-usage.js';
import {fitCapturedDescription, routingSummary} from './tool-summaries.js';
import {ownToolHelp, surfaceRevision, toolHelp} from './tool-help.js';
import {serverIdentity} from './server-identity.js';
import {toolPresentation} from './tool-annotations.js';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {ServiceTimingCategory} from './service-timings.js';
import type {ToolContext} from './tool-actions.js';
import type {Actor, CallOptions, CompiledRequest, JsonObject} from './types.js';
import {Registry, listsActions} from './catalog.js';
import {Compiler} from './compiler.js';
import {Introspection} from './introspection.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {authorizeExecution, readOnlyPolicy, type ExecutionPolicy} from './preflight.js';
import {connectorReadOnly, errorResult, MirrorError, readOnlyDeployment, untrustedProviderContent} from './errors.js';
import {recordSqliteFailure, sqliteRefusal} from './sqlite-diagnostics.js';
import {currentRequestId} from './request-context.js';
import {runWithQuotaPurpose} from './provider-quota.js';
import {guardInput, redactUrlSecrets, sha256, stable} from './security.js';
import {nextPageCall, paginate} from './pagination.js';
import {ScopeGuard} from './scope.js';
import {DelegatedNativeCompiler, delegatedParameterMatches} from './delegated-native.js';
import {WorkflowEngine} from './workflows.js';
import {ReportingService, reportingOperations} from './reporting.js';
import {redactReportingRecord} from './report-query-access.js';
import {applyExecutionRisk} from './execution-risk.js';
import {projectResponse} from './projection.js';
import {WriteReviewService, providerJobWriteTool, readOnlyWriteTool, writeTool} from './write-review.js';
import {reviewedProviderJob} from './effect-class.js';
import type {WriteOrigin} from './write-records.js';
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
import {creativeAssetView} from './creative-library.js';
import {sameLogin} from './connection-authority.js';
import {accessSetView, assetsWithinAccess} from './access-sets.js';
export const strictOptions: CallOptions = {mode: 'strict', flags: {}};
/**
 * What the audit record of a refused tool call keeps of its arguments (ARC-04 stage D): each redactor in turn removes
 * what must not be retained, in this order: the people of a request that carries them (src/personal-data.ts), the
 * providers' own (src/provider-workflows.ts: the links and cursors of a Meta existing-post read, private links of a
 * Business Profile place action), the OAuth code and state of a connection diagnostic, and reporting credentials. A
 * tool whose arguments hold something else that must not be kept adds its redactor here, or its provider's there.
 */
export const auditInputRedactors: readonly ((tool: string, input: JsonObject) => JsonObject)[] = Object.freeze([
  (tool: string, input: JsonObject) => withoutPeople(tool, input, personalDataActions()),
  ...providerInputRedactors,
  redactConnectionInput,
  (_tool: string, input: JsonObject) => redactReportingRecord(input),
]);
/** A refused call's arguments as its audit record keeps them. */
export const auditedInput = (tool: string, input: JsonObject): JsonObject =>
  auditInputRedactors.reduce((kept, redact) => redact(tool, kept), input);
/**
 * The workspace actions whose `gateway` only filters local metadata (ARC-01 and P9): `history` reads the retained audit
 * metadata and sends no request, so it may name a parked provider's gateway. Every other call that names a parked
 * gateway is refused before its arguments are read.
 */
export const localGatewayFilterActions: ReadonlySet<string> = new Set(['history']);
const localGatewayFilter = (tool: string, input: JsonObject | undefined) =>
  tool === workspaceTool.name && typeof input?.action === 'string' && localGatewayFilterActions.has(input.action);
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
/** Audit rows of work done under a client access set name the set (SEC-08). */
const accessSetAudit = (actor: Actor) => (actor.accessSetId !== undefined ? {access_set_id: actor.accessSetId} : {});
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
/**
 * One call of an AMCP tool that MirrorService answers itself (ARC-04 stage D): its arguments and caller, the request it
 * is audited and timed under, and `call`, through which the tool reaches other tools on the person's behalf (a nested
 * call, which is never the person's standalone review).
 */
interface CompositeCall extends ToolContext {
  readonly tool: string;
  readonly requestId: string;
  readonly start: number;
  readonly call: (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>;
}
/** An AMCP composite tool: the service-timing category of its calls, and how one call runs. */
interface CompositeTool {
  readonly category: ServiceTimingCategory;
  run(call: CompositeCall): Promise<JsonObject>;
}
/** The table's entry for `tool`: an own entry only, so an inherited name (`constructor`, `toString`) is no tool. */
const compositeTool = (table: Readonly<Record<string, CompositeTool>>, tool: unknown) =>
  typeof tool === 'string' && Object.hasOwn(table, tool) ? table[tool] : undefined;
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
      // A read-only deployment lists amcp_write with inspect only (owner decision D15, MCP-09), and with the owner's
      // provider-job switch also prepare and execute for report and export jobs (RPT-06).
      ...(this.policy.allowWrites
        ? [writeTool, mediaTool]
        : [this.policy.providerJobs === true ? providerJobWriteTool : readOnlyWriteTool, readOnlyMediaTool]),
    ];
  }
  /** tools/list: each tool with its title and reviewed annotations (MCP-06). */
  listTools() {
    const readOnly = !this.policy.allowWrites;
    // amcp_write creates provider jobs under the owner's switch (RPT-06), so it is not annotated read-only then.
    return this.listedTools().map(t => ({
      ...t,
      ...toolPresentation(t.name, readOnly && !(t.name === 'amcp_write' && this.policy.providerJobs === true)),
    }));
  }
  private listedTools() {
    const compact = this.options.flags.compactDescriptions !== false,
      readOnly = !this.policy.allowWrites,
      // A provider this deployment does not offer is not listed (CON-06, src/provider-offering.ts).
      offered = this.registry.listTools(this.options).filter(t => gatewayOffered(t.name));
    return [
      ...offered.map(t => {
        const definition = this.registry.tools.get(t.name)!,
          media = mediaDiscovery(t.name) ? mediaInstructions : undefined;
        if (!compact) return {...t, ...(media ? {description: t.description + ' ' + media} : {})};
        const note = amcpNote(definition),
          // A read-only deployment routes to what it lists: amcp_write inspect and amcp_media reads (D15).
          listed = listedDescription(definition, readOnly);
        // AMCP's own description where the captured one is untrue, and a short media sentence (MCP-10).
        return {
          ...t,
          description: fitCapturedDescription(t.name, listed, [
            note ?? '',
            media ? mediaListing(t.name, readOnly) : '',
            readOnly ? readOnlyTail(listed, this.policy.providerJobs === true) : '',
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
    return connectStore(this.store, actor, input, {request: this.wooCommerceRequest, signal});
  }
  /** What the providers' steps are given (src/provider-workflows.ts): the service's own parts, read when called. */
  private workflowContext(): WorkflowContext {
    return {
      store: this.store,
      registry: this.registry,
      transport: this.transport,
      credentials: this.credentials,
      fetcher: this.mediaFetcher === fetch ? undefined : this.mediaFetcher,
    };
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
    // The resource the refusal's path names, where its provider renews lapsed observations (Snapchat's scope hooks).
    const resource =
      typeof details.path === 'string'
        ? providerHooks(details.gateway)?.scope?.lapsedResource?.(details.path)
        : undefined;
    if (!resource) return false;
    try {
      const connection = this.store.resolveConnection(actor, details.gateway, details.account_id, read.connection_id);
      return this.store.ownershipLapsed(connection, details.account_id, resource);
    } catch {
      return false;
    }
  }
  /**
   * The tools MirrorService answers itself (ARC-04 stage D), by name: callOnce consults this table after the checks every
   * call passes (an active actor, an offered gateway, the action's own arguments) and before the native gateways. Each
   * entry declares the timing category its calls count under; a new composite tool is one entry.
   */
  private readonly compositeTools: Readonly<Record<string, CompositeTool>> = {
    [overviewTool.name]: {
      category: 'overview',
      run: async ({input, actor, tool, requestId, start}) =>
        this.wrap(
          await new ReportingOverview(this, this.mediaFetcher).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        ),
    },
    [previewTool.name]: {
      category: 'preview',
      run: async ({input, actor, tool, requestId, start, call}) =>
        this.wrap(await new AdPreviews(call, this.store).handle(input, actor), requestId, start, tool),
    },
    [workspaceTool.name]: {
      category: 'workspace',
      run: async ({input, actor, tool, requestId, start, call}) =>
        this.wrap(
          await new WorkspaceService(
            this.store,
            this.registry,
            this.transport,
            this.credentials,
            call,
            this.policy.allowWrites,
            this.wooCommerceRequest,
            this.options.flags,
            this.policy.providerJobs === true,
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        ),
    },
    [campaignTool.name]: {
      category: 'campaign',
      run: async ({input, actor, tool, requestId, start, call}) =>
        this.wrap(
          await new CampaignRunner(
            this.store,
            call,
            (a, id) => this.verifyWrite(a, id),
            (a, i) => validateProviderRequest(this, a, i),
            (a, steps) => campaignPreflight(this, a, steps),
            (g, op) => this.registry.acceptsArgument(g, 'account_id', op),
            // The runner's provider steps (src/provider-workflows.ts): Google's recipe goals, Microsoft's locations.
            (a, scope, current) => campaignProviderSteps.goals(this.workflowContext(), a, scope, current),
            (a, lookup) => campaignProviderSteps.locations(this.workflowContext(), a, lookup),
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        ),
    },
    [decisionTool.name]: {
      category: 'analysis',
      run: async ({input, actor, tool, requestId, start, call}) =>
        this.wrap(
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
            (id, u) => call('amcp_campaign', {action: 'get', id, detail: 'full'}, u),
          ).handle(input, actor),
          requestId,
          start,
          tool,
          input.action,
        ),
    },
    [mediaTool.name]: {
      category: 'media',
      run: async ({input, actor, tool, requestId, start, call}) =>
        this.wrap(
          mediaNext(
            input.action === 'asset_usage'
              ? await this.assetUsage(input, actor, call)
              : await this.media().call(input, actor),
          ),
          requestId,
          start,
          tool,
          input.action,
        ),
    },
    [writeTool.name]: {
      category: 'write',
      run: async ({input, actor, tool, requestId, start}) => {
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
      },
    },
    // Help and introspection share the one envelope {success, data, meta} (MCP-05); a captured success flag inside the
    // content is dropped, and the captured content itself is kept verbatim under data. Its calls are timed with the
    // native gateways' (native_other), as before it was an entry.
    amcp_tool_help: {
      category: 'native_other',
      run: async ({input, tool, requestId, start}) =>
        this.wrap(
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
        ),
    },
  };
  private async callOnce(tool: string, input: JsonObject, actor: Actor): Promise<JsonObject> {
    const requestId = randomUUID(),
      start = Date.now(),
      timingStart = performance.now();
    let actorChecked = false,
      failed = false;
    try {
      this.store.assertActorActive(actor);
      actorChecked = true;
      // A provider this deployment does not offer (a parked one, ARC-01 and P9) is refused before its arguments are
      // read, whether it is the tool itself or the gateway any AMCP tool names (CON-06). The one exception is the audit
      // history of retained work: a local metadata read that sends and offers nothing, so a parked provider's history
      // can still be filtered by its gateway, as its stored connections can still be removed.
      assertGatewayOffered(tool);
      if (!localGatewayFilter(tool, input)) assertGatewayOffered(input?.gateway);
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
        if (input.action === 'help') {
          guardInput(input);
          return this.wrap(ownToolHelp(own, input.topic), requestId, start, tool, 'help');
        }
      }
      // A call a workflow makes for the person (a campaign plan preparing its step) is not their standalone review.
      const call = (t: string, a: JsonObject, u: Actor) => {
        this.nested.add(a);
        return this.call(t, a, u);
      };
      // ARC-04 stage D: an AMCP tool is an entry of the composite tool table; the native gateways follow. Its result is
      // awaited here, so its refusal reaches the audit below like every other.
      const composite = compositeTool(this.compositeTools, tool);
      if (composite) return await composite.run({input, actor, tool, requestId, start, call});
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
          ...accessSetAudit(actor),
          input: auditedInput(tool, input),
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
      // The provider's reader of this usage kind (src/provider-workflows.ts: Google's image links, Snapchat's Top
      // Snaps, Meta's scalar references).
      reader = assetUsageReader(usageKind(asset));
    if (reader) return reader(this.workflowContext(), actor, input, call);
    throw unqualifiedUsage(asset);
  }
  /** The state of an execute's idempotency claim after the call (MCP-07): none when nothing was claimed or it was released. */
  private writeClaim(
    actor: Actor,
    input: JsonObject,
  ): 'none' | 'pending' | 'uncertain' | 'complete' | 'rejected' | undefined {
    if (input?.action !== 'execute') return undefined;
    const key = input.idempotency_key ?? input.review_id;
    if (typeof key !== 'string' || !key) return undefined;
    try {
      const row = this.store.db
        .prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, key) as {state?: string} | undefined;
      if (!row) return 'none';
      return ['pending', 'uncertain', 'complete', 'rejected'].includes(String(row.state))
        ? (row.state as 'pending' | 'uncertain' | 'complete' | 'rejected')
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
  /** The timing category a composite tool declares; every native gateway and any other name is native_other. */
  private timingCategory(tool: string): ServiceTimingCategory {
    return compositeTool(this.compositeTools, tool)?.category ?? 'native_other';
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
    // A first-party tool's own help (action:"help") is AMCP's text, read locally: it is no workflow step and holds no
    // provider content (F-L3-09). Help is answered before any handler, so no other result carries this action.
    const ownHelp = action === 'help';
    // A media review that amcp_write prepared or executed is no write review: it keeps no write workflow (WRT-08).
    const workflow = ownHelp
      ? undefined
      : workflowOutcome(
          tool === writeTool.name && this.mediaResults.has(data as JsonObject) ? undefined : tool,
          data as JsonObject,
          action,
        );
    if (workflow) {
      if (workflow.next_call && !this.listed(workflow.next_call.tool)) delete workflow.next_call;
      const path = workflow.website_path;
      if (this.websiteOrigin && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'))
        workflow.website_url = new URL(path, this.websiteOrigin).href;
      meta.workflow = workflow;
    }
    // Everything under data may be provider text; meta, and any error message, remedy or next step, are AMCP's own.
    if (tool && !ownHelp && carriesProviderContent(tool)) {
      meta.untrusted_provider_content = untrustedProviderContent;
      meta.untrusted_paths = ['data'];
    }
    return {success: true, data, meta};
  }
  /** Prepare inputs being tried whole before any split (see reviewed). */
  private ungrouped = new WeakSet<JsonObject>();
  /** Inputs a first-party workflow sent on the person's behalf, and the parts a group prepares (WRT-08 origin). */
  private nested = new WeakSet<JsonObject>();
  private groupParts = new WeakSet<JsonObject>();
  private mediaResults = new WeakSet<JsonObject>();
  private media_(result: unknown): unknown {
    if (result && typeof result === 'object') this.mediaResults.add(result as JsonObject);
    return result;
  }
  private origin(input: JsonObject): WriteOrigin {
    return this.nested.has(input) ? 'plan' : this.groupParts.has(input) ? 'group_part' : 'standalone';
  }
  private writeGroups() {
    return new WriteGroups(
      this.store,
      (input, actor) => {
        if (input.action === 'prepare') this.groupParts.add(input);
        return this.reviewed(input, actor);
      },
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
  /** A planned media step checked against its original and cached fitted copy without preparing it (MED-03 C). */
  plannedMedia(actor: Actor, input: JsonObject) {
    return this.media().plannedMedia(actor, input);
  }
  private connectionId(input: JsonObject, outer?: string) {
    const ids = [outer, input.connection_id, input.connectionId].filter(v => v !== undefined);
    if (ids.some(v => typeof v !== 'string' || v !== ids[0]))
      throw new MirrorError('CONFLICTING_PARAMETER', 'Connection ID aliases must identify the same connection.');
    return ids[0];
  }
  /** Whether a retained amcp_write review of this workspace is a provider report or export job (RPT-06). */
  private providerJobReview(actor: Actor, reviewId: unknown): boolean {
    if (typeof reviewId !== 'string') return false;
    const row = this.store.db
      .prepare("SELECT json_extract(data,'$.plan') AS plan FROM documents WHERE tenant_id=? AND kind=? AND id=?")
      .get(actor.tenantId, 'write_review', reviewId) as {plan: string | null} | undefined;
    return !!row?.plan && reviewedProviderJob(JSON.parse(row.plan) as CompiledRequest);
  }
  private async reviewed(input: JsonObject, actor: Actor): Promise<unknown> {
    // Who may change anything is decided before the payload is checked (MCP-09): a read-only deployment or a read-only
    // client learns that first, instead of after correcting arguments that could never run. Under the owner's
    // provider-job switch (RPT-06) a reader or a read-only deployment may still prepare and execute a report or export
    // job: a prepare is decided per compiled request (WriteReviewService.access) before any state is read, and an
    // execute here only when its retained review is a provider job.
    if (
      (input.action === 'prepare' || input.action === 'execute') &&
      !(
        this.policy.providerJobs === true &&
        (input.action === 'prepare' || this.providerJobReview(actor, input.review_id))
      )
    ) {
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
      return this.media_(await this.media().call(input, actor));
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
        if (groupLimitRefusal(e)) return groups.prepare(input, actor, this.origin(input));
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
        return this.media_(
          mediaNext(await this.media().call(workflowMediaInput(args.arguments, input.connection_id), actor)),
        );
      if (this.registry.tools.get(input.gateway)?.mode !== 'delegated') {
        const plan = this.compiler.compile(input.gateway, args, this.options),
          media = nativeMediaInput(plan, this.connectionId(args, input.connection_id));
        if (media) return this.media_(mediaNext(await this.media().call(media, actor)));
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
    ).call(
      input,
      actor,
      gateway ? this.contractMemory.form(session, gateway) : undefined,
      this.origin(input),
    )) as JsonObject;
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
    // The providers' steps of a native read are src/provider-workflows.ts's, at the points where this read named them.
    const wantedIds = nativeReadSteps.wanted(plan, input);
    if (input.connection_id && input.connectionId && input.connection_id !== input.connectionId)
      throw new MirrorError(
        'CONFLICTING_PARAMETER',
        'Connection ID aliases must identify the same connection.',
        {},
        403,
      );
    plan = applyExecutionRisk(plan);
    // Each provider's request checks: Google's draft generation, DV360's targeting search, Snapchat's by-ID reads, X's
    // audience estimate (one complete read with its deadline), Business Profile's place-action discovery.
    plan = nativeReadSteps.prepare(plan, input);
    // ARC-04 stage F: an asynchronous report job's read refuses arguments it does not take (src/report-jobs.ts).
    const job = reportJob(plan.gateway);
    if (job?.admit) plan = job.admit(plan, input);
    nativeReadSteps.admitted(plan, input);
    if (input.dry_run === true || (!plan.readOnly && input.dry_run !== false)) {
      // Access limited to a client access set prepares nothing for an account outside it, not even a dry run (SEC-08).
      if (actor.accessSetId !== undefined && plan.accountId)
        this.store.resolveConnection(actor, plan.gateway, plan.accountId, input.connection_id ?? input.connectionId);
      const result = {success: true, dry_run: true, action: plan.action, request: plan, executed: false};
      this.store.appendAudit(actor.tenantId, requestId, {
        event: 'preview',
        ...accessSetAudit(actor),
        request: plan,
        outcome: 'not_executed',
      });
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
    plan = nativeReadSteps.scoped(plan, scopedId);
    const credentials = await this.credentials.get(connection);
    this.store.appendAudit(actor.tenantId, requestId, {
      event: 'request_started',
      actor: actor.userId,
      ...accessSetAudit(actor),
      request: plan,
    });
    try {
      // A report job's read keeps its login from the first request to the last (Criteo, TikTok and X).
      const reportAccess = (p: CompiledRequest) => {
        if (reportJob(p.gateway)?.sameLogin?.(p)) {
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
        nativeReadSteps.received(p, data, status, activeAccount);
        this.delegatedCompiler.validateResponse(p, data, status);
        // The providers' response contracts, and the data a provider's read returns instead of the page (Reddit's
        // account history without people, PRV-07; Business Profile's place actions).
        const provided = nativeReadSteps.page(p, result);
        if (provided) return provided.data;
        // ARC-04 stage F: a page of an asynchronous report job's read is the job's (src/report-jobs.ts): its status or
        // result with what it retains, before the scope observes the page, or a downloaded report after it does.
        const pageJob = reportJob(p.gateway),
          page: ReportJobPage | undefined = pageJob && {
            store: this.store,
            actor,
            connection: active,
            credentials,
            result,
            authorize: (q, c) => new ScopeGuard(this.registry, this.store).authorize(q, c),
            authority: (q, c, before) => nativeAuthority(this.store, this.registry, actor, q, c, credentials, before),
            request: (q, authority) =>
              this.transport.request(q, authority(), credentials, undefined, {beforeAttempt: authority}),
            fetcher: this.mediaFetcher === fetch ? undefined : this.mediaFetcher,
          };
        const jobData = page && pageJob!.page?.(p, page);
        if (jobData) return jobData;
        scope.observe(p, active, data);
        const downloaded = page && pageJob!.observed?.(p, data, page);
        if (downloaded) return downloaded;
        // PRV-05: an MCP caller receives 64-bit integers exactly; every check above saw the provider's JSON numbers.
        return exactIntegerScope.getStore()?.active ? (result.exactData ?? data) : data;
      };
      // A report job's read runs as its job reads it (TikTok and Criteo: an output fenced by two status reads; Meta:
      // bounded result pages). A job answers only its own gateway's reads, so at most one runner applies to a plan:
      // a read its provider runs before any job (X's audience estimate), the job's, then one its provider runs when
      // no job does (Business Profile's place actions, DV360's targeting search).
      const first = nativeReadSteps.first(plan, fetchPage),
        jobRead = first ? undefined : job?.read?.(plan, fetchPage, input),
        own = first || jobRead ? undefined : nativeReadSteps.own(plan, fetchPage, input, connection.id);
      const result = first
        ? await first
        : jobRead
          ? await jobRead
          : own
            ? await own
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
        legacyLimit = nativeReadSteps.disclosed(plan, result.data, input, call => {
          this.registry.validate(plan.gateway, call, this.options);
          return this.compiler.compile(plan.gateway, call, this.options);
        });
      const kept = wantedIds ? nativeReadSteps.keep(result.data, wantedIds, result.pages, result.truncated) : undefined;
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
      const generation = nativeReadSteps.produced(plan, result.data);
      // Secrets in provider URLs (paging links, permalinks) never reach the caller; other provider text stays verbatim.
      const scrubbed = redactUrlSecrets(
        projected.data,
        new Set([...signedLinkFields, ...(providerHooks(plan.gateway)?.signedLinkFields?.(plan) ?? [])]),
      );
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
        ...accessSetAudit(actor),
        request: plan,
        outcome:
          (plan.reportDownload && plan.xReportRead) || plan.tiktokReportRead?.kind === 'download'
            ? {success: true, action: plan.action, report: (result.data as JsonObject).report, rows_omitted: true}
            : auditedRead(outcome),
      });
      return outcome;
    } catch (e) {
      e = nativeReadSteps.safeError(plan, e);
      this.store.appendAudit(actor.tenantId, requestId, {
        event: 'request_failed',
        ...accessSetAudit(actor),
        request: plan,
        error:
          e instanceof MirrorError ? {code: e.code, message: e.message, details: e.details} : {code: 'INTERNAL_ERROR'},
      });
      throw e;
    }
  }
  private async delegated(
    gateway: string,
    operation: string,
    args: JsonObject,
    actor: Actor,
    requestId: string,
  ): Promise<unknown> {
    // A provider workflow answers its tool's operation at its stage among these steps (src/provider-workflows.ts):
    // before the connection disconnect and diagnostics (WooCommerce's store listing, Adjust's reporting, GA4's, Search
    // Console's and Business Profile's sync), after them (Meta's Ad Library and existing posts), or after the Drive
    // inspection and the platform upload (Tag Manager's diagnostics).
    const workflow = (stage: DispatchStage) => {
      const answer = providerWorkflow(stage, gateway, operation, args.action);
      return answer && (() => answer.run(this.workflowContext(), {gateway, operation, args, actor, requestId}));
    };
    const beforeConnection = workflow('before_connection');
    if (beforeConnection) return beforeConnection();
    if (connectionDisconnectKind(gateway, operation, args.action))
      return connectionDisconnect(this.store, gateway, operation, args, actor);
    if (connectionDiagnosticKind(gateway, operation, args.action))
      return connectionDiagnostics(this.store, gateway, operation, args, actor, this.policy.allowWrites);
    const afterConnection = workflow('after_connection');
    if (afterConnection) return afterConnection();
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
    const afterMedia = workflow('after_media');
    if (afterMedia) return afterMedia();
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
      const connections = this.store.connectionsFor(actor).filter(c => c.enabled);
      if (operation === 'get_workspace_context')
        return {
          workspace: {id: actor.tenantId},
          actor: {id: actor.userId, role: actor.role},
          // Access limited to a client access set says so, with its name (SEC-08); the connections below are narrowed.
          ...(actor.accessSetId !== undefined ? {access_set: accessSetView(this.store, actor)} : {}),
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
      // A client access set lists only the assets of accounts it reaches (SEC-08); other access lists them all, as before.
      return assetsWithinAccess(this.store, actor, this.store.documents(actor.tenantId, 'workspace_asset'));
    }
    // Under a client access set only the set's own jobs are found by ID (SEC-08); elsewhere any job, as before.
    if (operation === 'get_creative_generation_job') return this.store.jobFor(actor, String(args.job_id));
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
