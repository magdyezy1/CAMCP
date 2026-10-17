import type {Store} from './store.js';
import type {JsonObject} from './types.js';

/**
 * The statements that select due schedules (`reporting_schedule`, `overview_schedule`) and the partial indexes they use,
 * in the store layer (ARC-02); they moved here verbatim from src/scheduled-work.ts, which re-exports them. The schema
 * ledger creates the indexes (store-0004, store-0011).
 */
export type ScheduleKind = 'reporting_schedule' | 'overview_schedule';
const kinds: ScheduleKind[] = ['reporting_schedule', 'overview_schedule'];
// Match JSON/JavaScript truthiness, including older string/integer declarations. Dates are a
// coarse numeric prefilter; the original JavaScript predicate below remains authoritative.
const active =
  "json_extract(data,'$.is_active') IS NOT NULL AND json_extract(data,'$.is_active')<>0 AND json_extract(data,'$.is_active')<>''";
/** The kinds the worker runs on a clock, and the SQL condition that selects an active one (restore quarantine). */
export const scheduleKinds: readonly ScheduleKind[] = kinds,
  activeScheduleSQL = active;
const deadline = "coalesce(CAST(json_extract(data,'$.next_run_at') AS REAL),0)";
export const scheduleIndexSQL = kinds
  .map(
    kind =>
      `CREATE INDEX IF NOT EXISTS ${kind}_due ON documents(tenant_id,${deadline},id) WHERE kind='${kind}' AND ${active}`,
  )
  .join(';');
export const dueScheduleSQL: Record<ScheduleKind, string> = Object.fromEntries(
  kinds.map(kind => [
    kind,
    `SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind='${kind}' AND ${active} AND ${deadline}<=? ORDER BY id`,
  ]),
) as Record<ScheduleKind, string>;

/**
 * OPS-08 tenant-count sweep: a selection pass that asks every workspace grows with the workspace count (the recorded
 * measurement, with its date and machine, is the one in docs/OPERATIONS.md beside `benchmark-schedules.mjs --sweep`,
 * which repeats it), so one global partial index by deadline names the workspaces with
 * a due schedule of a kind and the worker asks only those. Per-workspace selection, its order and every authority
 * check stay as they were; the coarse prefilter may name a workspace whose schedules the exact predicate then skips.
 */
export const scheduleGlobalIndexSQL = kinds
  .map(
    kind =>
      `CREATE INDEX IF NOT EXISTS ${kind}_due_global ON documents(${deadline},tenant_id) WHERE kind='${kind}' AND ${active}`,
  )
  .join(';');
export const dueTenantSQL: Record<ScheduleKind, string> = Object.fromEntries(
  kinds.map(kind => [
    kind,
    // INDEXED BY: otherwise the planner may walk every workspace through the per-workspace index, the cost removed here.
    `SELECT DISTINCT tenant_id FROM documents INDEXED BY ${kind}_due_global WHERE kind='${kind}' AND ${active} AND ${deadline}<=? AND EXISTS(SELECT 1 FROM tenants WHERE tenants.id=documents.tenant_id) ORDER BY tenant_id`,
  ]),
) as Record<ScheduleKind, string>;
/** The workspaces, in workspace ID order (as `listTenants`), that may have a due schedule of `kind`. */
export function dueScheduleTenants(store: Store, kind: ScheduleKind, at = Date.now()): string[] {
  return (store.sql().prepare(dueTenantSQL[kind]).all(at) as {tenant_id: string}[]).map(row => row.tenant_id);
}

/** Worker-internal selection only. No authority is derived from the index; enqueue rechecks the original actor/revision. */
export function dueSchedules(store: Store, tenant: string, kind: ScheduleKind, at = Date.now()): JsonObject[] {
  return (store.sql().prepare(dueScheduleSQL[kind]).all(tenant, at) as JsonObject[])
    .map(row => ({...JSON.parse(row.data), id: row.id, revision: row.revision}))
    .filter(schedule => schedule.is_active && schedule.next_run_at <= at);
}
