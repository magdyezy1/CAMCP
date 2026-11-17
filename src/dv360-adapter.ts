import type {
  CompileDraft,
  CompileHooks,
  ContractHooks,
  ContractNote,
  ExpectState,
  ProviderHooks,
  ProviderVerificationRead,
  StateTarget,
} from './provider-adapter.js';
import {sameNativeAccount} from './account-id.js';
import type {CompiledRequest, DeclaredOperation, JsonObject} from './types.js';
import {flatResourceTelemetry} from './review-flat-telemetry.js';
import {pickIdentity, readRole} from './review-state-core.js';
import type {TransportResult} from './transport.js';
import type {Registry} from './catalog.js';
import {
  authorizeDV360TargetingSearch,
  dv360TargetingSearchPlan,
  dv360TargetingSearchResult,
  dv360TargetingSearchRoute,
  validateDV360TargetingSearch,
} from './dv360-targeting-search.js';
import {authorizeDV360AudienceRead, dv360AudienceRead} from './dv360-audiences.js';
// Writes and campaigns (wave 4c).
import type {MutationResponse} from './provider-adapter.js';
import {extendDV360Tool} from './dv360-extensions.js';
// Wave 4c round 6 (w4c-arc6-tables).
import {deepFrozen} from './frozen-facts.js';
// Wave 4c round 6 (w4c-arc6-catalog).
import {dv360ConditionalPrograms} from './dv360-conditional-programs.js';
import {noPreviewRoute} from './ad-preview-kit.js';
import {usageNotExposed} from './provider-usage.js';

/** The ID field of each DV360 resource a state read names. */
const stateIds: Record<string, string> = {
  advertisers: 'advertiserId',
  campaigns: 'campaignId',
  insertionOrders: 'insertionOrderId',
  lineItems: 'lineItemId',
  creatives: 'creativeId',
  adAssets: 'adAssetId',
};

/**
 * R25 M0 (review S3-2, error 11 of the live checks of 2026-11-15): an agent that types an ID as JSON writes the advertiser as a
 * number. The shared alias check already reads such a number as the selected advertiser (it compares IDs as text), but the typed
 * write contracts compare the body's and the query's advertiserId with the selected advertiser as strings, and refused it as an
 * ACCOUNT_SCOPE_MISMATCH that read as a grant problem. The number of the selected advertiser's digits is sent as the string
 * DV360's int64 JSON takes, here, before any review is frozen; sameNativeAccount (src/account-id.ts) decides, and counts only a
 * safe integer. Anything else stays as written, and the contracts refuse it.
 */
function advertiserIdAsString(draft: CompileDraft): undefined {
  const account = draft.accountId;
  if (account === undefined) return undefined;
  const sameNumber = (value: unknown) => typeof value === 'number' && sameNativeAccount(draft.gateway, value, account);
  if (sameNumber(draft.query.advertiserId)) draft.query.advertiserId = account;
  const body = draft.body;
  if (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    sameNumber((body as JsonObject).advertiserId)
  )
    draft.body = {...(body as JsonObject), advertiserId: account};
  return undefined;
}

/**
 * Wave 4c (transport and catalog): DV360's part of the catalog compiler (src/compiler.ts). A request may name its
 * catalog route by resource and RPC; its parameters go in the query whatever the method; the advertiser it names as a
 * number is the string; the targeting search is planned as a reviewed read before the report job's controls.
 */
const dv360Compile: CompileHooks = Object.freeze({
  resourceAction: (registry: Registry, input: JsonObject) =>
    registry.data.supplemental.find(a => a.raw.resource === input.resource && a.raw.rpc === input.method),
  queryParameters: true as const,
  request: advertiserIdAsString,
  beforeJob: dv360TargetingSearchPlan,
});

/** Wave 4c (transport and catalog): what DV360's targeting search adds to its action contract row. */
const targetingSearchNote: ContractNote = Object.freeze({
  implementation: 'src/dv360-targeting-search.ts',
  test: 'tests/dv360-targeting-search.test.ts',
  reason:
    'Native advertiser-scoped POST search for geo regions, POIs and business chains; exact body variants, current scopes, bounded pagination and explicit completeness. It creates no targeting assignments.',
});
const dv360Contracts: ContractHooks = Object.freeze({
  readNotes: (plan: CompiledRequest) => (dv360TargetingSearchRoute(plan) ? [targetingSearchNote] : []),
});

