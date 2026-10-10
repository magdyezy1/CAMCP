import {monitorEventLoopDelay, type IntervalHistogram} from 'node:perf_hooks';

/**
 * Event-loop delay of this process (OPS-08): how long timers were late, sampled by `perf_hooks.monitorEventLoopDelay`.
 * It is the baseline for deciding whether report collection, schedules or media work should leave the HTTP process.
 * Figures are kept per fixed 15-minute window (the current one and the one before); nothing about requests is kept.
 */
export const EVENT_LOOP_WINDOW_MS = 15 * 60 * 1000;
export type EventLoopWindow = {
  from: number;
  to: number;
  samples: number;
  mean_ms: number | null;
  p50_ms: number | null;
  p99_ms: number | null;
  max_ms: number | null;
};
let histogram: IntervalHistogram | undefined,
  resolution = 0,
  windowStart = 0,
  previous: EventLoopWindow | null = null;
const ms = (nanoseconds: number) => (Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1000) / 1000 : null);
function snapshot(h: IntervalHistogram, from: number, to: number): EventLoopWindow {
  const samples = h.count;
  return samples > 0
    ? {
        from,
        to,
        samples,
        mean_ms: ms(h.mean),
        p50_ms: ms(h.percentile(50)),
        p99_ms: ms(h.percentile(99)),
        max_ms: ms(h.max),
      }
    : {from, to, samples: 0, mean_ms: null, p50_ms: null, p99_ms: null, max_ms: null};
}
/** Starts sampling (idempotent). The HTTP server and the standalone worker call it once at start. */
export function startEventLoopMonitor(resolutionMs = 20, now = Date.now()) {
  if (histogram) return;
  if (!Number.isInteger(resolutionMs) || resolutionMs < 1 || resolutionMs > 1000)
    throw TypeError('Invalid event-loop sampling resolution');
  histogram = monitorEventLoopDelay({resolution: resolutionMs});
  histogram.enable();
  resolution = resolutionMs;
  windowStart = Math.floor(now / EVENT_LOOP_WINDOW_MS) * EVENT_LOOP_WINDOW_MS;
  previous = null;
}
/** Stops sampling and forgets the figures (tests and shutdown). */
export function stopEventLoopMonitor() {
  histogram?.disable();
  histogram = undefined;
  previous = null;
}
/**
 * The current and previous window's delay percentiles, or null when no monitor runs in this process. A window that
 * has ended is closed on read, so the figures of an idle process are never older than one window.
 */
export function eventLoopDelay(now = Date.now()) {
  if (!histogram) return null;
  const start = Math.floor(now / EVENT_LOOP_WINDOW_MS) * EVENT_LOOP_WINDOW_MS;
  if (start > windowStart) {
    previous =
      start - windowStart === EVENT_LOOP_WINDOW_MS
        ? snapshot(histogram, windowStart, windowStart + EVENT_LOOP_WINDOW_MS)
        : null;
    histogram.reset();
    windowStart = start;
  }
  return {
    version: 1,
    resolution_ms: resolution,
    window_ms: EVENT_LOOP_WINDOW_MS,
    current: snapshot(histogram, windowStart, now),
    previous,
    scope:
      'Event-loop delay of the process that answered, per fixed 15-minute window: how late timers ran, in milliseconds. A previous window is shown only when it immediately precedes the current one. No request, workspace or job detail.',
  };
}
