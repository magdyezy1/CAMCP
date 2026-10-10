import {setTimeout as delay} from 'node:timers/promises';
import {sqliteDiagnostic, type SqliteDiagnostic} from './sqlite-diagnostics.js';
export type WorkerStage = 'schedule' | 'email_delivery' | 'job';
export type WorkerStageFailure = {
  event: 'worker_stage_failed';
  stage: WorkerStage;
  code: string;
  consecutive_failures: number;
  at: string;
  database?: SqliteDiagnostic;
};
/** A change of the loop's own state (OPS-07): storage exhausted or available again. Metadata only. */
export type WorkerLoopEvent = {
  level: 'warn' | 'info';
  event: 'worker_storage_paused' | 'worker_storage_resumed';
  at: string;
  stage?: WorkerStage;
  database?: SqliteDiagnostic;
};
type WorkerLoop = {
  schedule: () => void;
  deliverEmails: () => Promise<unknown>;
  work: () => Promise<boolean>;
  shouldStop: () => boolean;
  onFailure: (failure: WorkerStageFailure) => void;
  onceOnly?: boolean;
  pause?: (milliseconds: number) => Promise<unknown>;
  /** The clock stage backoff and storage probes use; tests inject one that their pause advances. */
  now?: () => number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  /** While storage is exhausted, one small committed write every 30 s; true when it succeeded. */
  storageProbe?: () => boolean;
  onEvent?: (event: WorkerLoopEvent) => void;
};
const stages: readonly WorkerStage[] = ['schedule', 'email_delivery', 'job'];
/** A stage failing for longer than this backs off; shorter failures keep the one-second cycle. */
export const STAGE_BACKOFF_AFTER_MS = 10000;
export const STAGE_BACKOFF_CAP_MS = 60000;
export const STORAGE_PROBE_INTERVAL_MS = 30000;
type StageState = {
  consecutive_failures: number;
  failures_total: number;
  first_failure_at: number | null;
  last_failure_at: number | null;
  last_code: string | null;
  next_attempt_at: number;
  backoffs: number;
  database?: SqliteDiagnostic;
};
type LoopHealth = {stages: Record<WorkerStage, StageState>; storage_paused: boolean; next_probe_at: number | null};
let latest: LoopHealth | undefined;
/**
 * This process's worker stages for owner health (OPS-07): each stage's state, consecutive and total failures, last
 * code and next attempt, and whether storage is paused. Null when no worker loop runs in this process (a standalone
 * worker reports through its own process).
 */
export function workerStageHealth(now = Date.now()) {
  if (!latest) return null;
  const health = latest;
  return {
    storage_paused: health.storage_paused,
    next_storage_probe_at: health.next_probe_at,
    stages: Object.fromEntries(
      stages.map(stage => {
        const s = health.stages[stage];
        return [
          stage,
          {
            state: health.storage_paused
              ? 'paused'
              : s.consecutive_failures === 0
                ? 'ok'
                : s.next_attempt_at > now
                  ? 'backing_off'
                  : 'failing',
            consecutive_failures: s.consecutive_failures,
            failures_total: s.failures_total,
            last_code: s.last_code,
            last_failure_at: s.last_failure_at,
            next_attempt_at: s.next_attempt_at > now ? s.next_attempt_at : null,
            ...(s.database ? {database: s.database} : {}),
          },
        ];
      }),
    ),
  };
}
const failureCode = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string' &&
  /^[A-Z_0-9]{1,80}$/.test(error.code)
    ? error.code
    : 'WORKER_STAGE_FAILED';
/**
 * The shared worker loop. Each stage (schedule, e-mail delivery, jobs) keeps its own failure state (OPS-07): a failure
 * does not keep the later stages of that cycle from running, the cycle then pauses one second as before (even when a
 * job was done), and a stage failing for longer than ten seconds backs off
 * (2 s, 4 s, ... at most 60 s, with jitter) while the other stages keep running; a success resets it. SQLite's
 * "full" (primary code 13) pauses every stage, since each one writes, and a storage probe runs every 30 s until a
 * write succeeds. `onceOnly` runs one cycle and propagates a failure, as before.
 */
