import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {reviewedWriteFamily} from '../src/reviewed-routes.js';
import type {CompiledRequest,JsonObject} from '../src/types.js';

/**
 * DV360 advertiser targeting (Display & Video 360 API v4, checked 2026-09-26): edit, create and delete of the five
 * advertiser targeting types, which every line item of the advertiser inherits.
 */
const gateway='dv360_native_action',registry=new Registry(),actor={tenantId:'dv360-advertiser-targeting',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const};
const editAction='DV360_ADVERTISERS_EDIT_ASSIGNED_TARGETING_OPTIONS',oneAction='DV360_ADVERTISERS_TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_';
/** TARGETING_TYPE_KEYWORD → keywordDetails, as the provider names the union member. */
const detailsField=(type:string)=>type.slice(15).toLowerCase().replace(/_([a-z])/g,(_m,c:string)=>c.toUpperCase())+'Details';
const keyword=(k:string,negative:boolean|null=true)=>({keywordDetails:{keyword:k,...(negative===null?{}:{negative})}});
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,83).toString('base64')),calls:JsonObject[]=[];
 const connection={id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},credentials={accessToken:'synthetic'};
 store.putConnection(owner,connection,credentials);
 const advertiser:JsonObject={name:'advertisers/123',advertiserId:'123',partnerId:'1',displayName:'Synthetic advertiser',entityStatus:'ENTITY_STATUS_ACTIVE'};
 const channels=new Set(['700','702']);let next=900,writes=0,perPage=2,foreign=false,cycle=false,dropCreated=false;
 const option=(type:string,details:JsonObject,extra:JsonObject={}):JsonObject=>{const id=String(extra.assignedTargetingOptionId??next++);return {name:'advertisers/123/targetingTypes/'+type+'/assignedTargetingOptions/'+id,assignedTargetingOptionId:id,targetingType:type,inheritance:'NOT_INHERITED',[detailsField(type)]:details,...extra};};
 let targeting:JsonObject[]=[
  option('TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION',{excludedSensitiveCategory:'SENSITIVE_CATEGORY_EMBEDDED_VIDEO'},{assignedTargetingOptionId:'1',inheritance:'INHERITED_FROM_PARTNER'}),
  option('TARGETING_TYPE_KEYWORD',{keyword:'free',negative:true},{assignedTargetingOptionId:'201'}),
  option('TARGETING_TYPE_CHANNEL',{channelId:'700',negative:true},{assignedTargetingOptionId:'700'}),
  option('TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION',{excludedContentRatingTier:'CONTENT_RATING_TIER_UNRATED'},{assignedTargetingOptionId:'19',assignedTargetingOptionIdAlias:'CONTENT_RATING_TIER_UNRATED'})
 ];
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init!.method!,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,query:u.search,body});
  const one=/^\/v4\/advertisers\/123\/targetingTypes\/([A-Z_]+)\/assignedTargetingOptions(?:\/([^/]+))?$/.exec(path);
  if(method==='GET'){
   if(path==='/v4/advertisers/123')return Response.json({...advertiser,updateTime:new Date().toISOString()});
   if(path==='/v4/advertisers/123:listAssignedTargetingOptions'){
    const filter=String(u.searchParams.get('filter'));assert.ok(filter.length<=500);assert.equal(u.searchParams.get('lineItemIds'),null);
    const types=[...filter.matchAll(/targetingType="([A-Z_]+)"/g)].map(m=>m[1]!),rows=targeting.filter(o=>types.includes(o.targetingType)).map(o=>foreign?{...o,name:String(o.name).replace('advertisers/123/','advertisers/999/')}:o);
    const offset=Number(u.searchParams.get('pageToken')??0),page=rows.slice(offset,offset+perPage);
    return Response.json({...(page.length?{assignedTargetingOptions:page}:{}),...(cycle||offset+perPage<rows.length?{nextPageToken:cycle?'0':String(offset+perPage)}:{})});
   }
   const channel=/^\/v4\/advertisers\/123\/channels\/(\d+)$/.exec(path)?.[1];
   if(channel&&channels.has(channel))return Response.json({name:'advertisers/123/channels/'+channel,channelId:channel,advertiserId:'123',displayName:'Blocked sites '+channel});
   return Response.json({error:{code:404,message:'Not found'}},{status:404});
  }
  writes++;
  if(one&&method==='POST'){const o=option(one[1]!,body[detailsField(one[1]!)]);targeting.push(o);return Response.json(o);}
  if(one&&method==='DELETE'){const id=decodeURIComponent(one[2]!);targeting=targeting.filter(o=>!(o.targetingType===one[1]&&(o.assignedTargetingOptionId===id||o.assignedTargetingOptionIdAlias===id)));return Response.json({});}
  assert.equal(path,'/v4/advertisers/123:editAssignedTargetingOptions');
  for(const d of body.deleteRequests??[])targeting=targeting.filter(o=>!(o.targetingType===d.targetingType&&d.assignedTargetingOptionIds.some((id:string)=>o.assignedTargetingOptionId===id||o.assignedTargetingOptionIdAlias===id)));
  const created=(body.createRequests??[]).flatMap((c:JsonObject)=>c.assignedTargetingOptions.map((a:JsonObject)=>option(c.targetingType,a[detailsField(c.targetingType)])));
  targeting.push(...created);
  const shown=dropCreated?created.slice(1):created;
  return Response.json(shown.length?{createdAssignedTargetingOptions:shown}:{});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const edit=(payload:JsonObject)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:editAction,params:{advertiserId:'123'},body:payload}},actor);
 const create=(type:string,payload:JsonObject)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:oneAction+'CREATE',params:{advertiserId:'123',targetingType:type},body:payload}},actor);
 const remove=(type:string,id:string)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:oneAction+'DELETE',params:{advertiserId:'123',targetingType:type,assignedTargetingOptionId:id}}},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 const keys=()=>targeting.map(o=>o.targetingType+':'+o.assignedTargetingOptionId).sort();
 return {store,calls,advertiser,edit,create,remove,execute,verify,keys,writes:()=>writes,foreign:()=>{foreign=true;},cycle:()=>{cycle=true;},dropCreated:()=>{dropCreated=true;},add:(o:JsonObject)=>{targeting.push(o);},option,perPage:(n:number)=>{perPage=n;}};
}
const brandSafety=()=>({
 deleteRequests:[{targetingType:'TARGETING_TYPE_KEYWORD',assignedTargetingOptionIds:['201']},{targetingType:'TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION',assignedTargetingOptionIds:['CONTENT_RATING_TIER_UNRATED']}],
 createRequests:[{targetingType:'TARGETING_TYPE_KEYWORD',assignedTargetingOptions:[keyword('casino'),keyword('gambling')]},
  {targetingType:'TARGETING_TYPE_CHANNEL',assignedTargetingOptions:[{channelDetails:{channelId:'702',negative:true}}]},
  {targetingType:'TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION',assignedTargetingOptions:[{sensitiveCategoryExclusionDetails:{excludedSensitiveCategory:'SENSITIVE_CATEGORY_LIVE_STREAMING_VIDEO'}}]},
  {targetingType:'TARGETING_TYPE_OMID',assignedTargetingOptions:[{omidDetails:{omid:'OMID_FOR_MOBILE_DISPLAY_ADS'}}]}]});

