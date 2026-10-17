import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * Small collection documents for an Overview report snapshot (OPS-08). The whole-job budget counters live in one
 * `overview_report_budget` document per report and each source's checkpoint in `overview_checkpoint` documents (one per
 * source, plus one per calendar period when the report is grouped), so a counter or checkpoint save rewrites only its
 * own small document instead of the whole `overview_report`. Readers fall back to the legacy inline `collection_budget`
 * and `checkpoints` fields of a report started by an older release; nothing is migrated.
 *
 * Gate: the first split save also replaces the report's inline `collection_budget` with a version 2 marker. An older
 * release accepts only version 1 counters, so after a rollback it refuses to resume such a report
 * (REPORT_DEFINITION_CHANGED) instead of collecting again with counters it cannot see. A trigger removes the parts
 * whenever their report document is deleted (retention, report deletion, disconnect), in the same statement
 * (src/report-repository.ts, schema ledger step store-0013).
 */
export const REPORT_BUDGET_KIND = 'overview_report_budget';
export const REPORT_CHECKPOINT_KIND = 'overview_checkpoint';
export const splitBudgetMarker = (definition: unknown) => ({version: 2, layout: 'split', definition});
export const splitLayout = (r: JsonObject) => r.collection_budget?.layout === 'split';
const strip = (document: JsonObject | undefined, field?: string) => {
  if (!document) return undefined;
  const {id: _id, revision: _revision, report_id: _report, ...data} = document;
  return field ? data[field] : data;
};
function optional(
  store: Store,
  tenant: string,
  kind: typeof REPORT_BUDGET_KIND | typeof REPORT_CHECKPOINT_KIND,
  id: string,
): JsonObject | undefined {
  return store.repo(kind, tenant).find(id);
}
/**
 * The report's collection counters as the budget reads them: the split document, else legacy inline version 1
 * counters, else none. A split marker without its document means the counters were lost, which is refused rather than
 * restarted from zero (counters are written before egress).
 */
export function reportBudgetState(store: Store, tenant: string, r: JsonObject): JsonObject | undefined {
  const split = strip(optional(store, tenant, REPORT_BUDGET_KIND, r.id)) as JsonObject | undefined;
  if (split) return split;
  if (splitLayout(r))
    throw new MirrorError(
      'REPORT_BUDGET_INVALID',
      'Retained collection counters are invalid; inspect the original run.',
    );
  return r.collection_budget ?? undefined;
}
/** The counters to show beside a report (usage only), from wherever they are kept; null for legacy reports without. */
export function reportBudgetView(store: Store, tenant: string, r: JsonObject): JsonObject | undefined {
  if (!splitLayout(r)) return r.collection_budget ?? undefined;
  return (strip(optional(store, tenant, REPORT_BUDGET_KIND, r.id)) as JsonObject | undefined) ?? undefined;
}
export class ReportParts {
  private marked: boolean;
  private saved = new Map<string, Map<string, unknown>>();
  constructor(
    private store: Store,
    private tenant: string,
    private report: JsonObject,
  ) {
    this.marked = splitLayout(report);
  }
  /**
   * Writes one part. A part is never written for a report that no longer exists (deleted or disconnected while it
   * ran): the save refuses with NOT_FOUND, as the whole-report save did, instead of leaving a part no trigger removes.
   */
  private put(kind: string, id: string, data: JsonObject) {
    this.store.transaction(() => {
      if (!this.store.repo('overview_report', this.tenant).has(this.report.id))
        throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
      this.store.putDocument(this.tenant, kind, id, {report_id: this.report.id, ...data});
    });
  }
  /** Saves the counters into their own document; the first save also writes the version 2 marker on the report. */
  saveBudget(state: JsonObject) {
    this.store.transaction(() => {
      this.put(REPORT_BUDGET_KIND, this.report.id, state);
      if (this.marked) return;
      const current = this.store.document(this.tenant, 'overview_report', this.report.id);
      if (!splitLayout(current))
        this.store.putDocument(this.tenant, 'overview_report', this.report.id, {
          ...current,
          collection_budget: splitBudgetMarker(state.definition),
        });
      this.marked = true;
    });
  }
  /** Adds collected time up to now to stopped counters (a release at shutdown); false when none are split. */
  releaseBudget(now = Date.now()): boolean {
    const budget = strip(optional(this.store, this.tenant, REPORT_BUDGET_KIND, this.report.id)) as
      JsonObject | undefined;
    if (!budget) return false;
    if (Number.isFinite(budget.active_since) && Number.isFinite(budget.elapsed_ms))
      this.put(REPORT_BUDGET_KIND, this.report.id, {
        ...budget,
        elapsed_ms: budget.elapsed_ms + Math.max(0, now - budget.active_since),
        active_since: null,
      });
    return true;
  }
  /**
   * One source's checkpoint: its completed result, its native progress, or its grouped periods assembled from their
   * own documents; else the legacy inline checkpoint.
   */
  source(key: string, legacy: JsonObject | undefined): JsonObject {
    const head = optional(this.store, this.tenant, REPORT_CHECKPOINT_KIND, this.report.id + ':' + key);
    if (!head) return legacy ?? {};
    if (head.result) return {result: head.result};
    if (head.checkpoint) return head.checkpoint;
    const prefix = this.report.id + ':' + key + ':',
      periods: JsonObject = {},
      remembered = new Map<string, unknown>();
    for (const row of this.store
      .repo(REPORT_CHECKPOINT_KIND, this.tenant)
      .range(prefix, this.report.id + ':' + key + ';')) {
      const period = row.id.slice(prefix.length);
      periods[period] = row.period;
      remembered.set(period, periods[period]);
    }
    this.saved.set(key, remembered);
    return {definition: head.definition, periods};
  }
  /**
   * Saves one source's progress. Grouped progress writes its head once and then only the periods whose state object
   * changed since the last save, so each save costs one period, never the source or the report.
   */
  save(key: string, value: JsonObject) {
    const head = this.report.id + ':' + key;
    this.store.transaction(() => {
      if (value.periods && typeof value.periods === 'object' && typeof value.definition === 'string') {
        const remembered = this.saved.get(key) ?? new Map<string, unknown>();
        if (!this.saved.has(key)) {
          this.put(REPORT_CHECKPOINT_KIND, head, {definition: value.definition});
          this.saved.set(key, remembered);
        }
        for (const [period, state] of Object.entries(value.periods as JsonObject))
          if (remembered.get(period) !== state) {
            this.put(REPORT_CHECKPOINT_KIND, head + ':' + period, {period: state});
            remembered.set(period, state);
          }
      } else this.put(REPORT_CHECKPOINT_KIND, head, {checkpoint: value});
    });
  }
  /** Records a source's result and drops its period progress, in one transaction. */
  complete(key: string, result: JsonObject) {
    const head = this.report.id + ':' + key;
    this.store.transaction(() => {
      this.put(REPORT_CHECKPOINT_KIND, head, {result});
      this.store.repo(REPORT_CHECKPOINT_KIND, this.tenant).deleteRange(head + ':', head + ';');
    });
    this.saved.delete(key);
  }
}
