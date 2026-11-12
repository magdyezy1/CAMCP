import type {MirrorService} from '../src/service.js';
import {backgroundRunProgress} from '../src/campaign-background.js';
import type {JsonObject} from '../src/types.js';

/**
 * The two long runs of the MCP tools (V2-MCP-02): `amcp_campaign run_background`, which queues an approved plan of media
 * uploads, and `amcp_reporting_overview export`, which queues the export of a snapshot. A call to either answers a handle
 * to a job that a worker runs on its own; a client follows it by polling (`get` of the plan, `export_status` of the
 * export), and the two ways to follow it without polling, a progress notification on the call's own stream
 * (server/mcp-progress.ts) and a task of the tasks extension (server/mcp-tasks.ts), read the same descriptors:
 * what the job is, where it stands, how to read its result and how it is stopped. Nothing else is a long run: a
 * report queued with `run`, a retry and every write answer as they always did.
 */
export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A job's states after which nothing more happens to it. */
export const finished = (state: unknown) => state === 'complete' || state === 'failed' || state === 'cancelled';

/** A call of one AMCP tool, as the person who made the long run: a read of its result, or the call that stops it. */
export interface ReadCall {
  tool: string;
  arguments: JsonObject;
}
/** The job a long run queued, and the record that names it: the plan, or the export. */
export interface RunHandle {
  job: string;
  id: string;
}
/** How far a job has come: units done (none to report for a failed or cancelled job) of a total, and a few words. */
export interface Point {
  done?: number;
  total: number;
  message: string;
}
export interface LongRun {
  /** The job the answer to the call queued; undefined when the answer queued nothing. */
  handle(data: JsonObject): RunHandle | undefined;
  /** The read that shows the result of the job once it has finished. */
  read(handle: RunHandle): ReadCall;
  /**
   * How the job is stopped: the call that does it, which an explicit request to stop carries the consent for; or, when
   * stopping it is a decision of its own, the call the person is to be asked to make instead.
   */
  cancel(handle: RunHandle): {run: ReadCall} | {instead: JsonObject};
  point(service: MirrorService, tenant: string, job: JsonObject): Point;
}

/** An export runs in two steps once it is queued: it starts, then it finishes. */
const exportStage: Readonly<Record<string, number>> = {queued: 0, running: 1, complete: 2};
const longRuns: Readonly<Record<string, LongRun>> = {
  'amcp_campaign run_background': {
    handle: data =>
      typeof data.id === 'string' && isObject(data.background) && typeof data.background.job_id === 'string'
        ? {job: data.background.job_id, id: data.id}
        : undefined,
    read: handle => ({tool: 'amcp_campaign', arguments: {action: 'get', id: handle.id}}),
    // Stopping a background run is cancelling its plan, which no job-level call does: the plan's own cancel, which asks
    // the person to confirm, stays the way.
    cancel: handle => ({
      instead: {
        tool: 'amcp_campaign',
        arguments: {action: 'cancel', id: handle.id},
        add_after_user_approval: {confirmed: true},
      },
    }),
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
      typeof data.id === 'string' && typeof data.job_id === 'string' ? {job: data.job_id, id: data.id} : undefined,
    read: handle => ({tool: 'amcp_reporting_overview', arguments: {action: 'export_status', id: handle.id}}),
    cancel: handle => ({
      run: {tool: 'amcp_reporting_overview', arguments: {action: 'cancel', id: handle.job, confirmed: true}},
    }),
    point: (_service, _tenant, job) => ({
      ...(exportStage[String(job.state)] === undefined ? {} : {done: exportStage[String(job.state)]!}),
      total: 2,
      message: String(job.state),
    }),
  },
};
/** The key of a long run in the table: its tool and action. */
export const longRunKey = (tool: string, action: string) => tool + ' ' + action;
/** The long run a tool call is, if it is one. */
export function longRunFor(tool: unknown, args: unknown): LongRun | undefined {
  if (typeof tool !== 'string' || !isObject(args) || typeof args.action !== 'string') return undefined;
  return longRunByKey(longRunKey(tool, args.action));
}
/** The long run a key of the table names (a task keeps its key). */
export const longRunByKey = (key: string): LongRun | undefined =>
  Object.hasOwn(longRuns, key) ? longRuns[key] : undefined;
