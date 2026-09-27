import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn dynamic UTM tracking parameters, Marketing API "Dynamic UTM Tracking" (li-lms-2026-09, checked 2026-09-27):
 * PUT creates (201) or, with the current idempotencyToken, replaces (200; stale token 409) and DELETE removes (204).
 */
const registry=new Registry(),gateway='linkedin_native_action',actor={tenantId:'tracking-test',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const actions={put:'linkedin_rest_ad_tracking_parameters_ad_entity_campaign_campaign_urn_put',putById:'linkedin_rest_ad_tracking_parameters_ad_tracking_parameter_id_put',delete:'linkedin_rest_ad_tracking_parameters_ad_entity_campaign_campaign_urn_delete'};
const campaign=id=>'urn:li:sponsoredCampaign:'+id,key=urn=>'(adEntity:('+urn.split(':')[2]+':'+urn+'))';
const utm={dynamicValueParameters:{utm_campaign:'CAMPAIGN_NAME',utm_campaign_id:'CAMPAIGN_ID',cg_id:'CAMPAIGN_GROUP_ID'},customValueParameters:{utm_source:'linkedin',utm_medium:'paid social'}};
function fixture(o={}){
 const store=new Store(':memory:',Buffer.alloc(32,88).toString('base64'));
 store.putConnection(admin,{id:'li',tenantId:actor.tenantId,gateway,enabled:true,accounts:['507'],writeAccounts:['507'],scopes:o.scopes??['rw_ads'],label:'Synthetic LinkedIn'},{accessToken:'synthetic'});
 const campaigns={123:{id:123,account:'urn:li:sponsoredAccount:507',name:'Spring launch',status:'ACTIVE'},124:{id:124,account:'urn:li:sponsoredAccount:999',name:'Foreign',status:'ACTIVE'},125:{id:125,account:'urn:li:sponsoredAccount:507',name:'Removed',status:'REMOVED'}};
 const params=new Map(Object.entries(o.params??{}));let token=100,writes=0;const calls=[];
 const fetcher=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET',headers=new Headers(init?.headers);calls.push({method,path:url.pathname,raw:String(raw),query:Object.fromEntries(url.searchParams),body:init?.body?JSON.parse(String(init.body)):undefined});
  assert.equal(headers.get('x-restli-protocol-version'),'2.0.0');
  if(url.pathname.startsWith('/rest/adTrackingParameters/')){
   const k=decodeURIComponent(url.pathname.slice('/rest/adTrackingParameters/'.length)),urn=/(urn:li:\w+:\d+)/.exec(k)?.[1];
   if(method==='GET'){const v=params.get(urn);return v?Response.json({...v,adEntity:{[urn.split(':')[2]]:urn},changeTimeStamps:{created:1,lastModified:2}}):Response.json({status:404,serviceErrorCode:100,message:'Not found'},{status:404});}
   writes++;
   if(method==='DELETE'){params.delete(urn);return new Response(null,{status:204});}
   const body=JSON.parse(String(init.body)),current=params.get(urn);
   if(current&&url.searchParams.get('idempotencyToken')!==current.idempotencyToken)return Response.json({status:409,message:'Conflict'},{status:409});
   if(o.mode!=='ignore')params.set(urn,{dynamicValueParameters:body.dynamicValueParameters??{},customValueParameters:body.customValueParameters??{},idempotencyToken:String(++token)});
   return new Response(null,{status:current?200:201});
  }
  if(method==='GET'&&url.pathname==='/rest/adAccounts/507')return Response.json({id:507,status:'ACTIVE',currency:'USD',name:'Synthetic account'});
  const c=/^\/rest\/adAccounts\/507\/adCampaigns\/(\d+)$/.exec(url.pathname);
  if(method==='GET'&&c)return campaigns[c[1]]?Response.json(campaigns[c[1]]):Response.json({status:404,serviceErrorCode:100,message:'Not found'},{status:404});
  throw Error('Unexpected '+method+' '+url.pathname);
 };
 const service=new MirrorService(registry,store,new NativeTransport(fetcher),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const put=(entity,payload,query,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.put,account_id:'507',path_params:{ad_entity_campaign_campaign_urn:key(entity)},payload,...(query?{query}:{}),...extra}},actor);
 const remove=entity=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.delete,account_id:'507',path_params:{ad_entity_campaign_campaign_urn:key(entity)}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,params,put,remove,execute,verify,writes:()=>writes,token:()=>String(token)};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('campaign parameters are created once with the canonical REST.li key and verify; the impact shows the URLs they change',async()=>{
 const f=fixture();try{
  const p=ok(await f.put(campaign(123),utm)),impact=p.data.creative_impact;
  assert.equal(impact.scope,'tracking_parameters');assert.equal(impact.operation,'create');assert.deepEqual(impact.after,{dynamic:utm.dynamicValueParameters,custom:utm.customValueParameters});assert.equal(impact.before.custom&&Object.keys(impact.before.custom).length,0);
  assert.match(impact.effect,/including running ads/);
  ok(await f.execute(p));assert.equal(f.writes(),1);
  const w=f.calls.find(c=>c.method==='PUT');assert.match(w.raw,/\/rest\/adTrackingParameters\/\(adEntity:\(sponsoredCampaign:urn%3Ali%3AsponsoredCampaign%3A123\)\)$/);assert.deepEqual(w.body,utm);
  assert.equal(ok(await f.verify(p)).data.status,'verified');
  assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('existing parameters are replaced only with the idempotencyToken read by the review; a change after review stops execution',async()=>{
 const f=fixture({params:{[campaign(123)]:{dynamicValueParameters:{utm_campaign:'CAMPAIGN_NAME'},customValueParameters:{utm_source:'li'},idempotencyToken:'100'}}});try{
  const none=await f.put(campaign(123),utm);assert.equal(none.error?.code,'CONFIGURATION_EXISTS');assert.equal(none.error.details.idempotency_token,'100');
  const stale=await f.put(campaign(123),utm,{idempotencyToken:'99'});assert.equal(stale.error?.code,'INVALID_LINKEDIN_TRACKING');assert.match(stale.error.message,/409/);
  const same=await f.put(campaign(123),{dynamicValueParameters:{utm_campaign:'CAMPAIGN_NAME'},customValueParameters:{utm_source:'li'}},{idempotencyToken:'100'});assert.equal(same.error?.code,'INVALID_LINKEDIN_TRACKING');assert.match(same.error.message,/already has exactly/);
  const p=ok(await f.put(campaign(123),utm,{idempotencyToken:'100'}));assert.equal(p.data.creative_impact.operation,'replace');
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');
  const q=ok(await f.put(campaign(123),{customValueParameters:{utm_source:'linkedin_ads'}},{idempotencyToken:f.token()}));
  f.params.set(campaign(123),{...f.params.get(campaign(123)),idempotencyToken:'555'});
  // The prerequisite check at execution sees the new token first; LinkedIn would answer 409.
  const changed=await f.execute(q);assert.equal(changed.error?.code,'INVALID_LINKEDIN_TRACKING');assert.match(changed.error.message,/not the token of the current parameters/);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('deletion removes the parameters and verifies their absence; deleting none is refused and owner policy applies',async()=>{
 const f=fixture({params:{[campaign(123)]:{dynamicValueParameters:{utm_campaign:'CAMPAIGN_NAME'},customValueParameters:{},idempotencyToken:'100'}}});try{
  const d=ok(await f.remove(campaign(123)));assert.equal(d.data.creative_impact.operation,'delete');ok(await f.execute(d));assert.equal(ok(await f.verify(d)).data.status,'verified');assert.equal(f.params.has(campaign(123)),false);
  const again=await f.remove(campaign(123));assert.equal(again.error?.code,'STATE_NOT_FOUND');
  f.params.set(campaign(123),{dynamicValueParameters:{utm_campaign:'CAMPAIGN_NAME'},customValueParameters:{},idempotencyToken:'200'});
  saveSpendPolicy(f.store,admin,{gateway,account_id:'507',confirmed:true,policy:{allow_deletion:false}});
  assert.equal((await f.remove(campaign(123))).error?.code,'POLICY_DELETION_FORBIDDEN');assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('malformed tracking parameters are refused before any request',async()=>{
 const cases=[
  ['name with a space',{customValueParameters:{'utm source':'x'}}],
  ['unknown dynamic value',{dynamicValueParameters:{utm_campaign:'CAMPAIGN_TITLE'}}],
  ['creative name before 202606',{dynamicValueParameters:{utm_content:'CREATIVE_NAME'}}],
  ['no parameters',{}],
  ['empty custom value',{customValueParameters:{utm_source:''}}],
  ['control character',{customValueParameters:{utm_source:'a\nb'}}],
  ['names differing only by case',{dynamicValueParameters:{UTM_ID:'CAMPAIGN_ID'},customValueParameters:{utm_id:'x'}}],
  ['another entity in the body',{...utm,adEntity:{sponsoredCampaign:campaign(999)}}],
  ['unqualified field',{...utm,idempotencyToken:'100'}],
  ['51 parameters',{customValueParameters:Object.fromEntries(Array.from({length:51},(_,i)=>['p'+i,'v']))}]
 ];
 for(const [label,payload] of cases){const f=fixture();try{const r=await f.put(campaign(123),payload);assert.equal(r.error?.code,'INVALID_LINKEDIN_TRACKING',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.put(campaign(123),utm,{idempotencyToken:'100',start:'0'})).error?.code,'INVALID_LINKEDIN_TRACKING');
  assert.equal((await f.put('urn:li:sponsoredAccount:507',utm)).error?.code,'INVALID_LINKEDIN_TRACKING');
  assert.equal((await f.put('urn:li:sponsoredAccount:999',utm)).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});

test('foreign and removed campaigns are refused after reading, without writes',async()=>{
 const f=fixture();try{
  const foreign=await f.put(campaign(124),utm);assert.equal(foreign.error?.code,'STATE_TARGET_MISMATCH');assert.match(foreign.error.message,/not a campaign of the selected ad account/);
  const removed=await f.put(campaign(125),utm);assert.equal(removed.error?.code,'INVALID_LINKEDIN_TRACKING');assert.match(removed.error.message,/REMOVED/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('account-level parameters and CREATIVE_NAME work with LinkedIn-Version 202608; reads-only logins cannot write',async()=>{
 const previous=process.env.AMCP_LINKEDIN_API_VERSION;process.env.AMCP_LINKEDIN_API_VERSION='202608';
 const f=fixture();try{
  const p=ok(await f.put('urn:li:sponsoredAccount:507',{dynamicValueParameters:{utm_content:'CREATIVE_NAME',utm_campaign:'CAMPAIGN_NAME'}}));assert.equal(p.data.creative_impact.entity.level,'ad_account');
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();if(previous===undefined)delete process.env.AMCP_LINKEDIN_API_VERSION;else process.env.AMCP_LINKEDIN_API_VERSION=previous;}
 const r=fixture({scopes:['r_ads']});try{assert.equal((await r.put(campaign(123),utm)).error?.code,'INSUFFICIENT_SCOPE');assert.equal(r.writes(),0);}finally{r.store.close();}
});

test('a write LinkedIn ignored is not verified',async()=>{
 const f=fixture({mode:'ignore'});try{const p=ok(await f.put(campaign(123),utm));ok(await f.execute(p));assert.notEqual(ok(await f.verify(p)).data.status,'verified');}finally{f.store.close();}
});

test('the ledger lists the three tracking parameter writes in the reviewed family',()=>{
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&Object.values(actions).includes(r.action));
 assert.equal(rows.length,3);for(const r of rows){assert.equal(r.status,'reviewed_write_family',r.action);assert.equal(r.family,'linkedin_tracking_parameters',r.action);}
});
