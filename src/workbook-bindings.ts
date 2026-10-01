import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, identifier, validate, writer} from './workspace-core.js';
import {reportingWorkbookAccess, reportQuerySQL} from './report-query-access.js';
import {reportRunScope} from './report-runs.js';

/** Local associations only. This projection never exposes preferences, stored URLs or query configurations. */
export function workbookBinding(store: Store, actor: Actor, id: unknown) {
  const binding = reportingWorkbookAccess(store, actor, identifier(id, 'workbook binding ID'), true);
  if (typeof binding.spreadsheet_id !== 'string' || !binding.spreadsheet_id || binding.spreadsheet_id.length > 200)
    bad('The legacy workbook association has an invalid spreadsheet ID.', 'REPORT_BINDING_INVALID');
  const rows = store.db
    .prepare(reportQuerySQL + " AND json_extract(q.data,'$.workbook_binding_id')=? ORDER BY q.id LIMIT 501")
    .all(actor.tenantId, binding.id) as JsonObject[];
  if (rows.length > 500) bad('A workbook binding supports at most 500 attached queries.', 'REPORT_BINDING_QUERY_LIMIT');
  const queries = rows.map(row => {
    const metadata = JSON.parse(row.metadata),
      scope = reportRunScope(store, actor, metadata);
    return {
      id: row.id,
      name: metadata.name,
      revision: row.revision,
      ...scope,
      website_path: '/operations?query_id=' + encodeURIComponent(row.id),
    };
  });
  const nameAvailable = typeof binding.spreadsheet_name === 'string' && binding.spreadsheet_name.length <= 2000;
  return {
    id: binding.id,
    record_kind: 'workbook_binding',
    revision: binding.revision,
    spreadsheet_id: binding.spreadsheet_id,
    spreadsheet_name: nameAvailable ? binding.spreadsheet_name : binding.spreadsheet_id,
    name_omitted: !nameAvailable && binding.spreadsheet_name !== undefined,
    query_count: queries.length,
    queries: queries.slice(0, 100),
    queries_truncated: queries.length > 100,
    binding_version: fingerprint({id: binding.id, revision: binding.revision, queries}),
    retired: binding.retired_at != null,
    can_edit: actor.role !== 'reader' && binding.retired_at == null,
    can_manage_state: actor.role !== 'reader' && queries.length === 0,
    external_access_verified: false,
    network_requests: 0,
    website_path: '/operations?workbook_binding_id=' + encodeURIComponent(binding.id),
    next_call: {tool: 'amcp_workspace', arguments: {action: 'report_binding', id: binding.id}},
    meaning:
      'Saved local workbook association. Its spreadsheet access has not been verified. Workbook reporting runs retain output in this workspace; this association is separate from Overview delivery destinations.',
  };
}

export function workbookBindingPage(store: Store, actor: Actor, input: JsonObject) {
  store.assertActorActive(actor);
  const limit = input.limit ?? 20,
    offset = input.offset ?? 0,
    search = input.search ?? '';
  const state = input.state ?? 'active';
  if (!['active', 'retired', 'all'].includes(state)) bad('Choose active, retired or all workbook associations.');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof search !== 'string' ||
    search.length > 200
  )
    bad('Use a workbook page limit of 1–100, nonnegative offset and search up to 200 characters.');
  if (
    input.spreadsheet_id !== undefined &&
    (typeof input.spreadsheet_id !== 'string' || input.spreadsheet_id.length > 200)
  )
    bad('Use an exact spreadsheet ID up to 200 characters.');
  const rows = store.db
    .prepare(
      "SELECT id FROM documents WHERE tenant_id=? AND kind='workbook'" +
        (state === 'all'
          ? ''
          : " AND json_extract(data,'$.retired_at') IS " + (state === 'active' ? 'NULL' : 'NOT NULL')) +
        (input.spreadsheet_id ? " AND json_extract(data,'$.spreadsheet_id')=?" : '') +
        ' ORDER BY id LIMIT 51 OFFSET ?',
    )
    .all(actor.tenantId, ...(input.spreadsheet_id ? [input.spreadsheet_id] : []), offset) as JsonObject[];
  const bindings: JsonObject[] = [];
  let scanned = 0;
  for (const row of rows.slice(0, 50)) {
    scanned++;
    try {
      const detail = workbookBinding(store, actor, row.id);
      if (
        ![detail.id, detail.spreadsheet_id, detail.spreadsheet_name]
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase())
      )
        continue;
      const {queries, binding_version, ...metadata} = detail;
      bindings.push({
        ...metadata,
        spreadsheet_name: metadata.spreadsheet_name.slice(0, 160),
        name_truncated: metadata.spreadsheet_name.length > 160,
      });
      if (bindings.length === limit) break;
    } catch (error) {
      if (!(error instanceof MirrorError)) throw error;
    }
  }
  return {
    record_kind: 'workbook_bindings',
    bindings,
    next_offset: rows.length > scanned ? offset + scanned : null,
    network_requests: 0,
  };
}

