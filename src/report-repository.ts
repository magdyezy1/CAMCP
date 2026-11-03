import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * Report records in the store layer (ARC-02): Overview snapshots (`overview_report`) and their parts, Google Sheets
 * deliveries, captured provider reports (`decision_report`), monitor incidents, client report presentations and
 * provider job receipts. The statements moved here verbatim from the modules that own the records
 * (src/reporting-overview.ts, src/report-checkpoints.ts, src/report-library.ts, src/google-sheets.ts,
 * src/creative-performance.ts, src/evidence-index.ts, src/report-monitors.ts, src/report-packs.ts,
 * src/provider-jobs.ts, src/owner-operations.ts and src/connection-disconnect.ts); each is bound to one workspace.
 */

// Overview snapshot parts (src/report-checkpoints.ts).
/** Deletes a snapshot's split budget and checkpoint documents with it, in the same statement (store-0013). */
export const reportPartsCleanupSQL = `CREATE TRIGGER IF NOT EXISTS overview_report_parts_cleanup AFTER DELETE ON documents WHEN old.kind='overview_report' BEGIN
  DELETE FROM documents WHERE tenant_id=old.tenant_id AND kind='overview_report_budget' AND id=old.id;
  DELETE FROM documents WHERE tenant_id=old.tenant_id AND kind='overview_checkpoint' AND id>=old.id||':' AND id<old.id||';';
END`;

// Overview snapshots (src/reporting-overview.ts).
/** The newest finished snapshot of a saved definition, in History order, without loading its rows or checkpoints. */
export function latestDefinitionContracts(
  store: Store,
  tenant: string,
  viewId?: string,
  scheduleId?: string,
): JsonObject | undefined {
  if (!viewId && !scheduleId) return undefined;
  const row = store
    .sql()
    .prepare(
      "SELECT json_extract(data,'$.platform_contracts') AS contracts FROM documents WHERE tenant_id=? AND kind='overview_report' AND json_extract(data,'$.state') IN ('complete','partial') AND json_type(data,'$.completed_at') IN ('integer','real') AND ((? IS NOT NULL AND json_extract(data,'$.view_id')=?) OR (? IS NOT NULL AND json_extract(data,'$.schedule_id')=?)) ORDER BY json_extract(data,'$.created_at') DESC,id LIMIT 1",
    )
    .get(tenant, viewId ?? null, viewId ?? null, scheduleId ?? null, scheduleId ?? null) as
    {contracts: string | null} | undefined;
  return row ? JSON.parse(row.contracts ?? '{}') : undefined;
}
/** The 50 newest finished snapshots with a completion time: id, configuration (JSON text) and completion time. */
export function recentFinishedSnapshots(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,json_extract(data,'$.config') AS config,json_extract(data,'$.completed_at') AS completed_at FROM documents WHERE tenant_id=? AND kind='overview_report' AND json_extract(data,'$.state') IN ('complete','partial') AND json_type(data,'$.completed_at') IN ('integer','real') ORDER BY json_extract(data,'$.completed_at') DESC,id LIMIT 50",
    )
    .all(tenant) as JsonObject[];
}
/** The Snapchat campaign rows (id, name) of one snapshot for one login and account, at most 2,000 (RPT-07). */
export function snapshotSnapchatCampaigns(
  store: Store,
  tenant: string,
  reportId: string,
  connectionId: string,
  account: string,
): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT json_extract(r.value,'$.campaign_id') AS id,json_extract(r.value,'$.campaign_name') AS name FROM documents d,json_each(d.data,'$.rows') r WHERE d.tenant_id=? AND d.id=? AND json_extract(r.value,'$.platform')='snapchat' AND json_extract(r.value,'$.connection_id')=? AND json_extract(r.value,'$.account_id')=? AND json_extract(r.value,'$.entity_level') IS NULL LIMIT 2000",
    )
    .all(tenant, reportId, connectionId, account) as JsonObject[];
}
/**
 * One page of snapshots for the list, newest first: 500 from `offset`, without rows, checkpoints, bindings, row counts
 * or the whole-window summary (RPT-05: get returns it), and with each snapshot's row count.
 */
