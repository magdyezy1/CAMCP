import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ScopeGuard} from '../src/scope.js';
import {ReportWorker} from '../src/worker.js';
import {metaReportKind,metaReportReadResult,runMetaReportRead,metaReportSnapshots,metaReportFieldContract} from '../src/meta-insights-jobs.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject,CompiledRequest} from '../src/types.js';

const registry=new Registry(),gateway='meta_native_action',actor={tenantId:'async-reports',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const},key=Buffer.alloc(32,35).toString('base64');
const definition=():JsonObject=>({fields:['account_id','account_currency','date_start','date_stop','campaign_id','impressions','spend','reach','actions'],level:'campaign',time_range:{since:'2026-08-01',until:'2026-08-03'},time_increment:'1',use_unified_attribution_setting:true});
function fixture(file=':memory:',persisted?:JsonObject,allowWrites=true){
 const store=new Store(file,key),c:Connection={id:'11111111-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway,label:'Selected reporting identity',accounts:['123'],writeAccounts:['123'],enabled:true,scopes:['ads_read'],resourceBindings:[{accountId:'123',pathPrefix:'/v25.0/55'},{accountId:'123',pathPrefix:'/v25.0/66'}]};if(!store.listConnections(actor.tenantId).length)store.putConnection(owner,c,{accessToken:'synthetic'});
 const data:JsonObject=persisted??{jobs:{},next:900,writes:0,currency:'USD',timezone:'Africa/Cairo'};const calls:JsonObject[]=[];let mode='success',afterRead:(()=>void)|undefined;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init!.method;assert.equal(u.origin,'https://graph.facebook.com');calls.push({method,path:u.pathname,query:Object.fromEntries(u.searchParams),body:init?.body?.toString()});
  if(method==='POST'){
   data.writes++;const body=Object.fromEntries([...new URLSearchParams(String(init?.body))].map(([k,v])=>{if(['fields','time_range','use_account_attribution_setting','use_unified_attribution_setting'].includes(k))return[k,JSON.parse(v)];return[k,v];})),id=String(data.next++);data.jobs[id]={id,account_id:'123',async_status:'Job Completed',async_percent_completion:100,date_start:body.time_range.since,date_stop:body.time_range.until,...body};
   if(mode==='lost')throw Error('Synthetic response lost after provider acceptance');if(mode==='empty')return Response.json({});if(mode==='partial')return Response.json({report_run_id:id,errors:[{message:'Failed'}]});if(mode==='foreign_receipt')return Response.json({report_run_id:'bad/path'});return Response.json({report_run_id:id});
  }
  afterRead?.();if(u.pathname==='/v25.0/act_123')return Response.json({id:'act_123',account_status:1,currency:data.currency,timezone_name:data.timezone,request_id:String(calls.length)});
  if(['/v25.0/55','/v25.0/66'].includes(u.pathname))return Response.json({id:u.pathname.slice(-2),account_id:mode==='foreign_target'?'999':'123',campaign:{id:'55',account_id:'123'},updated_time:String(calls.length)});
  const match=/^\/v25\.0\/(\d+)(\/insights)?$/.exec(u.pathname);if(!match)throw Error('Unexpected '+u.pathname);const job=data.jobs[match[1]!];assert.ok(job,'Unknown synthetic job');
  if(!match[2]){const response={...job,async_report_url:'https://private.invalid/?access_token=private'};if(mode==='pending'){response.async_status='Job Started';response.async_percent_completion=35;}if(mode==='failed'){response.async_status='Job Failed';response.error_code=123;}if(mode==='foreign_job')response.account_id='999';if(mode==='wrong_definition')response.time_range={since:'2026-07-01',until:'2026-07-03'};if(mode==='wrong_fields')response.fields=['account_id'];if(mode==='unknown_status')response.async_status='New Unknown State';if(mode==='completed_35')response.async_percent_completion=35;return Response.json(response);}
  const offset=u.searchParams.has('after')?1:0;const row:JsonObject={account_id:'123',account_currency:'USD',campaign_id:'55',adset_id:'66',ad_id:'77',date_start:'2026-08-0'+(1+offset),date_stop:'2026-08-0'+(1+offset),impressions:offset?'25':'0',spend:'0',reach:offset?'20':'0',private_url:'https://private.invalid/?secret=hidden'};
  if(mode==='per_row_error')row.errors=[{code:1}];if(mode==='bad_metric')row.spend={error:'unknown'};if(mode==='bad_actions')row.actions=[{action_type:'purchase',value:'unknown'}];if(mode==='null_metric')row.spend=null;if(mode==='native_actions')row.actions=[{action_type:'purchase',value:'3.25'}];if(mode==='foreign_row')row.account_id='999';if(mode==='wrong_parent')row.campaign_id='999';if(mode==='outside_dates')row.date_stop='2026-09-01';if(mode==='wrong_currency')row.account_currency='EUR';if(mode==='duplicate_row'){row.date_start='2026-08-01';row.date_stop='2026-08-01';}if(mode==='missing_rows')return Response.json({});if(mode==='row_error')return Response.json({error:{code:1,message:'Failed'}});if(mode==='unknown_paging')return Response.json({data:[row],paging:{has_more:true}});if(mode==='empty_next')return Response.json({data:[row],paging:{next:''}});if(mode==='empty_report')return Response.json({data:[]});
  const more=(['pages','loop','duplicate_row','foreign_cursor','no_cursor','partial_page'].includes(mode)&&(!offset||mode==='loop'));
  return Response.json({data:mode==='partial_page'?[]:[row],...(more?{paging:{cursors:mode==='no_cursor'?{}:{after:'second'},next:'https://graph.facebook.com/v25.0/'+(mode==='foreign_cursor'?'999':match[1])+'/insights?after=second&access_token=do-not-return'}}:{})});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});
 const args=(action='meta_report_task_create',body=definition())=>({action,account_id:'123',connection_id:c.id,path_params:{campaign_id:'55',ad_set_id:'66'},payload:body});
 const prepare=(action='meta_report_task_create',body=definition())=>service.call('amcp_write',{action:'prepare',gateway,arguments:args(action,body)},actor);
 const execute=(r:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:r.data.review_id,idempotency_key:r.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=(r:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:r.data.review_id},actor);
 const rows=(job='900',extra:JsonObject={},who=actor)=>service.call(gateway,{action:'meta_report_run_insights_get',account_id:'123',connection_id:c.id,params:{ad_id:job},query:{limit:1000},aggregate_pages:true,dry_run:false,...extra},who);
 return {store,c,data,calls,transport,service,args,prepare,execute,verify,rows,mode:(v:string)=>{mode=v;},onRead:(fn:()=>void)=>{afterRead=fn;}};
}
for(const action of ['meta_report_task_create','meta_ad_account_id_insights_report_create','meta_campaign_id_insights_report_create','meta_ad_set_id_insights_report_create'])test(action+' creates once, verifies the exact definition and retrieves native report rows',async()=>{const f=fixture();try{const d=definition();if(action.includes('ad_set')){d.level='adset';d.fields.push('adset_id');}const r=await f.prepare(action,d);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.creative_impact.may_affect_serving,false);const out=await f.execute(r);assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.data.report_run_id,'900');assert.equal((await f.execute(r)).data.replayed,true);assert.equal(f.store.ownsResource(f.c,'123','900'),false);assert.equal((await f.rows()).error.code,'RESOURCE_SCOPE_REQUIRED');const v=await f.verify(r);assert.equal(v.data.status,'verified',JSON.stringify(v));const rows=await f.rows();assert.equal(rows.success,true,JSON.stringify(rows));assert.equal(rows.data.data.report.complete,true);assert.equal(rows.data.data.data[0].impressions,'0');assert.equal(rows.data.data.data[0].actions,undefined);assert.equal(JSON.stringify(rows).includes('private.invalid'),false);assert.equal(f.data.writes,1);}finally{f.store.close();}});

