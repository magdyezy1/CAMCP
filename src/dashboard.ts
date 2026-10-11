import {workspaceCapabilities} from './capabilities.js';
import {writePause} from './owner-operations.js';
import {normalizeAccount} from './scope.js';
import {bad} from './workspace-core.js';
import {cursorBinding, decodeOffsetCursor, encodeOffsetCursor} from './page-cursor.js';
import {readinessContract, readinessView} from './readiness.js';
import {recordedCredentialHealth} from './connection-health.js';
import {attentionPlanStates, planCounts, recentPlans, visiblePlans} from './campaign-inventory.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

const levels = ['implemented', 'locally_tested', 'provider_read_checked', 'provider_validated', 'write_verified'];
const limitations =
  'A connection check is not validation of every workflow. No live badge is inferred from catalog coverage.';
/** The detail a caller can ask for by name, and its page size: [default, maximum]. */
const sectionLimits: Record<string, [number, number]> = {
  accounts: [25, 100],
  providers: [3, 5],
  connections: [25, 100],
  readiness: [25, 100],
  verified_writes: [25, 100],
  evidence: [10, 50],
  campaigns: [25, 100],
  features: [8, 8],
};
export const dashboardSections = Object.keys(sectionLimits);
/** The states a summary counts per provider, from the viewer's readiness of each account (CON-03). */
const readinessStates = ['ready', 'blocked', 'stale', 'unknown', 'unchecked', 'not_applicable'];
/**
 * One account's readiness for this viewer (CON-03): the shared, actor-independent account-read evidence evaluated with
 * the viewer's own role and grants, and its age. The website badge and every summary state come from it, never from a
 * raw readiness document.
 */
function accountReadiness(store: Store, actor: Actor, allowWrites: boolean, paused: boolean) {
  const memo = new Map<string, JsonObject>();
  return (c: Connection, account: string): JsonObject => {
    const key = JSON.stringify([c.id, account]);
    let view = memo.get(key);
    if (!view) {
      view = readinessView(store, actor, c, account, {
        allowWrites,
        paused,
        write: c.writeAccounts?.includes(account) === true,
      });
      memo.set(key, view);
    }
    return view;
  };
}
/** A summary state: not_applicable, ready, blocked, stale, unchecked (no account read yet) or unknown. */
export function readinessState(view: JsonObject): string {
  if (view.readiness === 'not_applicable') return 'not_applicable';
  if (view.ready === true) return 'ready';
  if (view.blocked === true) return 'blocked';
  if (view.stale === true) return 'stale';
  return view.checked_at == null ? 'unchecked' : 'unknown';
}

/** The whole dashboard as the website's Overview reads it (view:"full"). Unbounded: one record per receipt. */
export function fullDashboard(store: Store, actor: Actor, allowWrites: boolean): JsonObject {
  const receipts = store.documents(actor.tenantId, 'write_verification'),
    paused = !!writePause(store, actor.tenantId),
    readinessOf = accountReadiness(store, actor, allowWrites, paused);
  return {
    capabilities: workspaceCapabilities(store, actor),
    at: Date.now(),
    writes_enabled: allowWrites,
    writes_paused: writePause(store, actor.tenantId) ?? null,
    connections: store.listConnections(actor.tenantId).map(c => ({
      id: c.id,
      gateway: c.gateway,
      label: c.label,
      enabled: c.enabled,
      accounts: c.accounts,
      write_accounts: c.writeAccounts ?? [],
      // Sheets, Drive and resource-specific providers have no account read (CON-03).
      readiness: readinessContract(c.gateway) ? 'account_read' : 'not_applicable',
      accounts_status: c.accounts.map(account => ({
        account_id: account,
        // Shared account-read evidence evaluated for this viewer, with its age (CON-03).
        check: readinessOf(c, account),
        verified_writes: receipts
          .filter(r => r.connection_id === c.id && r.account_id === account)
          .map(r => ({review_id: r.id, at: r.checked_at, status: r.status, action: r.action})),
      })),
    })),
    // Bounded (CMP-05): the five newest plans needing attention and the eight newest plans, with counts in SQL; the
    // Campaigns page lists the rest.
    campaigns: homeCampaigns(store, actor),
    campaign_counts: planCounts(store, actor),
    levels,
    limitations,
  };
}
const campaignRow = (r: JsonObject) => ({
  id: r.id,
  name: r.name,
  state: r.state,
  updated_at: r.updated_at,
  steps: (r.steps ?? []).map((s: JsonObject) => ({id: s.id, status: s.status, error: s.error})),
});
function homeCampaigns(store: Store, actor: Actor): JsonObject[] {
  const rows = new Map<string, JsonObject>();
  for (const state of attentionPlanStates) for (const r of recentPlans(store, actor, 5, {state})) rows.set(r.id, r);
  const attention = [...rows.values()].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, 5);
  const out = new Map(attention.map(r => [r.id, r]));
  for (const r of recentPlans(store, actor, 8)) out.set(r.id, r);
  return [...out.values()].map(campaignRow);
}

