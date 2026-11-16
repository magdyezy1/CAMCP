import type {
  DelegatedHooks,
  ProviderHooks,
  ProviderVerificationRead,
  RefreshRequest,
  ScopeCallBuilder,
  ScopeContext,
} from './provider-adapter.js';
import type {CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {readRole, type ReviewVolatile} from './review-state-core.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {createsOnPost} from './family-kit.js';
import {redditNextPage} from './reddit-paging.js';
// Writes and campaigns (wave 4c).
import type {TransportResult} from './transport.js';
import {assertRedditWrite, assertRedditWriteScopes, validateRedditState} from './reddit-writes.js';
import {
  authorizeRedditPlanningRead,
  extendRedditTool,
  redditAudienceRoutes,
  redditReadRoutes,
} from './reddit-extensions.js';
import {assertRedditReportRules} from './reddit-report-rules.js';
import {redditAdPreviews} from './reddit-ad-previews.js';
import {redditAccountState, redditFundingInstrumentState} from './reddit-account-state.js';

/** The other names Reddit's tool arguments give its native parameters. */
const redditAliases: Record<string, string[]> = {
  ad_account_id: ['account_id'],
  ad_group_id: ['adgroup_id', 'adset_id'],
  'page.size': ['page_size', 'pageSize', 'limit'],
  'page.token': ['page_token', 'pageToken', 'after', 'cursor'],
  query: ['q'],
};
/**
 * Wave 4c (transport and catalog): Reddit's part of the delegated compiler (src/delegated-native.ts). Its audience and
 * read routes join the vendor snapshot's when the snapshot holds the v3 schemas; its arguments take Reddit's own
 * aliases; its unexploded arrays are comma-separated; its bodies are checked against the published v3 schemas, a
 * report's window and fields and its breakdown rules too; its account argument may be ad_account_id, and its paths
 * name the account under /ad_accounts/.
 */
const redditDelegated: DelegatedHooks = Object.freeze({
  routes: Object.freeze({components: 'reddit-v3', list: () => [...redditAudienceRoutes, ...redditReadRoutes()]}),
  aliases: (parameter: string) => redditAliases[parameter],
  joinedArrays: true as const,
  bodySchema: Object.freeze({
    applies: () => true,
    refusal: 'Request body does not satisfy the published Reddit API schema.',
    report(action: string, body: JsonObject) {
      if (action !== 'GET_INSIGHTS') return;
      const data = body.data;
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(data.starts_at) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(data.ends_at) ||
        Date.parse(data.starts_at) >= Date.parse(data.ends_at)
      )
        throw new MirrorError(
          'INVALID_REPORT_WINDOW',
          'Reddit reports require increasing UTC timestamps aligned to complete hours.',
        );
      if (data.fields.length === 0)
        throw new MirrorError('INVALID_VENDOR_BODY', 'A Reddit report requires at least one field.');
      // Breakdown rules Reddit enforces from 2026-12-08 (PRV-04): refused here instead of by a provider 400.
      assertRedditReportRules(data);
    },
  }),
  scope: Object.freeze({
    account: Object.freeze({aliases: Object.freeze(['ad_account_id']), path: /\/ad_accounts\/([^/:]+)/}),
  }),
});

/** Reddit's account-agnostic reference reads, which any bound account may make. */
const globalReads = [
  '/api/v3/time_zones',
  '/api/v3/targeting/interests',
  '/api/v3/targeting/geolocations',
  '/api/v3/targeting/communities/search',
];
/** The entities Reddit addresses by a global ID, owned once an account-scoped list or creation showed them. */
const ownedEntity =
  /^\/api\/v3\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|posts|structured_posts|funding_instruments)\/([^/]+)/;
/**
 * Reddit's resource scope, after the account path: its reference reads, the businesses of the selected account, and
 * an entity of a global ID the account owns.
 */