/**
 * What a review keeps of the advertiser a DV360 create is made in (R2.5 M1, L5-01): its IDs and names, its entity status, and
 * the currency and time zone of its general settings. Its billing, serving, creative and data-access configuration, its
 * integration details and its update time are not what a create under it depends on. No source-side field selection is sent
 * for this read (none is used for DV360 anywhere in this repository), so the projection is the narrowing.
 */
const dv360AdvertiserFields: readonly string[] = Object.freeze([
  'advertiserId',
  'partnerId',
  'name',
  'displayName',
  'entityStatus',
  'generalConfig.currencyCode',
  'generalConfig.timeZone',
]);

/**
 * Display & Video 360's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * targeting option search, a POST the catalog marks as a write, is a reviewed read. The account read is the advertiser.
 * On the wire, the targeting search is checked before it is sent and its response after, and the advertiser asset
 * uploads are its multipart/related contracts. Its writes may carry updateMask; a new serving entity starts paused.
 */
export const dv360Hooks: ProviderHooks = Object.freeze({
  gateway: 'dv360_native_action',
  previews: noPreviewRoute('dv360', 'Display & Video 360 has no ad preview route in its API that AMCP can read.'),
  compile: dv360Compile,
  // Wave 4c (transport and catalog): its tool takes the operations AMCP adds to the captured definition.
  catalog: Object.freeze({tools: Object.freeze({dv360_native_action: extendDV360Tool})}),
  contracts: dv360Contracts,
  checks: Object.freeze({
    shape: Object.freeze({
      // A write may carry updateMask, its concurrency parameter; new campaigns, insertion orders and line items start
      // paused or as drafts.
      queryParameter: 'updateMask',
      after(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
        if (
          /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems)$/.test(plan.path) &&
          plan.method === 'POST'
        )
          expect(body, 'entityStatus', ['ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT']);
      },
    }),
    // A resource read returns its ID under the resource's own field.
    state: Object.freeze({
      target: (read: CompiledRequest, _result: TransportResult, data: JsonObject, context: StateTarget) =>
        context.sameIds([data[stateIds[read.path.split('/').at(-2)!]!]], [context.target()]),
    }),
  }),
  review: Object.freeze({
    // Its resources are flat (a record's `updateTime` is `update_time`): the flat-resource names change by themselves.
    volatile: flatResourceTelemetry,
    // The advertiser a create is made in is kept to its identity (R2.5 M1, the ACCOUNT role, L5-01); a read of what a write
    // changes is kept whole, minus the fields of the table above.
    identity: (read: CompiledRequest, d: JsonObject) =>
      readRole(read) === 'account' ? pickIdentity(d, dv360AdvertiserFields) : undefined,
    // A created campaign, insertion order, line item or creative is read back by its returned ID, an update in place.
    verification(
      plan: CompiledRequest,
      result: JsonObject,
      read: (path: string, query?: JsonObject) => CompiledRequest,
    ): ProviderVerificationRead[] {
      const b = (plan.body ?? {}) as JsonObject,
        d = result.data ?? {};
      const id = d.campaignId ?? d.insertionOrderId ?? d.lineItemId ?? d.creativeId;
      if (!id) return [];
      return [{read: read(plan.method === 'POST' ? plan.path + '/' + id : plan.path), expected: b, id: String(id)}];
    },
  }),
  // The targeting option search (a POST) and the audience reads (GETs) of the selected advertiser.
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'dv360_targeting_search',
        stage: 'before_families' as const,
        claims: dv360TargetingSearchRoute,
        authorize: authorizeDV360TargetingSearch,
      }),
      Object.freeze({
        name: 'dv360_audience_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) => dv360AudienceRead(p) !== undefined,
        authorize: authorizeDV360AudienceRead,
      }),
    ]),
  }),
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => dv360TargetingSearchRoute(p),
    postRead: (plan: CompiledRequest) => dv360TargetingSearchRoute(plan),
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/v4/advertisers/' + id;
      return read;
    },
  }),
  wire: Object.freeze({
    // Its APIs send no usage header: the rate governor’s view says "not exposed" (R2.5 M2, MT3; src/provider-usage.ts).
    usage: usageNotExposed,
    validateRoute: validateDV360TargetingSearch,
    relatedUpload: (plan: CompiledRequest) =>
      plan.method === 'POST' &&
      /^\/upload\/v4\/advertisers\/\d+\/(?:assets|adAssets:uploadAdAsset)$/.test(plan.path) &&
      plan.query.uploadType === 'multipart',
    checkResult: (plan: CompiledRequest, data: unknown) => {
      if (dv360TargetingSearchRoute(plan)) dv360TargetingSearchResult(plan, data);
    },
  }),
  // Writes and campaigns (wave 4c): a create on an advertiser reads the advertiser (src/write-snapshots.ts).
  writes: Object.freeze({
    // Its response contract for the one mutation (src/write-outcome.ts).
    confirms: dv360Confirms,
    accountPath: /^\/v\d+\/advertisers\/[^/]+/,
    // A POST to a collection creates a member of it, and a custom method says what it does (R2.5 S2-2).
    operation: dv360Operation,
  }),
  // Wave 4c round 6 (w4c-arc6-versions): what tools/list and amcp_tool_help say of its gateway (src/tool-notes.ts): the
  // captured description with the sentences AMCP does not hold corrected, and the routing summary tools/list shows.
  notes: Object.freeze({
    description: (captured: string) =>
      captured
        .replace('with create_campaign or DV360_', 'with amcp_native_action create_campaign or DV360_')
        .replace(
          'create display/video/audio/Demand Gen or explicit YouTube & Partners line items with create_adset or DV360_',
          'create display/video/audio/Demand Gen line items with amcp_native_action create_adset or DV360_',
        )
        .replace(
          /For YouTube & Partners line item writes, provide the exact lineItemType and bidStrategy\.youtubeAndPartnersBid\. Existing DV360 accounts can return YouTube & Partners line items through read\/list, so MCP does not locally block explicit payloads; Google remains the final authority for account\/type-specific write support\./,
          'YouTube & Partners line items cannot be created or updated through the API, so AMCP refuses those writes; reads still return them.',
        )
        .replace('or the semantic create_creative tool,', 'or amcp_native_action create_creative,')
        .replace(
          /For Bid Manager reports, standard report runs, query runs, report retrieval, or report listing, use dv360_reporting_ops instead of this generic REST tool\./,
          'AMCP has no DV360 reporting: Bid Manager reports, query runs and report retrieval are not available.',
        )
        .replace(/ ?Write actions default to dry_run: true and require confirmed: true when dry_run is false\./, ''),
    summary:
      'Run one Display & Video 360 v4 REST action by name: a canonical DV360_* action such as DV360_ADVERTISERS_LIST, or resource and method (resource=advertisers, method=list); LIST_ACTIONS and DESCRIBE_ACTION find it. Path and query parameters go in params, pathParams or query, request bodies in body or payload. YouTube & Partners line items cannot be created or updated through the API, so AMCP refuses those writes, and AMCP has no DV360 reporting. The campaign flow, targeting and audience search, inventory and creative assignment: amcp_tool_help {gateway:"dv360_native_action"}.',
  }),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them).
  // Bid Manager reporting, which AMCP lists but never checks (src/discovery-programs.ts).
  programs: deepFrozen([
    {
      id: 'program:dv360_bid_manager_reporting',
      name: 'Display & Video 360 reporting (Bid Manager)',
      description: 'Run Display & Video 360 reports through the Bid Manager API.',
      prerequisites: [
        {
          id: 'bid_manager_scope',
          text: 'The Google identity must grant the Bid Manager OAuth scope, which is separate from the Display & Video 360 scope.',
        },
        {
          id: 'dv360_customer_role',
          text: 'The Google identity needs a Display & Video 360 user profile with access to the partner or advertiser.',
        },
        {
          id: 'reporting_workflow',
          text: 'AMCP has no Bid Manager report workflow yet; reports, query runs and report retrieval are not available.',
        },
      ],
      program: {
        access:
          'Bid Manager reporting uses its own OAuth scope and report workflow; an advertiser read does not establish reporting access.',
        reference: 'https://developers.google.com/bid-manager',
        checked_on: '2026-10-08',
      },
      unlocks: ['Display & Video 360 reporting'],
      withheld_actions: [],
    },
  ]),
  // Its top-level parameters (src/parameters.ts): its account alias, its resource and RPC controls, and its
  // JSON-encoded native bodies.
  parameters: deepFrozen({
    accountAliases: ['advertiserId'],
    platformControls: ['resource', 'method'],
    encodedBody: true as const,
  }),
  // Its SDF download job family and what it guarantees (src/provider-jobs.ts).
  jobFamilies: deepFrozen([
    {
      family: 'dv360_sdf_downloads',
      kind: 'export' as const,
      admission: 'The deployment-wide hourly bound per account (admitProviderJob).',
      lost_response: 'Uncertain; the original operation is read by its name, never resubmitted.',
      retrieval: 'The original operation is read until done; its files are then downloaded with media.download.',
    },
  ]),
  // Its wire contract (src/wire-contracts.ts): the pinned v4 Discovery method with the request's verb and path; media
  // and asset uploads are multipart transports with their own contracts.
  wireContract: deepFrozen({discovery: {document: 'dv360-v4', label: 'Display & Video 360', uploads: '/upload/'}}),
  // Wave 4c round 6 (w4c-arc6-catalog): its conditional program, the exact advertiser read
  // (src/conditional-programs.ts).
  conditionalPrograms: dv360ConditionalPrograms,
});

