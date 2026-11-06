import {PerRequestHTTPServerTransport, Server} from '@modelcontextprotocol/server';
import type {Transport} from '@modelcontextprotocol/server';

import {ProtocolErrorCode, ProtocolError} from '@modelcontextprotocol/server';
import type {Actor, JsonObject} from '../src/types.js';
import {outcomeSchema, workflowTools} from '../src/workflow-outcomes.js';
import {MirrorService, withExactIntegers} from '../src/service.js';
import {
  guidanceResources,
  readGuidance,
  campaignPrompt,
  buildCampaignPrompt,
  campaignPlatforms,
} from '../src/guidance.js';
import {MirrorError} from '../src/errors.js';
import {serverIdentity} from '../src/server-identity.js';
import {serverInstructionsFor} from '../src/tool-annotations.js';
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
      data: {},
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
/** What the server offers in both protocol eras; server/discover of the 2026-07-28 handler reports the same. */
export const mcpServerCapabilities = () => ({tools: {}, resources: {}, prompts: {}});
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
      capabilities: mcpServerCapabilities(),
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
  // 2026-07-28 clients ask for resource templates (the guides are to be served as templates); AMCP has none yet. The
  // earlier revisions never answered this method on AMCP, and keep not doing so.
  if (hooks.era === 'modern')
    server.setRequestHandler('resources/templates/list', async () => {
      service.store.assertActorActive(actor);
      return {resourceTemplates: []};
    });
  server.setRequestHandler('resources/read', async request => {
    service.store.assertActorActive(actor);
    try {
      return {contents: [readGuidance(request.params.uri)]};
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
    return {tools: service.listTools().map(t => ({...t, outputSchema: toolOutputSchema(t.name)})) as any};
  });
  server.setRequestHandler('tools/call', async request => {
    // PRV-05: native reads give the client 64-bit integers exactly, never a rounded ID of another entity.
    const work = withExactIntegers(() => service.call(request.params.name, request.params.arguments ?? {}, actor)),
      result = await (hooks.track ? hooks.track(work) : work),
      // General discovery already used this structured envelope. Text-only clients must receive the same result.
      presented = typeof result.success === 'boolean' ? result : {success: true, data: result};
    return {
      content: [{type: 'text', text: JSON.stringify(presented)}],
      structuredContent: presented,
      ...(result.success === false ? {isError: true} : {}),
    };
  });
  return server;
}
