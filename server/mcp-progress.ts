import type {MirrorService} from '../src/service.js';
import type {Actor, JsonObject} from '../src/types.js';
import {finished, isObject, longRunFor, type ReadCall} from './mcp-long-runs.js';

/**
 * Progress for the two long runs of the MCP tools (V2-MCP-02, decision 5): a call to `amcp_campaign run_background` or to
 * `amcp_reporting_overview export` that carries a `progressToken` stays open for a bounded time, sends
 * `notifications/progress` on its own request's stream as the job moves, and then answers. A client that sends no token
 * gets the answer it always got, at once; nothing here runs for it.
 *
 * What the wait is and is not:
 * - It reads the job's own durable record (the jobs table, and the plan of a background run), as the polling actions do; it
 *   never reads a provider, and it holds no lock.
 * - It ends when the job has finished, when the time is up (`holdMs`), when the caller has gone (a closed connection, or
 *   in the 2026-07-28 revision a cancelled request, which closes its stream) or when the process already holds `maxHeld`
 *   such requests, or the actor already holds its share of them (`perActor`); past either cap a call is answered at
 *   once. The share keeps one caller from holding every slot. The time is a bound even for a stream that stalls: the
 *   wait for a notification to be sent ends at the deadline and when the caller goes. It never cancels the job: the job
 *   was queued before the wait began and runs on under its own worker whatever the client does. (The earlier revisions
 *   send a cancel as a separate request, which the stateless server cannot match to the held one; there only a closed
 *   connection ends the wait early.)
 * - A job that finished within the wait answers with the read that shows it finished (`get` of the plan, `export_status`
 *   of the export). A job still running at the end answers what the call answered: the job handle and the next call.
 * - A notification is sent only when the progress has grown, since a progress value must increase; the first one is sent
 *   at once, so the client sees the wait begin. The message is the job's state and, for a plan, its count of uploads.
 */
export const progressLimits = {
  // The server never writes these; tests/mcp-progress.test.mjs narrows them to keep its holds short.
  /** How long one call may be held, in milliseconds. */
  holdMs: 25000,
  /** How often the job's record is read while it is held. */
  pollMs: 500,
  /** How many calls this process holds at once; a call past it is answered at once. */
  maxHeld: 8,
  /** How many of them one actor (workspace, person and AI client) may hold, so that no caller holds every slot. */
  perActor: 2,
};
let held = 0;
const heldBy = new Map<string, number>();
/** What a share is counted for: the workspace, the person and the AI client (the same identity a task is bound to). */
const shareOf = (actor: Actor): string => JSON.stringify([actor.tenantId, actor.userId, actor.ownerUserId ?? '']);
/** How many calls this process holds now (tests read it to see a hold end). */
export const heldNow = (): number => held;
/** How many calls one actor holds now. */
export const heldFor = (actor: Actor): number => heldBy.get(shareOf(actor)) ?? 0;

/** The progress token a request's `_meta` carries: a string or an integer, as the protocol defines it. */
export function progressTokenOf(meta: unknown): string | number | undefined {
  const token = isObject(meta) ? meta.progressToken : undefined;
  return typeof token === 'string' || (typeof token === 'number' && Number.isSafeInteger(token)) ? token : undefined;
}
/**
 * Whether a POST of the earlier protocol revisions must be answered as an event stream: a `tools/call` of a long run that
 * carries a progress token, from a client that accepts one. Those revisions answer in JSON, which has no room for a
 * notification; every other request keeps its JSON answer.
 */
export function wantsProgressStream(accept: unknown, body: unknown): boolean {
  if (typeof accept !== 'string' || !/text\/event-stream/i.test(accept)) return false;
  if (!isObject(body) || body.method !== 'tools/call' || !isObject(body.params)) return false;
  return (
    progressTokenOf(body.params._meta) !== undefined &&
    longRunFor(body.params.name, body.params.arguments) !== undefined
  );
}

