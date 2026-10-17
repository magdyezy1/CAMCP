import {Store} from './store.js';
import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {reportRunScope} from './report-runs.js';
import {workbookFeedRows} from './workbook-repository.js';

const withheldScan = 5000;
/**
 * Workbook report runs and schedules that the Operations feed withholds from everyone, the owner included, because
 * their retained account scope cannot be established (B13, DOC-02): counts by bounded reason for the owner only, with
 * no IDs, names or bodies. A zero count in production closes the path-only and opaque-format adapter question.
 * Owner health receives it from the workspace tool (`ownerOperations`' sources), which keeps the report modules off
 * the reviewed-write path that `src/owner-operations.ts` is on. A record whose scope check fails unexpectedly is counted
 * as scope_check_failed, so one malformed record never fails the owner's whole health view. `scope` is a test seam.
 */
export function withheldWorkbookRecords(store: Store, actor: Actor, scope = reportRunScope): JsonObject {
  const scan = (records: 'runs' | 'schedules') => {
    const rows = workbookFeedRows(store, actor.tenantId, records, withheldScan + 1),
      reasons = {scope_unavailable: 0, connection_unavailable: 0, metadata_unreadable: 0, scope_check_failed: 0};
    for (const row of rows.slice(0, withheldScan)) {
      let metadata: JsonObject;
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        reasons.metadata_unreadable++;
        continue;
      }
      try {
        scope(store, actor, metadata);
      } catch (e) {
        reasons[
          !(e instanceof MirrorError)
            ? 'scope_check_failed'
            : e.code === 'REPORT_SCOPE_UNAVAILABLE'
              ? 'scope_unavailable'
              : 'connection_unavailable'
        ]++;
      }
    }
    return {
      checked: Math.min(rows.length, withheldScan),
      truncated: rows.length > withheldScan,
      withheld:
        reasons.scope_unavailable +
        reasons.connection_unavailable +
        reasons.metadata_unreadable +
        reasons.scope_check_failed,
      reasons,
    };
  };
  return {
    runs: scan('runs'),
    schedules: scan('schedules'),
    meaning:
      'Records with no unambiguous account and connection scope (scope_unavailable), whose connection or account is no longer available (connection_unavailable), whose stored metadata cannot be read, or whose scope check failed unexpectedly (scope_check_failed). They are not shown in Operations; counts only.',
  };
}
