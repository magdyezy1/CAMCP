import {Store} from './store.js';
import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {reportRunFeedSQL, reportRunScope} from './report-runs.js';
import {workbookScheduleFeedSQL} from './workbook-schedules.js';

const withheldScan = 5000;
/**
 * Workbook report runs and schedules that the Operations feed withholds from everyone, the owner included, because
 * their retained account scope cannot be established (B13, DOC-02): counts by bounded reason for the owner only, with
 * no IDs, names or bodies. A zero count in production closes the path-only and opaque-format adapter question.
 * Owner health receives it from the workspace tool (`ownerOperations`' sources), which keeps the report modules off
 * the reviewed-write path that `src/owner-operations.ts` is on.
 */
export function withheldWorkbookRecords(store: Store, actor: Actor): JsonObject {
  const scan = (sql: string) => {
    const rows = store.db.prepare(sql + ' LIMIT ' + (withheldScan + 1)).all(actor.tenantId) as {metadata: string}[],
      reasons = {scope_unavailable: 0, connection_unavailable: 0, metadata_unreadable: 0};
    for (const row of rows.slice(0, withheldScan)) {
      let metadata: JsonObject;
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        reasons.metadata_unreadable++;
        continue;
      }
      try {
        reportRunScope(store, actor, metadata);
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        reasons[e.code === 'REPORT_SCOPE_UNAVAILABLE' ? 'scope_unavailable' : 'connection_unavailable']++;
      }
    }
    return {
      checked: Math.min(rows.length, withheldScan),
      truncated: rows.length > withheldScan,
      withheld: reasons.scope_unavailable + reasons.connection_unavailable + reasons.metadata_unreadable,
      reasons,
    };
  };
  return {
    runs: scan(reportRunFeedSQL),
    schedules: scan(workbookScheduleFeedSQL),
    meaning:
      'Records with no unambiguous account and connection scope (scope_unavailable), whose connection or account is no longer available (connection_unavailable) or whose stored metadata cannot be read. They are not shown in Operations; counts only.',
  };
}
