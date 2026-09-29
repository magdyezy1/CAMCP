import {setTimeout as delay} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import {stable as canonical} from './security.js';
/**
 * Only read callbacks belong here. A successful write is never resubmitted. `stable` says every one of the three
 * reads returned the same state: a disagreement that does not move, rather than one still propagating (Snapchat S5).
 */
export async function readConsistently<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  sleep: (ms: number) => Promise<unknown> = delay,
): Promise<{value?: T; attempts: number; consistent: boolean; stable?: boolean}> {
  let value: T | undefined;
  const seen = new Set<string>();
  let reads = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep((attempt - 1) * 250);
    try {
      value = await read();
      if (matches(value)) return {value, attempts: attempt, consistent: true};
      reads++;
      seen.add(canonical(value ?? null));
    } catch (e) {
      if (
        !(e instanceof MirrorError) ||
        (e.status !== 404 && !['STATE_NOT_FOUND', 'STATE_TARGET_MISMATCH'].includes(e.code))
      )
        throw e;
    }
  }
  return {value, attempts: 3, consistent: false, stable: reads === 3 && seen.size === 1};
}
