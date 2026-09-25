import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {actionContracts} from '../src/action-contracts.js';

test('documented Snapchat nested ad and ad-squad updates have reviewed contracts on all ten captured surfaces',()=>{
 const rows=actionContracts(new Registry()).filter(r=>r.gateway==='snapchat_native_action'&&['PUT','PATCH'].includes(r.method??'')&&/^\/v1\/(campaigns\/\{campaign_id\}\/adsquads|adsquads\/\{ad_squad_id\}\/ads)(?:\/\{[^}]+\})?$/.test(r.path??''));
 assert.equal(rows.length,10);for(const row of rows){assert.equal(row.status,'reviewed_write_family',row.action);assert.equal(row.family,'snapchat_nested_updates');assert.ok(row.tests.includes('tests/snapchat-nested-updates.test.ts'));}
});

import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Compiler} from '../src/compiler.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {readSnapUpdateState} from '../src/snapchat-nested-updates.js';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTestDirectory} from './temp.js';
import type {Actor,Connection,JsonObject} from '../src/types.js';

const actor:Actor={tenantId:'snap-nested',userId:'operator',role:'operator'},owner:Actor={...actor,role:'admin'},gateway='snapchat_native_action',account='account1',registry=new Registry(),compiler=new Compiler(registry);
const key=Buffer.alloc(32,47).toString('base64'),auth={accessToken:'synthetic-original'},options={mode:'strict' as const,flags:{}};
const actions=actionContracts(registry).filter(r=>r.gateway===gateway&&['PUT','PATCH'].includes(r.method??'')&&/^\/v1\/(campaigns\/\{campaign_id\}\/adsquads|adsquads\/\{ad_squad_id\}\/ads)(?:\/\{[^}]+\})?$/.test(r.path??''));
function fixture(file=':memory:',allowWrites=true){
 let store=new Store(file,key),mode='',hook:((path:string,method:string)=>void|Promise<void>)|undefined;
 const c:Connection={id:'11111111-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]};store.putConnection(owner,c,auth);
 const campaign:JsonObject={id:'campaign1',ad_account_id:account,name:'Campaign',status:'ACTIVE',buy_model:'AUCTION',pacing_level:'AD_SQUAD',start_time:'2026-01-01T00:00:00Z',end_time:'2027-01-01T00:00:00Z',daily_budget_micro:900000000};
 const squad:JsonObject={id:'squad1',campaign_id:campaign.id,name:'Squad',status:'PAUSED',type:'SNAP_ADS',billing_event:'IMPRESSION',optimization_goal:'IMPRESSIONS',bid_strategy:'LOWEST_COST_WITH_MAX_BID',bid_micro:1000000,daily_budget_micro:100000000,lifetime_budget_micro:900000000,start_time:'2026-01-01T00:00:00Z',end_time:'2027-01-01T00:00:00Z',targeting:{geos:[{country_code:'sa'}]},placement_v2:{config:'AUTOMATIC'},pacing_type:'STANDARD',included_content_types:['NEWS','SPORTS']};
 const ad:JsonObject={id:'ad1',ad_squad_id:squad.id,creative_id:'creative1',name:'Ad',status:'PAUSED',type:'REMOTE_WEBPAGE',start_time:'2026-01-01T00:00:00Z',end_time:'2027-01-01T00:00:00Z',third_party_paid_impression_tracking_urls:['https://approved.example/pixel?a=1','https://approved.example/pixel?a=2']};
 const rows:Record<string,JsonObject>={['adaccounts/'+account]:{id:account,currency:'SAR',timezone:'Asia/Riyadh'},'campaigns/campaign1':campaign,'adsquads/squad1':squad,'ads/ad1':ad};
 for(const name of Object.keys(rows).filter(k=>!k.startsWith('adaccounts/')))store.rememberResource(c,account,name);
 const calls:JsonObject[]=[],stats={writes:0};
 const transport=new NativeTransport(async(raw,init)=>{
  const u=new URL(String(raw)),method=init?.method??'GET';assert.equal(u.origin,'https://adsapi.snapchat.com');assert.equal(init?.redirect,'error');calls.push({path:u.pathname,method,body:init?.body});await hook?.(u.pathname,method);
  if(method==='GET'){
   const parts=u.pathname.split('/'),collection=parts[2]!,name=parts[3]!,current=structuredClone(rows[collection+'/'+name]);assert.ok(current,'Unexpected read '+u.pathname);
   if(mode==='foreign_account'&&collection==='campaigns')current.ad_account_id='another';
   if(mode==='foreign_parent'&&collection==='ads')current.ad_squad_id='other';
   if(mode==='foreign_target'&&collection==='adsquads')current.id='different';
   if(mode==='moving'&&collection==='adsquads')current.name+=' '+calls.length;
   if(mode==='deleted'&&collection==='ads')current.deleted=true;
   if(mode==='unknown_config'&&collection==='ads')current.future_configuration='must-not-drop';
   current.updated_at=new Date(Date.now()+calls.length).toISOString();current.created_at='2026-01-01T00:00:00Z';
   current.delivery_status=['NATIVE_'+calls.length];current.review_status='PENDING';
   if(collection==='adsquads'){current.included_content_types=calls.length%2?['SPORTS','NEWS']:['NEWS','SPORTS'];current.auto_bid=current.bid_strategy==='AUTO_BID';current.target_bid=current.bid_strategy==='TARGET_COST';current.targeting_reach_status='NATIVE_'+calls.length;}
   if(mode==='read_error')return Response.json({request_status:'ERROR',error:'Synthetic denial'});
   return Response.json({request_status:'SUCCESS',request_id:String(calls.length),...(mode==='partial'?{partial:true}:{}),[collection]:[{sub_request_status:'SUCCESS',[collection==='adsquads'?'adsquad':collection==='adaccounts'?'adaccount':collection.slice(0,-1)]:current}]});
  }
  stats.writes++;const kind=u.pathname.includes('/campaigns/')?'adsquads':'ads',body=JSON.parse(String(init?.body));assert.equal(new Headers(init?.headers).get('content-type'),method==='PATCH'?'application/json-patch+json':'application/json');
  const targets=method==='PUT'?body[kind]:[{id:u.pathname.split('/').at(-1)}];
  for(const t of targets){const old=rows[kind+'/'+t.id]!;if(method==='PUT')rows[kind+'/'+t.id]={...t};else for(const op of body)if(op.op!=='test')old[op.path.slice(1)]=op.op==='remove'?null:op.value;}
  if(mode==='lost')throw Error('Synthetic accepted response lost');
  const out=targets.map((t:JsonObject)=>({sub_request_status:mode==='write_error'?'ERROR':'SUCCESS',[kind==='ads'?'ad':'adsquad']:{...rows[kind+'/'+t.id],...(mode==='foreign_receipt'?{id:'foreign'}:{}),...(mode==='receipt_parent'?{[kind==='ads'?'ad_squad_id':'campaign_id']:'wrong'}:{})}}));
  if(mode==='legacy_success')return Response.json({status:'success',[kind]:out.map((r:JsonObject)=>({status:'success',[kind==='ads'?'ad':'adsquad']:r[kind==='ads'?'ad':'adsquad']}))});
  if(mode==='conflicting_receipt')out[0].status='error';
  if(mode==='warning')out[0].sub_request_warnings=[{code:'SYNTHETIC_DELIVERY_WARNING',message:'Synthetic native warning; verify delivery prerequisites.'}];
  return Response.json({request_status:'SUCCESS',request_id:String(calls.length),[kind]:mode==='empty_receipt'?[]:mode==='duplicate_receipt'?[...out,...out]:out});
 },async()=>{},30000,8*1024*1024,10000);
 let service=new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});
 const args=(action='snapchat_adsquad_patch',payload:unknown=[{op:'replace',path:'/name',value:'Reviewed name'}]):JsonObject=>{
  const values:JsonObject={campaign_id:'campaign1',ad_squad_id:'squad1',ad_id:'ad1'},path=registry.action(gateway,action)!.path!;
  return {action,account_id:account,connection_id:c.id,path_params:Object.fromEntries([...path.matchAll(/\{([^}]+)\}/g)].map(m=>[m[1]!,values[m[1]!]])),payload};
 };
 const prepare=(a=args())=>service.call('amcp_write',{action:'prepare',gateway,arguments:a},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {get store(){return store;},get service(){return service;},c,rows,calls,stats,args,prepare,execute,verify,mode:(v:string)=>{mode=v;},hook:(v:typeof hook)=>{hook=v;},restart:()=>{store.close();store=new Store(file,key);service=new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});}};
}
for(const a of actions)test(a.action+' prepares, executes once and reads back the exact nested native update',async()=>{
 const f=fixture();try{
  const squad=a.path!.includes('/campaigns/'),collection=squad?'adsquads':'ads',row=f.rows[collection+'/'+(squad?'squad1':'ad1')]!,payload=a.method==='PUT'?{[collection]:[{...row,name:'Reviewed name'}]}:[{op:'replace',path:'/name',value:'Reviewed name'}];
  const input=f.args(a.action,payload),p=await f.prepare(input);assert.equal(p.success,true,JSON.stringify(p));assert.equal(f.stats.writes,0);
  const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));assert.equal(e.data.success,true);assert.equal(f.stats.writes,1);
  const v=await f.verify(p);assert.equal(v.data.status,'verified',JSON.stringify(v));assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.stats.writes,1);
  assert.equal(f.rows[collection+'/'+row.id]!.name,'Reviewed name');
 }finally{f.store.close();}
});

