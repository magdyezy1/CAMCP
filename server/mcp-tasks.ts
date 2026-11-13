import {randomBytes, timingSafeEqual} from 'node:crypto';
import {MissingRequiredClientCapabilityError, ProtocolError, ProtocolErrorCode} from '@modelcontextprotocol/server';
import type {Server} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {overviewPollAfterMs} from '../src/reporting-overview.js';
import {sha256} from '../src/security.js';
import {withExactIntegers, type MirrorService} from '../src/service.js';
import type {Actor, JsonObject} from '../src/types.js';
import {
  finished,
  isObject,
  longRunByKey,
  longRunFor,
  longRunKey,
  type LongRun,
  type RunHandle,
} from './mcp-long-runs.js';

/**
 * The tasks extension of MCP revision 2026-07-28 (`io.modelcontextprotocol/tasks`, V2-MCP-02 decision 6), built here
 * because the SDK has no runtime for it. It exists on the 2026-07-28 path only, and only for a client that declares the
 * extension in the request itself (never inferred from anything else). For such a client the two long runs of
 * server/mcp-long-runs.ts answer a task instead of a polling handle: `resultType: "task"` and the task, which is a
 * document of the person's workspace, written before the answer leaves. Every other client, and every earlier revision,
 * is answered as always, with `poll_after_ms` and `next_call`.
 *
 * - A task follows one job. Its status is the job's: working while it is queued or running, then completed with the
 *   result of the read a polling client would make (`get` of the plan, `export_status` of the export, as a tool result),
 *   failed with the job's error, or cancelled. Nothing is stored of the result, so every read is made again, as the
 *   person and under their current rights, from this workspace's own records; no provider is ever asked. The read is
 *   made at every status, not only when the job is complete: a caller who may no longer read the report (its client
 *   access set lost the account, say) is answered that refusal as a failed task, never the job's progress or error.
 * - A task is bound to the workspace, the person and the AI client it was made for (an OAuth connection is the
 *   actor `oauth/<client>` of its person): the identifier is random (192 bits), the document is read in the caller's own
 *   workspace, and the binding is checked besides. An identifier that is unknown, altered, expired, another person's, another
 *   AI client's or another workspace's is answered with one error with one message, nothing read and nothing changed.
 * - `tasks/cancel` stops an export with the cancel action as the person does today, so a role that cannot cancel cannot
 *   cancel a task; the request to stop is the consent that action asks for. Stopping a background run is cancelling its
 *   plan, a decision of its own, so that task answers with the call to make instead. `tasks/update` always refuses:
 *   AMCP asks for no input in a task. `tasks/list` and `tasks/result` do not exist in this revision.
 * - A person has at most `maxActive` tasks at once. Calling the same long run again answers the same task. Past the bound
 *   the call is answered as it would be without the extension, with its job handle.
 */
export const tasksExtension = 'io.modelcontextprotocol/tasks';
/** How long a task is kept after it was made, and so how long its identifier is good for. */
export const taskTtlMs = 86400000;
export const taskLimits = {
  // The server never writes this; tests/mcp-tasks.test.mjs narrows it.
  /** How many unexpired tasks one person (workspace, person and AI client) may have. */
  maxActive: 100,
};
const clientCapabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
/** The longest identifier looked up: AMCP's are 32 characters, so a longer one is unknown without a lookup. */
const longestIdentifier = 64;

/** Whether the request's client declared the extension. Only a declaration counts. */
export function declaresTasks(envelope: unknown): boolean {
  const capabilities = isObject(envelope) ? envelope[clientCapabilitiesKey] : undefined;
  return (
    isObject(capabilities) && isObject(capabilities.extensions) && isObject(capabilities.extensions[tasksExtension])
  );
}
/** What a task is bound to: its identifier, the workspace, the person and the AI client (the role is not part of it). */
export const taskBinding = (id: string, actor: Actor): string =>
  sha256(
    JSON.stringify(['mcp-task', id, actor.tenantId, actor.userId, actor.ownerUserId ?? '', actor.accessSetId ?? '']),
  );
