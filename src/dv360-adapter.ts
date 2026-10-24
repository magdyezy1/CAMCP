import type {ExpectState, ProviderHooks, ProviderVerificationRead, StateTarget} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  authorizeDV360TargetingSearch,
  dv360TargetingSearchResult,
  dv360TargetingSearchRoute,
  validateDV360TargetingSearch,
} from './dv360-targeting-search.js';
import {authorizeDV360AudienceRead, dv360AudienceRead} from './dv360-audiences.js';

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
 * Display & Video 360's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the
 * targeting option search, a POST the catalog marks as a write, is a reviewed read. The account read is the advertiser.
 * On the wire, the targeting search is checked before it is sent and its response after, and the advertiser asset
 * uploads are its multipart/related contracts. Its writes may carry updateMask; a new serving entity starts paused.
 */
export const dv360Hooks: ProviderHooks = Object.freeze({
  gateway: 'dv360_native_action',
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
  writes: Object.freeze({accountPath: /^\/v\d+\/advertisers\/[^/]+/}),
});
