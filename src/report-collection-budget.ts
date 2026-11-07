import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

export const reportCollectionLimits: Readonly<{requests: number; rows: number; elapsed_ms: number; bytes: number}> =
  Object.freeze({
    requests: 1200,
    rows: 25000,
    elapsed_ms: 300000,
    bytes: 128 * 1024 * 1024,
  });
/**
 * The most rows one source unit (a level of a source, across its periods) may hold. A unit with more is refused with
 * REPORT_ROW_LIMIT, whose messages name this number; the collectors and the detail assembly all read it here (F-L5-28).
 */
export const reportUnitRowLimit = 10000;
const context = new AsyncLocalStorage<ReportCollectionBudget[]>();
/** One durable allowance across every account, calendar period, page, retry and download in one snapshot.
 * Counters are written before egress. Recovery keeps the same definition and counters; queue waiting is excluded
 * after a clean stop, while time after an interrupted process is conservatively charged to the original run. */
export class ReportCollectionBudget {
  private state: JsonObject;
  private last: number;
  private started: number;
  private completed = 0;
  constructor(
    previous: JsonObject | undefined,
    definition: string,
    private save: (state: JsonObject) => void,
    private limits = reportCollectionLimits,
    private now = () => performance.now(),
    private wall = () => Date.now(),
  ) {
    if (previous && (previous.version !== 1 || previous.definition !== definition))
      throw new MirrorError('REPORT_DEFINITION_CHANGED', 'Collection counters belong to another report definition.');
    this.state = previous
      ? structuredClone(previous)
      : {version: 1, definition, requests: 0, rows: 0, bytes: 0, elapsed_ms: 0, row_counts: {}};
    for (const key of ['requests', 'rows', 'bytes', 'elapsed_ms'])
      if (!Number.isFinite(this.state[key]) || this.state[key] < 0)
        throw new MirrorError(
          'REPORT_BUDGET_INVALID',
          'Retained collection counters are invalid; inspect the original run.',
        );
    if (this.state.active_since) this.state.elapsed_ms += Math.max(0, this.wall() - this.state.active_since);
    this.last = this.now();
    this.started = this.last;
    this.persist();
  }
  private tick() {
    const time = this.now();
    this.state.elapsed_ms += Math.max(0, time - this.last);
    this.last = time;
  }
  private persist(active = true) {
    this.tick();
    this.state.active_since = active ? this.wall() : null;
    this.save({...structuredClone(this.state), limits: this.limits});
  }
  private exceeded(kind: string): never {
    this.persist();
    throw new MirrorError(
      'REPORT_COLLECTION_LIMIT',
      'This snapshot reached its whole-job ' +
        kind +
        ' limit. Retained results and source errors remain available. Narrow the accounts, date window or grouping for a new run.',
      {
        dimension: kind,
        used: this.state[kind],
        limit: this.limits[kind as keyof typeof this.limits],
        definition: this.state.definition,
      },
      422,
    );
  }
  check() {
    this.tick();
    if (this.state.elapsed_ms >= this.limits.elapsed_ms) this.exceeded('elapsed_ms');
  }
  request(timeout: number): number {
    this.check();
    if (this.state.requests >= this.limits.requests) this.exceeded('requests');
    this.state.requests++;
    this.persist();
    return Math.max(1, Math.ceil(Math.min(timeout, this.limits.elapsed_ms - this.state.elapsed_ms)));
  }
  bytes(count: number) {
    this.check();
    this.state.bytes += count;
    if (this.state.bytes > this.limits.bytes) this.exceeded('bytes');
    this.persist();
  }
  rows(key: string, count: number) {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0)
      throw new MirrorError('REPORT_BUDGET_INVALID', 'Invalid collected row count.');
    const previous = this.state.row_counts[key] ?? 0;
    // A re-read cannot refund earlier consumption, even if rows disappeared at the provider.
    this.state.rows += Math.max(0, count - previous);
    this.state.row_counts[key] = Math.max(previous, count);
    if (this.state.rows > this.limits.rows) this.exceeded('rows');
    this.persist();
    this.completed++;
  }
  /** What is left of the allowance, so a collector can end inside it instead of at the limit error. */
  remaining(): {requests: number; elapsed_ms: number} {
    this.tick();
    return {
      requests: Math.max(0, this.limits.requests - this.state.requests),
      elapsed_ms: Math.max(0, this.limits.elapsed_ms - this.state.elapsed_ms),
    };
  }
  /** Yield only between completed native periods; never interrupt an advertising mutation. */
  nextPeriod() {
    this.check();
    if (this.completed > 0 && this.now() - this.started >= 20000)
      throw new MirrorError(
        'REPORT_COLLECTION_YIELD',
        'Collected periods are saved. Other queued work runs before this snapshot continues.',
        {retry_after_ms: 1000},
        503,
        true,
      );
  }
  run<T>(fn: () => Promise<T>) {
    this.check();
    const parents = context.getStore() ?? [];
    return context.run(parents.includes(this) ? parents : [...parents, this], fn);
  }
  close() {
    this.persist(false);
  }
}
export const collectionRequestTimeout = (timeout: number) =>
  (context.getStore() ?? []).reduce((remaining, budget) => Math.min(remaining, budget.request(timeout)), timeout);
export const collectionResponseBytes = (count: number) => {
  for (const budget of context.getStore() ?? []) budget.bytes(count);
};
export const collectionCheckpoint = () => {
  for (const budget of context.getStore() ?? []) budget.check();
};
/** The least that is left in the whole-job allowances this work answers to, or undefined outside every one. */
export const collectionAllowance = (): {requests: number; elapsed_ms: number} | undefined =>
  (context.getStore() ?? []).reduce<{requests: number; elapsed_ms: number} | undefined>((least, budget) => {
    const left = budget.remaining();
    return least
      ? {requests: Math.min(least.requests, left.requests), elapsed_ms: Math.min(least.elapsed_ms, left.elapsed_ms)}
      : left;
  }, undefined);
/** Whether `error` is AMCP's own whole-job allowance ending (a request, time, row or byte limit), not a limit of a source. */
export const collectionAllowanceEnded = (error: unknown): error is MirrorError =>
  error instanceof MirrorError &&
  error.code === 'REPORT_COLLECTION_LIMIT' &&
  typeof error.details.dimension === 'string';
