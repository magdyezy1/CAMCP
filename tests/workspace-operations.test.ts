import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportWorker} from '../src/worker.js';
import {createHttpApp} from '../server/http-app.js';
import type {Actor,JsonObject} from '../src/types.js';
const registry=new Registry(),key=Buffer.alloc(32,33).toString('base64'),actor:Actor={tenantId:'workspace-test',userId:'operator',role:'operator'},admin:Actor={...actor,role:'admin'},policy={allowWrites:true,maxBudgetChange:0,requireBeforeState:true};
const campaign={action:'meta_campaign_create',payload:{name:'Draft',status:'PAUSED',objective:'OUTCOME_TRAFFIC',special_ad_categories:[]}};
function setup(){
 const store=new Store(':memory:',key),connection={id:'aaaaaaaa-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:['ads_management']};store.putConnection(admin,connection,{accessToken:'synthetic'});
 const records=new Map<string,JsonObject>(),calls:JsonObject[]=[];let rows:JsonObject[]=[{campaign_id:'111',spend:'12.01',impressions:'2000',clicks:'50',conversions:'0',value:'0',term:'irrelevant'}],lost=false,wrong=false,paging=false;
 const transport=new NativeTransport((async(url,init)=>{const u=new URL(String(url)),method=init!.method!,body=init!.body?Object.fromEntries([...new URLSearchParams(String(init!.body))].map(([k,v])=>{if(v.startsWith('{')||v.startsWith('['))return [k,JSON.parse(v)];return [k,v];})):undefined;calls.push({path:u.pathname,method,body});
  if(u.pathname.endsWith('/insights'))return new Response(JSON.stringify({data:rows,...(paging?{paging:{next:'https://graph.facebook.com/next'}}:{})}));
  if(u.pathname.endsWith('/promote_pages'))return Response.json({data:[{id:'500'}]});
  if(method==='GET'){const id=u.pathname.split('/').at(-1)!;return new Response(JSON.stringify(id==='act_123'?{id:'act_123',currency:'USD',account_status:1}:records.get(id)??{id,name:'Synthetic',status:'PAUSED'}));}
  if(lost)throw Error('connection lost');const id=String(111+records.size);records.set(id,{id,...body,...(body?.creative?.creative_id?{creative:{id:body!.creative.creative_id}}:{}),...(wrong?{daily_budget:'999'}:{})});return new Response(JSON.stringify({id}));
 }) as typeof fetch);
 const service=new MirrorService(registry,store,transport,undefined,policy);return {store,service,calls,records,connection,setRows:(r:JsonObject[])=>{rows=r;},lose:()=>{lost=true;},mismatch:()=>{wrong=true;},partial:()=>{paging=true;}};
}
async function ok(s:MirrorService,tool:string,input:JsonObject,a=actor){const r=await s.call(tool,input,a);assert.equal(r.success,true,JSON.stringify(r));return r.data as JsonObject;}
const step=(id:string,args:JsonObject,depends_on:string[]=[])=>({id,kind:'write',gateway:'meta_native_action',connection_id:'aaaaaaaa-1111-4111-8111-111111111111',account_id:'123',arguments:args,depends_on});
const plan=(steps:JsonObject[])=>({action:'create',name:'Synthetic launch',brief:'Paused traffic campaign using approved settings.',steps});
test('durable campaign executes verified dependencies, binds created parents, and resumes without duplicate writes',async()=>{
 const x=setup();try{
  const r=await ok(x.service,'amcp_campaign',plan([step('campaign',campaign),step('adset',{action:'meta_adset_create',payload:{name:'Set',status:'PAUSED',daily_budget:'200',campaign_id:{$ref:'campaign#/data/id'}}},['campaign'])]));
  const first=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
  let run=await ok(x.service,'amcp_campaign',{action:'execute_next',id:r.id,review_id:first.review.review_id,idempotency_key:first.review.idempotency_key,confirmed:true,spend_change_confirmed:true});assert.equal(run.steps[0].status,'verified');
  const resumed=new MirrorService(registry,x.store,x.service.transport,undefined,policy),next=await ok(resumed,'amcp_campaign',{action:'prepare_next',id:r.id});assert.equal(next.review.request.body.campaign_id,'111');
  run=await ok(resumed,'amcp_campaign',{action:'execute_next',id:r.id,review_id:next.review.review_id,idempotency_key:next.review.idempotency_key,confirmed:true,spend_change_confirmed:true});assert.equal(run.state,'complete');assert.equal(x.calls.filter(c=>c.method==='POST').length,2);
  await ok(resumed,'amcp_campaign',{action:'prepare_next',id:r.id});assert.equal(x.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(x.store.verifyAudit(),true);
 }finally{x.store.close();}
});
test('crash before receipt persistence returns the original execution key; uncertain writes never prepare another mutation',async()=>{
 const x=setup();try{const r=await ok(x.service,'amcp_campaign',plan([step('campaign',campaign)])),p=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});
  const saved=x.store.document(actor.tenantId,'campaign_run',r.id);saved.steps[0].status='executing';x.store.putDocument(actor.tenantId,'campaign_run',r.id,saved);const before=x.calls.length,resume=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});assert.equal(resume.next_call.arguments.review_id,p.review.review_id);assert.equal(x.calls.length,before);
  x.lose();const failed=await ok(x.service,'amcp_campaign',{...resume.next_call.arguments,spend_change_confirmed:true});assert.equal(failed.steps[0].status,'uncertain');const stopped=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});assert.equal(stopped.blocked,true);assert.equal(x.calls.filter(c=>c.method==='POST').length,1);
 }finally{x.store.close();}
});
test('campaign read disagreement identifies budget field and stays in verification; plan tampering and unauthorized actors fail closed',async()=>{
 const x=setup();try{x.mismatch();const r=await ok(x.service,'amcp_campaign',plan([step('campaign',{...campaign,payload:{...campaign.payload,daily_budget:'200'}})])),p=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});
  const run=await ok(x.service,'amcp_campaign',{action:'execute_next',id:r.id,review_id:p.review.review_id,idempotency_key:p.review.idempotency_key,confirmed:true,spend_change_confirmed:true});assert.equal(run.steps[0].status,'verifying');assert.equal(run.steps[0].verification.code,'VERIFICATION_INCONCLUSIVE');assert.equal(run.steps[0].verification.checks[0].read_attempts,3);assert.deepEqual(run.steps[0].verification.checks[0].changed_fields,['/daily_budget']);assert.equal(x.calls.filter(c=>c.method==='POST').length,1);
  assert.equal((await x.service.call('amcp_campaign',{action:'get',id:r.id},{...actor,userId:'other'})).error.code,'FORBIDDEN');
  const doc=x.store.document(actor.tenantId,'campaign_run',r.id);doc.steps[0].arguments.payload.name='changed';x.store.putDocument(actor.tenantId,'campaign_run',r.id,doc);assert.equal((await x.service.call('amcp_campaign',{action:'get',id:r.id},actor)).error.code,'PLAN_CHANGED');
 }finally{x.store.close();}
});
test('approved profiles require revisions and refuse credentials; templates expand without changing explicit native settings',async()=>{
 const x=setup();try{const p=await ok(x.service,'amcp_workspace',{action:'save_profile',confirmed:true,profile:{name:'Client',utm:{utm_medium:'paid'},variables:{market:'EG'},templates:{traffic:[step('campaign',{...campaign,payload:{...campaign.payload,name:'{{profile.name}}-{{market}}'}})]}}});
  assert.equal((await x.service.call('amcp_workspace',{action:'save_profile',id:p.id,confirmed:true,profile:{name:'Stale'}},actor)).error.code,'REVISION_CONFLICT');
  assert.equal((await x.service.call('amcp_workspace',{action:'save_profile',confirmed:true,profile:{name:'Unsafe',variables:{access_token:'synthetic'}}},actor)).success,false);
  const run=await ok(x.service,'amcp_campaign',{action:'create',name:'Template',brief:'Test',profile_id:p.id,template:'traffic'});assert.equal(run.steps[0].arguments.payload.name,'Client-EG');assert.equal(run.profile_revision,p.revision);
  const r=await x.service.call('amcp_workspace',{action:'save_profile',confirmed:true,profile:{name:'Reader'}},{...actor,role:'reader'});assert.equal(r.error.code,'FORBIDDEN');
 }finally{x.store.close();}
});
test('readiness keeps unknown assets explicit and dashboard never promotes catalog coverage to verified writes',async()=>{
 const x=setup();try{const r=await ok(x.service,'amcp_workspace',{action:'check',connection_id:'aaaaaaaa-1111-4111-8111-111111111111',account_id:'123',live:true,requirements:{write:true,assets:[{kind:'pages',id:'999'}],destination_url:'https://example.com'}});assert.equal(r.live_read,true);assert.equal(r.ready,false);assert.equal(r.checks.find((c:JsonObject)=>c.key==='asset:pages:999').status,'unknown');
  const d=await ok(x.service,'amcp_workspace',{action:'dashboard'});assert.equal(d.capabilities.features.length,8);assert.equal(d.capabilities.evidence[0].writes.length,0);assert.equal(d.capabilities.evidence[0].read.length,1);
  assert.equal((await x.service.call('amcp_workspace',{action:'check',connection_id:'aaaaaaaa-1111-4111-8111-111111111111',account_id:'999',live:true},actor)).error.code,'ACCOUNT_FORBIDDEN');
 }finally{x.store.close();}
});
test('every reviewed write queues read-back, and a revoked connector prevents background egress',async()=>{
 const x=setup();try{const token=x.store.createKey(actor),a=x.store.authenticate(token),p=await ok(x.service,'amcp_write',{action:'prepare',gateway:'meta_native_action',connection_id:'aaaaaaaa-1111-4111-8111-111111111111',arguments:{...campaign,account_id:'123'}},a),out=await ok(x.service,'amcp_write',{action:'execute',review_id:p.review_id,idempotency_key:p.idempotency_key,confirmed:true},a);assert.equal(out.verification.status,'queued');x.store.revokeKey(token);const before=x.calls.length;
  const worker=new ReportWorker(x.store,async()=>null,(t,k,i)=>x.service.verificationJob(t,k,i));await worker.once();assert.equal(x.calls.length,before);assert.equal(x.store.job(actor.tenantId,out.verification.job_id).error.code,'UNAUTHORIZED');
 }finally{x.store.close();}
});
test('worker independently verifies a successful native response without repeating the mutation',async()=>{
 const x=setup();try{const p=await ok(x.service,'amcp_write',{action:'prepare',gateway:'meta_native_action',arguments:{...campaign,account_id:'123'}}),out=await ok(x.service,'amcp_write',{action:'execute',review_id:p.review_id,idempotency_key:p.idempotency_key,confirmed:true});await new ReportWorker(x.store,async()=>null,(t,k,i)=>x.service.verificationJob(t,k,i)).once();assert.equal(x.store.job(actor.tenantId,out.verification.job_id).result.status,'verified');assert.equal(x.calls.filter(c=>c.method==='POST').length,1);}finally{x.store.close();}
});
const capture={action:'capture',gateway:'meta_native_action',account_id:'123',connection_id:'aaaaaaaa-1111-4111-8111-111111111111',arguments:{action:'meta_ad_account_id_insights_get',ad_account_id:'act_123',account_id:'123',fields:'campaign_id,spend,impressions,clicks'},rows_pointer:'/data/data/data',mapping:{entity_id:'/campaign_id',spend:'/spend',clicks:'/clicks',impressions:'/impressions',conversions:'/conversions',conversion_value:'/value',search_term:'/term'},semantics:{currency:'USD',timezone:'Etc/UTC',date_from:'2026-09-01',date_to:'2026-09-07',attribution:'7-day click',conversion_definition:'purchase',source_name:'Synthetic native report',complete:true}};
test('source-linked report uses exact decimals, missing metrics remain unknown, and reconciles reference totals',async()=>{
 const x=setup();try{x.setRows([{campaign_id:'111',spend:'9007199254740993.12',clicks:'50',impressions:'2000',conversions:'2',value:'4'},{campaign_id:'112',spend:'0.01',clicks:'1',impressions:'10',conversions:'0',value:'0'}]);const r=await ok(x.service,'amcp_reporting',capture);assert.equal(r.totals.spend,'9007199254740993.13');assert.equal(r.totals.reach,null);assert.match(r.source_hash,/^[0-9a-f]{64}$/);const comparison=await ok(x.service,'amcp_reporting',{action:'reconcile',id:r.id,reference:{label:'Native export',captured_at:Date.now(),totals:{spend:'9007199254740993.13',clicks:'52'}}});assert.equal(comparison.matched,false);assert.equal(comparison.differences[1].difference,'-1');
  x.setRows([]);const empty=await ok(x.service,'amcp_reporting',{...capture,mapping:{spend:'/spend'}});assert.equal(empty.totals.spend,'0');assert.equal(empty.totals.clicks,null);
 }finally{x.store.close();}
});
test('report capture refuses native writes and incomplete pagination, and revoked accounts cannot read cached metrics',async()=>{
 const x=setup();try{const denied=await x.service.call('amcp_reporting',{...capture,arguments:{...campaign,account_id:'123'}},actor);assert.equal(denied.error.code,'REPORT_READ_REQUIRED');assert.equal(x.calls.length,0);
  const r=await ok(x.service,'amcp_reporting',capture);x.partial();assert.equal((await x.service.call('amcp_reporting',capture,actor)).error.code,'REPORT_INCOMPLETE');x.store.putConnection(admin,{...x.connection,enabled:false},x.store.credentials(actor.tenantId,'aaaaaaaa-1111-4111-8111-111111111111'));assert.equal((await x.service.call('amcp_reporting',{action:'get',id:r.id},actor)).success,false);assert.equal((await ok(x.service,'amcp_reporting',{action:'list'})).reports.length,0);
 }finally{x.store.close();}
});
test('optimization checks comparable windows, aggregates entity rows, enforces sample and freshness thresholds',async()=>{
 const x=setup();try{x.setRows([{campaign_id:'111',spend:'100',clicks:'100',impressions:'2000',conversions:'0',value:'0'},{campaign_id:'111',spend:'100',clicks:'100',impressions:'2000',conversions:'0',value:'0'}]);const base=await ok(x.service,'amcp_reporting',{...capture,semantics:{...capture.semantics,date_from:'2026-08-25',date_to:'2026-08-31'}});x.setRows([{campaign_id:'111',spend:'120',clicks:'50',impressions:'4000',conversions:'0',value:'0',term:'unrelated'}]);const now=await ok(x.service,'amcp_reporting',capture),a=await ok(x.service,'amcp_reporting',{action:'analyze',id:now.id,baseline_id:base.id,options:{planned_budget:'200',total_days:10,elapsed_days:5}});assert.equal(a.recommendations.filter((r:JsonObject)=>r.type==='possible_creative_fatigue').length,1);assert.ok(a.recommendations.some((r:JsonObject)=>r.type==='search_waste'));assert.ok(a.recommendations.every((r:JsonObject)=>r.automatic_execution===false));
  assert.equal((await x.service.call('amcp_reporting',{action:'combine',id:now.id,ids:[base.id]},actor)).success,false);x.store.putDocument(actor.tenantId,'decision_report',now.id,{...now,captured_at:0});assert.equal((await ok(x.service,'amcp_reporting',{action:'analyze',id:now.id})).eligible_for_action,false);
 }finally{x.store.close();}
});
test('Google provider validation sets validateOnly on a reviewed contract without creating a review or mutation receipt',async()=>{
 const store=new Store(':memory:',key);try{store.putConnection(admin,{id:'g',tenantId:actor.tenantId,gateway:'google_ads_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'G',scopes:[]},{accessToken:'synthetic',developerToken:'synthetic'});let body:any;const s=new MirrorService(registry,store,new NativeTransport((async(_u,init)=>{body=JSON.parse(String(init!.body));return new Response('{}');}) as typeof fetch),undefined,policy);
  const r=await ok(s,'amcp_campaign',{action:'validate_provider',gateway:'google_ads_native_action',connection_id:'g',arguments:{action:'google_ads_v23_campaign_budget_mutate_campaign_budgets',account_id:'123',payload:{operations:[{create:{name:'Budget',amount_micros:'1000000',delivery_method:'STANDARD'}}]}}});assert.equal(body.validateOnly,true);assert.equal(r.objects_created,false);assert.equal(store.documents(actor.tenantId,'write_review').length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM idempotency').get()!.n,0);
 }finally{store.close();}
});
test('new website operation pages enforce session and CSRF and retain escaped data in JSON',async()=>{
 const x=setup(),origin='https://amcp.shop',password='synthetic-workspace-password',listener=createHttpApp(x.service,x.store,{website:{origin,masterKey:key,adminPassword:password,tenantId:actor.tenantId}}).listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 const request=async(url:string,body?:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();return {status:r.status,headers:r.headers,text};};
 try{for(const route of ['/dashboard','/campaigns','/media','/profiles','/reports'])assert.equal((await request(route)).status,200);assert.equal((await request('/api/workspace/workspace',{action:'dashboard'})).status,401);const login=await request('/api/session',{password}),cookie=login.headers.get('set-cookie')!.split(';')[0]!,csrf=JSON.parse(login.text).csrf;assert.equal((await request('/api/workspace/workspace',{action:'dashboard'},{Cookie:cookie})).status,403);const dashboard=await request('/api/workspace/workspace',{action:'dashboard'},{Cookie:cookie,'X-AMCP-CSRF':csrf});assert.equal(JSON.parse(dashboard.text).data.capabilities.features.length,8);assert.equal((await request('/api/media/variants/missing/preview')).status,401);
 }finally{await new Promise<void>(r=>listener.close(()=>r()));x.store.close();}
});


test('campaign runner verifies the full Meta creative and paused-ad chain using native creative read IDs',async()=>{
 const x=setup();try{const r=await ok(x.service,'amcp_campaign',plan([
  step('campaign',campaign),
  step('adset',{action:'meta_adset_create',payload:{name:'Set',status:'PAUSED',campaign_id:{$ref:'campaign#/data/id'}}},['campaign']),
  step('creative',{action:'meta_creative_create',payload:{name:'Creative',object_story_spec:{page_id:'500',link_data:{image_hash:'existing_hash',link:'https://example.com',message:'test'}}}}),
  step('ad',{action:'meta_ad_create',payload:{name:'Ad',status:'PAUSED',adset_id:{$ref:'adset#/data/id'},creative:{creative_id:{$ref:'creative#/data/id'}}}},['adset','creative'])
 ]));
 for(let i=0;i<4;i++){const p=await ok(x.service,'amcp_campaign',{action:'prepare_next',id:r.id});assert.ok(p.review,JSON.stringify(p));const run=await ok(x.service,'amcp_campaign',{action:'execute_next',id:r.id,review_id:p.review.review_id,idempotency_key:p.review.idempotency_key,confirmed:true,spend_change_confirmed:true});assert.equal(run.steps[i].status,'verified',JSON.stringify(run.steps[i]));}
 assert.equal((await ok(x.service,'amcp_campaign',{action:'get',id:r.id})).state,'complete');assert.equal(x.calls.filter(c=>c.method==='POST').length,4);
 }finally{x.store.close();}
});
