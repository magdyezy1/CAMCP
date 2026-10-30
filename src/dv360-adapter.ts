import type {
  CompileHooks,
  ContractHooks,
  ContractNote,
  ExpectState,
  ProviderHooks,
  ProviderVerificationRead,
  StateTarget,
} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
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
 * Wave 4c (transport and catalog): DV360's part of the catalog compiler (src/compiler.ts). A request may name its
 * catalog route by resource and RPC; its parameters go in the query whatever the method; the targeting search is
 * planned as a reviewed read before the report job's controls.
 */
const dv360Compile: CompileHooks = Object.freeze({
  resourceAction: (registry: Registry, input: JsonObject) =>
    registry.data.supplemental.find(a => a.raw.resource === input.resource && a.raw.rpc === input.method),
  queryParameters: true as const,
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
 * Display & Video 360's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * targeting option search, a POST the catalog marks as a write, is a reviewed read. The account read is the advertiser.
 * On the wire, the targeting search is checked before it is sent and its response after, and the advertiser asset
 * uploads are its multipart/related contracts. Its writes may carry updateMask; a new serving entity starts paused.
 */
export const dv360Hooks: ProviderHooks = Object.freeze({
  gateway: 'dv360_native_action',
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