export function snapshotPage(store: Store, tenant: string, offset: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,revision,json_remove(data,'$.rows','$.checkpoints','$.actor_binding','$.collection_budget.row_counts','$.window_summary') AS data,json_array_length(data,'$.rows') AS row_count FROM documents WHERE tenant_id=? AND kind='overview_report' ORDER BY json_extract(data,'$.created_at') DESC,id LIMIT 500 OFFSET ?",
    )
    .all(tenant, offset) as JsonObject[];
}
/** The sources (JSON text) of the 25 newest snapshots, for network-free schedule previews. */
export function recentSnapshotSources(store: Store, tenant: string): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT json_extract(data,'$.sources') AS sources FROM documents WHERE tenant_id=? AND kind='overview_report' ORDER BY json_extract(data,'$.created_at') DESC LIMIT 25",
    )
    .all(tenant) as JsonObject[];
}
/** Snapshots to compare one with: 500 from `offset`, newest first, without their rows and other heavy fields. */
export function comparisonCandidates(store: Store, tenant: string, exceptId: string, offset: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT id,json_remove(data,'$.rows','$.checkpoints','$.actor_binding','$.collection_budget','$.window_summary','$.summary','$.sources') AS data FROM documents WHERE tenant_id=? AND kind='overview_report' AND id<>? ORDER BY json_extract(data,'$.created_at') DESC,id LIMIT 500 OFFSET ?",
    )
    .all(tenant, exceptId, offset) as JsonObject[];
}
/** How many rows a workspace's snapshots hold (owner health). */
export function snapshotRowCount(store: Store, tenant: string) {
  return (
    store
      .sql()
      .prepare(
        "SELECT coalesce(sum(json_array_length(data,'$.rows')),0) AS n FROM documents WHERE tenant_id=? AND kind='overview_report'",
      )
      .get(tenant) as JsonObject
  ).n;
}
/** Deletes the finished snapshots holding rows or sources read through a login (a local disconnect); how many. */
export function deleteSnapshotsReadThrough(store: Store, tenant: string, connectionId: string): number {
  return Number(
    store
      .sql()
      .prepare(
        `DELETE FROM documents WHERE tenant_id=? AND kind='overview_report'
        AND json_extract(data,'$.state') IN ('complete','partial','failed','cancelled')
        AND (EXISTS (SELECT 1 FROM json_each(data,'$.rows') WHERE json_extract(value,'$.connection_id')=?)
          OR EXISTS (SELECT 1 FROM json_each(data,'$.config.sources') WHERE json_extract(value,'$.connection_id')=?))`,
      )
      .run(tenant, connectionId, connectionId).changes,
  );
}
/** Deletes the captured reports, parsed Microsoft downloads and incidents read through a login; how many. */
export function deleteCapturedReportsReadThrough(store: Store, tenant: string, connectionId: string): number {
  return Number(
    store
      .sql()
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind IN ('decision_report','microsoft_report','report_incident') AND json_extract(data,'$.connection_id')=?",
      )
      .run(tenant, connectionId).changes,
  );
}

// Google Sheets deliveries (src/google-sheets.ts, src/report-library.ts).
/** A destination's unconfirmed (pending or uncertain) delivery other than `exceptId`, with its id, or undefined. */
export function unresolvedDelivery(
  store: Store,
  tenant: string,
  destinationId: string,
  exceptId = '',
): JsonObject | undefined {
  const row = store
    .sql()
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND id<>? AND json_extract(data,'$.destination_id')=? AND json_extract(data,'$.state') IN ('pending','uncertain') ORDER BY id LIMIT 1",
    )
    .get(tenant, exceptId, destinationId) as JsonObject | undefined;
  return row ? {...JSON.parse(row.data), id: row.id} : undefined;
}
/** Every delivery of one snapshot, by id, each with its id (and without its revision). */
export function snapshotDeliveries(store: Store, tenant: string, reportId: string) {
  return (
    store
      .sql()
      .prepare(
        "SELECT id,data FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.report_id')=? ORDER BY id",
      )
      .all(tenant, reportId) as JsonObject[]
  ).map(row => ({...JSON.parse(row.data), id: row.id}));
}
/** Whether a snapshot has an unconfirmed (pending or uncertain) delivery. */
export function hasUnconfirmedDelivery(store: Store, tenant: string, reportId: string): boolean {
  return !!store
    .sql()
    .prepare(
      "SELECT 1 FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.report_id')=? AND json_extract(data,'$.state') IN ('pending','uncertain') LIMIT 1",
    )
    .get(tenant, reportId);
}
/** Deletes a snapshot's complete and rejected delivery receipts (an abandoned one stays until retention). */
export function deleteSettledDeliveries(store: Store, tenant: string, reportId: string) {
  store
    .sql()
    .prepare(
      "DELETE FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.report_id')=? AND json_extract(data,'$.state') IN ('complete','rejected')",
    )
    .run(tenant, reportId);
}

// Captured provider reports (src/creative-performance.ts, src/evidence-index.ts).
const creativeProjection = `SELECT id,json_object('gateway',json_extract(data,'$.gateway'),
  'preset',json_extract(data,'$.preset'),'grain',json_extract(data,'$.grain'),
  'account_id',json_extract(data,'$.account_id'),'connection_id',json_extract(data,'$.connection_id'),
  'captured_at',json_extract(data,'$.captured_at'),'source_hash',json_extract(data,'$.source_hash'),
  'semantics',json_extract(data,'$.semantics'),'row_count',json_array_length(data,'$.rows')) AS metadata
  FROM documents WHERE tenant_id=? AND kind='decision_report' AND json_extract(data,'$.preset') IN ($PRESETS)
  AND json_extract(data,'$.grain')=? AND json_extract(data,'$.source')='provider_read'
  AND json_extract(data,'$.gateway')=?
  AND json_extract(data,'$.account_id')=? AND json_extract(data,'$.connection_id')=?`;
