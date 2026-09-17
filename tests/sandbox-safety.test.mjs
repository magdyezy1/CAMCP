import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {sandboxFetch,validateSandboxFixture,runSandbox} from '../dist/tools/live-sandbox.js';
import {buildUrl} from '../dist/src/transport.js';
import {Store} from '../dist/src/store.js';
test('sandbox defaults do not read credentials/fixture and cannot fall back to production or media services',async()=>{
 const r=JSON.parse(execFileSync(process.execPath,['dist/tools/live-sandbox.js','does-not-exist.json'],{env:{...process.env,AMCP_LIVE_SANDBOX:'false',AMCP_SANDBOX_CREDENTIALS_JSON:'invalid-json'},encoding:'utf8'}));assert.equal(r.status,'skipped');
 let calls=0;const fetcher=sandboxFetch(async()=>{calls++;return Response.json({});});
 for(const url of ['https://ads-api.x.com/12/accounts/a','https://upload.x.com/1.1/media/upload.json','https://api.x.com/2/tweets','https://ads-api-sandbox.x.com.evil.invalid/'])await assert.rejects(()=>fetcher(url),{code:'SANDBOX_ROUTE_UNQUALIFIED'});
 await assert.rejects(()=>fetcher('https://ads-api-sandbox.x.com/12/accounts/a',{method:'DELETE'}),{code:'SANDBOX_ROUTE_UNQUALIFIED'});assert.equal(calls,0);
 const p={gateway:'x_ads_native_action',path:'/12/accounts/a/campaigns',query:{}};
 assert.equal(buildUrl(p,{},'sandbox').hostname,'ads-api-sandbox.x.com');assert.equal(buildUrl(p,{}).hostname,'ads-api.x.com');
 assert.throws(()=>buildUrl({...p,origin:'https://upload.x.com'},{},'sandbox'),{code:'SANDBOX_ROUTE_UNQUALIFIED'});
 assert.throws(()=>validateSandboxFixture({gateway:'tiktok_native_action',account_id:'123',steps:[]}));
});
test('sandbox runner follows AMCP prepare/execute/verify and retains completed run idempotency',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,29).toString('base64')),credentials={consumerKey:'synthetic',consumerSecret:'synthetic',accessToken:'synthetic',tokenSecret:'synthetic'};
 const config={gateway:'x_ads_native_action',account_id:'test123',steps:[{id:'campaign',kind:'write',gateway:'x_ads_native_action',account_id:'test123',connection_id:'sandbox',depends_on:[],arguments:{action:'x_accounts_account_id_campaigns_post',payload:{name:'Synthetic sandbox campaign',entity_status:'PAUSED'}}}]};
 let mutations=0,record;const fetcher=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.hostname,'ads-api-sandbox.x.com');assert.match(new Headers(init.headers).get('Authorization'),/^OAuth /);
  if(init.method==='POST'){mutations++;record={id:'campaign1',...Object.fromEntries(new URLSearchParams(String(init.body)))};return Response.json({data:record});}
  return Response.json({data:url.pathname.endsWith('/test123')?{id:'test123',name:'Sandbox'}:record});
 };
 try{assert.equal((await runSandbox(config,store,credentials,'run-1','a'.repeat(64),fetcher)).status,'verified');assert.equal((await runSandbox(config,store,credentials,'run-1','a'.repeat(64),fetcher)).status,'verified');assert.equal(mutations,1);await assert.rejects(()=>runSandbox(config,store,credentials,'run-1','b'.repeat(64),fetcher));}finally{store.close();}
});