function redditResourceScope(
  plan: CompiledRequest,
  connection: Connection,
  id: string,
  {decoded, store}: ScopeContext,
) {
  if (globalReads.includes(decoded) && plan.readOnly) return true;
  if (decoded === '/api/v3/me/businesses' && plan.query.ad_account_id === id) return true;
  const entity = ownedEntity.exec(decoded);
  return !!entity && store.ownsResource(connection, id, entity[1] + '/' + entity[2]);
}
/** Ownership of entities listed by the selected account's own collections (or a profile's posts). */
function observeReddit(plan: CompiledRequest, connection: Connection, id: string, data: unknown, store: Store) {
  const d = data as JsonObject;
  const collection =
    /^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|funding_instruments)$/.exec(
      plan.path,
    )?.[1] ?? /^\/api\/v3\/profiles\/[^/]+\/(posts|structured_posts)$/.exec(plan.path)?.[1];
  if (collection && Array.isArray(d?.data))
    for (const entity of d.data)
      if (
        typeof entity?.id === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(entity.id) &&
        (!entity.ad_account_id || entity.ad_account_id === id)
      )
        store.rememberResource(connection, id, collection + '/' + entity.id);
}
/**
 * What changes by itself in a Reddit record (R2.5 M1, L5-02): Reddit computes `modified_at`, `updated_at`, `effective_status`
 * and `delivery_status` (a write that sends one is refused as server-derived, src/reddit-writes.ts), and a pixel's
 * `last_fired_at` is its last event (PRV-06 D: a review keeps whether and how recently it fired, not the time). The status a
 * user sets is `configured_status`, which stays. A funding instrument's `billable_amount` is its outstanding debt, a meter that
 * grows with every day the account spends, and `is_servable` and `reasons_not_servable` are what Reddit computes from it
 * (`components_schema_funding_instrument` of `.mirror/VENDOR/reddit-v3.json`; no other schema of Reddit carries these three).
 */
const redditReviewVolatile: ReviewVolatile = Object.freeze([
  'modified_at',
  'updated_at',
  'effective_status',
  'delivery_status',
  'last_fired_at',
  'billable_amount',
  'is_servable',
  'reasons_not_servable',
]);
/**
 * Reddit's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: reports, plus
 * the PRV-07 planning and history reads (src/reddit-extensions.ts), are POST reads. Its scope: the planning reads'
 * authorizer, the reference reads, and ownership of the global IDs its account lists and creations show. A review keeps
 * a response's records and verifies a write by the entity it returned. Its write contract and state check are its
 * gateway checks (src/reddit-writes.ts).
 */
