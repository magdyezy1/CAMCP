import {PerRequestHTTPServerTransport, Server} from '@modelcontextprotocol/server';
import type {Transport} from '@modelcontextprotocol/server';

import {ProtocolErrorCode, ProtocolError} from '@modelcontextprotocol/server';
import type {Actor, JsonObject} from '../src/types.js';
import {outcomeSchema, workflowTools} from '../src/workflow-outcomes.js';
import {typedToolData} from '../src/report-tool-output.js';
import {answerWithProgress, progressTokenOf} from './mcp-progress.js';
import {
  TaskOffer,
  createTask,
  declaresTasks,
  registerTaskHandlers,
  taskCallResult,
  tasksExtension,
} from './mcp-tasks.js';
import {MirrorService, withExactIntegers} from '../src/service.js';
import {
  guidanceResources,
  guidanceResourceTemplates,
  readGuidance,
  campaignPrompt,
  buildCampaignPrompt,
  campaignPlatforms,
} from '../src/guidance.js';
import {MirrorError, errorResult} from '../src/errors.js';
import {serverIdentity} from '../src/server-identity.js';
import {serverInstructionsFor} from '../src/tool-annotations.js';
import {withContractProfile} from '../src/contract-profile.js';
import {contractProfileOf} from '../src/mcp-client-profile.js';
import {callIsRead} from '../src/call-kind.js';
import {invalidCursor} from '../src/page-cursor.js';
import {BudgetRequest, Continuation, budgetRequest, budgeted, continuationOf} from './mcp-budget.js';
import {randomUUID} from 'node:crypto';
/** AMCP's published legacy guide-error code; SDK v2 emits Invalid Params unless the legacy adapter restores it. */
const resourceNotFound = -32002;
/** SDK v2 normalizes resource errors in both eras. Preserve AMCP's published legacy guide error on legacy wires. */
function keepLegacyGuideErrors<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if ('error' in message && message.error.code === -32602) {
      const data = message.error.data;
      if (data && typeof data === 'object' && 'index' in data && data.index === 'amcp://guides/index')
        return send({...message, error: {...message.error, code: resourceNotFound}}, options);
    }
    return send(message, options);
  };
  return transport;
}
/**
 * The one result envelope every tool returns (MCP-05): {success, data, meta} or {success:false, error, meta}. The AMCP
 * workflow tools also declare meta.workflow, the typed outcome a client can plan its next call from (MCP-07); the
 * property is optional and other meta stays open, so the schema only adds.
 */
export function toolOutputSchema(tool: string): JsonObject {
  return {
    type: 'object',
    properties: {
      success: {type: 'boolean'},
      // The two reporting tools type the fields their actions share (src/report-tool-output.ts); every other tool leaves
      // the payload to its own actions.
      data: typedToolData[tool] ?? {},
      error: {
        type: 'object',
        properties: {code: {type: 'string'}, message: {type: 'string'}, details: {type: 'object'}},
        required: ['code', 'message'],
      },
      meta: workflowTools.includes(tool) ? {type: 'object', properties: {workflow: outcomeSchema}} : {type: 'object'},
    },
    required: ['success'],
  };
}
/**
 * Per-request hooks of the HTTP endpoint: `track` sees each tool call's work until it settles (SEC-02 in-flight cap).
 * `era` is the protocol era the server will serve, which the serving entries (`createMcpHandler`, `serveStdio`) report
 * in their factory's context; a server made for a legacy transport is the default.
 */
export interface McpServerHooks {
  track?: <T>(work: Promise<T>) => Promise<T>;
  era?: 'legacy' | 'modern';
}
/** The build identity /versionz reports, so a client can tell which build it is talking to (MCP-05). */
export const mcpServerInfo = () => ({name: 'amcp', version: String(serverIdentity().version)});
/**
 * What the server offers: the same tools, resources and prompts in both protocol eras, and in the 2026-07-28 revision the
 * tasks extension besides (server/mcp-tasks.ts). The earlier revisions are never told of it; server/discover reports the
 * 2026-07-28 set.
 */
