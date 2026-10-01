import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {reportRunScope, reportScopeFieldsSQL} from './report-runs.js';
import {bad, fingerprint, noSecrets, obj} from './workspace-core.js';
import {redact} from './security.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {applyExecutionRisk} from './execution-risk.js';

let registry: Registry | undefined;
// Leave room for the query's ID, name, binding and revision around a 64 KiB configuration.
export const reportQueryRecordLimit = 73728;
export const reportQuerySQL = `SELECT q.id,q.revision,length(CAST(q.data AS BLOB)) AS bytes,json_object(
  'name',substr(json_extract(q.data,'$.name'),1,120),
  'workbook_binding_id',substr(json_extract(q.data,'$.workbook_binding_id'),1,160),
  'updated_at',json_extract(q.data,'$.updated_at'),
  ${reportScopeFieldsSQL('q.data')}) AS metadata
  FROM documents q WHERE q.tenant_id=? AND q.kind='reporting_query'`;
export function reportingConfigScope(store: Store, actor: Actor, config: JsonObject) {
  const row = store.db
    .prepare(`SELECT json_object(${reportScopeFieldsSQL('q.data')}) AS metadata FROM (SELECT ? AS data) q`)
    .get(JSON.stringify({query_config: config})) as JsonObject;
  return reportRunScope(store, actor, JSON.parse(row.metadata));
}
export function validateReportingConfig(store: Store, actor: Actor, config: JsonObject) {
  if (!obj(config) || Buffer.byteLength(JSON.stringify(config)) > 65536)
    bad('Use a reporting query object no larger than 64 KiB.');
  noSecrets(config);
  if (fingerprint(config) !== fingerprint(redact(config)))
    bad('Store credentials in Connections, not reporting queries.');
  const scope = reportingConfigScope(store, actor, config);
  if (config.gateway) {
    registry ??= new Registry();
    registry.validate(config.gateway, config.arguments, {mode: 'strict', flags: {}});
    const plan =
      registry.tools.get(config.gateway)?.mode === 'delegated'
        ? new DelegatedNativeCompiler().compile(config.gateway, config.arguments)
        : new Compiler(registry).compile(config.gateway, config.arguments, {mode: 'strict', flags: {}});
    if (!applyExecutionRisk(plan).readOnly)
      bad('Saved reporting queries require an independently classified native read.', 'REPORT_WRITE_FORBIDDEN');
    // The native compiler is a second authority on account identity; projection aliases cannot hide another target.
    if (
      plan.accountId &&
      reportRunScope(store, actor, {
        gateway: plan.gateway,
        account_anchors: [plan.accountId],
        connection_anchors: [scope.connection_id],
      }).account_id !== scope.account_id
    )
      bad('The native request does not match the explicit reporting account.', 'REPORT_SCOPE_UNAVAILABLE');
  }
  return scope;
}
export function reportingQueryScope(store: Store, actor: Actor, id: unknown) {
  store.assertActorActive(actor);
  if (typeof id !== 'string' || !id || id.length > 160) bad('Choose an exact saved query ID.');
  const row = store.db.prepare(reportQuerySQL + ' AND q.id=?').get(actor.tenantId, id) as JsonObject | undefined;
  if (!row) throw new MirrorError('NOT_FOUND', 'Saved query not found in this workspace.', {}, 404);
  const metadata = JSON.parse(row.metadata),
    scope = reportRunScope(store, actor, metadata);
  return {id: row.id as string, revision: row.revision as number, bytes: row.bytes as number, metadata, scope};
}
export function reportingQueryRecord(store: Store, actor: Actor, id: unknown) {
  const p = reportingQueryScope(store, actor, id);
  if (p.bytes > reportQueryRecordLimit)
    bad('This legacy query exceeds the 72 KiB record limit.', 'REPORT_QUERY_TOO_LARGE');
  return store.document(actor.tenantId, 'reporting_query', p.id);
}
export function reportingWorkbookAccess(store: Store, actor: Actor, id: string, allowRetired = false) {
  store.assertActorActive(actor);
  const size = store.db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) AS bytes,json_extract(data,'$.created_by') AS creator FROM documents WHERE tenant_id=? AND kind='workbook' AND id=?",
    )
    .get(actor.tenantId, id) as JsonObject | undefined;
  if (!size) throw new MirrorError('NOT_FOUND', 'Workbook binding not found in this workspace.', {}, 404);
  if (size?.bytes > 65536) bad('This legacy binding exceeds the 64 KiB settings limit.', 'REPORT_BINDING_TOO_LARGE');
  const rows = store.db
    .prepare(reportQuerySQL + " AND json_extract(q.data,'$.workbook_binding_id')=? LIMIT 501")
    .all(actor.tenantId, id) as JsonObject[];
  if (rows.length > 500) bad('A workbook binding supports at most 500 attached queries.', 'REPORT_BINDING_QUERY_LIMIT');
  if (rows.length) for (const row of rows) reportRunScope(store, actor, JSON.parse(row.metadata));
  else if (size.creator !== (actor.ownerUserId ?? actor.userId) && actor.role !== 'admin')
    bad(
      'Only this binding creator or a workspace administrator can manage an empty workbook binding.',
      'REPORT_BINDING_ACCESS_REQUIRED',
    );
  const binding = store.document(actor.tenantId, 'workbook', id);
  if (binding.retired_at != null && !allowRetired)
    bad(
      'This workbook association is retired. Restore it through Workbook setup before using it.',
      'REPORT_BINDING_RETIRED',
    );
  return binding;
}
export function reportQueryPage(store: Store, actor: Actor, input: JsonObject) {
  store.assertActorActive(actor);
  const limit = input.limit ?? 50,
    offset = input.offset ?? 0,
    search = input.search ?? '';
  if (
    input.spreadsheet_id !== undefined &&
    (typeof input.spreadsheet_id !== 'string' || input.spreadsheet_id.length > 200)
  )
    bad('Use an exact spreadsheet ID up to 200 characters.');
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    typeof search !== 'string' ||
    search.length > 200
  )
    bad('Use a query page limit of 1–100, nonnegative offset and search up to 200 characters.');
  const rows = store.db
      .prepare(
        reportQuerySQL +
          (input.spreadsheet_id
            ? " AND EXISTS(SELECT 1 FROM documents w WHERE w.tenant_id=q.tenant_id AND w.kind='workbook' AND w.id=json_extract(q.data,'$.workbook_binding_id') AND json_extract(w.data,'$.spreadsheet_id')=?)"
            : '') +
          ' ORDER BY q.id LIMIT 501 OFFSET ?',
      )
      .all(actor.tenantId, ...(input.spreadsheet_id ? [input.spreadsheet_id] : []), offset) as JsonObject[],
    result: JsonObject[] = [];
  let scanned = 0;
  for (const row of rows.slice(0, 500)) {
    scanned++;
    try {
      const p = JSON.parse(row.metadata),
        scope = reportRunScope(store, actor, p);
      if (input.account_id && input.account_id !== scope.account_id) continue;
      if (input.connection_id && input.connection_id !== scope.connection_id) continue;
      if (![p.name, row.id, scope.account_id].join(' ').toLowerCase().includes(search.trim().toLowerCase())) continue;
      result.push({
        id: row.id,
        name: p.name,
        revision: row.revision,
        ...scope,
        workbook_binding_id: p.workbook_binding_id,
        configuration_bytes: row.bytes,
        website_path: '/operations?query_id=' + encodeURIComponent(row.id),
        next_call: {tool: 'amcp_workspace', arguments: {action: 'report_query', id: row.id}},
      });
      if (result.length === limit) break;
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
    }
  }
  return {
    record_kind: 'workbook_queries',
    queries: result,
    next_offset: rows.length > scanned ? offset + scanned : null,
    network_requests: 0,
  };
}
export function reportingBootstrap(store: Store, actor: Actor, input: JsonObject) {
  const page = reportQueryPage(store, actor, {limit: 100, spreadsheet_id: input.spreadsheet_id}),
    queries: JsonObject[] = [],
    workbooks: JsonObject[] = [],
    schedules: JsonObject[] = [];
  let remainingBytes = 262144;
  for (const item of page.queries) {
    if (item.configuration_bytes > reportQueryRecordLimit || item.configuration_bytes > remainingBytes) {
      queries.push({...item, configuration_omitted: true});
      continue;
    }
    const query = store.document(actor.tenantId, 'reporting_query', item.id);
    remainingBytes -= item.configuration_bytes;
    let workbook: JsonObject | undefined;
    try {
      workbook = reportingWorkbookAccess(store, actor, query.workbook_binding_id);
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
    }
    if (input.spreadsheet_id && workbook?.spreadsheet_id !== input.spreadsheet_id) continue;
    const {actor_binding, ...publicQuery} = query;
    queries.push({...redact(publicQuery), next_call: item.next_call});
    if (workbook && !workbooks.some(w => w.id === workbook!.id)) {
      const bytes = Buffer.byteLength(JSON.stringify(workbook));
      if (bytes <= remainingBytes) {
        workbooks.push(redact(workbook));
        remainingBytes -= bytes;
      } else workbooks.push({id: workbook.id, spreadsheet_id: workbook.spreadsheet_id, settings_omitted: true});
    }
    const linked = store.db
      .prepare(
        "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM documents WHERE tenant_id=? AND kind='reporting_schedule' AND json_extract(data,'$.schedule_config.query_id')=? AND json_extract(data,'$.workbook_binding_id')=? ORDER BY id LIMIT 100",
      )
      .all(actor.tenantId, item.id, query.workbook_binding_id) as JsonObject[];
    for (const row of linked) {
      if (schedules.length >= 100) break;
      if (row.bytes <= 65536 && row.bytes <= remainingBytes) {
        const {actor_binding, ...schedule} = store.document(actor.tenantId, 'reporting_schedule', row.id);
        schedules.push(redact(schedule));
        remainingBytes -= row.bytes;
      } else
        schedules.push({
          id: row.id,
          settings_omitted: true,
          query_id: query.id,
          next_call: {tool: 'amcp_workspace', arguments: {action: 'report_schedule', id: row.id}},
        });
    }
  }
  // Empty bindings have no provider scope yet; retain only the creator/admin's local setup records.
  const empty = store.db
    .prepare(
      "SELECT w.id FROM documents w WHERE w.tenant_id=? AND w.kind='workbook' AND json_extract(w.data,'$.retired_at') IS NULL AND (?='admin' OR json_extract(w.data,'$.created_by')=?) AND (? IS NULL OR json_extract(w.data,'$.spreadsheet_id')=?) AND NOT EXISTS(SELECT 1 FROM documents q WHERE q.tenant_id=w.tenant_id AND q.kind='reporting_query' AND json_extract(q.data,'$.workbook_binding_id')=w.id) ORDER BY w.id LIMIT 100",
    )
    .all(
      actor.tenantId,
      actor.role,
      actor.ownerUserId ?? actor.userId,
      input.spreadsheet_id ?? null,
      input.spreadsheet_id ?? null,
    ) as JsonObject[];
  for (const row of empty)
    try {
      const w = reportingWorkbookAccess(store, actor, row.id);
      if ((!input.spreadsheet_id || w.spreadsheet_id === input.spreadsheet_id) && workbooks.length < 100) {
        const bytes = Buffer.byteLength(JSON.stringify(w));
        if (bytes <= remainingBytes) {
          workbooks.push(redact(w));
          remainingBytes -= bytes;
        } else workbooks.push({id: w.id, spreadsheet_id: w.spreadsheet_id, settings_omitted: true});
      }
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
    }
  store.assertActorActive(actor);
  return {
    workspace_id: actor.tenantId,
    workbooks,
    queries,
    schedules,
    destination: 'local',
    google_sheets_connected: false,
    external_writes: false,
    limits: {queries: 100, schedules: 100, workbooks: 100},
    next_query_offset: page.next_offset,
    next_call: {
      tool: 'amcp_workspace',
      arguments: {
        action: 'report_queries',
        ...(input.spreadsheet_id ? {spreadsheet_id: input.spreadsheet_id} : {}),
        ...(page.next_offset === null ? {} : {offset: page.next_offset}),
      },
    },
  };
}
