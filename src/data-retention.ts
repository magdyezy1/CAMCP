import type {JsonObject} from './types.js';

/**
 * Retention of report records (SEC-07, owner decision P3 of 2026-10-11: design to GDPR and KSA PDPL; reports follow a
 * retention per document kind). Report retention used to be opt-in: a workspace whose owner never saved a period kept
 * every finished snapshot, analysis and resolved incident forever. A deployment default now applies to every workspace
 * without its own period: `AMCP_REPORT_RETENTION_DAYS`, 365 days unless set to 7–3650 or `off` (the rollback). A
 * workspace owner's own period (Settings, `save_retention` with `days`, 7–365) always takes precedence.
 *
 * The document kinds the period covers, and the time each counts from, are declared here until the document-kind
 * registry (ARC-02) owns them; `cleanupReports` (src/owner-operations.ts) applies them:
 * - `overview_report` from `created_at`, once finished (complete, partial, failed or cancelled), with no queued or
 *   running job and no unconfirmed Google Sheets delivery;
 * - `decision_report` from `captured_at`;
 * - `report_incident` from `updated_at`, once resolved or superseded (open and acknowledged incidents stay);
 * - `sheets_delivery` from its completion, abandonment or send time, once terminal and its snapshot is gone;
 * - `report_presentation` and `report_file` with their snapshot;
 * - finished report, Overview, Sheets export and report file jobs from `updated_at`.
 * Audit records, write receipts, active work and archived campaign plans (their own opt-in period, CMP-05) are not
 * covered.
 *
 * src/owner-operations.ts imports this module and is on the reviewed-write path, so it imports nothing at run time:
 * the start-up validation of every retention setting (server/config.ts) brings in account erasure separately.
 */
export const DEFAULT_REPORT_RETENTION_DAYS = 365;
export const reportRetentionKinds: readonly string[] = [
  'overview_report',
  'decision_report',
  'report_incident',
  'sheets_delivery',
  'report_presentation',
  'report_file',
  'job:report_overview',
  'job:sheets_export',
  'job:report_file_export',
  'job:report',
];
/** The deployment's default report retention in days, or null when `AMCP_REPORT_RETENTION_DAYS=off`. */
export function reportRetentionDefault(env: NodeJS.ProcessEnv): number | null {
  const value = env.AMCP_REPORT_RETENTION_DAYS?.trim();
  if (value === 'off') return null;
  const days = value === undefined || value === '' ? DEFAULT_REPORT_RETENTION_DAYS : Number(value);
  if (!Number.isInteger(days) || days < 7 || days > 3650)
    throw Error('AMCP_REPORT_RETENTION_DAYS must be a whole number of days from 7 to 3650, or off.');
  return days;
}
export type ReportRetention = {days: number | null; source: 'workspace' | 'deployment_default' | 'off'};
/** The period that applies to a workspace: its owner's saved `days`, else the deployment default. */
export function reportRetention(policy: JsonObject | undefined, defaultDays: number | null): ReportRetention {
  if (Number.isInteger(policy?.days)) return {days: Number(policy!.days), source: 'workspace'};
  return defaultDays === null ? {days: null, source: 'off'} : {days: defaultDays, source: 'deployment_default'};
}
