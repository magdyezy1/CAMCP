import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint} from './workspace-core.js';
import {normalizeAccount} from './scope.js';
import {reportPresets} from './report-presets.js';

const scalar = (path: string, max = 200) =>
  `CASE WHEN json_type(data,'$.${path}')='text' AND length(json_extract(data,'$.${path}'))<=${max}
    THEN json_extract(data,'$.${path}') ELSE NULL END`;
// SQLite projects only bounded metadata. Native rows, page responses, requests and arbitrary fields
// never enter the discovery response or a JavaScript document array.
const selection = `tenant_id=? AND kind='decision_report' AND length(id) BETWEEN 1 AND 160 AND id>?
  AND (? IS NULL OR json_extract(data,'$.gateway')=?)
  AND (? IS NULL OR json_extract(data,'$.connection_id')=?)
  AND (? IS NULL OR json_extract(data,'$.preset')=?)`;
export const evidenceIndexSQL = `SELECT id,revision,json_object(
  'gateway',${scalar('gateway', 160)},'account_id',${scalar('account_id')},
  'connection_id',${scalar('connection_id')},'preset',${scalar('preset', 160)},
  'grain',${scalar('grain')},'source',${scalar('source', 80)},'source_hash',${scalar('source_hash', 128)},
  'captured_at',CASE WHEN json_type(data,'$.captured_at')='integer'
    AND json_extract(data,'$.captured_at') BETWEEN 0 AND 9007199254740991
    THEN json_extract(data,'$.captured_at') ELSE NULL END,
  'row_count',CASE WHEN json_type(data,'$.rows')='array' THEN json_array_length(data,'$.rows') ELSE NULL END,
  'semantics',json_object(${['source_name', 'currency', 'timezone', 'date_from', 'date_to', 'attribution', 'conversion_definition'].map(key => `'${key}',${scalar('semantics.' + key)}`).join(',')},
    'complete',json(CASE json_type(data,'$.semantics.complete') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE 'null' END))
  ) AS metadata FROM documents
  WHERE ${selection} ORDER BY id LIMIT ?`;

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
  const query = store.db.prepare(evidenceIndexSQL),
    remaining = store.db.prepare(`SELECT id FROM documents WHERE ${selection} ORDER BY id LIMIT 1`);
  const reports: JsonObject[] = [];
  let last = after,
    hasMore = false,
    scanned = 0;
  collection: while (scanned < 500) {
    const size = Math.min(limit + 1, 500 - scanned),
      rows = query.all(...params(last), size) as JsonObject[];
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
        hasMore = i + 1 < rows.length || (rows.length === size && Boolean(remaining.get(...params(last))));
        break collection;
      }
    }
    if (rows.length < size) break;
    if (scanned === 500) hasMore = Boolean(remaining.get(...params(last)));
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
