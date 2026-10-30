import type {ProviderHooks, ProviderVerificationRead, ScopeCallBuilder, ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {authorizeRedditPlanningRead} from './reddit-extensions.js';

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
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
 * Reddit's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts). Read classification: reports, plus
 * the PRV-07 planning and history reads (src/reddit-extensions.ts), are POST reads. Its scope: the planning reads'
 * authorizer, the reference reads, and ownership of the global IDs its account lists and creations show. A review keeps
 * a response's records and verifies a write by the entity it returned. Its write contract and state check stay in the
 * write stages (src/write-shape.ts says why).
 */
export const redditHooks: ProviderHooks = Object.freeze({
  gateway: 'reddit_native_action',
  // A response's records are under data, the rest is its envelope.
  review: Object.freeze({
    snapshot: (_read: CompiledRequest, d: JsonObject) => (Object.hasOwn(d, 'data') ? {data: d.data} : d),
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
    nextPage(plan: CompiledRequest, response: unknown, next: CompiledRequest) {
      const d = obj(response);
      const link = d.pagination?.next_url;
      if (!link) return null;
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination must supply a valid absolute URL.');
      }
      if (
        url.origin !== 'https://ads-api.reddit.com' ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== plan.path
      )
        throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination changed upstream scope.');
      const keys = new Set<string>();
      for (const [key, value] of url.searchParams) {
        if (keys.has(key))
          throw new MirrorError('UNSAFE_PAGINATION_LINK', 'Reddit pagination contains duplicate parameters.');
        keys.add(key);
        if (key === 'page.token') {
          next.query[key] = value;
          continue;
        }
        if (plan.query[key] === undefined || String(plan.query[key]) !== value)
          throw new MirrorError(
            'UNSAFE_PAGINATION_LINK',
            'Reddit pagination changed account scope, page size or report filters.',
            {parameter: key},
          );
      }
      if (!keys.has('page.token'))
        throw new MirrorError('UNKNOWN_PAGINATION', 'Reddit supplied a next URL without a page token.');
      return next;
    },
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
  }),
});
