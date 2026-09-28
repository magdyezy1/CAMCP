import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {ScopeGuard} from '../src/scope.js';
import type {Connection,JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';

const gateway='criteo_native_action',registry=new Registry(),actor={tenantId:'criteo',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const};
const prefix='/2026-01/retail-media',base=prefix+'/preferred-line-items/789';
const cases=[['audiences','AUDIENCE_TARGETS','audienceIds'],['stores','STORE_TARGET','storeIds'],['add-to-basket','ADD_TO_BASKET_TARGET','productIds']] as const;
const native=(action:string,payload:JsonObject={})=>({operation:'criteo_line_item_ops',arguments:{action,account_id:'123',params:{'line-item-id':'789'},payload}});
async function fixture(kind:string='stores',allowWrites=true,db=':memory:'){
 let store=new Store(db,Buffer.alloc(32,28).toString('base64'));const c:Connection={id:'c',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],label:'Synthetic Criteo',enabled:true,scopes:['RetailMedia_Campaign_Read','RetailMedia_Campaign_Manage']};
 store.putConnection(owner,c,{accessToken:'synthetic'});
 const key=kind==='audiences'?'audienceIds':kind==='stores'?'storeIds':'productIds';
 let targets:JsonObject={scope:'include',[key]:['10','20'],...(kind==='add-to-basket'?{categoryIds:['30']}:{})},writes=0,reads=0;
 const line:JsonObject={id:'789',type:'RetailMediaPreferredLineItem',attributes:{id:'789',campaignId:'456',targetRetailerId:'999',name:'Existing preferred line',budget:100,startDate:'2026-09-19',endDate:'2026-09-30',status:'paused',pacing:'standard'}};
 const campaign:JsonObject={id:'456',type:'RetailMediaCampaign',attributes:{accountId:'123',name:'Campaign',type:'preferred',isAutoDailyPacing:false,budget:1000,status:'inactive'}};
 const calls:JsonObject[]=[];let mutateMode='',readMode='',hook:(path:string,d:JsonObject)=>JsonObject=(_p,d)=>d;
 const page=(row:JsonObject)=>({data:[row],metadata:{currentPageIndex:0,currentPageSize:2,totalItemsAcrossAllPages:1,totalPages:1,nextPage:null}});
 const transport=new NativeTransport(async(input,init)=>{
  const url=new URL(String(input)),path=url.pathname,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,method:init?.method,body,query:[...url.searchParams]});
  if(path.includes('/targeting/')&&init?.method!=='GET'){
   writes++;const a=body.data.attributes;if(mutateMode!=='ignore'){
    if(init?.method==='PUT')targets.scope=a.scope;
    else for(const f of Object.keys(a))targets[f]=path.endsWith('/append')?[...new Set([...(targets[f]??[]),...a[f]])]:targets[f].filter((v:string)=>!a[f].includes(v));
   }
   if(mutateMode==='lost')throw new Error('Synthetic lost response after mutation');
   if(mutateMode==='empty')return new Response('',{status:204});
   return Response.json(mutateMode==='partial'?{data:{attributes:targets},errors:[{code:'partial',detail:'synthetic'}]}:mutateMode==='malformed'?{data:{attributes:{scope:'include'}}}:{data:{attributes:targets}});
  }
  reads++;let data:JsonObject;
  if(path===prefix+'/accounts/123/line-items'){
   assert.deepEqual(url.searchParams.getAll('limitToId'),['789']);data=page({...line,attributes:{...line.attributes,type:'preferred'}});
   if(readMode==='missing')data.data=[];
   if(readMode==='incomplete')data.metadata.nextPage='https://untrusted.example/next';
   if(readMode==='duplicate')data.data.push(data.data[0]);
  }else if(path===prefix+'/accounts/123/campaigns')data=page(campaign);
  else if(path===base)data={data:line};
  else if(path===base+'/targeting/'+kind)data={data:{attributes:structuredClone(targets)}};
  else if(path===prefix+'/accounts/123/audiences/search'){
   assert.equal(init?.method,'POST');assert.deepEqual(body.data.attributes.retailerIds,['999']);
   data={data:body.data.attributes.audienceIds.map((id:string)=>({id,type:'RetailMediaAudience',attributes:{accountId:'123',retailerId:'999',name:'Audience '+id,algebra:{audienceSegmentId:'segment'+id},channels:['Onsite']}})),meta:{offset:0,limit:500,totalItems:body.data.attributes.audienceIds.length}};
   if(readMode==='audience')data.data[0].attributes.accountId='other';
  }else throw Error('Unexpected path '+path);
  if(readMode==='error')data={errors:[{code:'provider-error'}]};
  if(readMode==='revoke')store.putConnection(owner,{...c,writeAccounts:[]},{accessToken:'synthetic'});
  if(readMode==='read-revoke')store.putConnection(owner,{...c,scopes:[]},{accessToken:'synthetic'});
  return Response.json(hook(path,structuredClone(data)));
 },async()=>{},30000,8*1024*1024,10000);
 const build=()=>new MirrorService(registry,store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});let service=build();
 const discovery=await service.call(gateway,{operation:'criteo_line_item_ops',arguments:{action:'GET_LINE_ITEMS_BY_ACCOUNT_ID',account_id:'123',params:{limitToId:['789'],limitToType:'Preferred',pageIndex:0,pageSize:2}}},actor);
 assert.equal(discovery.success,true,JSON.stringify(discovery));assert.equal(store.ownsResource(c,'123','preferred-line-items/789'),true);calls.length=0;reads=0;
 const prepare=(action:string,attributes:JsonObject)=>service.call('amcp_write',{action:'prepare',gateway,arguments:native(action,{data:{attributes}})},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {get store(){return store;},get service(){return service;},c,prepare,execute,verify,calls,line,campaign,targets:()=>targets,writes:()=>writes,reads:()=>reads,mode:(m:string)=>{mutateMode=m;},readMode:(m:string)=>{readMode=m;},hook:(fn:typeof hook)=>{hook=fn;},key,restart:()=>{store.close();store=new Store(db,Buffer.alloc(32,28).toString('base64'));service=build();}};
}
for(const [kind,stem,key]of cases)for(const operation of ['PUT','APPEND','DELETE'])test('reviewed Criteo '+kind+' '+operation+' executes once and verifies complete target state',async()=>{
 const f=await fixture(kind);try{
  const suffix=operation==='APPEND'&&kind!=='audiences'?stem+'S':operation==='DELETE'&&kind==='add-to-basket'?stem+'S':stem,action=operation+'_'+suffix+'_BY_LINE_ITEM_ID';
  const a=operation==='PUT'?{...f.targets(),scope:'exclude'}:{[key]:operation==='APPEND'?['40']:['10']};
  const p=await f.prepare(action,a);assert.equal(p.success,true,JSON.stringify(p));assert.equal(f.writes(),0);
  const r=await f.execute(p);assert.equal(r.success,true,JSON.stringify(r));assert.equal(f.writes(),1);
  const v=await f.verify(p);assert.equal(v.data.status,'verified',JSON.stringify(v));
  assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});
test('Criteo account membership, response completeness and referenced audience ownership fail closed',async()=>{
 for(const mode of ['missing','incomplete','duplicate','error','revoke','audience']){const f=await fixture(mode==='audience'?'audiences':'stores');try{
  f.readMode(mode);const p=await f.prepare(mode==='audience'?'APPEND_AUDIENCE_TARGETS_BY_LINE_ITEM_ID':'APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{[f.key]:['40']});assert.equal(p.success,false,mode);assert.equal(f.writes(),0);assert.ok(f.calls.every(c=>!c.path.includes('untrusted')));
 }finally{f.store.close();}}
 for(const change of ['campaign','retailer','kind']){const f=await fixture();try{
  if(change==='campaign')f.campaign.attributes.accountId='other';if(change==='retailer')f.hook((p,d)=>{if(p===base)d.data.attributes.targetRetailerId='other';return d;});if(change==='kind')f.campaign.attributes.type='auction';
  assert.equal((await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']})).success,false);assert.equal(f.writes(),0);
 }finally{f.store.close();}}
});
test('unordered native members and budget telemetry do not conflict, but targeting or budget edits do',async()=>{
 for(const change of ['telemetry','order','target','budget','scope','name']){const f=await fixture();try{
  const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});assert.equal(p.success,true,JSON.stringify(p));
  if(change==='telemetry'){f.line.attributes.budgetSpent=3;f.line.attributes.budgetRemaining=97;f.line.attributes.updatedAt='2026-09-19T12:00:00Z';f.hook((_p,d)=>({...d,futureEnvelopeTelemetry:Math.random(),traceId:'new-trace'}));}
  if(change==='order')f.targets().storeIds.reverse();if(change==='target')f.targets().storeIds.push('50');if(change==='budget')f.line.attributes.budget=101;if(change==='scope')f.targets().scope='exclude';if(change==='name')f.line.attributes.name='Renamed';
  const r=await f.execute(p);if(['telemetry','order'].includes(change))assert.equal(r.success,true,JSON.stringify(r));else{assert.equal(r.error.code,'STATE_CHANGED');assert.ok(r.error.details.changed_fields.length);assert.equal(f.writes(),0);}
 }finally{f.store.close();}}
});
test('Criteo scope changes do not silently replace members; malformed and cross-account writes never dispatch',async()=>{
 const f=await fixture();try{
  const p=await f.prepare('PUT_STORE_TARGET_BY_LINE_ITEM_ID',{scope:'exclude',storeIds:['40']});assert.equal(p.error.code,'TARGET_MEMBERSHIP_UPDATE_REQUIRED');
  for(const attrs of [{storeIds:['10','10']},{storeIds:[10]},{storeIds:[]},{storeIds:['40'],scope:'include'},{storeIds:['40'],budget:1000},{storeIds:Array.from({length:101},(_,i)=>String(i))}])assert.equal((await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',attrs)).success,false);
  const n=native('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{data:{attributes:{storeIds:['40']}}});n.arguments.account_id='999';assert.equal((await f.service.call('amcp_write',{action:'prepare',gateway,arguments:n},actor)).success,false);assert.equal(f.writes(),0);
 }finally{f.store.close();}
});
test('Criteo targeting obeys changed owner policies, grants, scopes, read-only deployment and explicit spend acknowledgement',async()=>{
 for(const control of ['activation','deletion','grant','scope','confirmation','deployment']){const f=await fixture('stores',control!=='deployment');try{
  const p=await f.prepare('DELETE_STORE_TARGET_BY_LINE_ITEM_ID',{storeIds:['10']});if(control==='deployment'){assert.equal(p.success,false);continue;}assert.equal(p.success,true,JSON.stringify(p));
  if(control==='activation'||control==='deletion')saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{[control==='activation'?'allow_activation':'allow_deletion']:false}});
  if(control==='grant'||control==='scope')f.store.putConnection(owner,{...f.c,...(control==='grant'?{writeAccounts:[]}:{scopes:[]})},{accessToken:'synthetic'});
  assert.equal((await f.execute(p,control==='confirmation'?{spend_change_confirmed:false}:{})).success,false,control);assert.equal(f.writes(),0);
 }finally{f.store.close();}}
});
test('Criteo partial, malformed, empty and lost mutation responses are never automatically resubmitted',async()=>{
 for(const mode of ['partial','malformed','empty','lost']){const f=await fixture();try{const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});assert.equal(p.success,true,JSON.stringify(p));f.mode(mode);assert.equal((await f.execute(p)).success,false,mode);await f.execute(p);assert.equal(f.writes(),1);assert.notEqual((await f.verify(p)).data?.status,'verified');}finally{f.store.close();}}
});
test('Criteo lost field updates are inconclusive after bounded read-back, not permission to retry',async()=>{
 const f=await fixture();try{const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});f.mode('ignore');assert.equal((await f.execute(p)).success,true);const v=await f.verify(p);assert.equal(v.data.status,'inconclusive',JSON.stringify(v));assert.ok(v.data.checks.some((c:JsonObject)=>c.changed_fields.includes('/target/store_ids')));assert.equal(f.writes(),1);}finally{f.store.close();}
});
test('concurrent Criteo execution dispatches only one mutation; read grant revocation blocks verification',async()=>{
 const f=await fixture();try{const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});const results=await Promise.all([f.execute(p),f.execute(p)]);assert.ok(results.some(r=>r.success));assert.equal(f.writes(),1);f.readMode('read-revoke');const v=await f.verify(p);assert.notEqual(v.data?.status,'verified');assert.equal(f.writes(),1);}finally{f.store.close();}
});
test('guessed Criteo global IDs and caller-injected internal read authority do not grant account ownership',async()=>{
 const f=await fixture();try{
  assert.throws(()=>new ScopeGuard(registry,f.store).authorize({gateway,action:'native',path:base.replace('789','987'),method:'GET',query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,accountId:'123',evidence:'synthetic',warnings:[]},f.c),/ownership/i);
  const n=native('GET_STORE_TARGETS_BY_LINE_ITEM_ID');Object.assign(n.arguments,{scopeContext:{criteoVerifiedLineId:'987'},criteoTargetState:{lineId:'987'}});const calls=f.calls.length;assert.equal((await f.service.call(gateway,n,actor)).success,false);assert.equal(f.calls.length,calls);
 }finally{f.store.close();}
});
test('Criteo completed and uncertain claims survive reopening SQLite and services',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-criteo-restart-'));
 try{for(const mode of ['complete','lost']){const f=await fixture('stores',true,path.join(temp,mode+'.sqlite'));try{
  const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});if(mode==='lost')f.mode('lost');await f.execute(p);f.restart();const r=await f.execute(p);assert.equal(f.writes(),1);
  if(mode==='complete'){assert.equal(r.data.replayed,true);assert.equal((await f.verify(p)).data.status,'verified');}else assert.equal(r.error.code,'WRITE_OUTCOME_UNCERTAIN');
 }finally{f.store.close();}}}finally{removeTestDirectory(temp,'amcp-criteo-restart-');}
});
test('successful Criteo verification cache cannot outlive a revoked recorded read scope',async()=>{
 const f=await fixture();try{const p=await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['40']});await f.execute(p);assert.equal((await f.verify(p)).data.status,'verified');f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});const n=f.reads();assert.equal((await f.verify(p)).success,false);assert.equal(f.reads(),n);}finally{f.store.close();}
});
test('Criteo native execution cannot bypass review with before_state or skip_preflight',async()=>{
 const f=await fixture();try{const n=native('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{data:{attributes:{storeIds:['40']}}});for(const extra of [{dry_run:false,confirmed:true},{dry_run:false,skip_preflight:true,before_state:{}}]){Object.assign(n.arguments,extra);assert.equal((await f.service.call(gateway,n,actor)).success,false);assert.equal(f.writes(),0);}}finally{f.store.close();}
});
test('Criteo unknown scope, unsupported target counts and nonempty warnings cannot be submitted',async()=>{
 for(const mode of ['scope','limit','warning','shape','size','metadata']){const f=await fixture();try{
  if(mode==='scope')f.targets().scope='unknown';if(mode==='limit')f.targets().storeIds=Array.from({length:1000},(_,i)=>'store-'+i);
  f.hook((p,d)=>{if(mode==='warning')d.warnings=[{code:'partial'}];if(mode==='shape'&&p.includes('/targeting/'))delete d.data.attributes.storeIds;if(mode==='size')d.extra='x'.repeat(4*1024*1024);if(mode==='metadata'&&d.metadata)d.metadata.totalItemsAcrossAllPages=2;return d;});
  assert.equal((await f.prepare('APPEND_STORE_TARGETS_BY_LINE_ITEM_ID',{storeIds:['new']})).success,false,mode);assert.equal(f.writes(),0);
 }finally{f.store.close();}}
});
