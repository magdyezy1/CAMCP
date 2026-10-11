import {MirrorError} from '../src/errors.js';
import type {Store} from '../src/store.js';
import type {Actor, JsonObject} from '../src/types.js';

/** One workspace entity the search found: what it is, its name, a short detail and the website page that opens it. */
export type WorkspaceSearchHit = {
  kind: 'plan' | 'report' | 'snapshot' | 'media' | 'account';
  id: string;
  label: string;
  detail: string;
  href: string;
};
/** A first-party tool call made as the searching person, returning its envelope ({success, data} or an error). */
export type WorkspaceSearchCall = (tool: string, input: JsonObject) => Promise<JsonObject>;

/** At most this many results of each kind: the palette lists a few, and the page itself lists the rest. */
export const workspaceSearchLimit = 5;
const reportScan = 100;

/** The query, trimmed: 2 to 100 characters without control characters, or a refusal naming `q`. */
export function workspaceSearchQuery(value: unknown): string {
  const q = typeof value === 'string' ? value.trim() : '';
  if (q.length < 2 || q.length > 100 || /[\u0000-\u001f\u007f]/.test(q))
    throw new MirrorError('INVALID_ARGUMENT', 'Search for 2 to 100 characters.', {field: 'q'}, 400);
  return q;
}
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const optionalDocument = (store: Store, tenant: string, kind: string, id: string): JsonObject | undefined => {
  try {
    return store.document(tenant, kind, id);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
};
/** A report's name as the website shows it: the client's name, then the report's. */
const reportLabel = (config: JsonObject | undefined) =>
  [text(config?.client_name), text(config?.name)].filter(Boolean).join(' · ') || 'Report';

/**
 * Workspace search (WEB-09, owner opt-in): finds the campaign plans, saved reports, report snapshots, uploaded media and
 * connected accounts already stored in AMCP, by name or ID, for the website's command palette. Plans, snapshots and
 * media are read through the same first-party list operations the website's own pages call, as the searching person,
 * so the same visibility and account-access checks apply; saved reports and accounts are the records the report builder
 * and the Connections page already list to every member. Nothing is sent to a provider and nothing is saved: every source
 * is a local read. A source that refuses or fails is reported as unavailable while the others still answer.
 */
export async function workspaceSearch(
  store: Store,
  actor: Actor,
  query: unknown,
  call: WorkspaceSearchCall,
): Promise<JsonObject> {
  const q = workspaceSearchQuery(query),
    needle = q.toLowerCase(),
    tenant = actor.tenantId,
    matches = (...values: unknown[]) => values.some(v => text(v).toLowerCase().includes(needle)),
    sources: Record<string, 'ok' | 'unavailable'> = {};
  store.assertActorActive(actor);
  const read = async (kind: string, fn: () => Promise<WorkspaceSearchHit[]> | WorkspaceSearchHit[]) => {
    try {
      const hits = (await fn()).slice(0, workspaceSearchLimit);
      sources[kind] = 'ok';
      return hits;
    } catch {
      sources[kind] = 'unavailable';
      return [];
    }
  };
  const data = async (tool: string, input: JsonObject) => {
    const r = await call(tool, input);
    if (r?.success !== true) throw Error('refused');
    return r.data as JsonObject;
  };
  const [plans, snapshots, media] = await Promise.all([
    read('plan', async () =>
      ((await data('amcp_campaign', {action: 'list', search: q, limit: workspaceSearchLimit})).campaigns ?? []).map(
        (p: JsonObject): WorkspaceSearchHit => ({
          kind: 'plan',
          id: String(p.id),
          label: text(p.name) || String(p.id),
          detail: text(p.state),
          href: '/campaigns?id=' + encodeURIComponent(String(p.id)),
        }),
      ),
    ),
    read('snapshot', async () =>
      ((await data('amcp_reporting_overview', {action: 'list', limit: reportScan})).reports ?? [])
        .filter((r: JsonObject) => matches(r.config?.name, r.config?.client_name, r.id))
        .map((r: JsonObject): WorkspaceSearchHit => ({
          kind: 'snapshot',
          id: String(r.id),
          label: reportLabel(r.config),
          detail: text(r.state),
          href: '/reporting-overview?report_id=' + encodeURIComponent(String(r.id)),
        })),
    ),
    read('media', async () =>
      ((await data('amcp_media', {action: 'library', search: q, limit: workspaceSearchLimit})).assets ?? []).map(
        (a: JsonObject): WorkspaceSearchHit => ({
          kind: 'media',
          id: String(a.asset_id),
          label: text(a.name) || text(a.filename) || String(a.asset_id),
          detail: [text(a.platform), text(a.account_id)].filter(Boolean).join(' · '),
          href:
            typeof a.website_path === 'string' && a.website_path.startsWith('/media?')
              ? a.website_path
              : '/media?asset_id=' + encodeURIComponent(String(a.asset_id)),
        }),
      ),
    ),
  ]);
  const reports = await read('report', () =>
    store
      .documents(tenant, 'overview_view')
      .filter(v => matches(v.config?.name, v.config?.client_name, v.id))
      .map(v => ({
        kind: 'report' as const,
        id: String(v.id),
        label: reportLabel(v.config),
        detail: Array.isArray(v.config?.sources) ? String(v.config.sources.length) : '',
        href: '/reporting-overview?view_id=' + encodeURIComponent(String(v.id)),
      })),
  );
  const accounts = await read('account', () =>
    store.listConnections(tenant).flatMap(c => {
      const names = new Map<string, string>();
      for (const group of optionalDocument(store, tenant, 'website_assets', c.id)?.groups ?? [])
        for (const asset of group?.assets ?? [])
          if (asset && typeof asset.name === 'string') names.set(String(asset.id).replace(/^act_/, ''), asset.name);
      return c.accounts
        .filter(id => matches(id, names.get(id.replace(/^act_/, '')), c.label))
        .map(id => ({
          kind: 'account' as const,
          id,
          label: names.get(id.replace(/^act_/, '')) ?? id,
          detail: [c.gateway, c.label].filter(Boolean).join(' · '),
          href: '/connections?connection_id=' + encodeURIComponent(c.id),
        }));
    }),
  );
  return {
    query: q,
    results: [...plans, ...reports, ...snapshots, ...media, ...accounts],
    sources,
    limit_per_kind: workspaceSearchLimit,
    provider_requests: 0,
  };
}