test('Snapchat sparse PUT, mutable identity and unknown configuration cannot reset settings',async()=>{
 for(const mode of ['missing','nested','identity','unknown']as const){const f=fixture();try{
  const row:JsonObject={...f.rows['ads/ad1']!,name:'New'};if(mode==='missing')delete row.third_party_paid_impression_tracking_urls;if(mode==='identity')row.creative_id='other';if(mode==='nested')row.ad_squad_id='other';if(mode==='unknown')f.mode('unknown_config');
  const p=await f.prepare(f.args('snapchat_ad_replace',{ads:[row]}));assert.equal(p.success,false,mode);assert.equal(f.stats.writes,0);
 }finally{f.store.close();}}
});

test('Snapchat patch rejects immutable, complex-resource, indexed, missing, malformed and unsafe monetary fields before egress',async()=>{
 const invalid:JsonObject[][]=[
  [{op:'replace',path:'/id',value:'new'}],[{op:'replace',path:'/campaign_id',value:'other'}],[{op:'replace',path:'/targeting',value:{geos:[{country_code:'us'}]}}],
  [{op:'replace',path:'/pixel_id',value:'guessed'}],[{op:'replace',path:'/targeting/geos/0',value:{country_code:'us'}}],[{op:'copy',path:'/name',from:'/id'}],
  [{op:'replace',path:'/name'}],[{op:'remove',path:'/status'}],[{op:'remove',path:'/daily_budget_micro'}],[{op:'replace',path:'/daily_budget_micro',value:0}],
  [{op:'replace',path:'/daily_budget_micro',value:100.5}],[{op:'replace',path:'/daily_budget_micro',value:'100000000'}],[{op:'replace',path:'/bid_micro',value:Number.MAX_SAFE_INTEGER+1}],
  [{op:'replace',path:'/start_time',value:'2026-02-30T00:00:00Z'}],[{op:'replace',path:'/status',value:'ENABLED'}],[{op:'replace',path:'/name',value:'bad\nname'}],
  [{op:'replace',path:'/excluded_content_types',value:['INVENTED']}],[{op:'replace',path:'/__proto__',value:{polluted:true}}]
 ];
 for(const payload of invalid){const f=fixture();try{const r=await f.prepare(f.args(undefined,payload));assert.equal(r.success,false,JSON.stringify(payload));assert.equal(f.calls.length,0,JSON.stringify(payload));}finally{f.store.close();}}
});

