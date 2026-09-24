import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Compiler} from '../src/compiler.js';
import {actionContracts} from '../src/action-contracts.js';
import {admitTiktokReport,parseTiktokReportCsv,readTiktokReportState,runTiktokReportRead} from '../src/tiktok-report-jobs.js';
import {sha256,scopeKey} from '../src/security.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject} from '../src/types.js';

const gateway='tiktok_native_action',registry=new Registry();
const actor={tenantId:'tiktok-report-test',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const};
const definition=():JsonObject=>({advertiser_id:'123',service_type:'AUCTION',report_type:'BASIC',data_level:'AUCTION_CAMPAIGN',dimensions:['campaign_id','stat_time_day'],metrics:['spend','clicks','impressions'],start_date:'2026-08-01',end_date:'2026-08-02',output_format:'CSV_STRING',enable_report_title_translation:false});
function fixture(file=':memory:',allowWrites=true){
 const key=Buffer.alloc(32,52).toString('base64');let store=new Store(file,key);
 const c:Connection={id:'11111111-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],label:'Synthetic report login',enabled:true,scopes:[]};store.putConnection(owner,c,{accessToken:'synthetic'});
 const calls:JsonObject[]=[],state:JsonObject={status:'SUCCESS',writes:0,currency:'USD',job:'job-456',csv:'campaign_id,stat_time_day,spend,clicks,impressions\r\n456,2026-08-01 00:00:00,0,0,100\r\n'};let mode='',hook:((path:string)=>void|Promise<void>)|undefined;
 const transport=new NativeTransport(async(raw,init)=>{const u=new URL(String(raw));assert.equal(u.origin,'https://business-api.tiktok.com');assert.equal(init?.redirect,'error');calls.push({path:u.pathname,method:init?.method,query:Object.fromEntries(u.searchParams),body:init?.body?JSON.parse(String(init.body)):undefined});
  await hook?.(u.pathname);
  if(u.pathname==='/open_api/v1.3/advertiser/info/')return Response.json({code:mode==='account_error'?40001:0,message:'OK',request_id:String(calls.length),data:{list:mode==='missing'?[]:[{advertiser_id:mode==='foreign'?'999':'123',name:'Synthetic advertiser '+calls.length,currency:state.currency,timezone:mode==='timezone'?'not/a/timezone':'Africa/Cairo',status:'STATUS_ENABLE'}],...(mode==='partial'?{page_info:{total_page:2}}:{})}});
  if(u.pathname.endsWith('/create/')){state.writes++;if(mode==='lost')throw Error('Accepted but reply lost');if(mode==='503')return new Response('Unavailable',{status:503});if(mode==='receipt')return Response.json({code:0,data:{task_id:'foreign/path'}});if(mode==='write_error')return Response.json({code:40001,message:'Rejected',data:{}});return Response.json({code:0,message:'OK',data:{task_id:state.job},request_id:String(calls.length)});}
  if(u.pathname.endsWith('/cancel/')){state.writes++;if(mode==='cancel_ignored')return Response.json({code:0,data:{status:'SUCCESS'}});if(mode==='cancel_lost'){state.status='CANCELED';throw Error('Reply lost');}state.status='CANCELED';return Response.json({code:0,message:'OK',data:{status:'CANCELED'}});}
  if(u.pathname.endsWith('/check/'))return Response.json({code:mode==='status_error'?40001:0,message:'OK',data:{status:state.status,message:state.status==='FAILED'?'Unsupported dimension combination':'',...(mode==='unknown_status_field'?{missing_rows:1}:{})},request_id:String(calls.length)});
  if(u.pathname.endsWith('/download/')){if(mode==='output_json')return Response.json({code:40001,message:'Failed output',data:{}});if(mode==='signed_url')return Response.json({code:0,data:{download_url:'https://untrusted.invalid/private',output_format:'CSV_DOWNLOAD'}});return new Response(mode==='utf8'?new Uint8Array([0xff,0xfe]):state.csv,{headers:{'content-type':'text/csv; charset=utf-8',...(mode==='short_transfer'?{'content-length':String(Buffer.byteLength(state.csv)+2)}:{})}});}
  throw Error('Unexpected request '+u.pathname);
 },async()=>{},30000,8*1024*1024,10000);
 const build=()=>new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});let service=build();
 const prepare=(alias='task',body=definition())=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'tiktok_report_'+alias+'_create',account_id:'123',payload:body}},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const get=(action='download',extra:JsonObject={})=>service.call(gateway,{action:'tiktok_report_task_'+action,account_id:'123',connection_id:c.id,params:{advertiser_id:'123',task_id:state.job},dry_run:false,...extra},actor);
 const cancel=(alias='task')=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'tiktok_report_'+alias+'_cancel',account_id:'123',payload:{advertiser_id:'123',task_id:state.job}}},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {get store(){return store;},c,state,calls,get service(){return service;},prepare,execute,get,cancel,verify,mode:(v:string)=>{mode=v;},hook:(v:typeof hook)=>{hook=v;},restart:()=>{store.close();store=new Store(file,key);service=build();}};
}
for(const alias of ['task','async'])test('TikTok '+alias+' reviewed submission, status and complete CSV output',async()=>{
 const f=fixture();try{const p=await f.prepare(alias);assert.equal(p.success,true,JSON.stringify(p));assert.equal(f.state.writes,0);const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));const v=await f.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(v.success,true,JSON.stringify(v));assert.equal(v.data.status,'verified');const r=await f.get();assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.report.complete,true);assert.equal(r.data.data.report.account_id,'123');assert.equal(r.data.data.report.currency,'USD');assert.equal(r.data.data.data[0].spend,'0');assert.equal(f.state.writes,1);}finally{f.store.close();}
});