const sameBinding = (a: unknown, b: string) =>
  typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What a task is stored as: the long run and job it follows, and who it belongs to. */
interface TaskDocument extends JsonObject {
  run: string;
  job_id: string;
  resource_id: string;
  owner_user_id: string;
  binding: string;
  created_at: number;
  expires_at: number;
}
/** A task a call is to be answered with in place of its own answer. */
export class TaskOffer {
  constructor(readonly task: JsonObject) {}
}
/** The result of a `tools/call` that made a task: the task, with the text every tool result carries. */
export const taskCallResult = (offer: TaskOffer): JsonObject => ({
  resultType: 'task',
  task: offer.task,
  content: [{type: 'text', text: JSON.stringify({task: offer.task})}],
});

const unknownTask = () => new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task.');
const iso = (at: unknown) => new Date(typeof at === 'number' ? at : 0).toISOString();
const statusOf = (state: unknown) =>
  state === 'complete' ? 'completed' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'working';

/** The task as the protocol describes it, from its document and the job's record. */
function describe(
  service: MirrorService,
  tenant: string,
  doc: TaskDocument,
  job: JsonObject,
  run: LongRun,
): JsonObject {
  const status = statusOf(job.state),
    message = status === 'working' ? run.point(service, tenant, job).message : undefined;
  return {
    taskId: doc.id,
    status,
    ...(message ? {statusMessage: message} : {}),
    createdAt: iso(doc.created_at),
    lastUpdatedAt: iso(job.updated_at ?? doc.created_at),
    ttlMs: taskTtlMs,
    pollIntervalMs: overviewPollAfterMs,
  };
}

/**
 * The task a call is answered with, made now, or undefined when the call is not a long run, did not queue one, queued one
 * that has already finished (there is nothing to wait for), or the person has `maxActive` tasks. The same long run
 * asked again is the same task.
 */
export function createTask(call: {
  service: MirrorService;
  actor: Actor;
  tool: string;
  args: JsonObject;
  result: JsonObject;
}): TaskOffer | undefined {
  const {service, actor, tool, args, result} = call,
    run = longRunFor(tool, args);
  if (!run || result.success !== true || !isObject(result.data)) return undefined;
  const handle = run.handle(result.data);
  if (!handle) return undefined;
  const tenant = actor.tenantId,
    store = service.store;
  let job: JsonObject;
  try {
    job = store.job(tenant, handle.job);
  } catch {
    return undefined;
  }
  if (finished(job.state)) return undefined;
  const repo = store.repo('mcp_task', tenant),
    now = Date.now(),
    owner = actor.ownerUserId ?? actor.userId,
    mine = (repo.findBy('owner_user_id', owner) as unknown as TaskDocument[]).filter(
      doc => doc.expires_at > now && sameBinding(doc.binding, taskBinding(doc.id, actor)),
    );
  const key = longRunKey(tool, String(args.action)),
    existing = mine.find(doc => doc.run === key && doc.job_id === handle.job);
  if (existing) return new TaskOffer(describe(service, tenant, existing, job, run));
  if (mine.length >= taskLimits.maxActive) return undefined;
  const id = randomBytes(24).toString('base64url'),
    document = {
      run: key,
      job_id: handle.job,
      resource_id: handle.id,
      owner_user_id: owner,
      binding: taskBinding(id, actor),
      created_at: now,
      expires_at: now + taskTtlMs,
    };
  repo.put(id, document);
  return new TaskOffer(describe(service, tenant, {...document, id, revision: 1}, job, run));
}

/**
 * Registers `tasks/get`, `tasks/update` and `tasks/cancel` on a server that serves the 2026-07-28 revision, for the
 * caller it was made for.
 */