export function previewWorkbookBinding(store: Store, actor: Actor, input: JsonObject) {
  const current = workbookBinding(store, actor, input.id);
  if (current.retired) bad('Restore this retired workbook association before renaming it.', 'REPORT_BINDING_RETIRED');
  if (current.binding_version !== input.binding_version)
    bad('The workbook setup or linked queries changed. Refresh before editing.', 'STALE_REPORT_BINDING');
  validate(input.binding, ['spreadsheet_name'], 1024, 'workbook setting');
  const name = input.binding.spreadsheet_name;
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))
    bad('Use a single-line workbook name in 1–120 characters.');
  const after = name.trim();
  return {
    id: current.id,
    record_kind: 'workbook_binding_preview',
    binding_version: current.binding_version,
    binding: {spreadsheet_name: after},
    spreadsheet_id: current.spreadsheet_id,
    changes:
      current.spreadsheet_name === after && !current.name_omitted
        ? []
        : [{field: 'spreadsheet_name', before: current.name_omitted ? null : current.spreadsheet_name, after}],
    query_count: current.query_count,
    network_requests: 0,
    external_writes: false,
    meaning:
      'Rename only the saved local workbook association. Its spreadsheet ID, stored preferences, linked queries, schedules and existing report runs remain unchanged. No external spreadsheet is renamed or accessed.',
  };
}

export function saveWorkbookBinding(store: Store, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true) bad('Confirm renaming this local workbook setup.', 'CONFIRMATION_REQUIRED');
  return store.transaction(() => {
    const preview = previewWorkbookBinding(store, actor, input);
    if (preview.changes.length) {
      const {id, revision, ...value} = reportingWorkbookAccess(store, actor, input.id);
      const result = store.putDocument(
        actor.tenantId,
        'workbook',
        id,
        {...value, ...preview.binding, updated_at: new Date().toISOString()},
        revision,
      );
      store.appendAudit(actor.tenantId, 'reporting/' + id, {
        event: 'workbook_binding_renamed',
        id,
        revision: result.revision,
        actor: actor.userId,
        fields: ['spreadsheet_name'],
      });
    }
    return {...workbookBinding(store, actor, input.id), changed: preview.changes.length > 0, external_writes: false};
  });
}

export function previewWorkbookBindingState(store: Store, actor: Actor, input: JsonObject) {
  const current = workbookBinding(store, actor, input.id);
  if (current.binding_version !== input.binding_version)
    bad('The workbook setup or linked queries changed. Refresh before changing its state.', 'STALE_REPORT_BINDING');
  if (typeof input.active !== 'boolean') bad('Choose an active or retired workbook state.');
  const linkedSchedule = store.db
    .prepare(
      "SELECT 1 AS present FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.workbook_binding_id')=? LIMIT 1",
    )
    .get(actor.tenantId, current.id);
  if (current.query_count || linkedSchedule)
    bad(
      'Move all linked queries and schedules before changing this workbook association state.',
      'REPORT_BINDING_IN_USE',
    );
  return {
    id: current.id,
    record_kind: 'workbook_binding_state_preview',
    binding_version: current.binding_version,
    active: input.active,
    retired: current.retired,
    spreadsheet_id: current.spreadsheet_id,
    spreadsheet_name: current.spreadsheet_name,
    changes: current.retired === !input.active ? [] : ['retired'],
    network_requests: 0,
    external_writes: false,
    external_access_verified: false,
    meaning:
      'Retire or restore an empty local workbook association. Keep its saved identity and settings. Retirement hides it from active lists and prevents new use until explicitly restored. No query, schedule, report run or external spreadsheet is deleted or changed.',
  };
}

export function saveWorkbookBindingState(store: Store, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true) bad('Confirm changing the local workbook association state.', 'CONFIRMATION_REQUIRED');
  return store.transaction(() => {
    const preview = previewWorkbookBindingState(store, actor, input);
    if (preview.changes.length) {
      const {id, revision, ...value} = reportingWorkbookAccess(store, actor, preview.id, true);
      if (preview.active) {
        delete value.retired_at;
        delete value.retired_by;
      } else {
        value.retired_at = Date.now();
        value.retired_by = actor.ownerUserId ?? actor.userId;
      }
      const result = store.putDocument(
        actor.tenantId,
        'workbook',
        id,
        {...value, updated_at: new Date().toISOString()},
        revision,
      );
      store.appendAudit(actor.tenantId, 'reporting/' + id, {
        event: preview.active ? 'workbook_binding_restored' : 'workbook_binding_retired',
        id,
        revision: result.revision,
        actor: actor.userId,
      });
    }
    return {...workbookBinding(store, actor, preview.id), changed: preview.changes.length > 0, external_writes: false};
  });
}