test('an advertiser edit reads the advertiser, every page of its targeting of the edited types and the assigned channel, then writes once and verifies',async()=>{
 const f=fixture();try{
  const p=await f.edit(brandSafety());assert.equal(p.success,true,JSON.stringify(p).slice(0,800));
  const reads=f.calls.map(c=>c.method+' '+c.path);
  assert.ok(reads.includes('GET /v4/advertisers/123')&&reads.includes('GET /v4/advertisers/123/channels/702'));
  assert.equal(f.calls.filter(c=>String(c.path).endsWith(':listAssignedTargetingOptions')).length,2,'both pages of the four existing options of these types are read');
  const impact=p.data.creative_impact;assert.equal(impact.scope,'advertiser_targeting');assert.equal(impact.may_affect_serving,true);assert.equal(impact.advertiser.advertiser_id,'123');assert.match(impact.effect,/Every line item of this advertiser inherits/);
  assert.equal((await f.execute(p,{spend_change_confirmed:false})).error.code,'SPEND_CONFIRMATION_REQUIRED');
  const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e).slice(0,800));assert.equal(f.writes(),1);
  assert.ok(!f.keys().includes('TARGETING_TYPE_KEYWORD:201')&&!f.keys().some(k=>k.startsWith('TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION')));
  const v=await f.verify(p);assert.equal(v.data.status,'verified',JSON.stringify(v).slice(0,800));
  assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('single create and delete routes change one advertiser option and verify',async()=>{
 const f=fixture();try{
  const c=await f.create('TARGETING_TYPE_KEYWORD',keyword('lottery'));assert.equal(c.success,true,JSON.stringify(c).slice(0,600));
  assert.equal((await f.execute(c)).success,true);assert.equal((await f.verify(c)).data.status,'verified');
  const d=await f.remove('TARGETING_TYPE_CHANNEL','700');assert.equal(d.success,true,JSON.stringify(d).slice(0,600));
  assert.equal((await f.execute(d)).success,true);assert.equal((await f.verify(d)).data.status,'verified');
  assert.ok(!f.keys().includes('TARGETING_TYPE_CHANNEL:700'));assert.equal(f.writes(),2);
 }finally{f.store.close();}
});

test('partner-inherited, absent and duplicate assignments, partner channels and a deleted advertiser are refused before any write',async()=>{
 const f=fixture();try{
  const cases:[string,()=>Promise<JsonObject>,string,RegExp][]=[
   ['partner exclusion',()=>f.remove('TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION','1'),'INVALID_DV360_TARGETING',/INHERITED_FROM_PARTNER/],
   ['absent keyword',()=>f.remove('TARGETING_TYPE_KEYWORD','999'),'STATE_NOT_FOUND',/Advertiser 123 has no TARGETING_TYPE_KEYWORD assignment 999/],
   ['duplicate keyword',()=>f.create('TARGETING_TYPE_KEYWORD',keyword('free')),'CONFIGURATION_EXISTS',/Advertiser 123 already has/],
   ['partner-inherited duplicate',()=>f.create('TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION',{sensitiveCategoryExclusionDetails:{excludedSensitiveCategory:'SENSITIVE_CATEGORY_EMBEDDED_VIDEO'}}),'CONFIGURATION_EXISTS',/INHERITED_FROM_PARTNER/],
   ['partner channel',()=>f.create('TARGETING_TYPE_CHANNEL',{channelDetails:{channelId:'701',negative:true}}),'STATE_TARGET_MISMATCH',/not owned by the selected advertiser/]
  ];
  for(const [label,run,code,message] of cases){const r=await run();assert.equal(r.error?.code,code,label+': '+JSON.stringify(r.error).slice(0,300));assert.match(r.error.message,message,label);}
  f.advertiser.entityStatus='ENTITY_STATUS_SCHEDULED_FOR_DELETION';
  const r=await f.create('TARGETING_TYPE_KEYWORD',keyword('lottery'));assert.equal(r.error?.code,'INVALID_DV360_TARGETING');assert.match(r.error.message,/SCHEDULED_FOR_DELETION/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('positive advertiser exclusions, line item types, line item fields and empty edits fail locally without network requests',async()=>{
 for(const [label,payload,code] of [
  ['keyword without negative',{createRequests:[{targetingType:'TARGETING_TYPE_KEYWORD',assignedTargetingOptions:[keyword('shoes',null)]}]},'INVALID_DV360_TARGETING'],
  ['positive keyword',{createRequests:[{targetingType:'TARGETING_TYPE_KEYWORD',assignedTargetingOptions:[keyword('shoes',false)]}]},'INVALID_DV360_TARGETING'],
  ['positive channel',{createRequests:[{targetingType:'TARGETING_TYPE_CHANNEL',assignedTargetingOptions:[{channelDetails:{channelId:'702'}}]}]},'INVALID_DV360_TARGETING'],
  ['region at advertiser level',{createRequests:[{targetingType:'TARGETING_TYPE_GEO_REGION',assignedTargetingOptions:[{geoRegionDetails:{targetingOptionId:'2840'}}]}]},'INVALID_DV360_TARGETING'],
  ['viewability deletion',{deleteRequests:[{targetingType:'TARGETING_TYPE_VIEWABILITY',assignedTargetingOptionIds:['1']}]},'INVALID_DV360_TARGETING'],
  ['line item IDs',{lineItemIds:['456'],createRequests:[{targetingType:'TARGETING_TYPE_KEYWORD',assignedTargetingOptions:[keyword('casino')]}]},'INVALID_VENDOR_BODY'],
  ['empty edit',{},'INVALID_DV360_TARGETING']
 ] as [string,JsonObject,string][]){
  const f=fixture();try{const r=await f.edit(payload);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}
 }
});

test('a receipt that omits a created option is kept as a failure, never resubmitted and never verified as success',async()=>{
 const f=fixture();try{
  const p=await f.edit(brandSafety());assert.equal(p.success,true);f.dropCreated();
  const e=await f.execute(p);assert.equal(e.success,false,JSON.stringify(e).slice(0,600));
  assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  assert.equal((await f.verify(p)).error?.code,'WRITE_PARTIAL_OR_FAILED');
 }finally{f.store.close();}
});

test('owner policies: advertiser targeting counts as serving for activation and its removals as deletions',async()=>{
 const f=fixture();try{
  f.advertiser.entityStatus='ENTITY_STATUS_PAUSED';
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:true,allow_activation:false}});
  assert.equal((await f.create('TARGETING_TYPE_KEYWORD',keyword('lottery'))).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:false,allow_activation:true}});
  assert.equal((await f.remove('TARGETING_TYPE_KEYWORD','201')).error?.code,'POLICY_DELETION_FORBIDDEN');
  assert.equal((await f.create('TARGETING_TYPE_KEYWORD',keyword('lottery'))).success,true);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('foreign rows and repeated page tokens never become complete advertiser targeting, and later changes stop execution',async()=>{
 for(const mode of ['foreign','cycle']){const f=fixture();try{if(mode==='foreign')f.foreign();else f.cycle();const r=await f.edit(brandSafety());assert.equal(r.success,false,mode);assert.match(String(r.error?.code),mode==='foreign'?/STATE_TARGET_MISMATCH/:/INCOMPLETE_STATE/);assert.equal(f.writes(),0);}finally{f.store.close();}}
 const f=fixture();try{
  const p=await f.edit(brandSafety());assert.equal(p.success,true);
  f.add(f.option('TARGETING_TYPE_KEYWORD',{keyword:'poker',negative:true}));
  assert.equal((await f.execute(p)).error?.code,'STATE_CHANGED');assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('the pinned v4 Discovery document documents the advertiser methods and types, and the routes form their own reviewed family',async()=>{
 const spec=JSON.parse(fs.readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')).document,adv=spec.resources.advertisers;
 assert.equal(adv.methods.editAssignedTargetingOptions.httpMethod,'POST');assert.equal(adv.methods.listAssignedTargetingOptions.httpMethod,'GET');
 const ato=adv.resources.targetingTypes.resources.assignedTargetingOptions.methods;assert.equal(ato.create.httpMethod,'POST');assert.equal(ato.delete.httpMethod,'DELETE');
 const {dv360AdvertiserTargetingTypes,dv360TargetingTypes}=await import('../src/dv360-line-item-targeting.js');
 const listed=String(spec.schemas.BulkEditAdvertiserAssignedTargetingOptionsRequest.properties.createRequests.description);
 assert.deepEqual([...listed.matchAll(/`(TARGETING_TYPE_[A-Z_]+)`/g)].map(m=>m[1]).sort(),[...dv360AdvertiserTargetingTypes].sort());
 for(const type of dv360AdvertiserTargetingTypes)assert.ok(dv360TargetingTypes.includes(type),type);
 const plan=(path:string,method:string)=>({gateway,accountId:'123',action:'x',method,path,query:{},headers:{},body:{},readOnly:false,destructive:false,requiresConfirmation:true,evidence:'',warnings:[]}) as CompiledRequest;
 assert.equal(reviewedWriteFamily(plan('/v4/advertisers/123:editAssignedTargetingOptions','POST')),'dv360_advertiser_targeting');
 assert.equal(reviewedWriteFamily(plan('/v4/advertisers/123/targetingTypes/TARGETING_TYPE_KEYWORD/assignedTargetingOptions','POST')),'dv360_advertiser_targeting');
 assert.equal(reviewedWriteFamily(plan('/v4/advertisers/123/lineItems:bulkEditAssignedTargetingOptions','POST')),'dv360_line_item_targeting');
});
