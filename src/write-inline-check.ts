import type {JsonObject} from './types.js';
import {knownBehaviours} from './known-behaviours.js';

/**
 * The inline read-back of a write (R2.5 r25-fr-verify, the owner's friction B1): every direct execute answered "succeeded" with its read-back only
 * queued (34 of 34, then 20 of 20), so 48 links Google had switched on were live about 6 minutes before anyone saw the mismatch. A standalone execute
 * now waits a few seconds for the read-back that a plan's step already makes (`verifyWrite`) and answers what it found: verified, mismatch, or
 * checking (the job stays queued, as the safety net, and the block names it). It only reads: nothing here sends a request, and the outcome of the
 * write, which is stored before this runs, is never touched.
 *
 * `sink` is what the verifier hands out as it goes: how many resources it means to read, and the checks it has finished. A wait that ends first still
 * says what was read: a settled mismatch among them is a mismatch (`complete: false`), and a part of the list is never "verified". It also stops the
 * read-back (`stopped`): the verifier asks the provider for nothing more and stores no receipt for a read it cut short, so the queued job reads the rest
 * once, instead of two read-backs reading the same resources.
 */
export interface VerificationSink {
  total: number;
  checks: JsonObject[];
  stopped?: boolean;
}
/** When a client that was told "still checking" reads again: the queued job has read by then (it is made available a second after the wait). */
const checkingRetryMs = 5000;
/** Groups of differences an answer names; the receipt (`amcp_campaign verify`) holds every one. */
const maxDifferences = 5;
/** A value an answer shows, or how many bytes it was when it is more than a few words. */
const clip = (value: unknown) => {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
  return bytes > 80 ? {omitted_bytes: bytes} : (value ?? null);
};
/**
 * What a list of checks says in a few words: how many resources were read back, what differs (grouped, with how many resources it differs on and one
 * example), the fields still differing in a read that has not settled, and the known behaviours (src/known-behaviours.ts) that explain a difference, by
 * their sentence. A check without a resource is the note of a read that failed, and is no resource read back.
 */
export function verificationSummary(checks: JsonObject[], total = 0): JsonObject {
  const read = checks.filter(c => typeof c.resource_id === 'string'),
    groups = new Map<string, JsonObject>(),
    known = new Map<string, number>(),
    unsettled = new Set<string>();
  for (const c of read) {
    for (const d of Array.isArray(c.diff) ? c.diff : []) {
      const key = JSON.stringify([d.field, d.expected, d.actual]),
        group = groups.get(key);
      if (group) group.count++;
      else
        groups.set(key, {
          field: d.field,
          expected: clip(d.expected),
          actual: clip(d.actual),
          count: 1,
          example: c.resource_id,
        });
    }
    if (typeof c.known === 'string') known.set(c.known, (known.get(c.known) ?? 0) + 1);
    if (c.status === 'inconclusive')
      for (const field of Array.isArray(c.changed_fields) ? c.changed_fields : []) unsettled.add(String(field));
  }
  const shown = [...groups.values()].slice(0, maxDifferences);
  return {
    checked: read.length,
    total: Math.max(total, read.length),
    ...(shown.length
      ? {
          differences: shown,
          ...(groups.size > shown.length ? {differences_omitted: groups.size - shown.length} : {}),
        }
      : {}),
    ...(unsettled.size ? {differing_fields: [...unsettled].slice(0, 10)} : {}),
    ...(known.size
      ? {
          known: [...known].map(([code, count]) => {
            const note = knownBehaviours[code]?.note;
            return {code, count, ...(note ? {note} : {})};
          }),
        }
      : {}),
  };
}
/**
 * The block that replaces a queued read-back in the answer of an execute: `verify` runs for at most `waitMs` and its receipt becomes the block. `marker`
 * is the queued read-back the claim holds (`job_id`, `next_call`), which the block keeps. `planned` is how many resources the change holds when the verifier
 * cannot say yet (a write group's later parts are read after the earlier ones): a wait that ends first reports it as the total. It never rejects, whatever the
 * verifier does, even after the wait.
 */
export async function inlineVerification(
  verify: (sink: VerificationSink) => Promise<JsonObject>,
  waitMs: number,
  marker: JsonObject,
  planned = 0,
): Promise<JsonObject> {
  const began = Date.now(),
    sink: VerificationSink = {total: 0, checks: []};
  let receipt: JsonObject | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  // A refusal, a thrown error or a read that ends after the wait is the same "not known yet": it is caught here, so none is left unhandled.
  const run = Promise.resolve()
    .then(() => verify(sink))
    .then(
      done => {
        receipt = done;
      },
      () => {},
    );
  await Promise.race([
    run,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  const finished = receipt !== undefined;
  // The wait is over and the read-back is not: it asks the provider for no more, and the queued job reads what is left.
  if (!finished) sink.stopped = true;
  const checks: JsonObject[] = finished && Array.isArray(receipt!.checks) ? receipt!.checks : sink.checks,
    mismatch = checks.some(c => c.status === 'mismatch'),
    status = finished
      ? ['verified', 'mismatch', 'failed', 'unsupported'].includes(receipt!.status)
        ? receipt!.status
        : 'checking'
      : mismatch
        ? 'mismatch'
        : 'checking',
    // The receipt's own hint, else, for a read-back still to finish, when the job will have read.
    retry =
      finished && typeof receipt!.retry_read_after_ms === 'number'
        ? receipt!.retry_read_after_ms
        : !finished || status === 'checking'
          ? checkingRetryMs
          : undefined;
  return {
    status,
    inline: true,
    waited_ms: Date.now() - began,
    ...verificationSummary(checks, finished ? Math.max(sink.total, checks.length) : Math.max(sink.total, planned)),
    ...(!finished && mismatch ? {complete: false} : {}),
    ...(finished && typeof receipt!.checked_at === 'number'
      ? {checked_at: new Date(receipt!.checked_at).toISOString()}
      : {}),
    ...(retry !== undefined ? {retry_read_after_ms: retry} : {}),
    ...(typeof marker?.job_id === 'string' ? {job_id: marker.job_id} : {}),
    ...(['checking', 'mismatch', 'failed'].includes(status) && marker?.next_call ? {next_call: marker.next_call} : {}),
  };
}