export function registerTaskHandlers(server: Server, service: MirrorService, actor: Actor): void {
  const tenant = actor.tenantId,
    store = service.store;
  /** A request of a client that declared the extension, for a task of this caller that is still kept. */
  const open = (envelope: unknown, taskId: string) => {
    if (!declaresTasks(envelope))
      throw new MissingRequiredClientCapabilityError({requiredCapabilities: {extensions: {[tasksExtension]: {}}}});
    store.assertActorActive(actor);
    if (typeof taskId !== 'string' || !taskId || taskId.length > longestIdentifier) throw unknownTask();
    const doc = store.repo('mcp_task', tenant).find(taskId) as TaskDocument | undefined;
    if (!doc || !(doc.expires_at > Date.now()) || !sameBinding(doc.binding, taskBinding(taskId, actor)))
      throw unknownTask();
    const run = longRunByKey(String(doc.run));
    let job: JsonObject;
    try {
      job = store.job(tenant, String(doc.job_id));
    } catch {
      // The job is gone (its report was deleted): there is nothing left to report.
      throw unknownTask();
    }
    if (!run) throw unknownTask();
    const handle: RunHandle = {job: doc.job_id, id: doc.resource_id};
    return {doc, job, run, handle};
  };
  const schemas = {params: z.looseObject({taskId: z.string()}), result: z.looseObject({})};
  server.setRequestHandler('tasks/get', schemas, async (params, ctx) => {
    const {doc, job, run, handle} = open(ctx.mcpReq.envelope, params.taskId);
    // Every status is read again, as the person and under the rights they have now (P2A-03). The binding of a task names
    // its access set by id, not by content, so a set that was narrowed after the task was made still matches it; the read
    // a polling client would make is what checks the report's accounts. A caller who may no longer read the report is
    // answered the refusal of that read and nothing of the job: not its progress, not its error text, no result.
    const read = run.read(handle),
      answer = await withExactIntegers(() => service.call(read.tool, read.arguments, actor));
    if (answer.success !== true)
      return {
        taskId: doc.id,
        status: 'failed',
        createdAt: iso(doc.created_at),
        lastUpdatedAt: iso(doc.created_at),
        ttlMs: taskTtlMs,
        pollIntervalMs: overviewPollAfterMs,
        error: {
          code: ProtocolErrorCode.InternalError,
          message: String(answer.error?.message ?? 'The result of the job cannot be read.'),
          ...(answer.error?.code ? {data: {code: String(answer.error.code)}} : {}),
        },
      };
    const task = describe(service, tenant, doc, job, run);
    if (task.status === 'failed')
      return {
        ...task,
        error: {
          code: ProtocolErrorCode.InternalError,
          message: String(job.error?.message ?? 'The job failed.'),
          ...(job.error?.code ? {data: {code: String(job.error.code)}} : {}),
        },
      };
    if (task.status !== 'completed') return task;
    // Completed: the result is what a polling client reads, as a tool result, as the person and under their rights now.
    return {
      ...task,
      result: {content: [{type: 'text', text: JSON.stringify(answer)}], structuredContent: answer},
    };
  });
  server.setRequestHandler('tasks/update', schemas, async (params, ctx) => {
    open(ctx.mcpReq.envelope, params.taskId);
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'This task takes no input: AMCP never asks for input in a task.',
    );
  });
  server.setRequestHandler('tasks/cancel', schemas, async (params, ctx) => {
    const {job, run, handle} = open(ctx.mcpReq.envelope, params.taskId);
    if (finished(job.state))
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'This task has already finished.');
    const how = run.cancel(handle);
    if ('instead' in how)
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Stopping this run is cancelling its plan, which needs the person’s confirmation. Ask them, then make the next_call.',
        {next_call: how.instead},
      );
    const answer = await service.call(how.run.tool, how.run.arguments, actor);
    if (answer.success !== true)
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        String(answer.error?.message ?? 'The job cannot be cancelled.'),
        {code: String(answer.error?.code ?? 'CANCEL_REFUSED')},
      );
    return {};
  });
}
