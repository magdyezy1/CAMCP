import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {JsonObject} from '../src/types.js';
const registry=new Registry(),actor={tenantId:'targeting',userId:'u',role:'operator' as const},admin={...actor,role:'admin' as const},gateway='google_ads_native_action',policy={allowWrites:true,maxBudgetChange:0,requireBeforeState:true};
const actions:Record<string,string>={campaignCriteria:'google_ads_v23_campaign_criterion_mutate_campaign_criteria',adGroupCriteria:'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',sharedSets:'google_ads_v23_shared_set_mutate_shared_sets',sharedCriteria:'google_ads_v23_shared_criterion_mutate_shared_criteria',campaignSharedSets:'google_ads_v23_campaign_shared_set_mutate_campaign_shared_sets'};
const name=(kind:string,id='100')=>'customers/123/'+kind+'/'+id;
function setup(){
 const store=new Store(':memory:',Buffer.alloc(32,72).toString('base64'));store.putConnection(admin,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:[]},{accessToken:'synthetic',developerToken:'synthetic'});
 let writes=0,reads=0,changed=false;const calls:JsonObject[]=[];
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const body=JSON.parse(String(init?.body)),path=new URL(String(url)).pathname;calls.push({path,body});
  if(path.endsWith('googleAds:search')){reads++;const entity=body.query.match(/ FROM ([a-z_]+)/)[1],key=entity.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase());
   return Response.json({results:entity==='customer'?[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC'}}]:[...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m=>({[key]:{resourceName:m[1],status:entity==='shared_set'?'ENABLED':changed?'ENABLED':'PAUSED',...(entity==='shared_set'?{type:m[1].endsWith('/101')?'NEGATIVE_PLACEMENTS':'NEGATIVE_KEYWORDS'}:{}),name:changed?'Changed':'Existing',...(entity==='ad_group_criterion'?{cpcBidMicros:changed?'2000':'1000',keyword:{text:'example',matchType:'EXACT'},type:'KEYWORD'}:{})}}))});
  }
  writes++;const kind=path.match(/\/([^/]+):mutate$/)![1];return Response.json({results:body.operations.map((o:JsonObject)=>({resourceName:o.remove??o.update?.resourceName??name(kind!,kind==='sharedSets'?'100':'100~200')}))});
 }),undefined,policy);
 return {store,service,calls,writes:()=>writes,reads:()=>reads,change:()=>{changed=true;},prepare:(kind:string,operations:JsonObject[])=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions[kind],account_id:'123',payload:{operations}}},actor)};
}
const creations:[string,JsonObject][]=[
 ['adGroupCriteria',{adGroup:name('adGroups'),status:'PAUSED',keyword:{text:'example',matchType:'EXACT'},cpcBidMicros:'1250000'}],
 ['adGroupCriteria',{adGroup:name('adGroups'),negative:true,keyword:{text:'free',matchType:'BROAD'}}],
 ['campaignCriteria',{campaign:name('campaigns'),negative:true,keyword:{text:'free',matchType:'PHRASE'}}],
 ['campaignCriteria',{campaign:name('campaigns'),location:{geoTargetConstant:'geoTargetConstants/1023191'}}],
 ['campaignCriteria',{campaign:name('campaigns'),language:{languageConstant:'languageConstants/1000'}}],
 ['campaignCriteria',{campaign:name('campaigns'),adSchedule:{dayOfWeek:'MONDAY',startHour:9,startMinute:'ZERO',endHour:17,endMinute:'THIRTY'}}],
 ['adGroupCriteria',{adGroup:name('adGroups'),status:'PAUSED',userList:{userList:name('userLists')}}],
 ['adGroupCriteria',{adGroup:name('adGroups'),status:'PAUSED',audience:{audience:name('audiences')}}],
 ['sharedSets',{name:'Negative keywords',type:'NEGATIVE_KEYWORDS'}],
 ['sharedCriteria',{sharedSet:name('sharedSets'),keyword:{text:'free',matchType:'BROAD'}}],
 ['sharedCriteria',{sharedSet:name('sharedSets','101'),placement:{url:'example.com'}}],
 ['campaignSharedSets',{campaign:name('campaigns'),sharedSet:name('sharedSets')}]
];
for(const [index,[kind,record]]of creations.entries())test('Google reviewed targeting create '+index+' '+kind,async()=>{
 const x=setup();try{
  const p=await x.prepare(kind,[{create:record}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal(x.writes(),0);assert.ok(x.reads()>0);
  const args={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true};assert.equal((await x.service.call('amcp_write',args,actor)).error.code,'SPEND_CONFIRMATION_REQUIRED');
  const result=await x.service.call('amcp_write',{...args,spend_change_confirmed:true},actor);assert.equal(result.success,true,JSON.stringify(result));assert.equal(x.writes(),1);
  assert.equal((await x.service.call('amcp_write',{...args,spend_change_confirmed:true},actor)).data.replayed,true);assert.equal(x.writes(),1);
 }finally{x.store.close();}
});
test('Google targeting updates and deletes protect mutable configuration and exact targets',async()=>{
 const x=setup();try{
  const op={update:{resource_name:name('adGroupCriteria','100~200'),cpc_bid_micros:'3000'},update_mask:'cpc_bid_micros'};
  const p=await x.prepare('adGroupCriteria',[op]);assert.equal(p.success,true,JSON.stringify(p));assert.ok(x.calls[0]!.body.query.includes('ad_group_criterion.cpc_bid_micros'));
  x.change();const stale=await x.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);assert.equal(stale.error.code,'STATE_CHANGED');assert.ok(JSON.stringify(stale.error.details.changed_fields).includes('cpcBidMicros'));assert.equal(x.writes(),0);
  for(const kind of Object.keys(actions)){const d=await x.prepare(kind,[{remove:name(kind,kind==='sharedSets'?'100':'100~200')}]);assert.equal(d.success,true,JSON.stringify(d));const e=await x.service.call('amcp_write',{action:'execute',review_id:d.data.review_id,idempotency_key:d.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);assert.equal(e.success,true,JSON.stringify(e));}
 }finally{x.store.close();}
});
test('Google targeting rejects invalid identities, cross-account parents, unsafe status and immutable masks before any read',async()=>{
 const x=setup();try{
  const cases:[string,JsonObject][]=[
   ['campaignCriteria',{create:{campaign:name('campaigns'),keyword:{text:'positive',matchType:'EXACT'}}}],
   ['adGroupCriteria',{create:{adGroup:name('adGroups'),status:'ENABLED',keyword:{text:'x',matchType:'EXACT'}}}],
   ['adGroupCriteria',{create:{adGroup:'customers/999/adGroups/100',status:'PAUSED',keyword:{text:'x',matchType:'EXACT'}}}],
   ['campaignCriteria',{create:{campaign:name('campaigns'),location:{geoTargetConstant:'geoTargetConstants/1'},device:{type:'MOBILE'}}}],
   ['campaignCriteria',{update:{resourceName:name('campaignCriteria','100~200'),negative:true},updateMask:'negative'}],
   ['sharedCriteria',{update:{resourceName:name('sharedCriteria','100~200'),keyword:{text:'x',matchType:'EXACT'}},updateMask:'keyword.text'}],
   ['sharedSets',{create:{name:'Invalid',type:'ARBITRARY'}}],
   ['sharedSets',{remove:name('sharedSets','100~200')}],
   ['adGroupCriteria',{remove:name('adGroupCriteria','100')}],
   ['campaignCriteria',{create:{campaign:name('campaigns'),device:{}}}],
   ['adGroupCriteria',{update:{resourceName:name('adGroupCriteria','100~200'),cpcBidMicros:123},updateMask:'cpcBidMicros'}]
  ];for(const [kind,op]of cases)assert.equal((await x.prepare(kind,[op])).success,false,JSON.stringify(op));assert.equal(x.reads(),0);assert.equal(x.writes(),0);
 }finally{x.store.close();}
});
test('Google shared placement members cannot be placed in a keyword list',async()=>{
 const x=setup();try{const p=await x.prepare('sharedCriteria',[{create:{sharedSet:name('sharedSets'),placement:{url:'example.com'}}}]);assert.equal(p.error.code,'INVALID_TARGETING_PARENT');assert.equal(x.writes(),0);}finally{x.store.close();}
});
