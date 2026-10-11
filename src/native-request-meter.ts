import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Counts the native provider request attempts made inside a metered call (COM-02 C): read-only requests apart from the
 * others. A campaign step records its counts in its journal metadata (`native_requests`), so the requests a step
 * costs are measured instead of extrapolated. Retries count as attempts; nothing about a request is kept but its count.
 */
export type NativeRequestCount = {reads: number; writes: number};
const meters = new AsyncLocalStorage<NativeRequestCount[]>();

/** Runs `fn`, adding every native request attempt it makes to `count` (also when it throws). Meters nest. */
export function meterNativeRequests<T>(count: NativeRequestCount, fn: () => Promise<T>): Promise<T> {
  return meters.run([...(meters.getStore() ?? []), count], fn);
}

/** Called by the transport once per attempt that is about to be sent. */
export function meterNativeRequest(readOnly: boolean): void {
  for (const count of meters.getStore() ?? []) count[readOnly ? 'reads' : 'writes']++;
}

/** Adds one metered phase to a step's journal counts: {prepare|execute|verify: {reads, writes}}. */
export function addNativeRequests(
  journal: Record<string, NativeRequestCount> | undefined,
  phase: 'prepare' | 'execute' | 'verify',
  count: NativeRequestCount,
): Record<string, NativeRequestCount> {
  const out = {...(journal ?? {})},
    before = out[phase] ?? {reads: 0, writes: 0};
  out[phase] = {reads: before.reads + count.reads, writes: before.writes + count.writes};
  return out;
}
