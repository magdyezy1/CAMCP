import {reportRetentionDocumentKinds, reportRetentionJobKinds} from './document-kinds.js';
import type {Store} from './store.js';

/**
 * The statements of the retention sweeps (ARC-02, SEC-07, owner decisions P3 and P11 of 2026-10-11), in the store
 * layer. src/document-kinds.ts declares what each kind keeps and for how long; these statements do it, each bound to
 * one workspace (`tenant_id=?`, and correlated subqueries for the records a kind waits for). They moved here verbatim
 * from src/owner-operations.ts, src/provider-jobs.ts and src/campaign-inventory.ts.
 */
const reportStatements: Record<string, {sql: string; cutoff: boolean}> = {
  report_incident: {
    sql: "DELETE FROM documents WHERE tenant_id=? AND kind='report_incident' AND (json_extract(data,'$.state')='resolved' OR json_extract(data,'$.superseded_by_version') IS NOT NULL) AND json_extract(data,'$.updated_at')<?",
    cutoff: true,
  },
  decision_report: {
    sql: "DELETE FROM documents WHERE tenant_id=? AND kind='decision_report' AND json_extract(data,'$.captured_at')<?",
    cutoff: true,
  },
  overview_report: {
    sql: "DELETE FROM documents WHERE tenant_id=? AND kind='overview_report' AND json_extract(data,'$.created_at')<? AND json_extract(data,'$.state') IN ('complete','partial','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.tenant_id=documents.tenant_id AND json_extract(jobs.input,'$.report_id')=documents.id AND jobs.state IN ('queued','running')) AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id=documents.tenant_id AND d.kind='sheets_delivery' AND json_extract(d.data,'$.report_id')=documents.id AND json_extract(d.data,'$.state') IN ('pending','uncertain'))",
    cutoff: true,
  },
  // A snapshot with an unconfirmed Sheets delivery is kept above (its recovery needs the identical report). Only
  // terminal receipts of removed snapshots are deleted, once they are older than the retention period.
  sheets_delivery: {
    sql: "DELETE FROM documents WHERE tenant_id=? AND kind='sheets_delivery' AND json_extract(data,'$.state') IN ('complete','rejected','abandoned') AND coalesce(json_extract(data,'$.abandoned_at'),json_extract(data,'$.completed_at'),json_extract(data,'$.sent_at'),0)<? AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=json_extract(documents.data,'$.report_id'))",
    cutoff: true,
  },
  report_presentation: {
    sql: "DELETE FROM documents WHERE tenant_id=? AND kind='report_presentation' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=documents.id)",
    cutoff: false,
  },
  report_file: {
    sql: orphanReportFiles(),
    cutoff: false,
  },
};
function orphanReportFiles() {
  return "DELETE FROM documents WHERE tenant_id=? AND kind='report_file' AND NOT EXISTS (SELECT 1 FROM documents r WHERE r.tenant_id=documents.tenant_id AND r.kind='overview_report' AND r.id=json_extract(documents.data,'$.report_id'))";
}
/** The document kinds the report sweep has statements for, in their order (equal to the registry's, by test). */
export const reportSweepKinds = () => Object.keys(reportStatements);
const reportJobsStatement =
  "DELETE FROM jobs WHERE tenant_id=? AND kind=? AND state IN ('complete','failed','cancelled') AND updated_at<? AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id=jobs.tenant_id AND d.kind='sheets_delivery' AND json_extract(d.data,'$.report_id')=json_extract(jobs.input,'$.report_id') AND json_extract(d.data,'$.state') IN ('pending','uncertain'))";

/**
 * Deletes one workspace's report records past `cutoff`, per kind in the registry's order, then its finished report
 * jobs. Returns how many of each it deleted, by kind (jobs under `job:<kind>`). The caller holds the transaction.
 */
export function applyReportRetention(store: Store, tenant: string, cutoff: number): Record<string, number> {
  const counts: Record<string, number> = {},
    db = store.sql();
  const count = (key: string, changes: number | bigint) => {
    if (Number(changes)) counts[key] = (counts[key] ?? 0) + Number(changes);
  };
  for (const kind of reportRetentionDocumentKinds()) {
    const statement = reportStatements[kind];
    if (!statement) throw new Error('No report retention statement for ' + kind + ' (src/retention-repository.ts).');
    count(kind, db.prepare(statement.sql).run(...(statement.cutoff ? [tenant, cutoff] : [tenant])).changes);
  }
  // Counted per job kind under the job:<kind> keys data-retention.ts declares, so the audit matches the kinds owner
  // health lists.
  for (const job of reportRetentionJobKinds)
    count('job:' + job, db.prepare(reportJobsStatement).run(tenant, job, cutoff).changes);
  return counts;
}
/**
 * Spend reservations are only readable for the current UTC day, so older rows are unreachable state; two days are kept
 * so the current and preceding UTC day survive for inspection. The audit log keeps the durable record of each write.
 */
export function sweepSpendReservations(store: Store, tenant: string): number {
  return Number(
    store
      .sql()
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND json_extract(data,'$.day')<date('now','-2 day')",
      )
      .run(tenant).changes,
  );
}
/** Report files whose snapshot is gone, whatever the period (they cannot be read without it). */
export function sweepOrphanReportFiles(store: Store, tenant: string): number {
  return Number(store.sql().prepare(orphanReportFiles()).run(tenant).changes);
}
/**
 * Provider-job receipts (RPT-06): a settled receipt once its `retain_until` passed, a submitting or uncertain one
 * `retentionDays` after it was created. How many were deleted.
 */
export function sweepProviderJobReceipts(store: Store, tenant: string, now: number, retentionDays: number): number {
  const db = store.sql();
  const settled = db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='provider_job' AND json_extract(data,'$.state') IN ('accepted','rejected') AND coalesce(json_extract(data,'$.retain_until'),0)<?",
      )
      .run(tenant, now).changes,
    unsettled = db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='provider_job' AND coalesce(json_extract(data,'$.state'),'') NOT IN ('accepted','rejected') AND coalesce(json_extract(data,'$.created_at'),0)<?",
      )
      .run(tenant, now - retentionDays * 86400000).changes;
  return Number(settled) + Number(unsettled);
}
/** The ids of a workspace's campaign plans archived before `cutoff` (CMP-05's opt-in purge). */
export function archivedPlansBefore(store: Store, tenant: string, cutoff: number): string[] {
  return (
    store
      .sql()
      .prepare(
        "SELECT id FROM documents WHERE tenant_id=? AND kind='campaign_run' AND json_extract(data,'$.archived.at')<?",
      )
      .all(tenant, cutoff) as {id: string}[]
  ).map(r => r.id);
}
