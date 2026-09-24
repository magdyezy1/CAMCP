import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {actionContracts} from '../src/action-contracts.js';
import {assertCriteoReport,criteoReportMetrics,criteoReportDimensions,criteoReportFilters,runCriteoReportRead} from '../src/criteo-report-jobs.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject,CompiledRequest} from '../src/types.js';

const gateway='criteo_native_action',prefix='/2026-01/retail-media',registry=new Registry();
const actor={tenantId:'criteo-report-test',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const},key=Buffer.alloc(32,46).toString('base64');
const names:Record<string,string>={accounts:'GENERATE_ASYNC_ACCOUNTS_REPORT',campaigns:'GENERATE_ASYNC_CAMPAIGNS_REPORT','line-items':'GENERATE_ASYNC_LINE_ITEMS_REPORT'};
const definition=(kind='accounts'):JsonObject=>({...(kind==='accounts'?{accountIds:['123']}:{ids:kind==='campaigns'?['456']:['789']}),startDate:'2026-08-01',endDate:'2026-08-02',timezone:'Africa/Cairo',format:'json-compact',dimensions:['accountId','date','campaignId',...(kind==='line-items'?['lineItemId']:[])],metrics:['impressions','spend','ctr','attributedSales'],clickAttributionWindow:'7D',viewAttributionWindow:'1D'});
const native=(kind:string,a=definition(kind))=>({operation:'criteo_reporting_ops',arguments:{action:names[kind],account_id:'123',payload:{data:{attributes:a}}}});
function fixture(file=':memory:',data:JsonObject={jobs:{},writes:0,currency:'USD'},allowWrites=true){
 let store=new Store(file,key);const c:Connection={id:'11111111-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],label:'Synthetic reporting login',enabled:true,scopes:['RetailMedia_Analytics_Read','RetailMedia_Accounts_Read','RetailMedia_Campaign_Read']};
 if(!store.listConnections(actor.tenantId).length)store.putConnection(owner,c,{accessToken:'synthetic'});
 const calls:JsonObject[]=[];let mode='',hook:(()=>void)|undefined,outputReads=0;const job=()=>Object.values(data.jobs).at(-1) as JsonObject;
 const output=(j:JsonObject)=>{
  const a=j.definition,fields=[...a.dimensions,...a.metrics];let rows:JsonObject[]=[{accountId:'123',date:'2026-08-01',campaignId:'456',lineItemId:'789',impressions:0,spend:0,ctr:null,attributedSales:13.5}];
  if(mode==='empty')rows=[];if(mode==='duplicate')rows.push({...rows[0]});
  if(mode==='foreign')rows[0]!.accountId='999';if(mode==='parent')rows[0]!.campaignId='999';if(mode==='date')rows[0]!.date='2026-07-31';if(mode==='metric')rows[0]!.spend={error:'missing'};
  const selected=rows.map(r=>Object.fromEntries(fields.map(f=>[f,r[f]??null])));
  const d=a.format==='json'?selected:{columns:fields,data:selected.map(r=>fields.map(f=>r[f])),rows:selected.length};
  if(mode==='columns'&&a.format==='json-compact')(d as JsonObject).columns[1]='privateField';
  if(mode==='cells'&&a.format==='json-compact')(d as JsonObject).data[0].pop();
  if(mode==='lost_precision'){(d as JsonObject).data[0][fields.indexOf('campaignId')]='8343086999167541140';}
  const text=JSON.stringify(d);return mode==='lost_precision'?text.replace('"8343086999167541140"','8343086999167541140'):text;
 };
 const status=(j:JsonObject)=>{
  const body=output(j),rows=mode==='empty'?0:mode==='duplicate'?2:1;
  return {data:{id:j.id,type:'StatusResponse',attributes:{id:j.id,status:mode==='pending'?'pending':mode==='failure'?'failure':mode==='expired'?'expired':'success',rowCount:mode==='truncated'?100000:mode==='count'?rows+1:rows,fileSizeBytes:Buffer.byteLength(body)+(mode==='size'?1:0),md5CheckSum:mode==='checksum'?'0'.repeat(32):createHash('md5').update(body).digest('hex'),createdAt:j.createdAt,expiresAt:new Date(j.expiresAt).toISOString(),message:'rows_count='+rows}},warnings:[],errors:[]};
 };
 const page=(rows:JsonObject[],u:URL)=>({data:rows,metadata:{currentPageIndex:0,currentPageSize:Number(u.searchParams.get('pageSize')??25),totalItemsAcrossAllPages:rows.length,totalPages:1,nextPage:mode==='incomplete'?'https://foreign.invalid/next':null},warnings:[],errors:[]});
 const transport=new NativeTransport(async(raw,init)=>{
  const u=new URL(String(raw)),method=init!.method;assert.equal(u.origin,'https://api.criteo.com');assert.equal(init?.redirect,'error');calls.push({path:u.pathname,query:[...u.searchParams],method,body:init?.body?JSON.parse(String(init.body)):undefined});
  if(method==='POST'){
   data.writes++;const body=JSON.parse(String(init?.body)),id=mode==='reuse'?job().id:randomUUID(),j={id,definition:body.data.attributes,createdAt:new Date().toISOString(),expiresAt:Date.now()+3600000};data.jobs[id]=j;
   if(mode==='lost')throw Error('Response lost after acceptance');if(mode==='receipt')return Response.json({data:{id:'bad/path',attributes:{status:'pending'}}});if(mode==='write_warning')return Response.json({...status(j),warnings:[{code:'ignored-report-type'}]});
   return Response.json({data:{type:'StatusResponse',id,attributes:{status:'pending',id,rowCount:0,fileSizeBytes:0,createdAt:j.createdAt,expiresAt:null,md5CheckSum:null}},errors:[],warnings:[]});
  }
  hook?.();
  if(u.pathname===prefix+'/accounts'){assert.deepEqual(u.searchParams.getAll('limitToId'),['123']);return Response.json(page([{id:'123',type:'RetailMediaAccount',attributes:{currency:data.currency,timeZone:'America/New_York',type:'demand',name:'Name '+calls.length}}],u));}
  if(u.pathname===prefix+'/accounts/123/campaigns')return Response.json(page([{id:'456',type:'RetailMediaCampaign',attributes:{accountId:mode==='foreign_target'?'999':'123',name:'Campaign',budgetSpent:calls.length,status:'active'}}],u));
  if(u.pathname===prefix+'/accounts/123/line-items')return Response.json(page([{id:'789',type:'RetailMediaLineItem',attributes:{campaignId:mode==='moved_parent'?'999':'456',type:'auction',budgetSpent:calls.length}}],u));
  const m=/\/reports\/([^/]+)\/(status|output)$/.exec(u.pathname);assert.ok(m,'Unexpected request '+u.pathname);const j=data.jobs[m[1]!];assert.ok(j,'Unexpected report ID');
  if(m[2]==='status'){if(mode==='status_changed'&&outputReads)j.createdAt=new Date(Date.parse(j.createdAt)+1000).toISOString();const s=status(j);if(mode==='wrong_status_id')s.data.id=randomUUID();if(mode==='status_error')(s.errors as JsonObject[]).push({code:'failed'});if(mode==='expired_time'){s.data.attributes.expiresAt=new Date(Date.now()-1000).toISOString();s.data.attributes.createdAt=new Date(Date.now()-3600000).toISOString();}return Response.json(s);}
  outputReads++;let bytes=output(j);if(mode==='output_error')bytes=JSON.stringify({errors:[{code:'failed'}]});
  return new Response(bytes,{status:200,headers:{'content-type':'application/json'}});
 },async()=>{},30000,8*1024*1024,10000);
 const build=()=>new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});let service=build();
 const discover=(kind:string)=>service.call(gateway,{operation:kind==='campaigns'?'criteo_campaign_ops':'criteo_line_item_ops',arguments:{action:kind==='campaigns'?'GET_CAMPAIGNS_BY_ACCOUNT_ID':'GET_LINE_ITEMS_BY_ACCOUNT_ID',account_id:'123',params:{limitToId:kind==='campaigns'?['456']:['789'],pageIndex:0,pageSize:51}}},actor);
 const prepare=(kind='accounts',a=definition(kind))=>service.call('amcp_write',{action:'prepare',gateway,arguments:native(kind,a)},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 const get=(action='GET_ASYNC_EXPORT_OUTPUT',extra:JsonObject={})=>service.call(gateway,{operation:'criteo_reporting_ops',arguments:{action,account_id:'123',params:{reportId:job().id},dry_run:false,...extra}},actor);
 return {get store(){return store;},get service(){return service;},c,calls,data,prepare,execute,verify,discover,get,job,mode:(s:string)=>{mode=s;},hook:(h:typeof hook)=>{hook=h;},restart:()=>{store.close();store=new Store(file,key);service=build();}};
}
for(const kind of Object.keys(names))for(const format of ['json','json-compact'])test('Criteo '+kind+' '+format+' reviewed job, verification and complete output',async()=>{
 const f=fixture();try{
  if(kind!=='accounts')assert.equal((await f.discover(kind)).success,true);
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{allow_activation:false,allow_deletion:false,max_budget_native:0,max_daily_increase_native:0}});
  const a=definition(kind);a.format=format;const p=await f.prepare(kind,a);assert.equal(p.success,true,JSON.stringify(p));assert.equal(f.data.writes,0);
  const executions=await Promise.all([f.execute(p),f.execute(p)]);assert.equal(executions.filter(r=>r.success).length>=1,true,JSON.stringify(executions));assert.equal(f.data.writes,1);
  const v=await f.verify(p);assert.equal(v.success,true,JSON.stringify(v));assert.equal(v.data.status,'verified',JSON.stringify(v));
  const next=v.data.verified_resources[0].read_result,r=await f.service.call(next.tool,next.arguments,actor);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.report.complete,true);assert.equal(r.data.data.report.currency,'USD');assert.equal(r.data.data.report.timezone,'Africa/Cairo');assert.equal(r.data.data.report.account_timezone,'America/New_York');assert.equal(r.data.data.data[0].spend,0);assert.equal(r.data.data.data[0].ctr,null);assert.equal(r.data.data.data[0].attributedSales,13.5);assert.equal(f.data.writes,1);
 }finally{f.store.close();}
});
test('three exact aliases are reviewed families with pinned native methods, fields and scopes',()=>{
 const compiler=new DelegatedNativeCompiler(),spec=JSON.parse(readFileSync('.mirror/VENDOR/criteo-retail-2026-01.json','utf8')).document;
 for(const [kind,action] of Object.entries(names)){
  const p=compiler.compile(gateway,native(kind));assert.equal(p.path,prefix+'/reports/'+kind);assert.equal(p.readOnly,false);assertCriteoReport(p);
  const schema=spec.components.schemas[kind==='accounts'?'AsyncAccountsReport':kind==='campaigns'?'AsyncCampaignsReport':'AsyncLineItemsReport'];
  assert.deepEqual(criteoReportDimensions,schema.properties.dimensions.items.enum);assert.deepEqual(criteoReportMetrics,schema.properties.metrics.items.enum);
  for(const [field,values]of Object.entries(criteoReportFilters))assert.deepEqual(values,schema.properties[field].items?.enum??schema.properties[field].enum,field);
  assert.equal(actionContracts(registry).find(r=>r.gateway===gateway&&r.action===action)?.family,'criteo_report_jobs');
  assert.deepEqual(spec.paths[p.path].post.security,[{oauth:['RetailMedia_Analytics_Read']}]);
 }
 assert.equal(actionContracts(registry).filter(r=>r.family==='criteo_report_jobs').length,3);
});
test('invalid report inputs stop before provider reads or writes',async()=>{
 const changes:JsonObject[]=[{accountIds:['123','999']},{accountIds:['999']},{format:'csv'},{format:'json-newline'},{timezone:'bad/Zone'},{timezone:undefined},{reportType:'summary'},{metrics:['invented']},{dimensions:['date']},{dimensions:['accountId','date','lineItemId']},{startDate:'2026-02-30'},{endDate:'2026-09-01'},{startDate:'2026-08-01T00:00:00Z'},{clickAttributionWindow:'7D',viewAttributionWindow:'30D'},{viewAttributionWindow:undefined},{metrics:['winRate']},{metrics:['videoViews']},{ids:['456']},{metrics:['spend','spend']},{accountIds:[123]}];
 for(const change of changes){const f=fixture();try{const p=await f.prepare('accounts',{...definition(),...change});assert.equal(p.success,false,JSON.stringify(change));assert.equal(f.calls.length,0);}finally{f.store.close();}}
});
test('account reports need no campaign scope while scoped targets need discovered and fresh parents',async()=>{
 const f=fixture();try{f.store.putConnection(owner,{...f.c,scopes:['RetailMedia_Analytics_Read','RetailMedia_Accounts_Read']},{accessToken:'synthetic'});assert.equal((await f.prepare()).success,true);const p=await f.prepare('campaigns');assert.equal(p.success,false);assert.equal(f.data.writes,0);}finally{f.store.close();}
 for(const mode of ['foreign_target','moved_parent','incomplete']){const f=fixture();try{assert.equal((await f.discover('line-items')).success,true);f.mode(mode);const p=await f.prepare('line-items');assert.equal(p.success,false,mode+JSON.stringify(p));assert.equal(f.data.writes,0);}finally{f.store.close();}}
});
test('telemetry changes preserve review; currency changes trigger a real conflict',async()=>{
 const f=fixture();try{const p=await f.prepare();f.data.currency='EUR';const result=await f.execute(p);assert.equal(result.success,false);assert.equal(result.error.code,'STATE_CHANGED');assert.ok(result.error.details.changed_fields.some((s:string)=>s.includes('currency')));assert.equal(f.data.writes,0);}finally{f.store.close();}
});
test('lost, partial and malformed submissions never replay or grant result access',async()=>{
 for(const mode of ['lost','write_warning','receipt']){const f=fixture();try{const p=await f.prepare();f.mode(mode);assert.equal((await f.execute(p)).success,false);await f.execute(p);assert.equal(f.data.writes,1,mode);assert.equal((await f.verify(p)).success,false);assert.equal((await f.get()).success,false);}finally{f.store.close();}}
});
test('pending resumes the same job, and an empty successful report remains distinct from failure',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);f.mode('pending');const v=await f.verify(p);assert.equal(v.data.status,'pending',JSON.stringify(v));const pending=await f.get();assert.equal(pending.error.code,'CRITEO_REPORT_PENDING');assert.equal(f.calls.some(c=>c.path.endsWith('/output')),false);f.mode('empty');const r=await f.get();assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.report.complete,true);assert.deepEqual(r.data.data.data,[]);assert.equal(f.data.writes,1);}finally{f.store.close();}
});
test('failed, expired, capped, malformed and changing reports never become successful empty data',async()=>{
 for(const mode of ['failure','expired','expired_time','truncated','count','checksum','size','columns','cells','foreign','parent','date','metric','duplicate','output_error','status_error','wrong_status_id','status_changed']){
  const f=fixture();try{assert.equal((await f.discover('campaigns')).success,true);const p=await f.prepare('campaigns');assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');f.mode(mode);const r=await f.get();assert.equal(r.success,false,mode+JSON.stringify(r));assert.equal(r.error.code,mode==='failure'?'CRITEO_REPORT_FAILED':['expired','expired_time'].includes(mode)?'CRITEO_REPORT_EXPIRED':mode==='truncated'?'CRITEO_REPORT_INCOMPLETE':'CRITEO_REPORT_STATE_UNVERIFIED',mode+JSON.stringify(r));assert.equal(f.data.writes,1);}finally{f.store.close();}
 }
});
test('original binding survives process restart; guessed and cross-connection report IDs are denied',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-criteo-report-')),f=fixture(join(dir,'store.db'));try{const p=await f.prepare();await f.execute(p);assert.equal((await f.get()).success,false);await f.verify(p);f.restart();const r=await f.get();assert.equal(r.success,true,JSON.stringify(r));f.store.putConnection(owner,{...f.c,id:'22222222-2222-4222-8222-222222222222'},{accessToken:'other'});assert.equal((await f.get('GET_ASYNC_EXPORT_OUTPUT',{connection_id:'22222222-2222-4222-8222-222222222222'})).success,false);assert.equal(f.data.writes,1);}finally{f.store.close();removeTestDirectory(dir,'amcp-criteo-report-');}
});
test('revocation and in-flight reauthorization fail before disclosing report rows',async()=>{
 for(const mode of ['grant','scope','credentials']){const f=fixture();try{const p=await f.prepare();await f.execute(p);await f.verify(p);f.hook(()=>{f.hook(undefined);if(mode==='credentials')f.store.replaceCredentials(actor.tenantId,f.c.id,{accessToken:'replacement'});else f.store.putConnection(owner,{...f.c,...(mode==='grant'?{enabled:false}:{scopes:[]})},{accessToken:'synthetic'});});const r=await f.get();assert.equal(r.success,false,mode+JSON.stringify(r));assert.equal(f.calls.some(c=>c.path.endsWith('/output')),false);}finally{f.store.close();}}
});
test('review and deployment controls cannot be bypassed through the native route',async()=>{
 const f=fixture();try{const n=native('accounts');const r=await f.service.call(gateway,{...n,arguments:{...n.arguments,dry_run:false,confirmed:true}},actor);assert.equal(r.success,false);assert.equal(r.error.code,'IDEMPOTENCY_REQUIRED');const p=new DelegatedNativeCompiler().compile(gateway,n);await assert.rejects(()=>f.service.runPlan(p,{dry_run:false,confirmed:true,idempotency_key:'bypass'},actor),{code:'WRITE_REVIEW_REQUIRED'});assert.equal(f.calls.length,0);}finally{f.store.close();}
 const blocked=fixture(':memory:',{jobs:{},writes:0,currency:'USD'},false);try{const p=await blocked.prepare();assert.equal(p.success,false);assert.equal(p.error.code,'LIVE_WRITES_DISABLED');assert.equal(blocked.calls.length,0);}finally{blocked.store.close();}
});
test('native int64 report identities survive JSON parsing without precision loss',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);await f.verify(p);f.mode('lost_precision');const r=await f.get();assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.data[0].campaignId,'8343086999167541140');assert.equal(r.data.data.report.checksum_verified,true);}finally{f.store.close();}
});
test('retrieval deadline is checked between reads and no further provider read starts after expiry',async()=>{
 const p:CompiledRequest={gateway,action:'AMCP_CRITEO_REPORT_READ',method:'GET',path:prefix+'/reports/11111111-1111-4111-8111-111111111111/output',accountId:'123',query:{},headers:{},readOnly:true,requiresConfirmation:false,destructive:false,evidence:'synthetic',warnings:[],criteoReportRead:{kind:'output'}};
 let now=100,calls=0;await assert.rejects(()=>runCriteoReportRead(p,async q=>{calls++;assert.equal(q.criteoReportDeadline,60100);now+=60001;return {status:'success'};},()=>now),{code:'CRITEO_REPORT_STATE_UNVERIFIED'});assert.equal(calls,1);
});
test('a shared report deadline aborts the fetch and forbids automatic retry after it expires',async()=>{
 const f=fixture();try{
  let calls=0,signal:AbortSignal|undefined;const transport=new NativeTransport(async(_url,init)=>{calls++;signal=init!.signal!;await new Promise((_,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));throw Error('unreachable');},async()=>{});
  const p:CompiledRequest={gateway,action:'AMCP_CRITEO_REPORT_READ',method:'GET',path:prefix+'/reports/11111111-1111-4111-8111-111111111111/output',accountId:'123',query:{},headers:{},readOnly:true,requiresConfirmation:false,destructive:false,evidence:'synthetic',warnings:[],criteoReportRead:{kind:'output'},criteoReportDeadline:performance.now()-1};
  await assert.rejects(()=>transport.request(p,f.c,{accessToken:'synthetic'}),{code:'CRITEO_REPORT_STATE_UNVERIFIED'});assert.equal(calls,0);
  p.criteoReportDeadline=performance.now()+200;
  // The transport uses an unref'ed abort timer. This small scoped timer keeps the
  // synthetic unresolved fetch alive, just as a real socket would, and is cleared.
  const keepAlive=setTimeout(()=>{},2000);try{await assert.rejects(()=>transport.request(p,f.c,{accessToken:'synthetic'}),{code:'CRITEO_REPORT_STATE_UNVERIFIED'});}finally{clearTimeout(keepAlive);}
  assert.ok(calls<=1);if(calls)assert.equal(signal!.aborted,true);
 }finally{f.store.close();}
});
