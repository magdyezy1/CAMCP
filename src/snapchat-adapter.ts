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
// The write-shape and state refusals keep the write stages' own helpers (src/write-common.ts).
import {fail, object} from './write-common.js';
import {pausedParentChildStatuses} from './paused-parents.js';
import {snapAdCreativePaths} from './snapchat-ad-creatives.js';
import {assertSnapLeadCreativeRefs, assertSnapLeadForms, snapLeadFormProjection} from './snapchat-lead-forms.js';
import {
  assertSnapSegmentUpdates,
  assertSnapSegments,
  snapSegmentProjection,
  snapSegmentState,
} from './snapchat-segments.js';
import {snapchatPlanningPlan, snapchatPlanningRoute} from './snapchat-planning-reads.js';
import {MirrorError} from './errors.js';
import {errorObject, errorToken} from './provider-error-core.js';
import {normalizeAccount} from './account-id.js';
import {authorizeSnapCatalogComparisonRead, snapCompareMarker} from './snapchat-catalog-reads.js';
import {snapchatOrganizationPixels, snapchatScopedResource} from './snapchat-scope.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
/** The list read that establishes ownership of each scoped entity kind. */
const kindLists: Record<string, string> = {
  campaigns: 'snapchat_campaign_list',
  adsquads: 'snapchat_adsquad_list',
  ads: 'snapchat_ad_list',
  creatives: 'snapchat_creative_list',
  media: 'snapchat_media_list',
  pixels: 'snapchat_pixel_list',
  lead_generation_forms: 'snapchat_lead_generation_forms_list',
  segments: 'snapchat_audience_list',
};
/**
 * Snapchat's resource scope, after the account path: an entity of a global ID the account owns, or the pixel list of
 * the organization the account's own read named.
 */
function snapchatResourceScope(
  plan: CompiledRequest,
  connection: Connection,
  id: string,
  {decoded, store}: ScopeContext,
) {
  const resource = snapchatScopedResource(plan.path);
  if (resource && store.ownsResource(connection, id, resource)) return true;
  const organization = plan.method === 'GET' && snapchatOrganizationPixels(decoded);
  return !!organization && store.ownsResource(connection, id, 'organizations/' + organization);
}
/** Ownership learned from the account's own entity lists, its own read and fresh reads of owned entities. */
function observeSnapchat(plan: CompiledRequest, connection: Connection, id: string, data: unknown, store: Store) {
  const d = data as JsonObject;
  const failed = (status: unknown) =>
    status !== undefined && (typeof status !== 'string' || status.toUpperCase() !== 'SUCCESS');
  const usable = (wrapped: unknown): wrapped is JsonObject => {
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return false;
    const value = wrapped as JsonObject;
    return !value.error && !failed(value.sub_request_status);
  };
  if (failed(d?.request_status) || d?.error || (Array.isArray(d?.errors) && d.errors.length)) return;
  const m =
    /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)$/.exec(
      plan.path,
    );
  const kind = m?.[1];
  if (kind && Array.isArray(d?.[kind]))
    for (const wrapped of d[kind]) {
      if (!usable(wrapped)) continue;
      const entity = wrapped[kind === 'media' ? 'media' : kind.slice(0, -1)] ?? wrapped;
      // Account segment lists also show segments shared from other accounts; only the account's own are owned.
      if (
        typeof entity?.id === 'string' &&
        /^[\w-]+$/.test(entity.id) &&
        (entity.ad_account_id === undefined
          ? kind !== 'segments'
          : typeof entity.ad_account_id === 'string' && entity.ad_account_id === id)
      )
        store.rememberResource(connection, id, kind + '/' + entity.id);
    }
  // The account's own read names its organization; that binds only the organization's pixel list (S6).
  const own = /^\/v1\/adaccounts\/([\w-]+)$/.exec(plan.path)?.[1],
    account =
      own && String(d?.request_status).toUpperCase() === 'SUCCESS' && usable(d.adaccounts?.[0])
        ? d.adaccounts[0].adaccount
        : undefined;
  if (
    own &&
    normalizeAccount(plan.gateway, own) === id &&
    account?.id === own &&
    typeof account.organization_id === 'string' &&
    /^[\w-]{1,64}$/.test(account.organization_id)
  )
    store.rememberResource(connection, id, 'organizations/' + account.organization_id);
  // A read of an entity authorize() already required ownership for keeps that ownership fresh when the
  // provider names the owning account, or a parent this login still owns. It never learns a new ID.
  const single = /^\/v1\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)\/([\w-]+)$/.exec(
    plan.path,
  );
  if (single && String(d?.request_status).toUpperCase() === 'SUCCESS') {
    const kind = single[1]!,
      wrapped = d[kind]?.[0],
      entity = usable(wrapped) ? wrapped[kind === 'media' ? 'media' : kind.slice(0, -1)] : undefined,
      parentField = kind === 'adsquads' ? 'campaign_id' : kind === 'ads' ? 'ad_squad_id' : undefined;
    const confirmed = parentField
      ? typeof entity?.[parentField] === 'string' &&
        store.ownsResource(connection, id, (kind === 'adsquads' ? 'campaigns/' : 'adsquads/') + entity[parentField])
      : entity?.ad_account_id === id;
    if (entity?.id === single[2] && confirmed) store.rememberResource(connection, id, kind + '/' + single[2]);
  }
}
/** Ownership of what a verified creation made: each successful row the account (or the parent in the path) owns. */
function observeSnapchatCreated(
  plan: CompiledRequest,
  connection: Connection,
  id: string,
  d: JsonObject,
  store: Store,
) {
  const match =
    /^\/v1\/(?:adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)|adaccounts\/[^/]+\/(media)_copy|campaigns\/[^/]+\/(adsquads)|adsquads\/[^/]+\/(ads))$/.exec(
      plan.path,
    );
  const kind = match?.slice(1).find(Boolean);
  if (!kind || String(d?.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(d[kind])) return;
  for (const row of d[kind]) {
    const entity = row[kind === 'media' ? 'media' : kind.slice(0, -1)];
    if (
      String(row.sub_request_status).toUpperCase() !== 'SUCCESS' ||
      typeof entity?.id !== 'string' ||
      !/^[-\w]+$/.test(entity.id)
    )
      continue;
    if (entity.ad_account_id !== undefined && entity.ad_account_id !== id) continue;
    const parent = /^\/v1\/(campaigns|adsquads)\/([^/]+)\//.exec(plan.path);
    if (
      parent &&
      entity[parent[1] === 'campaigns' ? 'campaign_id' : 'ad_squad_id'] !== undefined &&
      entity[parent[1] === 'campaigns' ? 'campaign_id' : 'ad_squad_id'] !== parent[2]
    )
      continue;
    store.rememberResource(connection, id, kind + '/' + entity.id);
  }
}
/**
 * Snapchat's write shape after the generic checks: 1–25 native records per creation, each new serving entity paused
 * unless its parent is read as paused (paused-parents.ts), lead forms, segments and lead creatives by their own
 * contracts, segment updates, and JSON Patch operations of a PATCH.
 */
