import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorService} from '../src/service.js';
import {createMcpServer} from '../server/mcp.js';
import type {Actor} from '../src/types.js';
const actor:Actor={tenantId:'t',userId:'test',role:'admin'};
test('MCP initialize, list tools and call help work through real SDK transports',async()=>{
 const store=new Store(':memory:');const service=new MirrorService(new Registry(),store);const server=createMcpServer(service,actor);const client=new Client({name:'test',version:'1'});const [c,s]=InMemoryTransport.createLinkedPair();
 try{await server.connect(s);await client.connect(c);const list=await client.listTools();assert.equal(list.tools.length,20);const response=await client.callTool({name:'whathead_tool_help',arguments:{}});const content=response.content as any[];assert.equal(JSON.parse(content[0].text).surface,'compact-v1');}finally{await client.close();await server.close();store.close();}
});
test('dry run compiles without credentials or any network request',async()=>{
 let calls=0;const store=new Store(':memory:');const service=new MirrorService(new Registry(),store,new NativeTransport((async()=>{calls++;throw Error('unexpected network');}) as typeof fetch));
 try{const r=await service.call('meta_native_action',{action:'meta_ad_account_id_campaigns_create',account_id:'123',payload:{},dry_run:true},actor);assert.equal(r.success,true);assert.equal(r.data.executed,false);assert.equal(calls,0);}finally{store.close();}
});
test('live writes are denied in the read-only deployment even when confirmed',async()=>{
 let calls=0;const store=new Store(':memory:');const service=new MirrorService(new Registry(),store,new NativeTransport((async()=>{calls++;throw Error();}) as typeof fetch));
 try{const r=await service.call('meta_native_action',{action:'meta_ad_account_id_campaigns_create',account_id:'123',payload:{name:'draft'},dry_run:false,confirmed:true,idempotency_key:'test'},actor);assert.equal(r.success,false);assert.equal(r.error.code,'LIVE_WRITES_DISABLED');assert.equal(calls,0);}finally{store.close();}
});
test('connected read traverses compiler, tenant binding, encrypted auth, transport and audit',async()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64'));store.putConnection(actor,{id:'c',tenantId:'t',gateway:'meta_native_action',accounts:['123'],enabled:true,label:'test',scopes:[]},{accessToken:'test-secret'});
 let calls=0;const service=new MirrorService(new Registry(),store,new NativeTransport((async(url,options)=>{calls++;assert.equal(String(url),'https://graph.facebook.com/v25.0/act_123/campaigns?limit=1');assert.equal((options!.headers as any).Authorization,'Bearer test-secret');return new Response('{"data":[{"id":"1234567890123456789"}]}');}) as typeof fetch));
 try{const r=await service.call('meta_native_action',{action:'meta_ad_account_id_campaigns_get',account_id:'123',params:{limit:1}},actor);assert.equal(r.success,true);assert.equal(r.data.data.data[0].id,'1234567890123456789');assert.equal(calls,1);assert.equal(store.verifyAudit(),true);assert.ok(!JSON.stringify(store.audit('t')).includes('test-secret'));}finally{store.close();}
});
test('conflicting top-level and nested account IDs never reach a vendor',async()=>{
 let calls=0;const store=new Store(':memory:');const service=new MirrorService(new Registry(),store,new NativeTransport((async()=>{calls++;throw Error();}) as typeof fetch));
 try{const r=await service.call('meta_native_action',{action:'meta_ad_account_id_campaigns_get',account_id:'123',path_params:{ad_account_id:'456'}},actor);assert.equal(r.error.code,'ACCOUNT_SCOPE_MISMATCH');assert.equal(calls,0);}finally{store.close();}
});
