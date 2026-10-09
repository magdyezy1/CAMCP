import {setTimeout as delay} from 'node:timers/promises';
import type {WorkerDrain} from '../src/worker.js';
import type {WorkerLoopEvent} from '../src/worker-loop.js';

export type ShutdownLog = (entry: Record<string, unknown>) => void;
/** One JSON line per entry: info on stdout, warnings and errors on stderr (Railway treats stderr as an error). */
export const jsonLine: ShutdownLog = entry =>
  (entry.level === 'info' ? process.stdout : process.stderr).write(JSON.stringify(entry) + '\n');
export const loopEventLog = (log: ShutdownLog) => (event: WorkerLoopEvent) => log(event);
/** A released read-only job stops at its next lease check; the exit waits at most this long for it. */
export const RELEASED_JOB_SETTLE_MS = 1000;
/**
 * Graceful shutdown (OPS-07). Stops taking work, returns a running read-only job to the queue at once (without
 * counting its attempt), lets a job that may be mid-mutation settle, and exits 0 when everything has settled; after
 * `graceMs` it exits 1 instead. Logs `shutdown_started`, `jobs_released` and `shutdown_completed` or
 * `shutdown_deadline`, metadata only.
 */
export function gracefulShutdown(options: {
  graceMs: number;
  log: ShutdownLog;
  drain: () => WorkerDrain;
  /** Settles when the worker loop has stopped. */
  workerDone: Promise<unknown>;
  /** Other work to wait for, such as open HTTP requests. */
  others?: Promise<unknown>[];
  close: () => void;
  exit: (code: number) => void;
  exitCode?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now,
    started = now(),
    exitCode = options.exitCode ?? 0;
  options.log({
    level: 'info',
    event: 'shutdown_started',
    grace_ms: options.graceMs,
    at: new Date(started).toISOString(),
  });
  let drained: WorkerDrain = {released: [], settling: []};
  try {
    drained = options.drain();
  } catch {
    // The worker keeps its leases; they expire and are recovered after the restart.
  }
  if (drained.released.length || drained.settling.length)
    options.log({
      level: 'info',
      event: 'jobs_released',
      released: drained.released.length,
      released_kinds: drained.released,
      settling_kinds: drained.settling,
    });
  let finished = false;
  const deadline = setTimeout(() => {
    if (finished) return;
    finished = true;
    options.log({
      level: 'error',
      event: 'shutdown_deadline',
      grace_ms: options.graceMs,
      settling_kinds: drained.settling,
    });
    options.exit(1);
  }, options.graceMs);
  deadline.unref?.();
  const worker = drained.released.length
    ? Promise.race([options.workerDone, delay(RELEASED_JOB_SETTLE_MS)])
    : options.workerDone;
  const done = Promise.allSettled([worker, ...(options.others ?? [])]).then(() => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    try {
      options.close();
    } finally {
      options.log({level: 'info', event: 'shutdown_completed', exit_code: exitCode, elapsed_ms: now() - started});
      options.exit(exitCode);
    }
  });
  return {drained, done};
}
