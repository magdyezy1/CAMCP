import type {ProviderHooks, ScopeContext} from './provider-adapter.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';

/**
 * Criteo's resource scope, after the account path: a preferred line item (and its targeting) is a global object path,
 * in scope once the account's line-item list showed it to this connection.
 */
function criteoResourceScope(
  _plan: CompiledRequest,
  connection: Connection,
  id: string,
  {decoded, store}: ScopeContext,
) {
  const line = criteoRoute(
    String.raw`/preferred-line-items/(\d+)(?:/targeting/(?:audiences|stores|add-to-basket)(?:/(?:append|delete))?)?$`,
  ).exec(decoded)?.[1];
  return !!line && store.ownsResource(connection, id, 'preferred-line-items/' + line);
}
/** The account's own line-item list is ownership evidence of the preferred line items it names. */
function observeCriteo(plan: CompiledRequest, connection: Connection, id: string, data: unknown, store: Store) {
  const d = data as JsonObject;
  if (
    new RegExp('^' + criteoPrefix + '/accounts/' + id + '/line-items$').test(plan.path) &&
    Array.isArray(d?.data) &&
    !d.error &&
    (!d.errors || (Array.isArray(d.errors) && !d.errors.length))
  ) {
    for (const row of d.data)
      if (
        typeof row?.id === 'string' &&
        /^[1-9][0-9]*$/.test(row.id) &&
        row.attributes?.type === 'preferred' &&
        typeof row.attributes?.campaignId === 'string' &&
        /^[1-9][0-9]*$/.test(row.attributes.campaignId)
      )
        store.rememberResource(connection, id, 'preferred-line-items/' + row.id);
  }
}

/**
 * Criteo's provider hooks (ARC-01 phase B; registered in src/provider-hooks.ts; the provider is parked, P9). Read
 * classification: searches, previews and the retailer bid and category recommendations are POST reads. On the wire,
 * report and campaign reads carry their own deadlines and report output is checked whole. Its scope: ownership of
 * the preferred line items its account lists.
 */
export const criteoHooks: ProviderHooks = Object.freeze({
  gateway: 'criteo_native_action',
  reads: Object.freeze({
    postRead: (_plan: CompiledRequest, pathname: string) =>
      /\/(?:search|preview)$/.test(pathname) ||
      criteoRoute('/retailers/[^/:]+/(?:cpc-min-bids|recommend-categories|recommend-keywords)$').test(pathname),
  }),
  scope: Object.freeze({resource: criteoResourceScope, observe: observeCriteo}),
  wire: Object.freeze({
    deadline: (plan: CompiledRequest) =>
      plan.readOnly && plan.method === 'GET'
        ? plan.criteoReportRead
          ? plan.criteoReportDeadline
          : plan.action === 'AMCP_CRITEO_CAMPAIGN_READ'
            ? plan.criteoCampaignDeadline
            : undefined
        : undefined,
    reportOutput: (plan: CompiledRequest) =>
      plan.criteoReportRead?.kind === 'output' &&
      plan.method === 'GET' &&
      criteoRoute('/reports/[a-f0-9-]+/output$', 'i').test(plan.path),
  }),
});