test('Snapchat native patch test/add/remove semantics use the frozen baseline and preserve ordered tracking tags',async()=>{
 const f=fixture();try{
  const payload=[{op:'test',path:'/name',value:'Ad'},{op:'remove',path:'/end_time'},{op:'replace',path:'/third_party_paid_impression_tracking_urls',value:['https://approved.example/pixel?a=2','https://approved.example/pixel?a=1']}];
  const p=await f.prepare(f.args('snapchat_ad_patch',payload));assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);
  assert.equal((await f.verify(p)).data.status,'verified');assert.equal(f.rows['ads/ad1']!.end_time,null);
  f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls.reverse();const v=await f.verify(p);assert.equal(v.data.status,'inconclusive');assert.ok(v.data.checks[0].changed_fields.some((x:string)=>x.includes('third_party_paid')));
 }finally{f.store.close();}
 for(const payload of [[{op:'test',path:'/name',value:'wrong'}],[{op:'add',path:'/name',value:'wrong'}],[{op:'replace',path:'/excluded_content_types',value:['NEWS']}]]){const f=fixture();try{assert.equal((await f.prepare(f.args(undefined,payload))).success,false);assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat exact account, parent and target checks reject stale ownership, partial state and moving baselines',async()=>{
 for(const mode of ['foreign_account','foreign_parent','foreign_target','deleted','partial','read_error','moving']){const f=fixture();try{f.mode(mode);const p=await f.prepare(f.args('snapchat_ad_patch'));assert.equal(p.success,false,mode);assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat telemetry and set order are stable while budget, targeting, parent, currency and tracking changes conflict',async()=>{
 for(const change of ['budget','targeting','parent','currency','tracking']){const f=fixture();try{
  const p=await f.prepare(f.args('snapchat_ad_patch'));assert.equal(p.success,true,JSON.stringify(p));
  if(change==='budget')f.rows['adsquads/squad1']!.daily_budget_micro++;if(change==='targeting')f.rows['adsquads/squad1']!.targeting={geos:[{country_code:'us'}]};if(change==='parent')f.rows['campaigns/campaign1']!.name='Changed';if(change==='currency')f.rows['adaccounts/'+account]!.currency='USD';if(change==='tracking')f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls.reverse();
  const e=await f.execute(p);assert.equal(e.error.code,'STATE_CHANGED',change+JSON.stringify(e));assert.ok(e.error.details.changed_fields.length);assert.equal(f.stats.writes,0);
 }finally{f.store.close();}}
});

test('Snapchat exact target budget policy excludes parent caps and enforces percentage, absolute and cumulative micros',async()=>{
 const f=fixture();try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:10,max_budget_native:110000000,max_daily_increase_native:15000000,allow_activation:false}});
  const budget=(n:number)=>f.args(undefined,[{op:'replace',path:'/daily_budget_micro',value:n}]);
  const bad=await f.prepare(budget(110000001));assert.equal(bad.error.code,'POLICY_BUDGET_LIMIT');
  const p=await f.prepare(budget(110000000));assert.equal(p.success,true,JSON.stringify(p));const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));assert.equal((await f.verify(p)).data.status,'verified');
  const reservation=f.store.documents(actor.tenantId,'spend_reservation')[0]!;assert.equal(reservation.increase_native,10000000);
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:10,max_budget_native:200000000,max_daily_increase_native:15000000}});
  assert.equal((await f.prepare(budget(121000001))).error.code,'POLICY_INCREASE_LIMIT');assert.equal((await f.prepare(budget(116000000))).error.code,'POLICY_DAILY_INCREASE_LIMIT');
 }finally{f.store.close();}
});