export const redditHooks: ProviderHooks = Object.freeze({
  gateway: 'reddit_native_action',
  // Its ads and their previews for amcp_ad_previews (src/ad-previews.ts).
  previews: redditAdPreviews,
  // Wave 4c (transport and catalog): its tool takes the audience and read operations AMCP adds to the captured one.
  catalog: Object.freeze({tools: Object.freeze({reddit_native_action: extendRedditTool})}),
  delegated: redditDelegated,
  // A token renewal sends the connection's descriptive User-Agent and authenticates the app with HTTP Basic, so the
  // app's ID and secret leave the form body.
  refresh: Object.freeze({
    request({body, headers}: RefreshRequest, c: Credentials, connection: Connection) {
      if (!connection.userAgent || /[\r\n]/.test(connection.userAgent))
        throw new MirrorError(
          'USER_AGENT_REQUIRED',
          'Configure a descriptive Reddit application userAgent on the connection.',
        );
      headers['User-Agent'] = connection.userAgent;
      headers.Authorization = 'Basic ' + Buffer.from(c.clientId + ':' + c.clientSecret).toString('base64');
      body.delete('client_id');
      body.delete('client_secret');
    },
  }),
  // A response's records are under data, the rest is its envelope.
  review: Object.freeze({
    snapshot: (_read: CompiledRequest, d: JsonObject) => (Object.hasOwn(d, 'data') ? {data: d.data} : d),
    // The ad account a write is made in (the role `account`) is kept to its identity (S3-3): it carries no balance, and
    // what changes by itself in it is `modified_at`, which the table drops; the rest of its row is not what a write depends on.
    // The funding instrument a campaign names (the role `reference`, S3-4) is kept to what the campaign depends on: its meter
    // and its computed servable state grow and flip as the account spends.
    identity(read: CompiledRequest, d: JsonObject) {
      const role = readRole(read);
      if (role === 'account' && d.data && typeof d.data === 'object' && !Array.isArray(d.data))
        return {data: redditAccountState(d.data)};
      if (role === 'reference' && Array.isArray(d.data)) return {data: d.data.map(redditFundingInstrumentState)};
      return undefined;
    },
    volatile: redditReviewVolatile,
    verification(
      plan: CompiledRequest,
      result: JsonObject,
      read: (path: string, query?: JsonObject) => CompiledRequest,
    ): ProviderVerificationRead[] {
      const b = (plan.body ?? {}) as JsonObject,
        d = result.data ?? {};
      const kind = plan.method === 'POST' ? plan.path.split('/').at(-1) : plan.path.split('/').at(-2),
        id = d.data?.id;
      if (!id) return [];
      return [{read: read('/api/v3/' + kind + '/' + id), expected: b.data, id}];
    },
    observed: (_plan: CompiledRequest, data: JsonObject) => data.data,
  }),
  scope: Object.freeze({
    authorizers: Object.freeze([
      Object.freeze({
        name: 'reddit_planning_read',
        stage: 'before_families' as const,
        claims: (p: CompiledRequest) => p.gateway === 'reddit_native_action' && p.readOnly && p.method === 'POST',
        authorize: authorizeRedditPlanningRead,
      }),
    ]),
    resource: redditResourceScope,
    ownershipReads(path: string, account: string, connectionId: string, _t: string | undefined, _c: ScopeCallBuilder) {
      const kind = /^\/api\/v3\/(campaigns|ad_groups|ads)\//.exec(path)?.[1],
        action =
          kind &&
          ({campaigns: 'LIST_CAMPAIGNS', ad_groups: 'LIST_AD_GROUPS', ads: 'LIST_ADS'} as Record<string, string>)[kind];
      return action
        ? [
            {
              tool: 'reddit_native_action',
              arguments: {
                operation: 'reddit_campaign_ops',
                arguments: {action, account_id: account, connection_id: connectionId},
              },
            },
          ]
        : [];
    },
    observe: observeReddit,
    // Only an accepted, account/profile-bound original creation may authorize a job read.
    observeCreated(plan: CompiledRequest, connection: Connection, id: string, d: JsonObject, store: Store) {
      const kind = /^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|saved_audiences|lead_gen_forms)$/.exec(
          plan.path,
        )?.[1],
        entity = d?.data;
      if (
        kind &&
        typeof entity?.id === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(entity.id) &&
        entity.ad_account_id === id
      )
        store.rememberResource(connection, id, kind + '/' + entity.id);
    },
  }),
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /^\/api\/v3\/ad_accounts\/[^/]+\/(?:reports|history|forecasting\/audience_and_delivery_estimates)$/.test(
        pathname,
      ) || ['/api/v3/forecasting/bid_suggestions', '/api/v3/targeting/keyword_suggestions'].includes(pathname),
  }),
  paging: Object.freeze({
    nextPage: redditNextPage,
  }),
  accountRead: Object.freeze({
    plan(read: CompiledRequest, id: string) {
      read.path = '/api/v3/ad_accounts/' + id;
      return read;
    },
  }),
  wire: Object.freeze({
    // Reddit requires a descriptive application User-Agent on every request.
    connectionHeaders(headers: Record<string, string>, connection: Connection) {
      if (!connection.userAgent || /[\r\n]/.test(connection.userAgent))
        throw new MirrorError(
          'USER_AGENT_REQUIRED',
          'Configure a descriptive Reddit application userAgent on the connection.',
        );
      headers['User-Agent'] = connection.userAgent;
    },
  }),
  // Workbook reporting (ARC-01, reporting; src/report-resource-scope.ts): delegated Reddit routes identify their exact
  // ad-account parent by ad_account_id. Scope never comes from a campaign or ad child ID or an arbitrary HTTP path.
  reportScope: Object.freeze({
    account: (kind: unknown, value: string) =>
      kind === 'account' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined,
    // Wave 4c round 6 (w4c-arc6-reporting): the selectors src/workbook-repository.ts projects: an account ID or ad
    // account ID field of the arguments, their params or path_params; no body makes them invalid.
    selectors: Object.freeze({
      order: 5,
      groups: Object.freeze([
        Object.freeze({
          paths: Object.freeze(['$', '$.params', '$."path_params"']),
          keys: Object.freeze(['accountid', 'adaccountid']),
        }),
      ]),
      otherwise: 'account',
    }),
  }),
  // Writes and campaigns (wave 4c): its write contract decides alone, and its state check is the exact-target check.
  // Its family reads pages with src/reddit-paging.ts, not src/pagination.ts, so this adapter imports them in no cycle.
  checks: Object.freeze({
    contract: assertRedditWrite,
    state: Object.freeze({
      target: (read: CompiledRequest, result: TransportResult) => validateRedditState(read, result),
    }),
  }),
  // Its review needs adsread and adsedit on the connection, before the family's scope check (src/write-review.ts).
  // Reddit creates with a POST and updates with a PATCH: every POST its review accepts creates (R2.5 S2-2).
  writes: Object.freeze({writeScopes: assertRedditWriteScopes, operation: createsOnPost}),
  // Wave 4c round 6 (w4c-arc6-versions): its catalog has write actions, which its gateway previews or refuses
  // (src/tool-notes.ts).
  notes: Object.freeze({delegatedWrites: true as const}),
  // Wave 4c round 6 (w4c-arc6-tables): its rows of the shared tables (src/provider-hooks.ts orders them). Its account
  // aliases (src/parameters.ts).
  parameters: Object.freeze({accountAliases: Object.freeze(['account_id', 'ad_account_id'])}),
});