// Writes and campaigns (wave 4c): moved verbatim from confirmedMutationResult (src/write-outcome.ts).
/** A delete returns an empty object or 204; a create or edit returns its entity ID. */
function dv360Confirms(
  plan: CompiledRequest,
  result: TransportResult,
  {data: d, segments, last, hasId}: MutationResponse,
): boolean {
  if (plan.method === 'DELETE')
    return (result.status === 200 && result.data !== null && Object.keys(d).length === 0) || result.status === 204;
  const kind = plan.method === 'POST' ? last : segments.at(-2)!,
    key: Record<string, string> = {
      campaigns: 'campaignId',
      insertionOrders: 'insertionOrderId',
      lineItems: 'lineItemId',
      creatives: 'creativeId',
    };
  return hasId(d[key[kind]!]) && (plan.method === 'POST' || String(d[key[kind]!]) === last);
}
/**
 * What a DV360 write does for the review's summary (R2.5 S2-2), as the v4 API builds its URLs (Google's API design): a POST
 * to a collection creates a member of it, and a POST that ends in a custom method (…:bulkEdit, …:duplicate) says what it
 * does by that method's name: bulkCreate and create make new entities, and duplicate makes a copy of one. Any other custom
 * method (bulkEdit, bulkUpdate, replace, editAssignedTargetingOptions) changes what exists, and keeps the path's reading.
 */
function dv360Operation(plan: CompiledRequest): DeclaredOperation | undefined {
  if (plan.method !== 'POST') return undefined;
  const method = /:([A-Za-z]+)$/.exec(plan.path)?.[1];
  if (method === undefined || method === 'create' || method === 'duplicate') return {operation: 'create'};
  if (method !== 'bulkCreate') return undefined;
  // A bulkCreate lists the entities it makes under the collection's own key (adAssets:bulkCreate takes {adAssets: [...]}).
  const collection = /([A-Za-z]+):bulkCreate$/.exec(plan.path)?.[1],
    rows = collection && plan.body && typeof plan.body === 'object' ? (plan.body as JsonObject)[collection] : undefined;
  return {
    operation: 'create',
    entity: collection === 'adAssets' ? 'ad asset' : collection,
    count: Array.isArray(rows) ? rows.length : undefined,
  };
}