test('eight aliases retain exact reviewed or scoped read contracts; inspection and dry run have no egress',async()=>{
 const f=fixture();try{
  for(const alias of ['task','async'])for(const kind of ['create','cancel','check','download']){
   const action='tiktok_report_'+alias+'_'+kind,contract=actionContracts(registry).find(r=>r.gateway===gateway&&r.action===action)!;
   assert.equal(contract.status,['create','cancel'].includes(kind)?'reviewed_write_family':'native_read',action);assert.ok(contract.tests.includes('tests/tiktok-report-jobs.test.ts'));
   const r=await f.service.call(gateway,{action,account_id:'123',...(['create','cancel'].includes(kind)?{payload:kind==='create'?definition():{advertiser_id:'123',task_id:'job-456'}}:{params:{advertiser_id:'123',task_id:'job-456'}}),dry_run:true},actor);assert.equal(r.success,true,JSON.stringify(r));
  }
  const inspected=await f.service.call('amcp_write',{action:'inspect',gateway,arguments:{action:'tiktok_report_task_create',account_id:'123',payload:definition()}},actor);assert.equal(inspected.success,true,JSON.stringify(inspected));assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});
test('invalid scopes, formats, dimensions, lifetime, dates and filters are rejected before egress',async()=>{
 const changes:JsonObject[]=[{advertiser_id:'999'},{advertiser_ids:['123','999']},{advertiser_id:123},{output_format:'CSV_DOWNLOAD'},{output_format:'XLSX_DOWNLOAD'},{enable_report_title_translation:true},{enable_report_title_translation:undefined},{page_size:100},{page:1},{chunk:true},{report_type:'PLAYABLE_MATERIAL'},{report_type:'CATALOG'},{service_type:'RESERVATION'},{data_level:'RESERVATION_AD'},{start_date:'2026-02-30'},{start_date:'2026-08-03'},{query_lifetime:true},{query_lifetime:'false'},{dimensions:['ad_id','stat_time_day']},{dimensions:['campaign_id','ad_id']},{dimensions:['campaign_id','invented_dimension']},{dimensions:['campaign_id','stat_time_day','stat_time_hour']},{metrics:['spend','spend']},{metrics:['spend; drop table']},{dimensions:['campaign_id','age'],metrics:['reach']},{order_type:'ASC'},{order_field:'invented'},{filtering:[{field_name:'create_time',filter_type:'BETWEEN',filter_value:'[]'}]},{filtering:[{field_name:'campaign_ids',filter_type:'IN',filter_value:'[123]'}]},{filtering:[{field_name:'campaign_ids',filter_type:'IN',filter_value:'["456","456"]'}]},{filtering:[{field_name:'ad_ids_v2',filter_type:'IN',filter_value:'["456"]'}]}];
 for(const change of changes){const f=fixture();try{const p=await f.prepare('task',{...definition(),...change});assert.equal(p.success,false,JSON.stringify(change));assert.equal(f.calls.length,0,JSON.stringify(change));}finally{f.store.close();}}
});
test('fresh account metadata ignores telemetry and names but preserves currency and timezone conflicts',async()=>{
 for(const mode of ['foreign','missing','partial','account_error','timezone']){const f=fixture();try{f.mode(mode);assert.equal((await f.prepare()).success,false,mode);assert.equal(f.state.writes,0);}finally{f.store.close();}}
 const f=fixture();try{const p=await f.prepare();assert.equal(p.success,true);f.state.currency='EUR';const e=await f.execute(p);assert.equal(e.error.code,'STATE_CHANGED');assert.ok(e.error.details.changed_fields.some((s:string)=>s.includes('currency')));assert.equal(f.state.writes,0);}finally{f.store.close();}
});
test('native bypass, readers, write grants, deployment controls, confirmation and review tampering remain blocked',async()=>{
 const f=fixture();try{
  const p=await f.prepare();const raw={action:'tiktok_report_task_create',account_id:'123',payload:definition(),dry_run:false};assert.equal((await f.service.call(gateway,raw,actor)).success,false);assert.equal(f.state.writes,0);
  assert.equal((await f.execute(p,{confirmed:false})).error.code,'CONFIRMATION_REQUIRED');assert.equal((await f.execute(p,{idempotency_key:'new-key'})).error.code,'IDEMPOTENCY_REQUIRED');
  assert.equal((await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true},{...actor,userId:'other'})).error.code,'FORBIDDEN');
  assert.equal((await f.service.call('amcp_write',{action:'prepare',gateway,arguments:raw},{...actor,role:'reader'})).success,false);
  f.store.putConnection(owner,{...f.c,writeAccounts:[]},{accessToken:'synthetic'});assert.equal((await f.execute(p)).error.code,'WRITE_ACCOUNT_FORBIDDEN');
  f.store.putConnection(owner,f.c,{accessToken:'synthetic'});const stored=f.store.document(actor.tenantId,'write_review',p.data.review_id);stored.plan.body.metrics=['spend'];f.store.putDocument(actor.tenantId,'write_review',p.data.review_id,stored);assert.equal((await f.execute(p)).error.code,'REVIEW_CHANGED');assert.equal(f.state.writes,0);
 }finally{f.store.close();}
 const disabled=fixture(':memory:',false);try{const p=await disabled.prepare();assert.equal(p.error.code,'LIVE_WRITES_DISABLED');assert.equal(disabled.calls.length,0);}finally{disabled.store.close();}
});
test('zero spending and activation policies permit report creation without weakening other write policies',async()=>{
 const f=fixture();try{saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{allow_activation:false,allow_deletion:false,max_budget_native:0,max_daily_increase_native:0}});const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);}finally{f.store.close();}
});
test('same job ID in another connection, wrong advertiser, guessed ID and another tenant cannot read output',async()=>{
 const f=fixture();try{
  assert.equal((await f.get('check')).error.code,'RESOURCE_SCOPE_REQUIRED');const p=await f.prepare();await f.execute(p);
  const other={...f.c,id:'22222222-2222-4222-8222-222222222222',label:'Second login'};f.store.putConnection(owner,other,{accessToken:'synthetic'});
  for(const extra of [{connection_id:other.id},{params:{advertiser_id:'999',task_id:f.state.job}},{params:{advertiser_id:'123',task_id:'guessed'}},{params:{advertiser_id:'123',task_id:f.state.job,fields:'all'}},{aggregate_pages:true}]){const n=f.calls.length;assert.equal((await f.get('download',extra)).success,false,JSON.stringify(extra));assert.equal(f.calls.length,n);}
  const n=f.calls.length;assert.equal((await f.service.call(gateway,{action:'tiktok_report_task_check',account_id:'123',connection_id:f.c.id,params:{advertiser_id:'123',task_id:f.state.job}},{...actor,tenantId:'other'})).success,false);assert.equal(f.calls.length,n);
 }finally{f.store.close();}
});
test('same-token binding survives harmless credential metadata updates and refuses reauthorization',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);f.store.putConnection(owner,f.c,{accessToken:'synthetic',expiresAt:Date.now()+86400000});assert.equal((await f.get()).success,true);f.store.putConnection(owner,f.c,{accessToken:'different'});const n=f.calls.length,r=await f.get();assert.equal(r.error.code,'TIKTOK_REPORT_TOKEN_CHANGED');assert.match(r.error.next_action,/original task/);assert.equal(f.calls.length,n);const v=await f.verify(p);assert.notEqual(v.data?.status,'verified');assert.equal(f.calls.length,n);}finally{f.store.close();}
});
test('in-flight revocation, changed token and changed status withhold rows',async()=>{
 for(const change of ['grant','token','status']){const f=fixture();try{const p=await f.prepare();await f.execute(p);f.hook(path=>{if(path.endsWith('/download/')){if(change==='grant')f.store.putConnection(owner,{...f.c,accounts:['999'],writeAccounts:[]},{accessToken:'synthetic'});else if(change==='token')f.store.putConnection(owner,f.c,{accessToken:'changed'});else f.state.status='FAILED';}});const r=await f.get();assert.equal(r.success,false,change+JSON.stringify(r));assert.equal(r.data,undefined);assert.equal(f.state.writes,1);}finally{f.store.close();}}
});
test('pending, failed, cancelled and unknown tasks never produce a successful empty report',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);for(const status of ['QUEUING','PROCESSING','FAILED','CANCELED','UNKNOWN']){f.state.status=status;const before=f.calls.filter(x=>x.path.endsWith('/download/')).length,r=await f.get();assert.equal(r.success,false,status);assert.equal(f.calls.filter(x=>x.path.endsWith('/download/')).length,before);const v=await f.verify(p);assert.notEqual(v.data.status,'verified');}f.state.status='SUCCESS';f.state.csv='campaign_id,stat_time_day,spend,clicks,impressions\r\n';const empty=await f.get();assert.equal(empty.success,true,JSON.stringify(empty));assert.deepEqual(empty.data.data.data,[]);assert.equal(empty.data.data.report.complete,true);assert.equal(empty.data.data.report.provider_count_verified,false);}finally{f.store.close();}
});
test('malformed and incomplete CSV, invalid UTF-8, JSON errors and signed URL responses fail closed',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);
  for(const mode of ['utf8','short_transfer','output_json','signed_url','status_error','unknown_status_field']){f.mode(mode);assert.equal((await f.get()).success,false,mode);}f.mode('');
  for(const csv of ['', 'Campaign ID,Date,Spend,Clicks,Impressions\n456,2026-08-01,0,0,0','campaign_id,stat_time_day,spend,clicks,impressions\n456,2026-08-01,0,0','campaign_id,stat_time_day,spend,clicks,impressions\n456,2026-08-01,0,0,"unfinished','campaign_id,stat_time_day,spend,clicks,impressions\n456,2026-07-31,0,0,0','campaign_id,stat_time_day,spend,clicks,impressions\n456,2026-08-01 24:00:00,0,0,0','campaign_id,stat_time_day,spend,clicks,impressions\n456,2026-08-01,0,0,0\n456,2026-08-01,1,1,1']){f.state.csv=csv;assert.equal((await f.get()).success,false,csv.slice(-45));}
 }finally{f.store.close();}
});
test('CSV parser preserves quoted Unicode, newlines, empty cells and exact large numbers with strict bounds',()=>{
 assert.deepEqual(parseTiktokReportCsv('\uFEFFa,b,c\r\n"اسم, \"\"quoted\"\"\nnext",,9007199254740993\r\n'),[['a','b','c'],['اسم, "quoted"\nnext','','9007199254740993']]);
 for(const text of ['a\rb','a\n"b"trailing','a\nun"quoted','a\n"unterminated','a\0','a\n'+'x'.repeat(65537),'a\n'+'x\n'.repeat(25001),'a\n'+'x'.repeat(8*1024*1024)])assert.throws(()=>parseTiktokReportCsv(text));
});
test('country-name alias, untrusted text, empty metrics and exact spend values remain explicit',async()=>{
 const f=fixture();try{const a=definition();a.dimensions=['campaign_id','stat_time_day','country_code'];a.metrics=['spend','campaign_name','clicks'];const p=await f.prepare('task',a);assert.equal(p.success,true,JSON.stringify(p));await f.execute(p);f.state.csv='campaign_id,stat_time_day,country_name,spend,campaign_name,clicks\n456,2026-08-01,Saudi Arabia,9007199254740993.123456,"=SUM(1,2)",\n';const r=await f.get();assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.data[0].spend,'9007199254740993.123456');assert.equal(r.data.data.data[0].clicks,'');assert.equal(r.data.data.report.country_code_available,false);assert.equal(r.data.data.report.data_untrusted,true);const audit=JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all());assert.equal(audit.includes('=SUM(1,2)'),false);}finally{f.store.close();}
});
test('lifetime and Upgraded Smart+ reports preserve their reviewed grain and ID filters',async()=>{
 for(const smart of [false,true]){const f=fixture();try{const a=definition();a.data_level=smart?'AUCTION_AD':'AUCTION_ADVERTISER';a.dimensions=smart?['ad_id_v2','stat_time_day']:['advertiser_id'];a.metrics=['spend'];if(smart)a.filtering=[{field_name:'ad_ids_v2',filter_type:'IN',filter_value:'["9007199254740993"]'}];else{a.query_lifetime=true;delete a.start_date;delete a.end_date;}const p=await f.prepare('task',a);assert.equal(p.success,true,JSON.stringify(p));await f.execute(p);f.state.csv=smart?'ad_id_v2,stat_time_day,spend\n9007199254740993,2026-08-01,0.01\n':'advertiser_id,spend\n123,0.01\n';assert.equal((await f.get()).success,true);f.state.csv=smart?'ad_id_v2,stat_time_day,spend\n456,2026-08-01,0.01\n':'advertiser_id,spend\n999,0.01\n';assert.equal((await f.get()).success,false);}finally{f.store.close();}}
});
test('concurrent executions converge on one durable submission and replay never consumes quota again',async()=>{
 const f=fixture();try{const p=await f.prepare();const results=await Promise.all([f.execute(p),f.execute(p),f.execute(p)]);assert.ok(results.some(r=>r.success),JSON.stringify(results));assert.equal(f.state.writes,1);const replay=await f.execute(p);assert.equal(replay.success,true);assert.equal(replay.data.replayed,true);assert.equal(f.state.writes,1);}finally{f.store.close();}
});
test('lost replies, transient HTTP errors, malformed receipts and native failures never resubmit or bind jobs',async()=>{
 for(const mode of ['lost','503','receipt','write_error']){const f=fixture();try{const p=await f.prepare();f.mode(mode);assert.equal((await f.execute(p)).success,false,mode);await f.execute(p);assert.equal(f.state.writes,1,mode);assert.equal((await f.get()).success,false);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='tiktok_report_run'").get()!.n,0);}finally{f.store.close();}}
});
for(const alias of ['task','async'])test('TikTok '+alias+' cancellation treats queued-to-processing as stable and reads back CANCELED',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);f.state.status='QUEUING';const c=await f.cancel(alias);assert.equal(c.success,true,JSON.stringify(c));f.state.status='PROCESSING';const e=await f.execute(c);assert.equal(e.success,true,JSON.stringify(e));const v=await f.verify(c);assert.equal(v.data.status,'verified',JSON.stringify(v));assert.equal((await f.get()).error.code,'TIKTOK_REPORT_CANCELED');assert.equal(f.state.writes,2);}finally{f.store.close();}
});
test('completed or unknown tasks cannot be cancelled; completion races and lost cancellation replies never retry',async()=>{
 const f=fixture();try{assert.equal((await f.cancel()).success,false);const p=await f.prepare();await f.execute(p);assert.equal((await f.cancel()).error.code,'TIKTOK_REPORT_NOT_CANCELLABLE');f.state.status='PROCESSING';const c=await f.cancel();f.state.status='SUCCESS';assert.equal((await f.execute(c)).error.code,'TIKTOK_REPORT_NOT_CANCELLABLE');assert.equal(f.state.writes,1);f.state.status='PROCESSING';const c2=await f.cancel();f.mode('cancel_lost');assert.equal((await f.execute(c2)).success,false);await f.execute(c2);assert.equal(f.state.writes,2);}finally{f.store.close();}
});
test('two SQLite workers share app creation pacing and rolling account limits, including clock rollback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-tiktok-quota-')),path=join(dir,'test.sqlite'),a=new Store(path),b=new Store(path),plan=new Compiler(registry).compile(gateway,{action:'tiktok_report_task_create',account_id:'123',payload:definition()},{mode:'strict',flags:{}}),auth={accessToken:'synthetic',clientId:'app'};try{
  const now=10000000;a.transaction(()=>admitTiktokReport(plan,a,auth,now));assert.throws(()=>b.transaction(()=>admitTiktokReport({...plan,accountId:'999'},b,auth,now+999)),(e:any)=>e.code==='PLATFORM_RATE_LIMIT'&&e.details.submission_started===false);
  for(let i=1;i<500;i++)b.transaction(()=>admitTiktokReport(plan,b,auth,now+i*1000));assert.throws(()=>a.transaction(()=>admitTiktokReport(plan,a,auth,now+501000)),(e:any)=>e.code==='PLATFORM_RATE_LIMIT');assert.throws(()=>a.transaction(()=>admitTiktokReport(plan,a,auth,now-1)));a.transaction(()=>admitTiktokReport(plan,a,auth,now+3600000));
 }finally{a.close();b.close();removeTestDirectory(dir,'amcp-tiktok-quota-');}
});
test('pre-dispatch rate rejection leaves the same review unsubmitted and usable after the delay',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);const p2=await f.prepare();const e=await f.execute(p2);assert.equal(e.error.code,'PLATFORM_RATE_LIMIT');assert.equal(e.error.details.submission_started,false);assert.equal(f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,p2.data.review_id),undefined);f.store.db.prepare("DELETE FROM documents WHERE kind='tiktok_report_quota'").run();f.state.job='job-new';assert.equal((await f.execute(p2)).success,true);assert.equal(f.state.writes,2);}finally{f.store.close();}
});
test('restart resumes original output, 30-day expiry prunes bindings without resetting idempotency',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-tiktok-restart-')),f=fixture(join(dir,'test.sqlite'));try{const p=await f.prepare();await f.execute(p);f.restart();assert.equal((await f.execute(p)).data.replayed,true);assert.equal((await f.get()).success,true);const key=scopeKey(f.c.id,f.state.job),b=f.store.document(actor.tenantId,'tiktok_report_run',key);b.expires_at=Date.now()-1;f.store.putDocument(actor.tenantId,'tiktok_report_run',key,b);assert.equal((await f.get()).error.code,'TIKTOK_REPORT_EXPIRED');f.store.cleanupTransient();assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='tiktok_report_run'").get()!.n,0);assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.state.writes,1);}finally{f.store.close();removeTestDirectory(dir,'amcp-tiktok-restart-');}
});
test('retrieval and prerequisite deadlines stop later egress and bound oversized account snapshots',async()=>{
 const p=new Compiler(registry).compile(gateway,{action:'tiktok_report_task_create',account_id:'123',payload:definition()},{mode:'strict',flags:{}});await assert.rejects(()=>readTiktokReportState(p,async()=>({status:200,headers:{},data:{code:0,data:{list:[],noise:'x'.repeat(1024*1024)}}}),()=>sha256('synthetic')));
 let now=0,calls=0;await assert.rejects(()=>runTiktokReportRead({...p,readOnly:true,method:'GET',path:'/v1.3/report/task/download/',body:undefined,query:{advertiser_id:'123',task_id:'job-456'},tiktokReportRead:{task_id:'job-456',kind:'download'}},async()=>{calls++;now=60001;return {status:'SUCCESS'};},()=>now));assert.equal(calls,1);
});
test('a reused provider task ID cannot rebind ownership, and its uncertain submission never retries',async()=>{
 const f=fixture();try{const first=await f.prepare();await f.execute(first);f.store.db.prepare("DELETE FROM documents WHERE kind='tiktok_report_quota'").run();const second=await f.prepare();const e=await f.execute(second);assert.equal(e.success,false);await f.execute(second);assert.equal(f.state.writes,2);const original=f.store.document(actor.tenantId,'tiktok_report_run',scopeKey(f.c.id,f.state.job));assert.equal(original.review_id,first.data.review_id);assert.equal((await f.get()).success,true);}finally{f.store.close();}
});
test('expired reviews and changed tokens during preparation prevent submission',async()=>{
 const f=fixture();try{const p=await f.prepare();const review=f.store.document(actor.tenantId,'write_review',p.data.review_id);review.expires_at=Date.now()-1;f.store.putDocument(actor.tenantId,'write_review',p.data.review_id,review);assert.equal((await f.execute(p)).error.code,'REVIEW_EXPIRED');f.hook(path=>{if(path.endsWith('/advertiser/info/'))f.store.putConnection(owner,f.c,{accessToken:'new-token'});});const bad=await f.prepare();assert.equal(bad.error.code,'TIKTOK_REPORT_TOKEN_CHANGED');assert.equal(f.state.writes,0);}finally{f.store.close();}
});
test('grant revocation after provider acceptance withholds the result but preserves completed idempotency',async()=>{
 const f=fixture();try{const p=await f.prepare();f.hook(path=>{if(path.endsWith('/create/'))f.store.putConnection(owner,{...f.c,accounts:['999'],writeAccounts:[]},{accessToken:'synthetic'});});const e=await f.execute(p);assert.equal(e.success,false);assert.equal(f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,p.data.review_id)!.state,'complete',JSON.stringify(e));f.hook(undefined);f.store.putConnection(owner,f.c,{accessToken:'synthetic'});assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.state.writes,1);}finally{f.store.close();}
});