test('pending and failed jobs remain distinguishable and are never recreated by verification',async()=>{const f=fixture();try{const r=await f.prepare();await f.execute(r);f.mode('pending');const p=await f.verify(r);assert.equal(p.data.status,'pending',JSON.stringify(p));assert.equal((await f.rows()).error.code,'META_REPORT_PENDING');f.mode('failed');const failed=await f.verify(r);assert.equal(failed.data.status,'failed',JSON.stringify(failed));assert.equal((await f.rows()).success,false);assert.equal(f.data.writes,1);}finally{f.store.close();}});

test('complete scoped pagination has truthful truncation, resumable cursors and no provider access-token URL',async()=>{const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');f.mode('pages');const complete=await f.rows();assert.equal(complete.success,true,JSON.stringify(complete));assert.equal(complete.data.pages,2);assert.equal(complete.data.data.data.length,2);assert.equal(complete.data.data.report.complete,true);assert.equal(JSON.stringify(complete).includes('access_token'),false);const partial=await f.rows('900',{aggregate_pages:false});assert.equal(partial.data.truncated,true);assert.equal(partial.data.data.report.complete,false);const next=partial.data.data.report.next_call;const remaining=await f.service.call(next.tool,next.arguments,actor);assert.equal(remaining.data.data.data.length,1);assert.equal(remaining.data.data.report.complete,false);assert.equal(remaining.data.data.report.remaining_pages_complete,true);assert.equal(remaining.data.data.report.retrieved_from_start,false);assert.equal(remaining.data.data.data[0].date_start,'2026-08-02');}finally{f.store.close();}});

test('foreign, incomplete, looping and malformed report pages never become successful empty reports',async()=>{for(const mode of ['foreign_row','wrong_parent','outside_dates','wrong_currency','missing_rows','row_error','per_row_error','bad_metric','bad_actions','unknown_paging','empty_next','loop','duplicate_row','foreign_cursor','no_cursor','partial_page']){const f=fixture();try{const r=await f.prepare('meta_campaign_id_insights_report_create');assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');f.mode(mode);const result=await f.rows();assert.equal(result.success,false,mode+': '+JSON.stringify(result));assert.equal(f.data.writes,1);}finally{f.store.close();}}});

test('only a successfully completed job can produce a complete empty report',async()=>{const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');f.mode('empty_report');const result=await f.rows();assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.data.report.complete,true);assert.deepEqual(result.data.data.data,[]);}finally{f.store.close();}});

test('foreign jobs and mismatched dates, fields or completion status do not grant result access',async()=>{for(const mode of ['foreign_job','wrong_definition','wrong_fields','unknown_status','completed_35']){const f=fixture();try{const r=await f.prepare();await f.execute(r);f.mode(mode);const v=await f.verify(r);assert.equal(v.data.status,'unverified',JSON.stringify(v));assert.equal((await f.rows()).success,false);assert.equal(f.store.ownsResource(f.c,'123','900'),false);}finally{f.store.close();}}});

test('account state changes invalidate review; report metric names do not trigger spending or activation policies',async()=>{const f=fixture();try{saveSpendPolicy(f.store,owner,{gateway,account_id:'123',policy:{allow_activation:false,allow_deletion:false,max_budget_native:1},confirmed:true});const r=await f.prepare();assert.equal(r.success,true,JSON.stringify(r));f.data.currency='EUR';assert.equal((await f.execute(r)).error.code,'STATE_CHANGED');assert.equal(f.data.writes,0);f.data.currency='USD';assert.equal((await f.execute(r)).success,true);assert.equal(f.data.writes,1);}finally{f.store.close();}});

test('malformed receipts remain failed and lost responses remain uncertain across restart',async()=>{for(const mode of ['empty','partial','foreign_receipt','lost']){const directory=mkdtempSync(join(tmpdir(),'amcp-meta-report-'));let f=fixture(join(directory,'store.sqlite'));try{const r=await f.prepare();f.mode(mode);const result=await f.execute(r);assert.equal(result.success,false,JSON.stringify(result));const data=f.data;f.store.close();f=fixture(join(directory,'store.sqlite'),data);const replay=await f.execute(r);if(mode==='lost')assert.equal(replay.error.code,'WRITE_OUTCOME_UNCERTAIN');else assert.equal(replay.data.replayed,true);assert.equal(f.data.writes,1);}finally{f.store.close();removeTestDirectory(directory,'amcp-meta-report-');}}});

test('roles, grants, revoked scopes, duplicate logins and in-flight revocation cannot bypass report scope',async()=>{for(const mode of ['reader','grant','scope','inflight','other_connection']){const f=fixture();try{if(mode==='reader'){assert.equal((await f.service.call('amcp_write',{action:'prepare',gateway,arguments:f.args()},{...actor,role:'reader'})).success,false);assert.equal(f.calls.length,0);continue;}const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');if(mode==='grant')f.store.putConnection(owner,{...f.c,accounts:['999'],writeAccounts:[],resourceBindings:[]},{accessToken:'synthetic'});if(mode==='scope')f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});if(mode==='inflight')f.onRead(()=>f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'}));if(mode==='other_connection')f.store.putConnection(owner,{...f.c,id:'22222222-2222-4222-8222-222222222222'},{accessToken:'other'});const out=await f.rows('900',mode==='other_connection'?{connection_id:'22222222-2222-4222-8222-222222222222'}:{});assert.equal(out.success,false,mode+JSON.stringify(out));assert.equal(f.data.writes,1);}finally{f.store.close();}}});

test('the exact four catalog aliases become reviewed report jobs without enabling audience-network reports',()=>{const all=actionContracts(registry);assert.equal(all.filter(r=>r.family==='meta_insights_jobs').length,4);assert.equal(all.find(r=>r.action==='meta_business_id_adnetworkanalytics_report_create')!.status,'unqualified_read');});

test('all supported fields, definition inputs and snapshot selectors match pinned official SDK evidence',async()=>{
 const proof=JSON.parse(readFileSync('tests/fixtures/meta-insights-sdk-v25.json','utf8')),f=fixture();
 try{const r=await f.prepare();assert.equal(r.success,true);const plan=r.data.request as CompiledRequest;
  for(const field of [...metaReportFieldContract.metrics,...metaReportFieldContract.identities])assert.ok(proof.models.adsinsights[field],field);
  for(const model of Object.values(proof.creation) as JsonObject[]){assert.equal(model.method,'POST');assert.equal(model.edge,'/insights');for(const [field,value] of Object.entries(plan.body!))assert.ok(model.parameters[field],field);}
  for(const field of metaReportFieldContract.definition){assert.ok(proof.models.adreportrun[field],field);for(const model of Object.values(proof.creation) as JsonObject[])assert.ok(model.parameters[field],field);}
  assert.equal(proof.models.adreportrun.fields,'list<string>');assert.equal(proof.models.adsinsights.spend,'string');assert.equal(proof.models.adsinsights.actions,'list<AdsActionStats>');
  assert.ok(Object.values(proof.sources).every((s:any)=>s.url.includes('/25.0.3/')&&/^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(metaReportSnapshots(plan)[0]!.query.fields,'id,account_status,currency,timezone_name');
 }finally{f.store.close();}
});

test('array and CSV field inputs freeze the same native list before submission',async()=>{
 const f=fixture();try{const a=await f.prepare(),d=definition();d.fields=d.fields.join(',');const b=await f.prepare('meta_report_task_create',d);assert.equal(a.success,true);assert.equal(b.success,true,JSON.stringify(b));assert.deepEqual(a.data.request.body,b.data.request.body);assert.equal((await f.execute(b)).success,true);const wire=new URLSearchParams(f.calls.find(c=>c.method==='POST')!.body);assert.deepEqual(JSON.parse(wire.get('fields')!),definition().fields);assert.equal(wire.get('time_increment'),'1');assert.equal((await f.verify(b)).data.status,'verified');}finally{f.store.close();}
});

test('unsupported definitions are refused before any credential or provider use',async()=>{
 const f=fixture();try{const bodies=[{...definition(),fields:['account_id']},{...definition(),fields:[...definition().fields,'invented_metric']},{...definition(),fields:[...definition().fields,'spend']},{...definition(),level:'invented'},{...definition(),time_increment:1},{...definition(),time_increment:'91'},{...definition(),time_range:{since:'2026-02-30',until:'2026-03-01'}},{...definition(),time_range:{since:'2026-08-04',until:'2026-08-01'}},{...definition(),time_range:{since:'2025-01-01',until:'2026-08-01'}},{...definition(),date_preset:'yesterday'},{...definition(),breakdowns:['age']},{...definition(),filtering:[]},{...definition(),use_account_attribution_setting:true},{...definition(),action_report_time:'unknown'},{...definition(),export_format:'csv'}];for(const body of bodies){const r=await f.prepare('meta_report_task_create',body);assert.equal(r.success,false,JSON.stringify(body));assert.equal(f.calls.length,0);}assert.equal((await f.prepare('meta_ad_set_id_insights_report_create')).success,false);assert.equal(f.calls.length,0);}finally{f.store.close();}
});

test('all report levels and native time/attribution options retain their exact definitions',async()=>{
 for(const level of ['account','campaign','adset','ad']){const f=fixture();try{const d=definition();d.level=level;if(level==='account')d.fields=d.fields.filter((f:string)=>f!=='campaign_id');if(['adset','ad'].includes(level))d.fields.push('adset_id');if(level==='ad')d.fields.push('ad_id');d.time_increment=level==='account'?'all_days':level==='campaign'?'monthly':'90';d.use_unified_attribution_setting=false;d.use_account_attribution_setting=true;d.action_report_time='conversion';const r=await f.prepare('meta_report_task_create',d);assert.equal(r.success,true);assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');const rows=await f.rows();assert.equal(rows.success,true);assert.equal(rows.data.data.report.definition.action_report_time,'conversion');}finally{f.store.close();}}
});

test('reviewed fields are a set, but changed dates or attribution prevent completion',async()=>{
 for(const field of ['order','dates','attribution']){const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);if(field==='order')f.data.jobs['900'].fields.reverse();if(field==='dates')f.data.jobs['900'].date_stop='2026-08-04';if(field==='attribution')f.data.jobs['900'].use_unified_attribution_setting=false;const v=await f.verify(r);assert.equal(v.data.status,field==='order'?'verified':'unverified');if(field!=='order')assert.equal((await f.rows()).success,false);}finally{f.store.close();}}
});

test('null and action metrics preserve native values without zero filling or summing',async()=>{
 const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');f.mode('null_metric');assert.equal((await f.rows()).data.data.data[0].spend,null);f.mode('native_actions');assert.deepEqual((await f.rows()).data.data.data[0].actions,[{action_type:'purchase',value:'3.25'}]);}finally{f.store.close();}
});

test('a report receipt cannot authorize unrelated mutations or query/header overrides',async()=>{
 const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');const p:CompiledRequest={...r.data.request,path:'/v25.0/900',method:'POST',body:{status:'ACTIVE'},readOnly:false};assert.throws(()=>new ScopeGuard(registry,f.store).authorize(p,f.c),{code:'RESOURCE_SCOPE_REQUIRED'});for(const query of [{limit:0},{limit:1001},{after:''},{after:'x'.repeat(4097)},{fields:'spend'},{method:'POST'}])assert.equal((await f.rows('900',{query})).success,false);assert.equal(f.data.writes,1);}finally{f.store.close();}
});

test('foreign parent state, missing write grants and deployment controls block report creation',async()=>{
 for(const mode of ['parent','grant','scope','inflight','deployment','tenant']){const f=fixture(':memory:',undefined,mode!=='deployment');try{if(mode==='parent')f.mode('foreign_target');if(mode==='grant')f.store.putConnection(owner,{...f.c,writeAccounts:[]},{accessToken:'synthetic'});if(mode==='scope')f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});if(mode==='inflight')f.onRead(()=>f.store.putConnection(owner,{...f.c,writeAccounts:[]},{accessToken:'synthetic'}));const r=await f.service.call('amcp_write',{action:'prepare',gateway,arguments:f.args('meta_campaign_id_insights_report_create')},mode==='tenant'?{...actor,tenantId:'foreign'}:actor);assert.equal(r.success,false,mode);assert.equal(f.data.writes,0);}finally{f.store.close();}}
});

test('creation cannot bypass review through direct native execution',async()=>{
 const f=fixture();try{const r=await f.service.call(gateway,{...f.args(),dry_run:false,confirmed:true,idempotency_key:'fake'},actor);assert.equal(r.success,false);assert.equal(r.error.code,'WRITE_REVIEW_REQUIRED');assert.equal(f.calls.length,0);}finally{f.store.close();}
});

test('review immutability, expiry and revoked grants are enforced before creation',async()=>{
 for(const mode of ['expiry','integrity','grant','scope']){const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r,{arguments:{payload:definition()}})).error.code,'INVALID_ARGUMENT');const doc=f.store.document(actor.tenantId,'write_review',r.data.review_id);if(mode==='expiry')f.store.putDocument(actor.tenantId,'write_review',r.data.review_id,{...doc,expires_at:0});if(mode==='integrity'){doc.plan.body.time_range.until='2026-08-02';f.store.putDocument(actor.tenantId,'write_review',r.data.review_id,doc);}if(mode==='grant')f.store.putConnection(owner,{...f.c,writeAccounts:[]},{accessToken:'synthetic'});if(mode==='scope')f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});assert.equal((await f.execute(r)).success,false);assert.equal(f.data.writes,0);}finally{f.store.close();}}
});

