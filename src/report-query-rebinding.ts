import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, identifier} from './workspace-core.js';
import {reportingQueryRecord} from './report-query-access.js';
import {workbookBinding} from './workbook-bindings.js';

/** Scope and bound both associations before moving a query or any of its schedule metadata. */
export function reportingBindingMove(store: Store, actor: Actor, id: unknown, targetId: unknown) {
  const query = reportingQueryRecord(store, actor, id);
  const source = workbookBinding(store, actor, query.workbook_binding_id);
  const target = workbookBinding(store, actor, identifier(targetId, 'target workbook binding ID'));
  if (source.retired || target.retired)
    bad('Restore a retired workbook association before moving queries to or from it.', 'REPORT_BINDING_RETIRED');
  if (source.id === target.id) bad('Choose a different workbook association.', 'REPORT_BINDING_UNCHANGED');
  if (target.query_count >= 500)
    bad('A workbook binding supports at most 500 attached queries.', 'REPORT_BINDING_QUERY_LIMIT');
  const rows = store.db
    .prepare(
      "SELECT id,revision,length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.workbook_binding_id') AS binding_id,json_extract(data,'$.is_active') AS active FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? ORDER BY id LIMIT 101",
    )
    .all(actor.tenantId, query.id) as JsonObject[];
  if (rows.length > 100) bad('A reviewed query move supports up to 100 schedules.', 'REPORT_QUERY_SCHEDULE_LIMIT');
  for (const row of rows) {
    if (row.bytes > 65536) bad('This legacy schedule exceeds the 64 KiB settings limit.', 'REPORT_SCHEDULE_TOO_LARGE');
    if (row.binding_id !== source.id || ![0, 1].includes(row.active))
      bad(
        'A linked schedule has inconsistent workbook or active-state metadata. Inspect it before moving this query.',
        'REPORT_BINDING_MISMATCH',
      );
  }
  const projection = (binding: typeof source) => ({
    id: binding.id,
    spreadsheet_id: binding.spreadsheet_id,
    spreadsheet_name: binding.spreadsheet_name,
    name_omitted: binding.name_omitted,
    website_path: binding.website_path,
  });
  return {
    id: query.id,
    source: projection(source),
    target: projection(target),
    schedules: rows.map(row => ({
      id: row.id,
      revision: row.revision,
      active: row.active === 1,
      website_path: '/operations?workbook_schedule_id=' + encodeURIComponent(row.id),
    })),
    schedules_to_rebind: rows.length,
    schedules_to_pause: rows.filter(row => row.active === 1).length,
    rebinding_version: fingerprint({
      query: query.revision,
      source: source.binding_version,
      target: target.binding_version,
      schedules: rows,
    }),
  };
}

/** Called only inside the same transaction as the query revision and audit. Existing jobs are never rewritten. */
export function moveWorkbookSchedules(store: Store, actor: Actor, move: ReturnType<typeof reportingBindingMove>) {
  const update = store.db.prepare(
    "UPDATE documents SET data=json_set(data,'$.workbook_binding_id',?,'$.is_active',json('false'),'$.pause_reason','workbook_binding_changed','$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='reporting_schedule' AND id=? AND revision=?",
  );
  const now = new Date().toISOString();
  for (const schedule of move.schedules) {
    const changed = update.run(move.target.id, now, actor.tenantId, schedule.id, schedule.revision).changes;
    if (Number(changed) !== 1)
      bad('A linked schedule changed. Refresh before moving the query.', 'STALE_REPORT_REBINDING');
  }
}