test('Snapchat full PUT preserves both budget caps and compares each child independently',async()=>{
 const f=fixture();try{
  const second={...f.rows['adsquads/squad1']!,id:'squad2',daily_budget_micro:200000000};f.rows['adsquads/squad2']=second;f.store.rememberResource(f.c,account,'adsquads/squad2');
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:10,max_daily_increase_native:30000000}});
  const p=await f.prepare(f.args('snapchat_adsquad_replace',{adsquads:[{...f.rows['adsquads/squad1']!,daily_budget_micro:110000000},{...second,daily_budget_micro:220000000}]}));assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');
  const row=f.store.documents(actor.tenantId,'spend_reservation')[0]!;assert.equal(row.increase_native,30000000);
 }finally{f.store.close();}
});

test('Snapchat naming does not consume budget but activation and absent spending acknowledgement are refused',async()=>{
 const f=fixture();try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{allow_activation:false,max_budget_native:0,max_daily_increase_native:0}});
  const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p,{spend_change_confirmed:false})).error.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal((await f.execute(p)).success,true);
  const active=await f.prepare(f.args(undefined,[{op:'replace',path:'/status',value:'ACTIVE'}]));assert.equal(active.error.code,'POLICY_ACTIVATION_FORBIDDEN');
 }finally{f.store.close();}
});

