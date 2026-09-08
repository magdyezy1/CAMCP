import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {CredentialProvider} from '../src/auth.js';
import {nextPage} from '../src/pagination.js';
import {createReportExecutor} from '../src/report-executor.js';
import {ReportWorker} from '../src/worker.js';
import type {Actor,Connection} from '../src/types.js';

const actor:Actor={tenantId:'reddit-test',userId:'operator',role:'reader'};
const connection:Connection={id:'00000000-0000-4000-8000-000000000001',tenantId:actor.tenantId,gateway:'reddit_native_action',accounts:['a2_111'],enabled:true,label:'test',scopes:['adsread'],userAgent:'server:amcp-mirror-test:0.1.0 (local mock)'};
const registry=new Registry();
const report={action:'GET_INSIGHTS',account_id:'a2_111',payload:{data:{starts_at:'2026-08-01T00:00:00Z',ends_at:'2026-08-02T00:00:00Z',fields:['IMPRESSIONS'],breakdowns:['DATE']}}};
function setup(fetcher:typeof fetch){
 const store=new Store(':memory:',Buffer.alloc(32,11).toString('base64'));
 store.putConnection({...actor,role:'admin'},connection,{accessToken:'synthetic'});
 const service=new MirrorService(registry,store,new NativeTransport(fetcher,async()=>{}));
 return {store,service,call:(operation:string,args:any)=>service.call('reddit_native_action',{operation,arguments:args},actor)};
}

test('Reddit published routes use account aliases, comma lists and explicit query pagination',async()=>{
 const calls:any[]=[];const x=setup((async(url,init)=>{calls.push({url:new URL(String(url)),init});return new Response('{"data":[],"pagination":{}}');}) as typeof fetch);
 try{
  const r=await x.call('reddit_campaign_ops',{action:'FETCH_CAMPAIGNS',account_id:'a2_111',connectionId:connection.id,params:{id:['123','456']},pageSize:50,pageToken:'next'});
  assert.equal(r.success,true);assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/api/v3/ad_accounts/a2_111/campaigns');assert.equal(calls[0].url.searchParams.get('id'),'123,456');assert.equal(calls[0].url.searchParams.get('page.size'),'50');assert.equal(calls[0].url.searchParams.get('page.token'),'next');assert.equal(calls[0].init.headers['User-Agent'],connection.userAgent);
  const conflict=await x.call('reddit_campaign_ops',{action:'LIST_CAMPAIGNS',account_id:'a2_111',params:{ad_account_id:'a2_222'}});assert.equal(conflict.success,false);assert.equal(calls.length,1);
  const alias=await x.call('reddit_campaign_ops',{action:'LIST_CAMPAIGNS',account_id:'a2_111',connection_id:connection.id,connectionId:'00000000-0000-4000-8000-000000000002'});assert.equal(alias.error.code,'CONFLICTING_PARAMETER');assert.equal(calls.length,1);
 }finally{x.store.close();}
});

test('Reddit mutations validate vendor bodies and preview without network or credential access',async()=>{
 let calls=0;const x=setup((async()=>{calls++;throw Error('unexpected egress');}) as typeof fetch);
 try{
  const args={action:'CREATE_CAMPAIGN',account_id:'a2_111',payload:{data:{name:'Local preview',configured_status:'PAUSED',objective:'CLICKS'}}};
  const result=await x.call('reddit_campaign_ops',args);assert.equal(result.success,true);assert.equal(result.data.executed,false);assert.equal(result.data.request.method,'POST');assert.deepEqual(result.data.request.body,args.payload);
  const denied=await x.call('reddit_campaign_ops',{...args,dry_run:false,confirmed:true});assert.equal(denied.error.code,'LIVE_WRITES_DISABLED');
  const invalid=await x.call('reddit_campaign_ops',{...args,payload:{data:{name:'Incomplete'}}});assert.equal(invalid.error.code,'INVALID_VENDOR_BODY');
  const badReport=await x.call('reddit_reporting_ops',{...report,payload:{data:{...report.payload.data,ends_at:report.payload.data.starts_at}}});assert.equal(badReport.error.code,'INVALID_REPORT_WINDOW');
  assert.equal(calls,0);
 }finally{x.store.close();}
});

