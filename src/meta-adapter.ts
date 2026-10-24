import type {
  ExpectState,
  ProviderHooks,
  ProviderVerificationRead,
  ScopeCallBuilder,
  ScopeContext,
  StateTarget,
} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {TransportResult} from './transport.js';
// The write-shape and state refusals keep the write stages' own helper (src/write-common.ts).
import {fail} from './write-common.js';
import {validateMetaCampaign, validateMetaV26} from './meta-contracts.js';
import {metaCreativeFeaturesObserved} from './meta-creative-features.js';
import {pausedParentChildStatuses} from './paused-parents.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';
import {metaAdLibraryRead} from './meta-ad-library-contract.js';
import {assertMetaLabelScope, metaLabelIdentities} from './meta-label-writes.js';
import {authorizeMetaDatasetRead, metaDatasetRead, observeMetaPixels} from './meta-dataset-scope.js';
import {
  boundedWait,
  errorInteger,
  errorMinute,
  errorObject,
  metaRegainAccessMs,
  providerReference,
} from './provider-error-core.js';
import type {ProviderErrorClass, ProviderErrorContext, ProviderErrorInput} from './provider-error-taxonomy.js';
// Writes and campaigns (wave 4c).
import {buildMetaWebsiteRecipe, metaWebsiteRecipes} from './meta-website-recipes.js';
import {metaWriteShapeBefore} from './meta-write-shape.js';
import type {ReviewStateContext} from './provider-adapter.js';
import {metaAdSetAudienceChoice} from './meta-contracts.js';
import {metaCreativeCreate, metaCreativeState} from './meta-creative-state.js';
import {metaStateReads} from './meta-state-reads.js';
import {metaCreativeImpact} from './meta-creative-features.js';
import {metaActivationGates, metaActivationRecord, metaActivationSteps} from './meta-recipe-activation.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});

// Meta Graph and Marketing API error codes (developers.facebook.com: Graph API "Handling Errors" and Marketing API
// "Rate Limiting", read 2026-10-08). Only these documented codes are mapped; every other Meta code keeps its HTTP
// classification with layer `unknown`.
const metaThrottles = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);
/** The ad-account-level throttle subcodes Meta documents for codes 17 and 613. */
const metaAccountSubcodes = new Set([2446079, 1487742]);
/** A Meta refusal, classified from its documented codes (PRV-01); every Meta refusal is classified here. */
function classifyMetaError(input: ProviderErrorInput, context: ProviderErrorContext): ProviderErrorClass {
  const {headers, readOnly} = input,
    {base, legacyCode, legacyRetryable, layerOf} = context,
    error = errorObject(errorObject(input.body).error);
  const code = errorInteger(error.code),
    subcode = errorInteger(error.error_subcode),
    meta = {...base, ...(subcode !== undefined ? {providerSubcode: subcode} : {})};
  if (code === 190)
    return {...meta, code: 'REAUTHORIZATION_REQUIRED', layer: 'credential', retryable: false, documented: true};
  if (code !== undefined && (code === 10 || (code >= 200 && code <= 299)))
    return {...meta, code: 'PROVIDER_PERMISSION_MISSING', layer: 'consent', retryable: false, documented: true};
  if (code !== undefined && metaThrottles.has(code)) {
    const account = code >= 80000 || (subcode !== undefined && metaAccountSubcodes.has(subcode));
    return {
      ...meta,
      code: 'PLATFORM_RATE_LIMIT',
      layer: 'rate_limit',
      retryable: readOnly || legacyRetryable,
      retryAfterMs: boundedWait(
        Math.max(metaRegainAccessMs(headers.get('x-business-use-case-usage')) ?? errorMinute, input.retryAfterMs ?? 0),
      ),
      cooldownScope: account ? 'account' : 'login',
      documented: true,
    };
  }
  return {
    ...meta,
    code: legacyCode,
    layer: layerOf(legacyCode),
    // Meta marks a temporary failure is_transient; a read may be retried, a write never is.
    retryable: legacyRetryable || (readOnly && error.is_transient === true),
    documented: false,
  };
}
/**
 * Meta's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: a Graph batch is
 * never a read, and an account's value rule sets are a documented read whose path holds "set". The account read is the
 * ad account node with its status, currency and time zone, which the response is.
 */