test('TikTok token replacement after acceptance preserves the completed task and its specific recovery error',async()=>{
 const f=fixture();try{const p=await f.prepare();f.hook(path=>{if(path.endsWith('/create/'))f.store.putConnection(owner,f.c,{accessToken:'replacement'});});const result=await f.execute(p);assert.equal(result.success,false);assert.equal(result.error.code,'TIKTOK_REPORT_TOKEN_CHANGED');assert.equal(f.store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,p.data.review_id)!.state,'complete');const task=f.store.document(actor.tenantId,'tiktok_report_run',scopeKey(f.c.id,f.state.job));assert.equal(task.review_id,p.data.review_id);assert.equal(task.token_fingerprint,sha256('synthetic'));f.hook(undefined);assert.equal((await f.execute(p)).data.replayed,true);assert.equal((await f.get()).error.code,'TIKTOK_REPORT_TOKEN_CHANGED');assert.equal(f.state.writes,1);}finally{f.store.close();}
});
test('native SDK fields and manually observed lifecycle remain separate from captured catalog metadata',()=>{
 const evidence=JSON.parse(readFileSync('tests/fixtures/tiktok-report-v13.json','utf8'));assert.equal(evidence.version,'v1.3');const create=evidence.models.ReportTaskCreateBody.fields.map((x:JsonObject)=>x.name),cancel=evidence.models.TaskCancelBody.fields.map((x:JsonObject)=>x.name);
 for(const field of Object.keys(definition()))assert.ok(create.includes(field),field);assert.deepEqual(cancel,['advertiser_id','task_id']);assert.ok(evidence.manual_browser_evidence.same_access_token_required);assert.deepEqual(evidence.manual_browser_evidence.statuses,['QUEUING','PROCESSING','SUCCESS','FAILED','CANCELED']);assert.equal(evidence.manual_browser_evidence.stream_format,'CSV_STRING');
 for(const model of Object.values(evidence.models) as JsonObject[]){assert.match(model.sha256,/^[a-f0-9]{64}$/);assert.match(model.url,/^https:\/\/raw.githubusercontent.com\/tiktok\/tiktok-business-api-sdk\//);}
});
test('HTTP retrieval uses the shared monotonic deadline, including aborting a stalled provider',async()=>{
 const p=new Compiler(registry).compile(gateway,{action:'tiktok_report_task_download',account_id:'123',params:{advertiser_id:'123',task_id:'job-456'}},{mode:'strict',flags:{}});p.tiktokReportRead={kind:'download'};p.tiktokReportDeadline=performance.now()+20;
 let calls=0,aborted=false;const transport=new NativeTransport(async(_url,init)=>new Promise((_resolve,reject)=>{calls++;const timer=setTimeout(()=>reject(Error('Abort did not happen')),200);init!.signal!.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(Error('Aborted'));},{once:true});}),async()=>{},1000);
 await assert.rejects(()=>transport.request(p,{id:'c',tenantId:actor.tenantId,gateway,accounts:['123'],scopes:[],enabled:true,label:'Synthetic'},{accessToken:'synthetic'}));assert.equal(aborted,true);assert.equal(calls,1);
});
test('response projection cannot label sliced report rows complete or truncate definition metadata',async()=>{
 const f=fixture();try{const p=await f.prepare();await f.execute(p);f.state.csv+='789,2026-08-02 00:00:00,0.01,1,10\r\n';const r=await f.get('download',{max_items:1,result_fields:['campaign_id','spend']});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.truncated,true);assert.equal(r.data.data.data.length,1);assert.equal(r.data.data.report.complete,false);assert.equal(r.data.data.report.source_complete,true);assert.equal(r.data.data.report.source_rows,2);assert.equal(r.data.data.report.returned_rows,1);assert.deepEqual(r.data.data.report.definition,definition());assert.equal(r.data.data.report.columns.length,5);}finally{f.store.close();}
});