test('Snapchat fields that would invalidate bidding, pacing or the date interval cannot be submitted',async()=>{
 for(const payload of [[{op:'replace',path:'/bid_strategy',value:'AUTO_BID'},{op:'replace',path:'/pacing_type',value:'ACCELERATED'}],[{op:'replace',path:'/end_time',value:'2025-01-01T00:00:00Z'}],[{op:'replace',path:'/start_time',value:'2025-01-01T00:00:00Z'}]]){const f=fixture();try{assert.equal((await f.prepare(f.args(undefined,payload))).success,false);assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat native bypass, reader, other workspace, grants and deployment gates remain enforced',async()=>{
 const f=fixture();try{
  const p=await f.prepare();assert.equal(p.success,true);
  assert.equal((await f.service.call(gateway,{...f.args(),dry_run:false,confirmed:true,idempotency_key:'synthetic-native'},actor)).error.code,'WRITE_REVIEW_REQUIRED');
  assert.equal((await f.service.call('amcp_write',{action:'prepare',gateway,arguments:f.args()},{...actor,role:'reader'})).success,false);
  assert.equal((await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},{...actor,tenantId:'other'})).success,false);
  f.store.putConnection(owner,{...f.c,writeAccounts:[]},auth);assert.equal((await f.execute(p)).error.code,'WRITE_ACCOUNT_FORBIDDEN');assert.equal(f.stats.writes,0);
 }finally{f.store.close();}
 const off=fixture(':memory:',false);try{assert.equal((await off.prepare()).error.code,'LIVE_WRITES_DISABLED');assert.equal(off.stats.writes,0);}finally{off.store.close();}
});

for(const authority of ['account','login','actor'])test('Snapchat in-flight '+authority+' withdrawal stops further reads and mutations',async()=>{
 const f=fixture();try{
  let active=true;f.store.bindActorCheck(actor,()=>{if(!active)throw Error('Synthetic actor revoked');});
  f.hook(()=>{if(authority==='account')f.store.putConnection(owner,{...f.c,accounts:['another'],writeAccounts:[]},auth);if(authority==='login')f.store.putConnection(owner,f.c,{accessToken:'replacement'});if(authority==='actor')active=false;});
  const p=await f.prepare();assert.equal(p.success,false);assert.equal(f.calls.length,1);assert.equal(f.stats.writes,0);
 }finally{f.store.close();}
});

test('Snapchat failed, partial, mismatched or lost receipts never permit a second update',async()=>{
 for(const mode of ['write_error','foreign_receipt','receipt_parent','empty_receipt','duplicate_receipt','conflicting_receipt','lost']){const f=fixture();try{const p=await f.prepare();f.mode(mode);assert.equal((await f.execute(p)).success,false,mode);await f.execute(p);assert.equal(f.stats.writes,1,mode);assert.notEqual((await f.verify(p)).data?.status,'verified',mode);}finally{f.store.close();}}
});

test('Snapchat update claims and verified results survive restart and concurrent execution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-snap-update-')),f=fixture(join(dir,'state.sqlite'));try{const p=await f.prepare();const results=await Promise.all([f.execute(p),f.execute(p)]);assert.ok(results.some(r=>r.success));assert.equal(f.stats.writes,1);f.restart();assert.equal((await f.execute(p)).data.replayed,true);assert.equal((await f.verify(p)).data.status,'verified');assert.equal(f.stats.writes,1);}finally{f.store.close();removeTestDirectory(dir,'amcp-snap-update-');}
});

test('Snapchat accepted receipts survive an access withdrawal before delivery',async()=>{
 const f=fixture();try{
  const p=await f.prepare();f.hook((_path,method)=>{if(method==='PATCH')f.store.putConnection(owner,{...f.c,writeAccounts:[]},auth);});assert.equal((await f.execute(p)).success,false);
  const saved=f.store.db.prepare('SELECT state FROM idempotency').get()!;assert.equal(saved.state,'complete');assert.equal(f.stats.writes,1);
  f.hook(undefined);f.store.putConnection(owner,f.c,auth);assert.equal((await f.execute(p)).error.code,'RESOURCE_SCOPE_REQUIRED');
  // Re-provisioning invalidates observed resources. Model a new authorized
  // account-scoped discovery before delivering the historical receipt.
  for(const resource of ['campaigns/campaign1','adsquads/squad1'])f.store.rememberResource(f.c,account,resource);
  const replay=await f.execute(p);assert.equal(replay.success,true,JSON.stringify(replay));assert.equal(replay.data.replayed,true);assert.equal(f.stats.writes,1);
 }finally{f.store.close();}
});