/** The account edges whose lists and creations are ownership evidence for the global IDs they return. */
const ownedCollections = /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives|customaudiences)$/;
/** The typed list read that establishes a typed action's object, by its route parameter (MCP-09). */
const typedLists: Record<string, string> = {
  campaign_id: 'meta_campaign_list',
  ad_set_id: 'meta_adset_list',
  ad_id: 'meta_ad_list',
  creative_id: 'meta_creative_list',
  custom_audience_id: 'meta_custom_audience_list',
};
/** Meta's ownership learning from a successful account-scoped read. */
function observeMeta(plan: CompiledRequest, connection: Connection, id: string, data: unknown, store: Store) {
  observeMetaPixels(plan, connection, id, data, store);
  const d = data as JsonObject;
  if (ownedCollections.test(plan.path) && Array.isArray(d?.data)) {
    // Explicit foreign ownership can never grant access, even on an account edge. Audience lists additionally
    // show shared resources, so they require an explicit matching account rather than relying on the edge.
    const audiences = plan.path.endsWith('/customaudiences');
    for (const entity of d.data)
      if (
        typeof entity?.id === 'string' &&
        /^\d+$/.test(entity.id) &&
        (entity.account_id === undefined
          ? !audiences
          : typeof entity.account_id === 'string' && normalizeAccount(plan.gateway, entity.account_id) === id)
      )
        store.rememberResource(connection, id, entity.id);
  }
  // The account's value rule set list is ownership evidence for later edits and deletion of those sets by ID.
  if (metaRoute('act_\\d+/value_rule_set$').test(plan.path) && Array.isArray(d?.data)) {
    for (const set of d.data)
      if (typeof set?.id === 'string' && /^\d+$/.test(set.id)) store.rememberResource(connection, id, set.id);
  }
  if (metaRoute('act_\\d+/adlabels$').test(plan.path)) {
    const labels = metaLabelIdentities(d, id);
    for (const label of labels) store.rememberResource(connection, id, label);
  }
}

/** The read that shows a Meta write took effect: its node, read back with the fields the write sent. */
function metaVerification(
  plan: CompiledRequest,
  result: JsonObject,
  read: (path: string, query?: JsonObject) => CompiledRequest,
): ProviderVerificationRead[] {
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {};
  const id = String(d.id ?? plan.path.split('/').at(-1));
  if (!/^\d+$/.test(id)) return [];
  const expected = {...b};
  delete expected.execution_options;
  if (expected.creative?.creative_id) expected.creative = {id: expected.creative.creative_id};
  // Meta's reference does not say whether a creative read returns destination_spec (the owner's condition of
  // 2026-09-29: verify it on read-back, else against the write response, never silently). The Advantage+ creative
  // feature choices (PRV-06 C) are compared the same way, and the features Meta shows on its own are reported.
  const creative = /\/adcreatives$/.test(plan.path),
    readOptional = creative
      ? ['destination_spec', 'degrees_of_freedom_spec'].filter(field => Object.hasOwn(expected, field))
      : [];
  return [
    {
      read: read(metaPrefix + id, {fields: ['id', ...Object.keys(expected)].join(',')}),
      expected,
      id,
      ...(readOptional.length ? {readOptional} : {}),
      ...(creative && Object.hasOwn(expected, 'degrees_of_freedom_spec')
        ? {observe: (actual: unknown) => metaCreativeFeaturesObserved(expected, actual)}
        : {}),
    },
  ];
}