test('concurrent execution and a process restart retain one creation and its scoped read access',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'amcp-meta-report-'));let f=fixture(join(directory,'store.sqlite'));
 try{const r=await f.prepare(),calls=await Promise.all([f.execute(r),f.execute(r)]);assert.ok(calls.some(c=>c.success));assert.equal(f.data.writes,1);const data=f.data;f.store.close();f=fixture(join(directory,'store.sqlite'),data);assert.equal((await f.execute(r)).data.replayed,true);assert.equal((await f.verify(r)).data.status,'verified');const readerService=new MirrorService(registry,f.store,f.transport);const result=await readerService.call(gateway,{action:'meta_report_run_insights_get',account_id:'123',connection_id:f.c.id,params:{ad_id:'900'},dry_run:false},{...actor,role:'reader'});assert.equal(result.success,true,JSON.stringify(result));assert.equal(f.data.writes,1);}finally{f.store.close();removeTestDirectory(directory,'amcp-meta-report-');}
});

test('background verification polls only reads, persists pending work, and surfaces provider failure',async()=>{
 for(const mode of ['complete','failed']){const f=fixture();try{const r=await f.prepare(),out=await f.execute(r);assert.equal(out.success,true);const jobId=out.data.verification.job_id,worker=new ReportWorker(f.store,async()=>{throw Error('No report export');},(tenant,kind,input)=>f.service.verificationJob(tenant,kind,input));f.mode('pending');await worker.once();assert.equal(f.store.job(actor.tenantId,jobId).state,'queued');f.store.db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(jobId);f.mode(mode==='complete'?'success':'failed');await worker.once();assert.equal(f.store.job(actor.tenantId,jobId).state,mode==='complete'?'complete':'failed');assert.equal(f.data.writes,1);}finally{f.store.close();}}
});