test('Snapchat preparation and verification have byte and monotonic transport bounds',async()=>{
 const f=fixture();try{
  const p=compiler.compile(gateway,f.args(),options);await assert.rejects(readSnapUpdateState(p,async()=>({status:200,headers:{},data:{large:'x'.repeat(8*1024*1024)}})),{code:'SNAPCHAT_UPDATE_STATE_UNVERIFIED'});
  let sent=0;const transport=new NativeTransport(async()=>{sent++;throw Error('Expired read reached network');});await assert.rejects(transport.request({...p,method:'GET',path:'/v1/adaccounts/'+account,body:undefined,readOnly:true,snapUpdateDeadline:performance.now()-1},f.c,auth),{code:'SNAPCHAT_UPDATE_STATE_UNVERIFIED'});assert.equal(sent,0);
 }finally{f.store.close();}
});

test('Snapchat malformed current budgets, immutable identities and tracking origins are not valid review evidence',async()=>{
 const cases:[string,string,unknown][]=[['adsquads/squad1','daily_budget_micro','100000000'],['adsquads/squad1','bid_micro',Number.MAX_SAFE_INTEGER+1],['adsquads/squad1','billing_event',undefined],['ads/ad1','creative_id',undefined],['ads/ad1','type',undefined],['ads/ad1','third_party_paid_impression_tracking_urls',[{expandedTrackingUrl:'https://untrusted.example/pixel'}]]];
 for(const [resource,field,v]of cases){const f=fixture();try{f.rows[resource]![field]=v;const r=await f.prepare(f.args('snapchat_ad_patch'));assert.equal(r.success,false,resource+'/'+field);assert.equal(r.error.code,'SNAPCHAT_UPDATE_STATE_UNVERIFIED');assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat reserved and smart-budget modes require their own complete dependency contracts',async()=>{
 for(const field of ['reserved','shared']){const f=fixture();try{f.rows['campaigns/campaign1']!.buy_model=field==='reserved'?'RESERVED':'AUCTION';if(field==='shared')f.rows['campaigns/campaign1']!.pacing_level='CAMPAIGN';const r=await f.prepare();assert.equal(r.success,false,field);assert.equal(r.error.code,'SNAPCHAT_UPDATE_STATE_UNVERIFIED');assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat test-only and unchanged active PUT states do not falsely activate, but a real activation remains forbidden',async()=>{
 for(const kind of ['patch','put']){const f=fixture();try{
  f.rows['ads/ad1']!.status='ACTIVE';saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{allow_activation:false}});
  const payload=kind==='patch'?[{op:'test',path:'/status',value:'ACTIVE'},{op:'replace',path:'/name',value:'Retain delivery'}]:{ads:[{...f.rows['ads/ad1']!,name:'Retain delivery'}]};
  const p=await f.prepare(f.args(kind==='patch'?'snapchat_ad_patch':'snapchat_ad_replace',payload));assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}}
});

test('Snapchat changing original tracking URL conflicts while expanded tracking telemetry does not',async()=>{
 const f=fixture();try{
  f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls=[{tracking_url:'https://approved.example/original',expandedTrackingUrl:'https://tracking.example/1',trackingUrlMetadata:{meter:1}}];
  const p=await f.prepare(f.args('snapchat_ad_patch'));assert.equal(p.success,true,JSON.stringify(p));
  f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls[0].expandedTrackingUrl='https://tracking.example/2';f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls[0].trackingUrlMetadata={meter:2};
  assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');
  f.rows['ads/ad1']!.third_party_paid_impression_tracking_urls[0].tracking_url='https://approved.example/different';const v=await f.verify(p);assert.equal(v.data.status,'inconclusive');assert.ok(v.data.checks[0].changed_fields.some((s:string)=>s.includes('third_party_paid')));
 }finally{f.store.close();}
});

test('Snapchat parent conversion and regulation changes remain in the concurrency guard',async()=>{
 for(const field of ['objective_v2_properties','regulations','mobile_app_properties']){const f=fixture();try{const p=await f.prepare();assert.equal(p.success,true);f.rows['campaigns/campaign1']![field]={changed:'native-setting'};const r=await f.execute(p);assert.equal(r.error?.code,'STATE_CHANGED',field+JSON.stringify(r));assert.ok(r.error.details.changed_fields.some((s:string)=>s.includes(field)));assert.equal(f.stats.writes,0);}finally{f.store.close();}}
});

test('Snapchat documented legacy success and nonfatal warning receipts retain exact results without masking errors',async()=>{
 for(const mode of ['legacy_success','warning']){const f=fixture();try{const p=await f.prepare();f.mode(mode);const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));assert.equal(e.data.success,true);if(mode==='warning')assert.equal(e.data.data.adsquads[0].sub_request_warnings[0].code,'SYNTHETIC_DELIVERY_WARNING');assert.equal((await f.verify(p)).data.status,'verified');assert.equal(f.stats.writes,1);}finally{f.store.close();}}
});