/**
 * `amcp_workspace dashboard` (MCP-01). By default a bounded summary: counts per provider, one compact row per account
 * with its readiness and the latest verification time, and campaign counts by state. `sections` names the detail to
 * return instead (paged, and filtered by gateway, connection_id and account_id); view:"full" is the whole record the
 * website's Overview reads. Nothing here reads a provider or saves anything.
 */
export function dashboard(store: Store, actor: Actor, allowWrites: boolean, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  const view = input.view ?? 'summary';
  if (view !== 'summary' && view !== 'full')
    bad('dashboard view is "summary" (the default) or "full".', 'INVALID_ARGUMENT', {field: 'view'});
  if (input.offset !== undefined)
    bad('Continue a dashboard section with its next_cursor; offset is not accepted here.', 'INVALID_ARGUMENT', {
      field: 'offset',
    });
  if (view === 'full') {
    for (const key of ['sections', 'gateway', 'connection_id', 'account_id', 'limit', 'cursor'])
      if (input[key] !== undefined)
        bad('view:"full" takes no filters or paging; use sections for bounded detail.', 'INVALID_ARGUMENT', {
          field: key,
        });
    return fullDashboard(store, actor, allowWrites);
  }
  for (const key of ['gateway', 'connection_id', 'account_id'])
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key] || input[key].length > 200))
      bad('Use an exact gateway, connection_id or account_id of up to 200 characters.', 'INVALID_ARGUMENT', {
        field: key,
      });
  const sections: string[] = input.sections ?? ['accounts'];
  if (
    !Array.isArray(sections) ||
    !sections.length ||
    new Set(sections).size !== sections.length ||
    sections.some(s => !dashboardSections.includes(s))
  )
    bad('sections lists distinct dashboard section names, as details.allowed names them.', 'INVALID_ARGUMENT', {
      field: 'sections',
      allowed: dashboardSections,
    });
  if (input.cursor !== undefined && sections.length !== 1)
    bad('A cursor continues one section; request that section alone.', 'INVALID_ARGUMENT', {field: 'cursor'});
  if (input.limit !== undefined && sections.length !== 1)
    bad('limit pages one section; request that section alone.', 'INVALID_ARGUMENT', {field: 'limit'});
  const filters: JsonObject = Object.fromEntries(
    ['gateway', 'connection_id', 'account_id'].filter(k => input[k] !== undefined).map(k => [k, input[k]]),
  );
  const connections = store
      .listConnections(actor.tenantId)
      .filter(
        c =>
          (!filters.gateway || c.gateway === filters.gateway) &&
          (!filters.connection_id || c.id === filters.connection_id),
      ),
    gatewayOf = new Map(store.listConnections(actor.tenantId).map(c => [c.id, c.gateway])),
    matchesAccount = (gateway: string | undefined, id: unknown) =>
      !filters.account_id ||
      (typeof id === 'string' &&
        normalizeAccount(gateway ?? '', id) === normalizeAccount(gateway ?? '', filters.account_id)),
    inScope = (r: JsonObject) =>
      connections.some(c => c.id === r.connection_id) && matchesAccount(gatewayOf.get(r.connection_id), r.account_id);
  const receipts = store.documents(actor.tenantId, 'write_verification').filter(inScope),
    paused = !!writePause(store, actor.tenantId),
    readinessOf = accountReadiness(store, actor, allowWrites, paused),
    accounts = connections.flatMap(c =>
      c.accounts.filter(a => matchesAccount(c.gateway, a)).map(account => ({connection: c, account})),
    );
  const latest = (rows: JsonObject[]) =>
    rows.reduce<number | null>(
      (m, r) => (typeof r.checked_at === 'number' && (m === null || r.checked_at > m) ? r.checked_at : m),
      null,
    );
  const at = Date.now();
  const page = (name: string, rows: unknown[]) => {
    const [fallback, max] = sectionLimits[name]!,
      limit = input.limit ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
      bad('limit is a whole number of rows from 1 to the section maximum in details.max.', 'INVALID_ARGUMENT', {
        field: 'limit',
        section: name,
        max,
      });
    const binding = cursorBinding(store, actor, {action: 'dashboard', section: name, limit, ...filters}),
      offset = decodeOffsetCursor(input.cursor, binding, 'dashboard section'),
      items = rows.slice(offset, offset + limit),
      more = offset + items.length < rows.length,
      next = more ? encodeOffsetCursor(binding, offset + items.length) : null;
    return {
      total: rows.length,
      returned: items.length,
      has_more: more,
      next_cursor: next,
      ...(next
        ? {
            next_call: {
              tool: 'amcp_workspace',
              arguments: {action: 'dashboard', sections: [name], ...filters, limit, cursor: next},
            },
          }
        : {}),
      items,
    };
  };
  const builders: Record<string, () => unknown[]> = {
    accounts: () =>
      accounts.map(({connection: c, account}) => {
        const check = readinessOf(c, account),
          writes = receipts.filter(r => r.connection_id === c.id && r.account_id === account);
        return {
          gateway: c.gateway,
          connection_id: c.id,
          account_id: account,
          enabled: c.enabled,
          write_granted: c.writeAccounts?.includes(account) === true,
          readiness: readinessState(check),
          checked_at: check.checked_at ?? null,
          stale: check.stale === true,
          live_read: check.live_read === true,
          verified_writes: writes.filter(r => r.status === 'verified').length,
          write_receipts: writes.length,
          last_verified_at: latest(writes.filter(r => r.status === 'verified')),
        };
      }),
    providers: () =>
      workspaceCapabilities(store, actor).providers.filter(
        (p: JsonObject) => !filters.gateway || p.gateway === filters.gateway,
      ),
    connections: () =>
      connections.map(c => ({
        id: c.id,
        gateway: c.gateway,
        label: c.label,
        enabled: c.enabled,
        accounts: c.accounts.filter(a => matchesAccount(c.gateway, a)),
        write_accounts: (c.writeAccounts ?? []).filter(a => matchesAccount(c.gateway, a)),
        // What AMCP's own renewals recorded (CON-02), so an Operations connection item's next call explains it (OPS-06).
        credential_health: recordedCredentialHealth(store, c),
      })),
    readiness: () =>
      accounts.map(({connection: c, account}) => ({
        gateway: c.gateway,
        connection_id: c.id,
        account_id: account,
        check: readinessOf(c, account),
      })),
    verified_writes: () =>
      receipts
        .map(r => ({
          review_id: r.id,
          at: r.checked_at,
          status: r.status,
          action: r.action,
          gateway: gatewayOf.get(r.connection_id) ?? null,
          connection_id: r.connection_id,
          account_id: r.account_id,
        }))
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    evidence: () =>
      workspaceCapabilities(store, actor).evidence.filter(
        (e: JsonObject) => connections.some(c => c.id === e.connection_id) && matchesAccount(e.gateway, e.account_id),
      ),
    campaigns: () => visiblePlans(store, actor).map(campaignRow),
    features: () => workspaceCapabilities(store, actor).features,
  };
  const head = {
    at,
    writes_enabled: allowWrites,
    writes_paused: writePause(store, actor.tenantId) ?? null,
    ...(Object.keys(filters).length ? {filters} : {}),
  };
  if (input.sections !== undefined)
    return {
      record_kind: 'dashboard_sections',
      view: 'summary',
      ...head,
      sections: Object.fromEntries(sections.map(name => [name, page(name, builders[name]!())])),
      network_requests: 0,
    };
  const campaigns = planCounts(store, actor),
    gateways = [...new Set(connections.map(c => c.gateway))];
  return {
    record_kind: 'dashboard_summary',
    view: 'summary',
    ...head,
    providers: gateways.map(gateway => {
      const own = accounts.filter(a => a.connection.gateway === gateway),
        writes = receipts.filter(r => gatewayOf.get(r.connection_id) === gateway),
        states = own.map(({connection: c, account}) => readinessState(readinessOf(c, account)));
      return {
        gateway,
        connections: connections.filter(c => c.gateway === gateway).length,
        accounts: own.length,
        write_granted_accounts: own.filter(a => a.connection.writeAccounts?.includes(a.account)).length,
        readiness: Object.fromEntries(readinessStates.map(s => [s, states.filter(x => x === s).length])),
        verified_writes: writes.filter(r => r.status === 'verified').length,
        last_verified_at: latest(writes.filter(r => r.status === 'verified')),
      };
    }),
    accounts: page('accounts', builders.accounts!()),
    campaigns: {total: campaigns.total, by_state: campaigns.by_state},
    section_call: {
      tool: 'amcp_workspace',
      arguments: {action: 'dashboard', sections: ['verified_writes'], ...filters},
      sections: dashboardSections,
      meaning:
        'Ask for one or more sections by name for bounded detail; gateway, connection_id and account_id narrow them and next_cursor continues one section.',
    },
    network_requests: 0,
    levels,
    limitations,
  };
}