function snapchatWriteShape(plan: CompiledRequest, body: JsonObject, expect: ExpectState) {
  if (plan.method === 'POST') {
    const kind = plan.path.split('/').at(-1)!;
    if (!Array.isArray(body[kind]) || !body[kind].length || body[kind].length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native ' + kind + ' records.');
    if (kind === 'lead_generation_forms') assertSnapLeadForms(plan, body[kind]);
    else if (kind === 'segments') assertSnapSegments(plan, body[kind]);
    else if (kind === 'creatives') assertSnapLeadCreativeRefs(body[kind]);
    else for (const row of body[kind]) expect(object(row), 'status', pausedParentChildStatuses(plan) ?? ['PAUSED']);
  }
  if (plan.method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path)) {
    if (!Array.isArray(body.segments) || !body.segments.length || body.segments.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native segments records.');
    assertSnapSegmentUpdates(plan, body.segments);
  }
  if (plan.method === 'PATCH') {
    if (
      !Array.isArray(plan.body) ||
      !plan.body.length ||
      plan.body.length > 25 ||
      plan.body.some(
        op =>
          !op ||
          !['add', 'remove', 'replace', 'test'].includes(op.op) ||
          typeof op.path !== 'string' ||
          !/^\/[a-zA-Z0-9_/-]+$/.test(op.path) ||
          op.path.split('/').some((part: string) => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
          (op.op !== 'remove' && !Object.hasOwn(op, 'value')),
      )
    )
      fail('INVALID_PATCH', 'Use 1–25 native JSON Patch add, remove, replace or test operations.');
  }
}
/** A Snapchat entity read returns one exact record; a creative or lead form names the selected ad account. */
function snapchatStateTarget(read: CompiledRequest, _result: TransportResult, data: JsonObject, context: StateTarget) {
  const target = context.target(),
    kind = read.path.split('/').at(-2)!,
    rows = data[kind];
  if (!Array.isArray(rows) || rows.length !== 1)
    fail('STATE_READ_FAILED', 'Snapchat must return one exact target record.');
  const singular = kind === 'adsquads' ? 'adsquad' : kind === 'media' ? 'media' : kind.slice(0, -1);
  context.sameIds(
    rows.map((r: JsonObject) => (r[singular] ?? r).id),
    [target],
  );
  if (
    ['creatives', 'lead_generation_forms'].includes(kind) &&
    (rows[0][singular] ?? rows[0]).ad_account_id !== context.id
  )
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'The creative or lead form must explicitly belong to the selected Snapchat ad account.',
    );
}

/**
 * A Snapchat ad account as a review keeps it (Snapchat S9): what a write under it depends on, not its billing centre,
 * funding sources, cells or invoicing arrangements. The state hash covers these fields, so a change of currency or
 * status still invalidates a review.
 */
export const snapAccountFields = ['id', 'name', 'status', 'currency', 'timezone', 'organization_id', 'type'];
function snapAccountState(account: unknown): unknown {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return account;
  return Object.fromEntries(
    snapAccountFields.filter(k => Object.hasOwn(account, k)).map(k => [k, (account as JsonObject)[k]]),
  );
}
// Snapchat records whose read-back adds provider fields or renames sent ones are compared as projections.
const snapProjections: Record<string, (row: unknown) => unknown> = {
  lead_generation_forms: snapLeadFormProjection,
  segments: snapSegmentProjection,
};
/** The state a review keeps of a Snapchat read: each row's record, segments and ad accounts in their projections. */
function snapchatSnapshot(read: CompiledRequest, d: JsonObject): unknown {
  const kind = read.path.split('/').at(-2)!,
    singular = kind === 'adsquads' ? 'adsquad' : kind === 'media' ? 'media' : kind.slice(0, -1);
  if (!Array.isArray(d[kind])) return d;
  return {
    [kind]: d[kind].map((row: JsonObject) =>
      Object.hasOwn(row, singular)
        ? {
            [singular]:
              kind === 'segments'
                ? snapSegmentState(row[singular])
                : kind === 'adaccounts'
                  ? snapAccountState(row[singular])
                  : row[singular],
          }
        : row,
    ),
  };
}
/** The reads that show Snapchat writes took effect: each returned record, read back by its ID. */
function snapchatVerification(
  plan: CompiledRequest,
  result: JsonObject,
  read: (path: string, query?: JsonObject) => CompiledRequest,
): ProviderVerificationRead[] {
  const b = (plan.body ?? {}) as JsonObject,
    d = result.data ?? {};
  const kind = Object.keys(d).find(k =>
    ['campaigns', 'adsquads', 'ads', 'creatives', 'lead_generation_forms', 'segments'].includes(k),
  );
  if (!kind) return [];
  const singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1);
  // Array-index patches and removes need before/after reconstruction. Do not label partial checks verified.
  if (
    Array.isArray(plan.body) &&
    plan.body.some((p: JsonObject) => !['add', 'replace'].includes(p.op) || !/^\/[A-Za-z_]+$/.test(p.path))
  )
    return [];
  // Snapchat's GET never returns placement_v2 (it reads back as placement:"UNSUPPORTED"). A field no read
  // can observe is compared with the provider's own write response instead; a missing echo stays inconclusive.
  const writeOnly = kind === 'adsquads' ? ['placement_v2'] : [];
  return d[kind].map((r: JsonObject, i: number) => {
    const id = r[singular].id,
      expected = {
        ...(b[kind]?.[i] ??
          (Array.isArray(plan.body)
            ? Object.fromEntries((plan.body as JsonObject[]).map(p => [p.path.slice(1), p.value]))
            : b)),
      },
      acknowledged: Record<string, {sent: unknown; echoed: unknown}> = {};
    for (const field of writeOnly)
      if (Object.hasOwn(expected, field)) {
        acknowledged[field] = {sent: expected[field], echoed: r[singular]?.[field]};
        delete expected[field];
      }
    return {
      read: read('/v1/' + kind + '/' + id),
      expected: (snapProjections[kind]?.(expected) ?? expected) as JsonObject,
      id,
      ...(Object.keys(acknowledged).length ? {acknowledged} : {}),
    };
  });
}
/** What a Snapchat verification read shows: its one record, lead forms and segments in their projections. */
function snapchatObserved(plan: CompiledRequest, data: JsonObject): JsonObject {
  const kind = plan.path.split('/').at(-2)!,
    singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1),
    row = data[kind]?.[0]?.[singular];
  return (snapProjections[kind]?.(row) ?? row) as JsonObject;
}

