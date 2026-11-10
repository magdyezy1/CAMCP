import type {MirrorService} from '../src/service.js';
import {backgroundRunProgress} from '../src/campaign-background.js';
import type {Actor, JsonObject} from '../src/types.js';

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
 *   such requests; past the cap a call is answered at once. It never cancels the job: the job was queued before the wait
 *   began and runs on under its own worker whatever the client does. (The earlier revisions send a cancel as a separate
 *   request, which the stateless server cannot match to the held one; there only a closed connection ends the wait early.)
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
};
let held = 0;
/** How many calls this process holds now (tests read it to see a hold end). */
export const heldNow = (): number => held;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A job's states after which nothing more happens to it. */
const finished = (state: unknown) => state === 'complete' || state === 'failed' || state === 'cancelled';

interface Point {
  /** Units done; undefined when the job has nothing to report (a failed or cancelled job). */
  done?: number;
  total: number;
  message: string;
}
/** A read the call's own answer names, which shows the result of the job once it has finished. */
export interface ReadCall {
  tool: string;
  arguments: JsonObject;
}
interface LongRun {
  /** The job the answer to the call queued and the read that shows it finished; undefined when it queued nothing. */
  handle(data: JsonObject): {job: string; read: ReadCall} | undefined;
  point(service: MirrorService, tenant: string, job: JsonObject): Point;
}
/** An export runs in two steps once it is queued: it starts, then it finishes. */
const exportStage: Readonly<Record<string, number>> = {queued: 0, running: 1, complete: 2};
const longRuns: Readonly<Record<string, LongRun>> = {
  'amcp_campaign run_background': {
    handle: data =>
      typeof data.id === 'string' && isObject(data.background) && typeof data.background.job_id === 'string'
        ? {job: data.background.job_id, read: {tool: 'amcp_campaign', arguments: {action: 'get', id: data.id}}}
        : undefined,
    point(service, tenant, job) {
      const {state, done, total} = backgroundRunProgress(service.store, tenant, job);
      return {
        ...(done === undefined ? {} : {done}),
        total,
        message: done === undefined ? state : state + ': ' + done + ' of ' + total + ' uploads settled',
      };
    },
  },
  'amcp_reporting_overview export': {
    handle: data =>
      typeof data.id === 'string' && typeof data.job_id === 'string'
        ? {
            job: data.job_id,
            read: {tool: 'amcp_reporting_overview', arguments: {action: 'export_status', id: data.id}},
          }
        : undefined,
    point: (_service, _tenant, job) => ({
      ...(exportStage[String(job.state)] === undefined ? {} : {done: exportStage[String(job.state)]!}),
      total: 2,
      message: String(job.state),
    }),
  },
};
/** The long run a tool call is, if it is one. */
export function longRunFor(tool: unknown, args: unknown): LongRun | undefined {
  if (typeof tool !== 'string' || !isObject(args) || typeof args.action !== 'string') return undefined;
  return Object.hasOwn(longRuns, tool + ' ' + args.action) ? longRuns[tool + ' ' + args.action] : undefined;
}
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
 * The answer to a call that carries a progress token: the call's own answer, or the finished read of the job it queued
 * when the job finished while the call was held (see the file comment for what holds and what ends it).
 */
export async function answerWithProgress(call: ProgressCall): Promise<JsonObject> {
  const {result} = call,
    run = longRunFor(call.tool, call.args);
  if (!run || result.success !== true || !isObject(result.data)) return result;
  const handle = run.handle(result.data);
  if (!handle || held >= progressLimits.maxHeld) return result;
  const store = call.service.store,
    tenant = call.actor.tenantId,
    ended = () => call.signal.aborted,
    deadline = Date.now() + progressLimits.holdMs;
  held++;
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
            await call.notify({
              method: 'notifications/progress',
              params: {progressToken: call.token, progress: point.done, total: point.total, message: point.message},
            });
          } catch {
            // The stream is closed: nobody is waiting, and the job is unaffected.
            return result;
          }
          sent = point.done;
        }
      }
      first = false;
      if (over) {
        const answer = await call.read(handle.read);
        return answer.success === true ? answer : result;
      }
      if (ended() || Date.now() >= deadline) return result;
      await pause(Math.min(progressLimits.pollMs, deadline - Date.now()), call.signal);
      if (ended()) return result;
    }
  } finally {
    held--;
  }
}
