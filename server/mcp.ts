import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type {Actor, JsonObject} from '../src/types.js';
import {outcomeSchema, workflowTools} from '../src/workflow-outcomes.js';
import {MirrorService} from '../src/service.js';
import {
  guidanceResources,
  readGuidance,
  campaignPrompt,
  buildCampaignPrompt,
  campaignPlatforms,
} from '../src/guidance.js';
import {MirrorError} from '../src/errors.js';
import {serverIdentity} from '../src/server-identity.js';
import {serverInstructions} from '../src/tool-annotations.js';
/** JSON-RPC's "resource not found" (MCP-05); the SDK names only the generic codes. */
const resourceNotFound = -32002;
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
      error: {type: 'object', required: ['code', 'message']},
      meta: workflowTools.includes(tool) ? {type: 'object', properties: {workflow: outcomeSchema}} : {type: 'object'},
    },
    required: ['success'],
  };
}
/** Per-request hooks of the HTTP endpoint: `track` sees each tool call's work until it settles (SEC-02 in-flight cap). */
export interface McpServerHooks {
  track?: <T>(work: Promise<T>) => Promise<T>;
}
export function createMcpServer(service: MirrorService, actor: Actor, hooks: McpServerHooks = {}) {
  const server = new Server(
    // The build identity /versionz reports, so a client can tell which build it is talking to (MCP-05).
    {name: 'amcp', version: String(serverIdentity().version)},
    // Orientation for every client, pinned at 2,000 characters (MCP-06).
    {capabilities: {tools: {}, resources: {}, prompts: {}}, instructions: serverInstructions},
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {resources: guidanceResources};
  });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    service.store.assertActorActive(actor);
    try {
      return {contents: [readGuidance(request.params.uri)]};
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'GUIDE_NOT_FOUND')
        throw new McpError(resourceNotFound, 'Unknown AMCP guide URI.', {
          uri: String(request.params.uri).slice(0, 300),
          index: 'amcp://guides/index',
        });
      throw e;
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {prompts: [campaignPrompt]};
  });
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    service.store.assertActorActive(actor);
    if (request.params.name !== campaignPrompt.name)
      throw new McpError(ErrorCode.InvalidParams, 'Unknown AMCP prompt.', {
        name: String(request.params.name).slice(0, 200),
        allowed: [campaignPrompt.name],
      });
    try {
      return buildCampaignPrompt(request.params.arguments ?? {});
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'INVALID_ARGUMENT')
        throw new McpError(ErrorCode.InvalidParams, e.message, {allowed: {platform: campaignPlatforms}});
      throw e;
    }
  });
  // Like every other handler, the catalog is listed only to a credential that is still active (SEC-05).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {tools: service.listTools().map(t => ({...t, outputSchema: toolOutputSchema(t.name)})) as any};
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const work = service.call(request.params.name, request.params.arguments ?? {}, actor),
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