test('Reddit global campaign reads require ownership learned from a bound collection',async()=>{
 const urls:string[]=[];const x=setup((async(url)=>{urls.push(String(url));return new Response(JSON.stringify(String(url).endsWith('/campaigns')?{data:[{id:'123',ad_account_id:'a2_111'},{id:'999',ad_account_id:'a2_222'}],pagination:{}}:{data:{id:'123'}}));}) as typeof fetch);
 try{
  const args={action:'GET_CAMPAIGN',account_id:'a2_111',params:{campaign_id:'123'}};
  assert.equal((await x.call('reddit_campaign_ops',args)).error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(urls.length,0);
  assert.equal((await x.call('reddit_campaign_ops',{action:'LIST_CAMPAIGNS',account_id:'a2_111'})).success,true);
  const owned=await x.call('reddit_campaign_ops',args);assert.equal(owned.success,true,JSON.stringify(owned));
  assert.equal((await x.call('reddit_campaign_ops',{...args,params:{campaign_id:'999'}})).error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(urls.length,2);
 }finally{x.store.close();}
});

test('native Reddit reporting collects each page with the same body and fails on truncation',async()=>{
 for(const endless of [false,true]){
  const calls:any[]=[];const x=setup((async(url,init)=>{calls.push({url:String(url),body:init?.body});return new Response(JSON.stringify({data:{metrics:[{date:'2026-08-01',impressions:calls.length}]},pagination:{next_url:endless||calls.length===1?'https://ads-api.reddit.com/api/v3/ad_accounts/a2_111/reports?page.token='+calls.length:null}}));}) as typeof fetch);
  try{
   const id=x.store.enqueue(actor.tenantId,'report',{query_config:{gateway:'reddit_native_action',arguments:{operation:'reddit_reporting_ops',arguments:report}}});
   await new ReportWorker(x.store,createReportExecutor(x.service)).once();const job=x.store.job(actor.tenantId,id);
   assert.equal(job.state,endless?'failed':'complete');assert.equal(calls.length,endless?25:2);assert.ok(calls.every(c=>c.body===JSON.stringify(report.payload)));
   if(endless)assert.equal(job.error.code,'REPORT_TRUNCATED');else {assert.equal(job.result.data.data.metrics.length,2);assert.equal(job.result.pages,2);}
  }finally{x.store.close();}
 }
});

test('Reddit pagination refuses new filters, account changes, credentials and duplicate tokens',()=>{
 const x=setup((async()=>{throw Error('no egress');}) as typeof fetch);
 try{
  const plan=x.service.delegatedCompiler.compile('reddit_native_action',{operation:'reddit_reporting_ops',arguments:report});
  const prefix='https://ads-api.reddit.com/api/v3/ad_accounts/a2_111/reports';
  for(const link of [prefix.replace('a2_111','a2_222')+'?page.token=2',prefix+'?page.token=2&ad_account_id=a2_222',prefix+'?page.token=2&page.token=3',prefix.replace('https://','https://user:secret@')+'?page.token=2',prefix+'?page.token=2#fragment',prefix+'?page.token=2&fields=SPEND'])assert.throws(()=>nextPage(plan,{pagination:{next_url:link}}));
  const next=nextPage(plan,{pagination:{next_url:prefix+'?page.token=2'}});assert.deepEqual(next?.body,report.payload);assert.equal(next?.query['page.token'],'2');
 }finally{x.store.close();}
});

test('valid JSON with an invalid Reddit report shape is a durable failure',async()=>{
 for(const response of [{},{data:[],pagination:{}},{data:{metrics:'not rows'},pagination:{}},{data:{metrics:[{impressions:'not a number'}]},pagination:{}}]){
  const x=setup((async()=>new Response(JSON.stringify(response))) as typeof fetch);
  try{
   const id=x.store.enqueue(actor.tenantId,'report',{query_config:{gateway:'reddit_native_action',arguments:{operation:'reddit_reporting_ops',arguments:report}}});
   await new ReportWorker(x.store,createReportExecutor(x.service)).once();const job=x.store.job(actor.tenantId,id);assert.equal(job.state,'failed');assert.equal(job.error.code,'UPSTREAM_RESPONSE_INVALID');
  }finally{x.store.close();}
 }
});

test('Reddit token refresh uses documented Basic authentication and preserves rotated credentials',async()=>{
 const x=setup((async()=>{throw Error('no ads egress');}) as typeof fetch);
 try{
  x.store.replaceCredentials(actor.tenantId,connection.id,{accessToken:'expired',expiresAt:1,refreshToken:'old-refresh',clientId:'test-app',clientSecret:'test-secret'});
  let calls=0;const provider=new CredentialProvider(x.store,(async(url,init)=>{calls++;assert.equal(String(url),'https://www.reddit.com/api/v1/access_token');const h=init?.headers as Record<string,string>;assert.equal(h.Authorization,'Basic '+Buffer.from('test-app:test-secret').toString('base64'));assert.equal(h['User-Agent'],connection.userAgent);const body=init?.body as URLSearchParams;assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('client_secret'),null);assert.equal(init?.redirect,'error');return new Response('{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}');}) as typeof fetch);
  const [a,b]=await Promise.all([provider.get(connection),provider.get(connection)]);assert.equal(a.accessToken,b.accessToken);assert.equal(calls,1);assert.equal(x.store.credentials(actor.tenantId,connection.id).refreshToken,'new-refresh');
 }finally{x.store.close();}
});
