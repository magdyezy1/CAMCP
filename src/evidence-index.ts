import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {reportPresets} from './report-presets.js';
import {evidenceStatements} from './report-repository.js';
// The bounded metadata projection is in the store layer (src/report-repository.ts).
export {evidenceIndexSQL} from './report-repository.js';

export function evidenceIndex(store: Store, actor: Actor, input: JsonObject) {
  store.assertActorActive(actor);
  const limit = input.limit ?? 30,
    search = input.search ?? '';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) bad('Use an evidence page size of 1–100.');
  if (input.offset !== undefined && input.offset !== 0)
    bad('Saved evidence discovery uses next_cursor; restart from the first page.');
  if (typeof search !== 'string' || search.length > 150 || /[\x00-\x1f\x7f]/.test(search))
    bad('Use at most 150 plain-text search characters.');
  for (const key of ['gateway', 'connection_id', 'account_id'])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== 'string' || !input[key] || input[key].length > 200 || /[\x00-\x1f\x7f]/.test(input[key]))
    )
      bad('Use an exact ' + key + '.');
  if (input.account_id !== undefined && input.gateway === undefined)
    bad('Choose the gateway together with the account filter.');
  if (input.preset !== undefined && !reportPresets.some(p => p.id === input.preset))
    bad('Choose a supported evidence preset filter.');
  const filters = {
    search: search.trim().toLowerCase(),
    gateway: input.gateway ?? null,
    connection_id: input.connection_id ?? null,
    preset: input.preset ?? null,
    account_id: input.account_id === undefined ? null : normalizeAccount(input.gateway, input.account_id),
  };
  const binding = () =>
    fingerprint({
      workflow: 'evidence-index-v1',
      tenant: actor.tenantId,
      user: actor.userId,
      role: actor.role,
      session: store.sessionIdentity(actor) ?? null,
      filters,
      connections: store
        .connectionsFor(actor)
        .map(c => ({
          id: c.id,
          gateway: c.gateway,
          enabled: c.enabled,
          accounts: [...c.accounts].sort(),
          scopes: [...c.scopes].sort(),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  const original = binding();
  let after = '';
  if (input.cursor !== undefined) {
    const value = store.openReadCursor(actor, original, input.cursor);
    if (value.version !== 1 || typeof value.after !== 'string' || !value.after || value.after.length > 160)
      bad('Restart saved evidence discovery from the first page.', 'INVALID_READ_CURSOR');
    after = value.after;
  }
  const params = (position: string) => [
    actor.tenantId,
    position,
    filters.gateway,
    filters.gateway,
    filters.connection_id,
    filters.connection_id,
    filters.preset,
    filters.preset,
  ];
  const statements = evidenceStatements(store);
  const reports: JsonObject[] = [];
  let last = after,
    hasMore = false,
    scanned = 0;
  collection: while (scanned < 500) {
    const size = Math.min(limit + 1, 500 - scanned),
      rows = statements.page(params(last), size);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      last = row.id;
      scanned++;
      const metadata = JSON.parse(row.metadata);
      store.assertActorActive(actor);
      if (/[\x00-\x1f\x7f]/.test(row.id)) continue;
      if (!['gateway', 'account_id', 'connection_id'].every(k => typeof metadata[k] === 'string' && metadata[k]))
        continue;
      try {
        store.resolveConnection(actor, metadata.gateway, metadata.account_id, metadata.connection_id);
      } catch {
        store.assertActorActive(actor);
        continue;
      }
      store.assertActorActive(actor);
      if (filters.account_id !== null && normalizeAccount(metadata.gateway, metadata.account_id) !== filters.account_id)
        continue;
      if (
        filters.search &&
        ![row.id, metadata.semantics.source_name, metadata.account_id, metadata.preset].some(
          v => typeof v === 'string' && v.toLowerCase().includes(filters.search),
        )
      )
        continue;
      reports.push({id: row.id, revision: row.revision, ...metadata});
      if (reports.length === limit) {
        hasMore = i + 1 < rows.length || (rows.length === size && statements.remains(params(last)));
        break collection;
      }
    }
    if (rows.length < size) break;
    if (scanned === 500) hasMore = statements.remains(params(last));
  }
  store.assertActorActive(actor);
  if (binding() !== original) bad('Account access changed. Refresh saved evidence discovery.', 'INVALID_READ_CURSOR');
  return {
    reports,
    has_more: hasMore,
    next_cursor: hasMore ? store.sealReadCursor(actor, original, {version: 1, after: last}) : null,
    network_requests: 0,
  };
}