export async function runWorkerLoop(options: WorkerLoop): Promise<void> {
  const now = options.now ?? Date.now,
    random = options.random ?? Math.random,
    pause = options.pause ?? delay;
  const health: LoopHealth = {
    stages: Object.fromEntries(
      stages.map(stage => [
        stage,
        {
          consecutive_failures: 0,
          failures_total: 0,
          first_failure_at: null,
          last_failure_at: null,
          last_code: null,
          next_attempt_at: 0,
          backoffs: 0,
        },
      ]),
    ) as Record<WorkerStage, StageState>,
    storage_paused: false,
    next_probe_at: null,
  };
  latest = health;
  const run = (stage: WorkerStage): Promise<unknown> | unknown =>
    stage === 'schedule' ? options.schedule() : stage === 'email_delivery' ? options.deliverEmails() : options.work();
  while (!options.shouldStop()) {
    if (health.storage_paused) {
      const at = now();
      if (at >= (health.next_probe_at ?? 0)) {
        let available = false;
        try {
          available = options.storageProbe ? options.storageProbe() : true;
        } catch {
          available = false;
        }
        if (available) {
          health.storage_paused = false;
          health.next_probe_at = null;
          options.onEvent?.({level: 'info', event: 'worker_storage_resumed', at: new Date(at).toISOString()});
        } else health.next_probe_at = at + STORAGE_PROBE_INTERVAL_MS;
      }
      if (health.storage_paused) {
        if (options.onceOnly) return;
        await pause(1000);
        continue;
      }
    }
    let worked = false,
      failed = false;
    for (const [index, stage] of stages.entries()) {
      // A stop observed after a stage starts no later stage (the first check is the loop condition).
      if (index > 0 && options.shouldStop()) return;
      const state = health.stages[stage];
      if (state.next_attempt_at > now()) continue;
      try {
        const result = await run(stage);
        if (stage === 'job') worked = result === true;
        state.consecutive_failures = 0;
        state.first_failure_at = null;
        state.next_attempt_at = 0;
        state.backoffs = 0;
        delete state.database;
      } catch (error) {
        const at = now(),
          database = sqliteDiagnostic(error),
          code = failureCode(error);
        state.consecutive_failures++;
        state.failures_total = Math.min(Number.MAX_SAFE_INTEGER, state.failures_total + 1);
        state.first_failure_at ??= at;
        state.last_failure_at = at;
        state.last_code = code;
        if (database) state.database = database;
        else delete state.database;
        if (at - state.first_failure_at >= STAGE_BACKOFF_AFTER_MS) {
          state.backoffs++;
          const base = Math.min(STAGE_BACKOFF_CAP_MS, 1000 * 2 ** state.backoffs);
          state.next_attempt_at = at + Math.round(base * (0.75 + 0.25 * random()));
        }
        // Keep the diagnostic metadata-only; exception messages can contain native arguments or credentials.
        options.onFailure({
          event: 'worker_stage_failed',
          stage,
          code,
          consecutive_failures: state.consecutive_failures,
          at: new Date().toISOString(),
          ...(database ? {database} : {}),
        });
        if (database?.primary_code === 13 && !health.storage_paused) {
          health.storage_paused = true;
          health.next_probe_at = at + STORAGE_PROBE_INTERVAL_MS;
          options.onEvent?.({
            level: 'warn',
            event: 'worker_storage_paused',
            at: new Date(at).toISOString(),
            stage,
            database,
          });
        }
        if (options.onceOnly) throw error;
        failed = true;
        // Stage isolation: the remaining stages still run in this cycle, unless storage is now exhausted (every stage
        // writes, so they wait for the storage probe instead).
        if (health.storage_paused) break;
      }
    }
    if (options.onceOnly || options.shouldStop()) return;
    // A failed cycle is always paced, so a failing stage never spins even while another stage drains work.
    if (!worked || failed) await pause(1000);
  }
}
type FailureWindow = {started: number; suppressed: number};
/**
 * The worker's failure log (OPS-07): the first failure of a stage is written at once; later failures of that stage
 * within a minute are counted and written as one `worker_stage_failures` summary when the minute has passed, so a
 * persistent failure writes at most one line per stage per minute instead of one per second.
 */
export function stageFailureLog(write: (entry: Record<string, unknown>) => void, clock: () => number = Date.now) {
  const windows = new Map<WorkerStage, FailureWindow>();
  return (failure: WorkerStageFailure) => {
    const at = clock(),
      window = windows.get(failure.stage);
    if (!window || at - window.started >= 60000) {
      if (window?.suppressed)
        write({
          level: 'error',
          event: 'worker_stage_failures',
          stage: failure.stage,
          count: window.suppressed + 1,
          code: failure.code,
          consecutive_failures: failure.consecutive_failures,
          at: failure.at,
          ...(failure.database ? {database: failure.database} : {}),
        });
      else write({level: 'error', ...failure});
      windows.set(failure.stage, {started: at, suppressed: 0});
      return;
    }
    window.suppressed++;
  };
}