/**
 * Snapchat's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: the planning
 * POSTs, the by-ID entity reads, the audience, bid and forecasting estimates, and the catalog and Ads Library searches.
 * Its scope: the catalog comparison's internal reads, and ownership of the global IDs its account lists and creations
 * show (Snapchat S3, S6). Its gateway checks: an ad's creative paths, its native records and a state read's one record.
 * A review keeps each row's record and verifies each returned record by its ID.
 */
export const snapchatHooks: ProviderHooks = Object.freeze({
  gateway: 'snapchat_native_action',
  // Wave 4c (transport and catalog): its targeting insight and forecast POSTs are planned as reviewed reads.
  compile: Object.freeze({afterJob: snapchatPlanningPlan}),
  checks: Object.freeze({
    // An ad's creative references are checked before anything else (src/snapchat-ad-creatives.ts).
    shape: Object.freeze({
      before: (plan: CompiledRequest) => void snapAdCreativePaths(plan),
      after: snapchatWriteShape,
    }),
    state: Object.freeze({target: snapchatStateTarget}),
  }),
  review: Object.freeze({
    snapshot: snapchatSnapshot,
    verification: snapchatVerification,
    observed: snapchatObserved,
  }),
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'snapchat_catalog_comparison_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) => p.gateway === 'snapchat_native_action' && p.action === snapCompareMarker,
        authorize: authorizeSnapCatalogComparisonRead,
      }),
    ]),
    resource: snapchatResourceScope,
    ownershipReads(path: string, _a: string, _c: string, _t: string | undefined, call: ScopeCallBuilder) {
      // An organization's pixel list is readable once the account's own read names the organization (Snapchat S6).
      if (snapchatOrganizationPixels(path)) return [call('snapchat_account_get')];
      const [kind, resource] = snapchatScopedResource(path)?.split('/') ?? [],
        action = kind && kindLists[kind];
      // Only the refused ID comes back, however long the account's list (Snapchat S3: 312 creatives were 52 KB).
      return action ? [call(action, resource && /^[\w-]{1,64}$/.test(resource) ? {result_ids: [resource]} : {})] : [];
    },
    observe: observeSnapchat,
    observeCreated: observeSnapchatCreated,
  }),
  reads: Object.freeze({
    plannedRead: (p: CompiledRequest) => !!snapchatPlanningRoute(p),
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /^\/v1\/adaccounts\/[^/]+\/(?:get_(?:campaigns|adsquads|ads|creatives|media)_by_ids|ad_squad_outcome_estimates_v2|audience_size(?:_v2)?|bid_estimate|targeting_insights|reserved_forecasting)$/.test(
        pathname,
      ) ||
      /^\/v1\/(?:catalogs\/[^/]+\/(?:product_search|products\/search|flights\/search|hotels\/search|facets)|ads_library\/(?:ads|sponsored_content)\/search)$/.test(
        pathname,
      ),
  }),
  paging: Object.freeze({
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      const link = d.paging?.next_link ?? d.paging?.next;
      if (!link) return null;
      const url = new URL(link, 'https://adsapi.snapchat.com');
      if (url.origin !== 'https://adsapi.snapchat.com' || url.pathname !== plan.path)
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed upstream scope.');
      const paginationKeys = new Set(['cursor', 'offset', 'page', 'page_token']);
      for (const [key, value] of url.searchParams) {
        if (paginationKeys.has(key)) {
          next.query[key] = value;
          continue;
        }
        const original = plan.query[key];
        if (original === undefined || String(original) !== value)
          throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Pagination link changed account scope or report filters.', {
            parameter: key,
          });
      }
      // The server may omit invariant filters from its link; retain them verbatim.
      return next;
    },
  }),
  // The account read returns the ad account wrapped like every entity read (adaccounts[0].adaccount, S8).
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/v1/adaccounts/' + id;
      return read;
    },
    account: (data: JsonObject) => data.adaccounts?.[0]?.adaccount,
  }),
  // Chunked media uploads INIT and FINALIZE as field-only multipart forms; a PATCH body is a JSON Patch; an update's
  // state reads carry their own deadline.
  wire: Object.freeze({
    fieldUpload: (plan: CompiledRequest) =>
      plan.method === 'POST' &&
      /^\/(?:[a-z]{2}\/)?v1\/media\/[\w-]+\/multipart-upload-v2$/.test(plan.path) &&
      ['INIT', 'FINALIZE'].includes(plan.query.action),
    jsonType: (plan: CompiledRequest) => (plan.method === 'PATCH' ? 'application/json-patch+json' : undefined),
    deadline: (plan: CompiledRequest) => (plan.readOnly && plan.method === 'GET' ? plan.snapUpdateDeadline : undefined),
    reportData: (plan: CompiledRequest) => /\/stats$/.test(plan.path),
    errors: Object.freeze({code: (body: unknown) => errorToken(errorObject(body).error_code)}),
  }),
});
