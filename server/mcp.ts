import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Actor} from '../src/types.js';
import {MirrorService} from '../src/service.js';
export function createMcpServer(service:MirrorService,actor:Actor){
 const server=new Server({name:'amcp',version:'0.1.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:service.registry.listTools(service.options) as any}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  const result=await service.call(request.params.name,request.params.arguments??{},actor);
  return {content:[{type:'text',text:JSON.stringify(result)}],...(result.success===false?{isError:true}:{})};
 });
 return server;
}