export const metaHooks: ProviderHooks = Object.freeze({
  gateway: 'meta_native_action',
  checks: Object.freeze({
    // Meta's campaign and v26 request rules come first.
    request(plan: CompiledRequest) {
      validateMetaCampaign(plan);
      validateMetaV26(plan);
    },
    shape: Object.freeze({
      // Writes and campaigns (wave 4c): a creative's own contract, no budget schedules and no inline creatives, before
      // the generic checks (src/meta-write-shape.ts).
      before: metaWriteShapeBefore,
      // Campaigns start paused. Ad sets and ads may start active under a parent the review reads as paused
      // (paused-parents.ts, the owner's decision of 2026-09-29).
      after(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
        if (/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads)$/.test(plan.path) && plan.method === 'POST')
          expect(body, 'status', pausedParentChildStatuses(plan) ?? ['PAUSED']);
      },
    }),
    // A node read names its ID last; a status asked for must be returned.
    state: Object.freeze({
      target(read: CompiledRequest, _result: TransportResult, data: JsonObject, {sameIds, target}: StateTarget) {
        sameIds([String(data.id).replace(/^act_/, '')], [target()]);
        if (String(read.query.fields).split(',').includes('status') && !Object.hasOwn(data, 'status'))
          fail('STATE_READ_FAILED', 'Meta did not return the requested target status.');
      },
    }),
  }),
  review: Object.freeze({verification: metaVerification}),
  reads: Object.freeze({
    batch: (key: string) => key === 'batch',
    // GET act_<id>/value_rule_set. The fixed act_ path binds it, so it has no authorizer of its own.
    qualifiedRead: (p: CompiledRequest) =>
      (!p.origin || p.origin === 'https://graph.facebook.com') && metaRoute('act_\\d+/value_rule_set$').test(p.path),
  }),
  scope: Object.freeze({
    // The public Ad Library read needs no account (its fixed contract only).
    publicRead: metaAdLibraryRead,
    // Labels are read with ads_read or ads_management.
    assert(plan: CompiledRequest, connection: Connection) {
      if (
        plan.action === 'AMCP_META_LABEL_READ' ||
        (plan.method === 'GET' && metaRoute('act_\\d+/adlabels$').test(plan.path))
      )
        assertMetaLabelScope(connection);
    },
    authorizers: Object.freeze([
      Object.freeze({
        name: 'meta_dataset_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) => metaDatasetRead(p) !== undefined,
        authorize: authorizeMetaDatasetRead,
      }),
    ]),
    // A Graph node of a global ID is in scope when an account-scoped list established its ownership.
    resource(plan: CompiledRequest, connection: Connection, id: string, {decoded, store}: ScopeContext) {
      const resource = /^\/v[^/]+\/([^/]+)/.exec(decoded)?.[1];
      return !!resource && store.ownsResource(connection, id, resource);
    },
    ownershipReads(
      path: string,
      account: string,
      connectionId: string,
      template: string | undefined,
      call: ScopeCallBuilder,
    ) {
      // A Meta pixel's aggregate reads are opened by the account's pixel list, which the measurement ledger reads (MSR-03).
      // Only the pixel stats route and dataset quality name it: a numeric /stats path without that route could be another
      // object's, and keeps the candidate-list hints below.
      if (/^\/v[^/]+\/\{pixel_id\}\/stats$/.test(template ?? '') || /^\/v[^/]+\/dataset_quality$/.test(path))
        return [
          {
            tool: 'amcp_workspace',
            arguments: {
              action: 'measurement_ledger',
              gateway: 'meta_native_action',
              account_id: account,
              connection_id: connectionId,
            },
          },
        ];
      if (!/^\/v[^/]+\/\d+(?:\/|$)/.test(path)) return [];
      // A typed action names its object's type in its route ({campaign_id}, {ad_set_id}...), so one list read
      // establishes its ownership (MCP-09); a bare ID of unknown type still offers each candidate list.
      const typed = typedLists[/^\/v[^/]+\/\{([a-z_]+)\}/.exec(template ?? '')?.[1] ?? ''];
      return (
        typed
          ? [typed]
          : ['meta_campaign_list', 'meta_adset_list', 'meta_ad_list', 'meta_creative_list', 'meta_custom_audience_list']
      ).map(a => call(a, {query: {fields: 'id'}}));
    },
    observe: observeMeta,
    // Meta object IDs are global: a creation on an account edge is owned by that account unless it names another.
    observeCreated(plan: CompiledRequest, connection: Connection, id: string, d: JsonObject, store: Store) {
      if (!ownedCollections.test(plan.path) || typeof d?.id !== 'string' || !/^\d+$/.test(d.id)) return;
      if (d.account_id !== undefined && normalizeAccount(plan.gateway, d.account_id) !== id) return;
      store.rememberResource(connection, id, d.id);
    },
  }),
  paging: Object.freeze({
    nextPage(_plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      if (!d.paging?.next) return null;
      const cursor = d.paging?.cursors?.after;
      if (!cursor) throw new MirrorError('UNKNOWN_PAGINATION', 'Meta advertises another page but supplies no cursor.');
      next.query.after = cursor;
      return next;
    },
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = metaPrefix + 'act_' + id;
      read.query = {fields: 'id,name,account_status,currency,timezone_name'};
      return read;
    },
    account: (data: JsonObject) => data,
  }),
  // Graph requests send their body form-encoded; Meta's trace ID may sit in the error body, and its documented codes
  // classify credential, permission and throttle refusals.
  wire: Object.freeze({
    formBody: () => true,
    reportData: (plan: CompiledRequest) => /\/insights$/.test(plan.path),
    errors: Object.freeze({
      bodyRequestId: (body: unknown) => providerReference(errorObject(errorObject(body).error).fbtrace_id),
      code: (body: unknown) => errorInteger(errorObject(errorObject(body).error).code),
      classify: classifyMetaError,
    }),
  }),
  // Writes and campaigns (wave 4c): the guided website recipes.
  campaign: Object.freeze({
    recipes: Object.freeze(
      metaWebsiteRecipes.map(definition =>
        Object.freeze({definition, build: (b: JsonObject) => buildMetaWebsiteRecipe(definition.id, b)}),
      ),
    ),
    // A launch's campaign activated, gated on its ad's review and its conversion pixel.
    activation: Object.freeze({steps: metaActivationSteps, record: metaActivationRecord, gates: metaActivationGates}),
  }),
  // Its parts of the reviewed write lifecycle (src/write-review.ts): a new creative's state is the account read and the
  // creative's identity sources, which Meta's module reads itself through the review's access check; an ad set's audience
  // choice is checked after the review's paused-parent check.
  writes: Object.freeze({
    // An account-edge creation reads the account and its parent, a node edit the node (src/meta-state-reads.ts).
    snapshots: metaStateReads,
    ownState: Object.freeze({
      claims: metaCreativeCreate,
      state: async (plan: CompiledRequest, {store, transport, credentials, actor, access}: ReviewStateContext) => ({
        creative_source: await metaCreativeState(plan, store, transport, credentials, actor, access),
      }),
    }),
    parentChecks: metaAdSetAudienceChoice,
    // A creative's shop destination and creative feature choices (src/write-impact.ts).
    impact: (plan: CompiledRequest) => metaCreativeImpact(plan),
  }),
});