/** A call that carries a progress token, and what it needs to wait on the job it queued. */
export interface ProgressCall {
  service: MirrorService;
  actor: Actor;
  tool: string;
  args: JsonObject;
  /** The envelope the call answered. */
  result: JsonObject;
  token: string | number;
  /** Sends a notification on the stream of this request. */
  notify: (notification: {method: string; params: JsonObject}) => Promise<void>;
  /**
   * Aborts when the request ends before its answer: a cancelled request, or a connection that closed (the SDK closes the
   * request's server when the HTTP response or the stdio input closes, in every protocol revision).
   */
  signal: AbortSignal;
  /** Runs the read that shows the job finished, as the person (AMCP's own tool call). */
  read: (call: ReadCall) => Promise<JsonObject>;
}

/** Waits `ms`, or until the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener('abort', done, {once: true});
  });
}

/**
 * `work`, unless `ms` pass or the signal aborts first: then `undefined`, and `work` is left to settle on its own (its
 * failure is then of no interest). A failure of `work` before that is thrown. The timer and the listener never outlive it.
 */
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<{value: T} | undefined> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', gone);
    };
    const gone = () => {
      settle();
      resolve(undefined);
    };
    const timer = setTimeout(gone, Math.max(0, ms));
    // Handlers first, so that a failure of work after the wait has ended is never an unhandled rejection.
    work.then(
      value => {
        settle();
        resolve({value});
      },
      error => {
        settle();
        reject(error);
      },
    );
    if (signal.aborted) return gone();
    signal.addEventListener('abort', gone, {once: true});
  });
}

/**
 * The answer to a call that carries a progress token: the call's own answer, or the finished read of the job it queued
 * when the job finished while the call was held (see the file comment for what holds and what ends it).
 */
export async function answerWithProgress(call: ProgressCall): Promise<JsonObject> {
  const {result} = call,
    run = longRunFor(call.tool, call.args);
  if (!run || result.success !== true || !isObject(result.data)) return result;
  const handle = run.handle(result.data);
  const share = shareOf(call.actor);
  if (!handle || held >= progressLimits.maxHeld || (heldBy.get(share) ?? 0) >= progressLimits.perActor) return result;
  const store = call.service.store,
    tenant = call.actor.tenantId,
    ended = () => call.signal.aborted,
    deadline = Date.now() + progressLimits.holdMs;
  held++;
  heldBy.set(share, (heldBy.get(share) ?? 0) + 1);
  try {
    let sent: number | undefined,
      first = true;
    for (;;) {
      let job: JsonObject;
      try {
        job = store.job(tenant, handle.job);
      } catch {
        return result;
      }
      const over = finished(job.state);
      // A job that has already finished when the wait begins needs no notification; it is answered below.
      if (!(first && over)) {
        const point = run.point(call.service, tenant, job);
        if (point.done !== undefined && (sent === undefined || point.done > sent)) {
          try {
            // Not awaited past the deadline or the caller's going: a stream that stalls must not keep the slot.
            const delivered = await within(
              call.notify({
                method: 'notifications/progress',
                params: {progressToken: call.token, progress: point.done, total: point.total, message: point.message},
              }),
              deadline - Date.now(),
              call.signal,
            );
            if (!delivered) return result;
          } catch {
            // The stream is closed: nobody is waiting, and the job is unaffected.
            return result;
          }
          sent = point.done;
        }
      }
      first = false;
      if (over) {
        const answer = await call.read(run.read(handle));
        return answer.success === true ? answer : result;
      }
      if (ended() || Date.now() >= deadline) return result;
      await pause(Math.min(progressLimits.pollMs, deadline - Date.now()), call.signal);
      if (ended()) return result;
    }
  } finally {
    held--;
    const left = (heldBy.get(share) ?? 1) - 1;
    if (left > 0) heldBy.set(share, left);
    else heldBy.delete(share);
  }
}
