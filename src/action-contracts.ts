import {Registry} from './catalog.js';
import {withheldWriteProgramId, withheldWriteReason} from './withheld-writes.js';
import {connectionDiagnosticKind, businessQandaRetirement} from './connection-diagnostics.js';
import {connectionDisconnectKind} from './connection-disconnect.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {businessWorkflowOperations} from './workflows.js';
import {reportingOperations} from './reporting.js';
import {bodyDeletionValues, independentlyReadOnly} from './execution-risk.js';
import {qualifiedProviderRead} from './provider-read-contracts.js';
import {reviewedWriteFamily} from './reviewed-routes.js';
import {mediaRoute} from './media-routing.js';
import {providerContracts} from './provider-contracts.js';
import {MirrorError} from './errors.js';
import {assertGatewayOffered, gatewayOffered} from './provider-offering.js';
import {retiredProviderAction, unsupportedProviderAlias} from './retired-provider-actions.js';
import type {Action, CompiledRequest, JsonObject} from './types.js';
import type {ContractLegacy} from './provider-adapter.js';
import {reviewedFamilyFiles} from './reviewed-families.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import {providerWorkflows, type ContractStage} from './provider-workflows.js';
import {personalDataRead, personalDataReadReason} from './personal-data.js';
import {
  acceptanceLayers,
  acceptanceMeaning,
  contractAcceptance,
  liveQualification,
  type ContractAcceptance,
  type LiveQualification,
} from './acceptance-ledger.js';
import {
  recordedRouteAnchor,
  routeAnchorPageMeaning,
  routeAnchorSources,
  type AnchorStatus,
  type RouteAnchor,
} from './route-anchors.js';

export type ContractStatus =
  | 'native_read'
  | 'reviewed_write_family'
  | 'media_workflow'
  | 'local_workflow'
  | 'adapter_requires_input'
  | 'blocked_write'
  | 'unmapped'
  | 'unqualified_read'
  | 'provider_unsupported';
