import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
test('real HTTP MCP enforces bearer, origin and body limits and serves SDK tools',async()=>{
 const store=new Store(':memory:'),service=new MirrorService(new Registry(),store);
 const key=store.createKey({tenantId:'http-test',userId:'r',role:'reader'});
 const listener=createHttpApp(service,store,{maxBodyBytes:8192}).listen(0,'127.0.0.1');
 await new Promise<void>(r=>listener.once('listening',r));const address=listener.address() as {port:number},url=new URL('http://127.0.0.1:'+address.port+'/mcp');
 const client=new Client({name:'http-integration',version:'1'});
 try{
  assert.equal((await fetch(url,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,401);
  assert.equal((await fetch(url,{method:'POST',body:'{}',headers:{Authorization:'Bearer '+key,Origin:'https://evil.invalid','Content-Type':'application/json'}})).status,403);
  assert.equal((await fetch(url,{method:'POST',body:JSON.stringify({padding:'x'.repeat(9000)}),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'}})).status,413);
  assert.equal((await fetch(url,{method:'POST',body:'{',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'}})).status,400);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+key}}}));
  assert.equal((await client.listTools()).tools.length,20);
  const result=await client.callTool({name:'whathead_tool_help',arguments:{}});assert.equal(JSON.parse((result.content as any)[0].text).surface,'compact-v1');
  store.revokeKey(key);assert.equal((await fetch(url,{headers:{Authorization:'Bearer '+key}})).status,401);
 }finally{await client.close();await new Promise<void>(r=>listener.close(()=>r()));store.close();}
});