test('Snapchat review expiry, request integrity and changed owner policies are enforced at execution',async()=>{
 for(const mode of ['expired','tampered','policy']){const f=fixture();try{
  const p=await f.prepare(f.args(undefined,[{op:'replace',path:'/daily_budget_micro',value:110000000}]));assert.equal(p.success,true);
  if(mode==='policy')saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:1}});
  else{const doc=f.store.document(actor.tenantId,'write_review',p.data.review_id);if(mode==='expired')doc.expires_at=0;else doc.plan.body[0].value=120000000;f.store.putDocument(actor.tenantId,'write_review',p.data.review_id,doc);}
  const e=await f.execute(p);assert.equal(e.error?.code,mode==='expired'?'REVIEW_EXPIRED':mode==='tampered'?'REVIEW_CHANGED':'POLICY_INCREASE_LIMIT',JSON.stringify(e));assert.equal(f.stats.writes,0);
 }finally{f.store.close();}}
});

test('Snapchat maximum qualified batch preserves each exact child and refuses the next item before reads',async()=>{
 const f=fixture();try{
  const ads=Array.from({length:25},(_,i)=>({...f.rows['ads/ad1']!,id:'ad-'+i,name:'Ad '+i}));for(const ad of ads){f.rows['ads/'+ad.id]=ad;f.store.rememberResource(f.c,account,'ads/'+ad.id);}
  const p=await f.prepare(f.args('snapchat_ad_replace',{ads:ads.map(ad=>({...ad,name:'Reviewed '+ad.name}))}));assert.equal(p.success,true,JSON.stringify(p));assert.equal(f.calls.length,56);assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');assert.equal(f.stats.writes,1);
  const n=f.calls.length;const bad=await f.prepare(f.args('snapchat_ad_replace',{ads:[...ads,{...ads[0],id:'ad-26'}]}));assert.equal(bad.success,false);assert.equal(f.calls.length,n);
 }finally{f.store.close();}
});

test('Snapchat lost accepted update remains uncertain after restart and is never resubmitted',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-snap-update-')),f=fixture(join(dir,'state.sqlite'));try{const p=await f.prepare();f.mode('lost');assert.equal((await f.execute(p)).success,false);f.restart();assert.equal((await f.execute(p)).error.code,'WRITE_OUTCOME_UNCERTAIN');assert.equal(f.stats.writes,1);}finally{f.store.close();removeTestDirectory(dir,'amcp-snap-update-');}
});

for(const authority of ['actor','login','account'])test('Snapchat verification cannot deliver data after in-flight '+authority+' withdrawal',async()=>{
 const f=fixture();try{
  const p=await f.prepare();assert.equal((await f.execute(p)).success,true);let active=true;f.store.bindActorCheck(actor,()=>{if(!active)throw Error('Synthetic inactive actor');});const calls=f.calls.length;
  f.hook(()=>{if(authority==='actor')active=false;if(authority==='login')f.store.putConnection(owner,f.c,{accessToken:'different'});if(authority==='account')f.store.putConnection(owner,{...f.c,accounts:['other'],writeAccounts:[]},auth);});
  const v=await f.verify(p);assert.notEqual(v.data?.status,'verified',JSON.stringify(v));assert.equal(f.calls.length,calls+1);assert.equal(f.stats.writes,1);
 }finally{f.store.close();}
});

test('Snapchat deprecated bid flags and wire-value tests cannot leak into an update',async()=>{
 const f=fixture();try{for(const payload of [[{op:'test',path:'/start_time',value:'2026-01-01T00:00:00Z'}],[{op:'replace',path:'/auto_bid',value:true}],[{op:'replace',path:'/target_bid',value:true}],[{op:'replace',path:'/daily_budget_micro',value:4999999}]]){const p=await f.prepare(f.args(undefined,payload));assert.equal(p.success,false);assert.equal(f.calls.length,0);}
  for(const id of ['constructor','prototype','toString']){const r=await f.prepare(f.args('snapchat_ad_replace',{ads:[{...f.rows['ads/ad1']!,id}]}));assert.equal(r.success,false);assert.equal(f.calls.length,0);}
 }finally{f.store.close();}
});