export interface ActionContract {
  gateway: string;
  operation?: string;
  action: string;
  aliases: string[];
  method: string | null;
  path: string | null;
  origin?: string;
  status: ContractStatus;
  family?: string;
  /**
   * The family that alone claims the deleting bodies of a route another family owns (r25-m4-smartdelete: tiktok_smart_plus_deletions claims
   * operation_status: DELETE on the three Smart+ status routes, which stay tiktok_smart_plus_status's for every other body). Present only then;
   * `implementation` and `tests` name both families' files.
   */
  deletion_family?: string;
  implementation: string;
  reason: string;
  source: string;
  tests: string[];
  /** unverified unless the provider acceptance ledger accepted this action's current contract (ACC-05). */
  live_qualification: LiveQualification;
  /** Present when the ledger has a row for this action (accepted, refused or stale); absent means unverified. */
  acceptance?: ContractAcceptance;
  /** A blocked write that waits on a provider program names its discovery-only entry (ACC-05). */
  program_id?: string;
  /** What the route's method and path rest on (ARC-03, generated/route-anchors.json); advisory, never permission. */
  anchor_status?: AnchorStatus;
  /** The anchoring document, SDK request or dated page, or the capture file and the reason nothing else anchors it. */
  anchor?: RouteAnchor;
}
const familyFiles: Record<string, [string, string[]]> = {
  google_entities: ['src/write-review.ts', ['tests/write-review.test.ts', 'tests/review-envelopes.test.ts']],
  meta_entities: ['src/write-review.ts', ['tests/meta-provision.test.ts']],
  tiktok_entities: [
    'src/write-review.ts',
    [
      'tests/write-platforms.test.ts',
      'tests/tiktok-verification.test.ts',
      'tests/tiktok-adgroup-conversions.test.mjs',
      'tests/tiktok-manual-ad-identities.test.mjs',
      'tests/tiktok-ad-update-native.test.mjs',
      'tests/tiktok-manual-cutoff.test.mjs',
      'tests/tiktok-search-recipe.test.mjs',
      'tests/tiktok-serving-parent-children.test.mjs',
      'tests/tiktok-smart-plus-reconcile.test.mjs',
    ],
  ],
  snapchat_entities: [
    'src/write-review.ts',
    [
      'tests/snapchat-writes.test.ts',
      'tests/snapchat-lead-forms.test.mjs',
      'tests/snapchat-segments.test.mjs',
      'tests/snapchat-creative-references.test.mjs',
    ],
  ],
  linkedin_entities: ['src/write-review.ts', ['tests/write-platforms.test.ts']],
  x_entities: ['src/write-review.ts', ['tests/x-targeting-writes.test.ts', 'tests/write-platforms.test.ts']],
  dv360_entities: ['src/write-review.ts', ['tests/write-platforms.test.ts']],
};
const localReads = new Set([
  'get_workspace_context',
  'list_accounts',
  'list_workspace_assets',
  'get_creative_generation_job',
  'inspect_google_drive_media',
  'search_ads_library',
]);
const cache = new WeakMap<Registry, ActionContract[]>();
function concrete(template: string, parameters: JsonObject = {}): string {
  return template.replace(/\{\+?([^{}=]+)(?:=([^{}]+))?\}/g, (_m, key: string, pattern: string | undefined) => {
    const shape = pattern ?? parameters[key]?.pattern;
    return shape && shape !== '*'
      ? shape
          .replace(/^\^|\$/g, '')
          .replaceAll('[^/]+', '123')
          .replaceAll('[^/]*', '123')
          .replaceAll('**', '123')
          .replaceAll('*', '123')
      : '123';
  });
}
function classify(
  gateway: string,
  action: string,
  method: string | null,
  path: string | null,
  readOnly: boolean | null,
  source: string,
  aliases: string[] = [],
  operation?: string,
  origin?: string,
  specialTransport?: string,
  parameters: JsonObject = {},
  executionAction = action,
): ActionContract {
  const provider = providerContracts.find(c => c.gateway === gateway),
    result: ActionContract = {
      gateway,
      ...(operation ? {operation} : {}),
      action,
      aliases,
      method,
      path,
      ...(origin ? {origin} : {}),
      status: 'unmapped',
      implementation: '',
      reason: 'No provider request mapping exists. The advertised name is not executable.',
      source,
      tests: [],
      live_qualification: 'unverified',
    };
  const unavailable = unsupportedProviderAlias(gateway, action);
  if (unavailable)
    return {
      ...result,
      status: 'provider_unsupported',
      implementation: 'src/retired-provider-actions.ts',
      reason: unavailable.reason + ' ' + unavailable.replacement,
      source: unavailable.source,
      tests: ['tests/provider-unavailable-actions.test.mjs'],
    };
  if (!method || !path) return result;
  const absolute = path.startsWith('https://') ? new URL(concrete(path, parameters)) : undefined,
    relative = absolute?.pathname ?? concrete(path.split('?')[0]!, parameters);
  const p: CompiledRequest = {
    gateway,
    action: operation ? operation + (executionAction !== operation ? '/' + executionAction : '') : executionAction,
    method,
    path: relative,
    origin: origin ?? absolute?.origin,
    query: Object.fromEntries(
      new URLSearchParams((absolute?.search ?? path.split('?')[1] ?? '').replaceAll('{action}', 'initializeUpload')),
    ),
    body: ['GET', 'HEAD'].includes(method) ? undefined : {},
    headers: {},
    readOnly: readOnly === true,
    destructive: method === 'DELETE',
    requiresConfirmation: false,
    accountId: '123',
    evidence: source,
    warnings: [],
    specialTransport,
  };
  result.origin = p.origin;
  const retired = retiredProviderAction(p);
  if (retired) {
    return {
      ...result,
      status: 'provider_unsupported',
      implementation: 'src/retired-provider-actions.ts',
      reason:
        'The provider documents this method as no longer supported. Retained in the denominator; no replacement API is invented.',
      source: retired.source,
      tests: ['tests/retired-provider-actions.test.ts'],
    };
  }
  if (independentlyReadOnly(p)) {
    result.status = 'native_read';
    result.implementation = 'src/compiler.ts / src/delegated-native.ts / src/transport.ts';
    result.reason =
      'A mapped route passes independent read classification. Exact scope, payload, pagination and account/provider access still require verification.';
    result.tests = provider?.tests ?? [];
    if (qualifiedProviderRead(p)) {
      result.implementation += ' / src/provider-read-contracts.ts';
      result.tests = [...result.tests, 'tests/provider-read-contracts.test.ts'];
      result.reason +=
        ' Documented fixed GET semantics override ambiguous resource names; Business/Catalog/member resources still require exact administrator bindings.';
    }
    // What a native read of the provider's own adds, from its adapter's contract hooks (DV360's targeting search, X's
    // audience estimate and report status, TikTok's report tasks, Google's draft generation), in their order.
    for (const note of providerHooks(p.gateway)?.contracts?.readNotes?.(p) ?? []) {
      result.implementation += ' / ' + note.implementation;
      result.tests = note.once ? [...new Set([...result.tests, note.test])] : [...result.tests, note.test];
      result.reason += ' ' + note.reason;
    }
    return result;
  }
  const family = reviewedWriteFamily({...p, readOnly: false});
  if (family) {
    result.status = 'reviewed_write_family';
    result.family = family;
    [result.implementation, result.tests] = familyFiles[family] ?? reviewedFamilyFiles(family)!;
    const deletion = deletionFamily(p, family);
    if (deletion) {
      const [implementation, tests] = familyFiles[deletion] ?? reviewedFamilyFiles(deletion)!;
      result.deletion_family = deletion;
      result.implementation += ' / ' + implementation;
      result.tests = [...new Set([...result.tests, ...tests])];
    }
    result.reason =
      'Route belongs to a reviewed family. Only amcp_write inspect with the exact payload can establish request support; family fixtures do not test every field or variant.';
    return result;
  }
  const media = mediaRoute(p);
  if (media) {
    result.status = 'media_workflow';
    result.implementation = 'src/media-upload.ts';
    result.tests = ['tests/media-upload.test.ts'];
    result.reason =
      'Use amcp_media or the native Drive import bridge. Raw native upload variants are not thereby enabled.';
    return result;
  }
  // A raw step of a workflow amcp_media performs itself has no upload of AMCP's to continue, so it stays refused; the
  // ledger names the workflow that performs it (the provider's contract hooks: Snapchat's chunked upload, F-58).
  const step = providerHooks(p.gateway)?.contracts?.mediaStep?.(p);
  if (step) {
    result.status = 'media_workflow';
    result.implementation = 'src/media-upload.ts';
    result.tests = ['tests/media-upload.test.ts'];
    result.reason = step;
    return result;
  }
  if (readOnly === true && personalDataRead(p))
    return {
      ...result,
      status: 'unqualified_read',
      implementation: 'src/personal-data.ts',
      reason: personalDataReadReason,
      tests: ['tests/native-read-data-guards.test.ts'],
    };
  result.status = readOnly === true ? 'unqualified_read' : 'blocked_write';
  result.implementation = 'src/reviewed-routes.ts';
  const withheld = readOnly === true ? undefined : withheldWriteReason(p.gateway, p.action);
  if (withheld) {
    result.reason = withheld;
    // The discovery-only program this write waits on, when it waits on one (ACC-05).
    const program = withheldWriteProgramId(p.gateway, p.action);
    if (program) result.program_id = program;
    return result;
  }
  result.reason =
    readOnly === true
      ? 'Captured read metadata did not pass independent read-only classification. This route cannot execute without a specific risk contract.'
      : 'Mapping exists, but there is no reviewed write family. Add exact scope, prerequisites, state projection, spending rules, receipt, recovery and negative tests before execution.';
  return result;
}
/**
 * The ledger classifies a route by an empty body, so a family that owns only the deleting bodies of a route would own none. Each deletion value the
 * route's gateway declares (bodyDeletionValues, src/execution-risk.ts, the table the deletion policy reads) is probed as a body, and the family that
 * claims it, when it is not the route's own, is the route's deletion family. familyOf refuses a body that two families claim, so a double claim fails here.
 */