test('report binding expiry, reused provider IDs and cached verification cannot revive revoked access',async()=>{
 for(const mode of ['expiry','reuse','scope']){const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');if(mode==='expiry'){const key=f.c.id+'/123/900',doc=f.store.document(actor.tenantId,'meta_report_run',key);f.store.putDocument(actor.tenantId,'meta_report_run',key,{...doc,expires_at:0});assert.equal((await f.rows()).success,false);}if(mode==='reuse'){f.data.next=900;const second=await f.prepare();assert.equal((await f.execute(second)).success,true);assert.equal((await f.verify(second)).data.status,'unverified');}if(mode==='scope'){f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});assert.equal((await f.verify(r)).success,false);}assert.equal(f.store.ownsResource(f.c,'123','900'),false);}finally{f.store.close();}}
});

test('bounded retrieval reports remaining pages without claiming whole-report completeness',async()=>{
 const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');f.mode('pages');const out=await f.rows('900',{max_pages:1});assert.equal(out.data.pages,1);assert.equal(out.data.truncated,true);assert.equal(out.data.data.report.complete,false);assert.equal(out.data.data.report.next_call.arguments.connection_id,f.c.id);for(const n of [0,26,1.5])assert.equal((await f.rows('900',{max_pages:n})).success,false);}finally{f.store.close();}
});

test('report byte, row and monotonic deadline limits stop retrieval without creating another job',async(t)=>{
 const f=fixture();try{const r=await f.prepare();assert.equal((await f.execute(r)).success,true);assert.equal((await f.verify(r)).data.status,'verified');const binding=f.store.document(actor.tenantId,'meta_report_run',f.c.id+'/123/900'),p:CompiledRequest={...r.data.request,path:'/v25.0/900/insights',method:'GET',body:undefined,query:{limit:1000},headers:{},readOnly:true,metaReportRead:{...binding,kind:'rows'}};
  assert.throws(()=>metaReportReadResult(p,{status:200,data:{data:[],other:'x'.repeat(4*1024*1024)},headers:{}}),{code:'META_REPORT_STATE_UNVERIFIED'});
  await assert.rejects(()=>runMetaReportRead(p,async()=>({data:[],padding:'x'.repeat(8*1024*1024)}),true),{code:'META_REPORT_STATE_UNVERIFIED'});
  await assert.rejects(()=>runMetaReportRead(p,async()=>({data:Array.from({length:25001},(_,i)=>({account_id:'123',campaign_id:String(i),date_start:'2026-08-01',date_stop:'2026-08-01'}))}),true),{code:'META_REPORT_STATE_UNVERIFIED'});
  let time=0;t.mock.method(performance,'now',()=>time);await assert.rejects(()=>runMetaReportRead(p,async()=>{time=60001;return{data:[]};},true),{code:'META_REPORT_STATE_UNVERIFIED'});assert.equal(f.data.writes,1);
 }finally{f.store.close();}
});

test('report family membership never qualifies alternate origins, methods or transports',async()=>{
 const f=fixture();try{const r=await f.prepare(),p=r.data.request as CompiledRequest;assert.equal(metaReportKind(p),'account');for(const change of [{origin:'https://foreign.invalid'},{method:'GET'},{path:p.path+'/create'},{specialTransport:'upload'},{action:'meta_business_id_adnetworkanalytics_report_create'}])assert.equal(metaReportKind({...p,...change}),undefined);}finally{f.store.close();}
});