/** The provider-read reports of one preset set, grain, gateway, account and login, as metadata only (MED-04). */
export interface CreativeReportScope {
  presets: readonly string[];
  grain: string;
  gateway: string;
  account: string;
  connectionId: string;
}
function creativeQuery(tenant: string, scope: CreativeReportScope) {
  return {
    query: creativeProjection.replace('$PRESETS', scope.presets.map(() => '?').join(',')),
    params: [tenant, ...scope.presets, scope.grain, scope.gateway, scope.account, scope.connectionId],
  };
}
/** One page of those reports after the id `after`, by id, at most `limit`. */
export function creativeReportPage(
  store: Store,
  tenant: string,
  scope: CreativeReportScope,
  after: string,
  limit: number,
): JsonObject[] {
  const {query, params} = creativeQuery(tenant, scope);
  return store
    .sql()
    .prepare(query + ' AND id>? ORDER BY id LIMIT ?')
    .all(...params, after, limit) as JsonObject[];
}
/** One of those reports by id, or undefined when it is not in the scope. */
export function creativeReport(
  store: Store,
  tenant: string,
  scope: CreativeReportScope,
  reportId: string,
): JsonObject | undefined {
  const {query, params} = creativeQuery(tenant, scope);
  return store
    .sql()
    .prepare(query + ' AND id=?')
    .get(...params, reportId) as JsonObject | undefined;
}
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
/**
 * The saved evidence discovery statements (DEC-01): a page of captured-report metadata after a position, and whether
 * any report remains after one. Both take the workspace, the position and each filter twice (null for none).
 */
export function evidenceStatements(store: Store) {
  const page = store.sql().prepare(evidenceIndexSQL),
    remaining = store.sql().prepare(`SELECT id FROM documents WHERE ${selection} ORDER BY id LIMIT 1`);
  return {
    page: (params: (string | null)[], size: number) => page.all(...params, size) as JsonObject[],
    remains: (params: (string | null)[]) => Boolean(remaining.get(...params)),
  };
}

// Monitor incidents (src/report-monitors.ts).
/**
 * Retires the attention of a revised rule's older incidents (still open, not superseded): they are marked superseded
 * by `ruleVersion` and keep their state and evidence. How many.
 */
export function supersedeIncidents(store: Store, tenant: string, monitorId: string, ruleVersion: number): number {
  return Number(
    store
      .sql()
      .prepare(
        "UPDATE documents SET data=json_set(data,'$.superseded_by_version',?,'$.superseded_at',?,'$.snoozed_until',NULL,'$.updated_at',?),revision=revision+1 WHERE tenant_id=? AND kind='report_incident' AND json_extract(data,'$.monitor_id')=? AND coalesce(json_extract(data,'$.rule_version'),0)<? AND json_extract(data,'$.state')!='resolved' AND json_extract(data,'$.superseded_by_version') IS NULL",
      )
      .run(ruleVersion, Date.now(), Date.now(), tenant, monitorId, ruleVersion).changes,
  );
}

// Client report presentations (src/report-packs.ts).
/** 100 client profiles with an approved report presentation from `offset`, by id: branding metadata only. */
export function presentationProfilePage(store: Store, tenant: string, offset: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      `SELECT id,revision,json_object('name',json_extract(data,'$.name'),
    'approved_by',json_extract(data,'$.approved_by'),'approved_at',json_extract(data,'$.approved_at'),
    'bindings',json_extract(data,'$.bindings'),'report_presentation',json_extract(data,'$.report_presentation')) AS data
    FROM documents WHERE tenant_id=? AND kind='client_profile' AND json_type(data,'$.report_presentation')='object'
    ORDER BY id LIMIT 100 OFFSET ?`,
    )
    .all(tenant, offset) as JsonObject[];
}

// Provider job receipts (src/provider-jobs.ts).
/** Provider job receipts created since `since`, counted by gateway, state and source (never their contents). */
export function providerJobCounts(store: Store, tenant: string, since: number): JsonObject[] {
  return store
    .sql()
    .prepare(
      "SELECT json_extract(data,'$.gateway') AS gateway,json_extract(data,'$.state') AS state,json_extract(data,'$.source') AS source,count(*) AS count FROM documents WHERE tenant_id=? AND kind='provider_job' AND json_extract(data,'$.created_at')>=? GROUP BY 1,2,3 ORDER BY 1,2,3",
    )
    .all(tenant, since) as JsonObject[];
}