function deletionFamily(p: CompiledRequest, family: string): string | undefined {
  for (const [field, values] of Object.entries(bodyDeletionValues[p.gateway]?.fields ?? {}))
    for (const value of values) {
      const claimed = reviewedWriteFamily({...p, readOnly: false, body: {[field]: value}});
      if (claimed && claimed !== family) return claimed;
    }
  return undefined;
}
/** Enumerates every captured action AND every delegated action enum. Unknown
 * provider denominators remain unknown. No catalog row grants permission. */
export function actionContracts(registry: Registry): ActionContract[] {
  const saved = cache.get(registry);
  if (saved) return saved;
  const records = new Map<string, ActionContract>(),
    vendor = new DelegatedNativeCompiler(),
    // A provider's own delegated routes beside the snapshot's (its delegated hooks: Reddit's audience and read routes).
    vendorRoutes = [...vendor.data.routes, ...registeredProviderHooks.flatMap(h => h.delegated?.routes?.list() ?? [])],
    // Each provider's catalogued actions without a route of their own (its contract hooks: Google Ads' legacy actions).
    legacy = new Map<string, ContractLegacy>();
  for (const {gateway, contracts} of registeredProviderHooks) {
    const adapted = contracts?.legacy?.(registry);
    if (adapted) legacy.set(gateway, adapted);
  }
  const put = (row: ActionContract) => records.set([row.gateway, row.operation ?? '', row.action].join('/'), row);
  const direct = (gateway: string, a: Action) => {
    let route = registry.action(gateway, a.name) ?? a,
      source = route.evidence;
    if (!route.path) route = registry.data.supplemental.find(s => s.gateway === gateway && s.name === a.name) ?? route;
    const adapter = legacy.get(gateway);
    if (adapter && !route.path) ({route, source} = adapter.route(a, route, source));
    // The compiler executes canonical names; classify that same identity while
    // retaining every advertised alias as its own denominator row.
    // Google legacy adapters deliberately retain the legacy name for immutable
    // operation restrictions even when they route to a general mutate RPC.
    const executionAction = adapter && !a.path ? a.name : route.canonical_name || route.name;
    const row = classify(
      gateway,
      a.name,
      route.method,
      route.path,
      route.read_only,
      source,
      [...new Set([a.canonical_name, ...a.aliases])].filter(n => n !== a.name),
      undefined,
      undefined,
      route.raw.special_transport,
      {},
      executionAction,
    );
    // An explicit adapter whose route depends on the request has the adapter's row (Google Ads' legacy actions).
    if (adapter && !route.path && adapter.adapted(a))
      Object.assign(row, {...adapter.row, tests: [...adapter.row.tests]});
    put(row);
  };
  for (const catalog of registry.catalogs.values())
    if (catalog.mode === 'direct') for (const a of catalog.actions) direct(catalog.gateway, a);
  for (const a of registry.data.supplemental)
    if (registry.tools.get(a.gateway!)?.mode === 'direct' && !records.has(a.gateway + '//' + a.name))
      direct(a.gateway!, a);
  // The actions providers document beyond the captured catalog (their catalog hooks): those that extend a captured
  // catalog where the registry holds it (Meta's rule update and delete, Google's Data Manager), a tool's own whatever
  // it holds (Apple's v1 actions). Each provider's rows are its own gateway's, so their order between providers does
  // not matter (the rows are sorted below).
  for (const {gateway, catalog} of registeredProviderHooks) {
    const extra = catalog?.supplemental;
    if (extra && (extra.requires === 'tool' || registry.catalogs.has(gateway)))
      for (const a of extra.actions) direct(gateway, a);
  }
  // The row a provider workflow sets at one of the ledger's stages (src/provider-workflows.ts), else the row so far.
  const workflowRow = (stage: ContractStage, tool: string, operation: string, action: string, row: ActionContract) => {
    for (const {tool: owner, contract} of providerWorkflows)
      if (owner === tool && contract?.stage === stage && contract.listed(operation, action, row))
        row = {...row, ...contract.row, tests: [...contract.row.tests]};
    return row;
  };
  for (const tool of registry.tools.values())
    if (tool.mode === 'delegated')
      for (const op of tool.operations ?? []) {
        const choices = op.argumentsSchema.properties?.action?.enum ?? [op.operation];
        for (const action of choices) {
          const route = vendorRoutes.find(
            r =>
              r.gateway === tool.name &&
              r.operation === op.operation &&
              (r.action === action || (!r.action && action === op.operation)),
          );
          let row = classify(
            tool.name,
            action,
            route?.method ?? null,
            route?.path ?? null,
            route?.readOnly ?? null,
            route?.source ?? tool.schema_evidence,
            [],
            op.operation,
            route?.origin,
            route?.unsupportedMedia?.length ? 'vendor_media' : undefined,
            route?.parameters,
          );
          if (
            !route &&
            (tool.name === 'amcp_platform_workspace' ||
              (tool.name === 'amcp_native_action' &&
                (localReads.has(op.operation) ||
                  reportingOperations.has(op.operation) ||
                  businessWorkflowOperations.has(op.operation) ||
                  op.operation === 'platform_media_upload')))
          ) {
            row = {
              ...row,
              status: 'local_workflow',
              implementation: 'src/service.ts / src/workflows.ts / src/reporting.ts',
              reason:
                'Implemented AMCP workflow; platform and payload support depend on its underlying contracts. This row never enables native writes.',
              tests: ['tests/workflows.test.ts'],
            };
          }
          // A provider workflow's row (WooCommerce's store listing, Tag Manager's diagnostics), before the diagnostics.
          row = workflowRow('before_diagnostics', tool.name, op.operation, action, row);
          const diagnostic = connectionDiagnosticKind(tool.name, op.operation, action);
          if (diagnostic)
            row = {
              ...row,
              status: 'local_workflow',
              implementation: 'src/connection-diagnostics.ts',
              reason:
                diagnostic === 'qanda'
                  ? 'Implemented local retirement-status diagnostic. Google discontinued Q&A on 2025-11-03; no Q&A provider request or replacement API is available.'
                  : 'Read-only tenant-scoped connection metadata with explicit/default identity resolution; no credential access, provider request or implicit connection/grant changes. Recorded configuration is not live readiness.',
              ...(diagnostic === 'qanda' ? {source: businessQandaRetirement.source} : {}),
              tests: ['tests/connection-diagnostics.test.ts'],
            };
          // A provider workflow's row (GA4's and Search Console's sync, Business Profile's sync, Adjust's reporting,
          // Meta's Ad Library and existing posts), before the disconnect rule.
          row = workflowRow('before_disconnect', tool.name, op.operation, action, row);
          if (connectionDisconnectKind(tool.name, op.operation, action))
            row = {
              ...row,
              status: 'local_workflow',
              implementation: 'src/connection-disconnect.ts',
              reason:
                'Administrator-only explicit-UUID local disconnect, with dry-run default. Atomically removes the encrypted credential row, resource bindings and discovery metadata while retaining recovery history. No provider calls or grant revocation; default selection never chooses the identity.',
              tests: ['tests/connection-disconnect.test.ts'],
            };
          // A provider's native read whose row names its contract (Business Profile's place-action discovery), last.
          row = workflowRow('after_disconnect', tool.name, op.operation, action, row);
          put(row);
        }
      }
  // Include independent delegated extensions and vendor mappings even when a
  // wrapper action enum is incomplete. They have their own provenance.
  for (const r of vendorRoutes)
    if (
      registry.tools.get(r.gateway)?.mode === 'delegated' &&
      !records.has([r.gateway, r.operation, r.action || r.operation].join('/'))
    )
      put(
        classify(
          r.gateway,
          r.action || r.operation,
          r.method,
          r.path,
          r.readOnly,
          r.source,
          [],
          r.operation,
          r.origin,
          r.unsupportedMedia?.length ? 'vendor_media' : undefined,
          r.parameters,
        ),
      );
  const rows = [...records.values()].sort((a, b) =>
    [a.gateway, a.operation ?? '', a.action]
      .join('/')
      .localeCompare([b.gateway, b.operation ?? '', b.action].join('/'), 'en'),
  );
  // Live qualification is the provider acceptance ledger's to state, and only for the current contract (ACC-05).
  for (const row of rows) {
    const acceptance = contractAcceptance(row);
    row.live_qualification = liveQualification(acceptance);
    if (acceptance.status !== 'unverified') row.acceptance = acceptance;
    // The route anchor recorded for this row (ARC-03): evidence about its method and path, never a permission.
    Object.assign(row, recordedRouteAnchor(row));
  }
  cache.set(registry, rows);
  return rows;
}
export function actionContractSummary(registry: Registry) {
  const rows = actionContracts(registry);
  return [...new Set([...registry.catalogs.keys(), ...rows.map(r => r.gateway)])].sort().map(gateway => ({
    gateway,
    actions: rows.filter(r => r.gateway === gateway).length,
    counts: Object.fromEntries(
      [...new Set(rows.filter(r => r.gateway === gateway).map(r => r.status))]
        .sort()
        .map(status => [status, rows.filter(r => r.gateway === gateway && r.status === status).length]),
    ),
    captured_catalog_complete: registry.catalogs.get(gateway)?.complete ?? false,
    provider_api_coverage: 'unknown',
    live_qualification: 'unverified',
  }));
}
export function actionContractPage(registry: Registry, input: JsonObject) {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200))
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Contract inventory uses offset >= 0, limit 1–100 and search up to 200 characters.',
    );
  // A provider this deployment does not offer is neither listed nor searchable here (CON-06, src/provider-offering.ts).
  const summary = actionContractSummary(registry).filter(s => gatewayOffered(s.gateway));
  if (input.gateway !== undefined) assertGatewayOffered(input.gateway);
  if (input.gateway !== undefined && !registry.tools.has(input.gateway))
    throw new MirrorError(
      'UNKNOWN_GATEWAY',
      'gateway ' +
        JSON.stringify(String(input.gateway)) +
        ' is not a gateway. Gateways: ' +
        summary.map(s => s.gateway).join(', ') +
        '.',
      {field: 'gateway', allowed: summary.map(s => s.gateway)},
    );
  const needle = String(input.search ?? '').toLowerCase(),
    rows = actionContracts(registry).filter(
      r =>
        gatewayOffered(r.gateway) &&
        (!input.gateway || r.gateway === input.gateway) &&
        (!needle || [r.action, r.operation, r.path, r.status, ...r.aliases].join(' ').toLowerCase().includes(needle)),
    );
  const shown = rows.slice(offset, offset + limit);
  return {
    network_requests: 0,
    // A page filtered to one gateway summarises that gateway only (Snapchat S10: about 6 KB of every gateway before).
    summary: input.gateway ? summary.filter(s => s.gateway === input.gateway) : summary,
    total: rows.length,
    offset,
    limit,
    has_more: offset + limit < rows.length,
    // The paging fields every AMCP list carries (MCP-07): the offset of the next page while has_more is true.
    next_offset: offset + limit < rows.length ? offset + limit : null,
    // Every row states its acceptance {status, scope, checked_at}; the layers count the whole filtered set (ACC-05).
    actions: shown.map(r => ({...r, acceptance: r.acceptance ?? {status: 'unverified' as const}})),
    acceptance_layers: acceptanceLayers(rows),
    acceptance_meaning: acceptanceMeaning,
    // Each row's anchor_status and anchor (ARC-03), and the pinned documents and SDKs the shown rows name.
    anchor_meaning: routeAnchorPageMeaning,
    anchor_sources: routeAnchorSources(shown),
    meaning:
      'Complete local action/enum inventory, not complete vendor API coverage or live qualification. Route membership is conditional on exact-payload inspect, permissions, server-read review and provider validation.',
    next_step:
      'amcp_write inspect for a native mutation; amcp_media for uploads. Blocked entries require implementation, not additional user confirmation.',
  };
}
