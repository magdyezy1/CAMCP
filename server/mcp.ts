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
export function createMcpServer(service: MirrorService, actor: Actor) {
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: service.listTools().map(t => ({...t, outputSchema})) as any,
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await service.call(request.params.name, request.params.arguments ?? {}, actor);
    return {
      content: [{type: 'text', text: JSON.stringify(result)}],
      structuredContent: typeof result.success === 'boolean' ? result : {success: true, data: result},
      ...(result.success === false ? {isError: true} : {}),
    };
  });
  return server;
}
