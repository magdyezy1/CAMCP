import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {Actor} from '../src/types.js';
import {MirrorService} from '../src/service.js';
import {guidanceResources, readGuidance, campaignPrompt, buildCampaignPrompt} from '../src/guidance.js';
/** Per-request hooks of the HTTP endpoint: `track` sees each tool call's work until it settles (SEC-02 in-flight cap). */
export interface McpServerHooks {
  track?: <T>(work: Promise<T>) => Promise<T>;
}
export function createMcpServer(service: MirrorService, actor: Actor, hooks: McpServerHooks = {}) {
  const server = new Server({name: 'amcp', version: '0.1.0'}, {capabilities: {tools: {}, resources: {}, prompts: {}}});
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {resources: guidanceResources};
  });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    service.store.assertActorActive(actor);
    return {contents: [readGuidance(request.params.uri)]};
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {prompts: [campaignPrompt]};
  });
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    service.store.assertActorActive(actor);
    if (request.params.name !== campaignPrompt.name) throw Error('Unknown AMCP prompt.');
    return buildCampaignPrompt(request.params.arguments ?? {});
  });
  const outputSchema = {
    type: 'object',
    properties: {
      success: {type: 'boolean'},
      data: {},
      error: {
        type: 'object',
        properties: {code: {type: 'string'}, message: {type: 'string'}, details: {type: 'object'}},
        required: ['code', 'message'],
      },
      meta: {type: 'object'},
    },
    required: ['success'],
  };
  // Like every other handler, the catalog is listed only to a credential that is still active (SEC-05).
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    service.store.assertActorActive(actor);
    return {tools: service.listTools().map(t => ({...t, outputSchema})) as any};
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