export const mcpServerCapabilities = (era?: 'legacy' | 'modern') => ({
  tools: {},
  resources: {},
  prompts: {},
  ...(era === 'modern' ? {extensions: {[tasksExtension]: {}}} : {}),
});
/**
 * The caching hints of the 2026-07-28 revision, the same on every transport (HTTP and stdio). Lists and guides change
 * only with a release, but what a caller sees depends on their role, so they are private; server/discover describes the
 * deployment and not the caller, so it is public. The SDK stamps these on the results it builds; the legacy revisions
 * have no such fields and are never affected.
 */
export const mcpCacheHints = {
  'server/discover': {ttlMs: 3600000, cacheScope: 'public'},
  'tools/list': {ttlMs: 300000, cacheScope: 'private'},
  'prompts/list': {ttlMs: 300000, cacheScope: 'private'},
  'resources/list': {ttlMs: 300000, cacheScope: 'private'},
  'resources/templates/list': {ttlMs: 300000, cacheScope: 'private'},
  'resources/read': {ttlMs: 300000, cacheScope: 'private'},
} as const;
export function createMcpServer(service: MirrorService, actor: Actor, hooks: McpServerHooks = {}) {
  // Orientation for every client, pinned at 2,000 characters (MCP-06), in the deployment's mode: a read-only one offers
  // amcp_write inspect only, so its instructions never send a client to prepare or execute.
  const instructions = serverInstructionsFor(service.policy),
    server = new Server(mcpServerInfo(), {
      capabilities: mcpServerCapabilities(hooks.era),
      instructions,
      cacheHints: mcpCacheHints,
    });
  const connect = server.connect.bind(server);
  server.connect = transport =>
    connect(
      hooks.era !== 'modern' && !(transport instanceof PerRequestHTTPServerTransport)
        ? keepLegacyGuideErrors(transport)
        : transport,
    );
  server.setRequestHandler('resources/list', async () => {
    service.store.assertActorActive(actor);
    return {resources: guidanceResources};
  });
  // 2026-07-28 clients ask for resource templates. The guides' sections are the template a client on the v2 contract profile is
  // offered (V2-MCP-06); every other client is told there are none, as it always was. The earlier revisions never answered this
  // method on AMCP, and keep not doing so.
  if (hooks.era === 'modern')
    server.setRequestHandler('resources/templates/list', async () => {
      service.store.assertActorActive(actor);
      return {resourceTemplates: contractProfileOf(service.store, actor) === 'v2' ? guidanceResourceTemplates : []};
    });
  server.setRequestHandler('resources/read', async request => {
    service.store.assertActorActive(actor);
    try {
      // A section of a guide is a resource for a v2 client only: for any other its URI is unknown, on both revisions.
      return {contents: [readGuidance(request.params.uri, contractProfileOf(service.store, actor) === 'v2')]};
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'GUIDE_NOT_FOUND')
        throw new ProtocolError(resourceNotFound, 'Unknown AMCP guide URI.', {
          uri: String(request.params.uri).slice(0, 300),
          index: 'amcp://guides/index',
        });
      throw e;
    }
  });
  server.setRequestHandler('prompts/list', async () => {
    service.store.assertActorActive(actor);
    return {prompts: [campaignPrompt]};
  });
  server.setRequestHandler('prompts/get', async request => {
    service.store.assertActorActive(actor);
    if (request.params.name !== campaignPrompt.name)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown AMCP prompt.', {
        name: String(request.params.name).slice(0, 200),
        allowed: [campaignPrompt.name],
      });
    try {
      return buildCampaignPrompt(request.params.arguments ?? {});
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'INVALID_ARGUMENT')
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, e.message, {allowed: {platform: campaignPlatforms}});
      throw e;
    }
  });
  // Like every other handler, the catalog is listed only to a credential that is still active (SEC-05).
  server.setRequestHandler('tools/list', async () => {
    service.store.assertActorActive(actor);
    // The listing a client is shown follows its contract profile (V2-MCP-06), read from its record at this request.
    return withContractProfile(contractProfileOf(service.store, actor), () => ({
      tools: service.listTools().map(t => ({...t, outputSchema: toolOutputSchema(t.name)})) as any,
    }));
  });
  // The tasks extension exists on the 2026-07-28 path only (server/mcp-tasks.ts).
  if (hooks.era === 'modern') registerTaskHandlers(server, service, actor);
  server.setRequestHandler('tools/call', async (request, ctx) => {
    // The client's contract profile, read from its record at this request (V2-MCP-06): the call runs as that profile and no other.
    const profile = contractProfileOf(service.store, actor),
      name = request.params.name,
      // General discovery already used this structured envelope. Text-only clients must receive the same result.
      present = (result: JsonObject) => {
        const presented = typeof result.success === 'boolean' ? result : {success: true, data: result};
        return {
          content: [{type: 'text', text: JSON.stringify(presented)}],
          structuredContent: presented,
          ...(result.success === false ? {isError: true} : {}),
        };
      };
    // A v2 client's byte budget and continuation are this layer's arguments: a tool never sees them. Whether the call reads, and
    // where a continuation continues, are settled before anything runs, so a call that changes something is never run twice.
    let budget: BudgetRequest | undefined,
      reads = false,
      continued: Continuation | undefined;
    if (profile === 'v2')
      try {
        budget = budgetRequest(request.params.arguments ?? {});
        reads = callIsRead(service, name, budget.args);
        if (budget.continuation !== undefined) {
          if (!reads) throw invalidCursor('response continuation');
          continued = continuationOf(actor, name, budget);
        }
      } catch (e) {
        return present(errorResult(e, randomUUID(), 0)) as any;
      }
    const args = budget ? budget.args : (request.params.arguments ?? {}),
      token = progressTokenOf(request.params._meta),
      // Only a client that declares the tasks extension in this very request is offered a task, never one inferred.
      tasksOn = hooks.era === 'modern' && declaresTasks(ctx.mcpReq.envelope),
      // PRV-05: native reads give the client 64-bit integers exactly, never a rounded ID of another entity.
      call = () => service.call(name, args, actor),
      // A call that queues a long run is answered a task by a client that declares the extension; otherwise one that
      // carries a progress token waits for it, bounded, and reports its progress on this request's stream (V2-MCP-02).
      // With neither, nothing differs from a plain call.
      work = withContractProfile(
        profile,
        () =>
          withExactIntegers(
            token === undefined && !tasksOn
              ? call
              : async () => {
                  const answer = await call(),
                    offer = tasksOn ? createTask({service, actor, tool: name, args, result: answer}) : undefined;
                  if (offer) return offer;
                  return token === undefined
                    ? answer
                    : await answerWithProgress({
                        service,
                        actor,
                        tool: name,
                        args,
                        result: answer,
                        token,
                        notify: notification => ctx.mcpReq.notify(notification),
                        signal: ctx.mcpReq.signal,
                        read: read => service.call(read.tool, read.arguments, actor),
                      });
                },
          ),
        args,
      ),
      result = await (hooks.track ? hooks.track(work) : work);
    if (result instanceof TaskOffer) return taskCallResult(result) as any;
    // A v2 client's list read is cut at a row boundary to its budget, with the call that continues it (server/mcp-budget.ts).
    try {
      return present(
        budget && reads && result.success === true
          ? budgeted({tool: name, actor, request: budget, given: continued, envelope: result})
          : result,
      ) as any;
    } catch (e) {
      return present(errorResult(e, randomUUID(), 0)) as any;
    }
  });
  return server;
}
