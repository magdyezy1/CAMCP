import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * DV360 audiences, Display & Video 360 API v4 (pinned Discovery document and "Audience list targeting", checked 2026-09-27):
 * advertiser-scoped audience reads, and audience group targeting of line items and Demand Gen ad groups.
 */
const gateway='dv360_native_action',registry=new Registry();
const actor={tenantId:'dv360-audiences',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const AG='TARGETING_TYPE_AUDIENCE_GROUP';
const detailsField=type=>type.slice(15).toLowerCase().replace(/_([a-z])/g,(_m,c)=>c.toUpperCase())+'Details';
const collections={firstPartyAndPartnerAudiences:'firstPartyAndPartnerAudienceId',googleAudiences:'googleAudienceId',customLists:'customListId',combinedAudiences:'combinedAudienceId'};
/** DV360 returns settings and groups in its own order and leaves out a recency without limit. */
const providerForm=details=>{
 const group=g=>({settings:[...g.settings].reverse().map(s=>s.recency==='RECENCY_NO_LIMIT'?{firstPartyAndPartnerAudienceId:s.firstPartyAndPartnerAudienceId}:s)});
 return Object.fromEntries(Object.entries(details).map(([k,v])=>[k,Array.isArray(v)?[...v].reverse().map(group):group(v)]));
};
function fixture(scopes=['https://www.googleapis.com/auth/display-video']){
 const store=new Store(':memory:',Buffer.alloc(32,86).toString('base64')),calls=[];
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes},{accessToken:'synthetic'});
 const lineItems={
  456:{lineItemType:'LINE_ITEM_TYPE_DISPLAY_DEFAULT',entityStatus:'ENTITY_STATUS_PAUSED',displayName:'Display'},
  457:{lineItemType:'LINE_ITEM_TYPE_DISPLAY_DEFAULT',entityStatus:'ENTITY_STATUS_PAUSED',displayName:'Display with audiences'},
  460:{lineItemType:'LINE_ITEM_TYPE_DEMAND_GEN',entityStatus:'ENTITY_STATUS_PAUSED',displayName:'Demand Gen',demandGenSettings:{geoLanguageTargetingEnabled:true},bidStrategy:{demandGenBid:{type:'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CLICKS'}}}
 };
 const adGroups={901:{lineItemId:'460',displayName:'Demand Gen group',adGroupFormat:'AD_GROUP_FORMAT_DEMAND_GEN',entityStatus:'ENTITY_STATUS_PAUSED',adGroupInventoryControl:{adGroupInventoryStrategy:'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'}}};
 const audiences={
  firstPartyAndPartnerAudiences:{501:{displayName:'Site visitors',firstPartyAndPartnerAudienceType:'TYPE_FIRST_PARTY',audienceType:'ACTIVITY_BASED',audienceSource:'DISPLAY_VIDEO_360'},502:{displayName:'Partner intenders',firstPartyAndPartnerAudienceType:'TYPE_PARTNER',audienceType:'THIRD_PARTY'},503:{displayName:'Buyers',firstPartyAndPartnerAudienceType:'TYPE_FIRST_PARTY',audienceType:'CUSTOMER_MATCH_CONTACT_INFO',audienceSource:'DISPLAY_VIDEO_360'}},
  googleAudiences:{601:{displayName:'Sports fans',googleAudienceType:'GOOGLE_AUDIENCE_TYPE_AFFINITY'},602:{displayName:'Recently moved',googleAudienceType:'GOOGLE_AUDIENCE_TYPE_LIFE_EVENT'},603:{displayName:'Shoe shoppers',googleAudienceType:'GOOGLE_AUDIENCE_TYPE_IN_MARKET'}},
  customLists:{701:{displayName:'Running interest'}},
  combinedAudiences:Object.fromEntries(['801','802','803','804','805','806'].map(id=>[id,{displayName:'Combined '+id}]))
 };
 const targeting=new Map([['lineItems/457',[{name:'advertisers/123/lineItems/457/targetingTypes/'+AG+'/assignedTargetingOptions/audienceGroup',assignedTargetingOptionId:'audienceGroup',targetingType:AG,inheritance:'NOT_INHERITED',audienceGroupDetails:{includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'503'}]}]}}]]]);
 let writes=0,reads=0,mode='';
 const option=(level,ownerId,type,details)=>{const id=type===AG?'audienceGroup':String(7000+writes);return {name:'advertisers/123/'+level+'/'+ownerId+'/targetingTypes/'+type+'/assignedTargetingOptions/'+id,assignedTargetingOptionId:id,targetingType:type,inheritance:'NOT_INHERITED',[detailsField(type)]:type===AG?providerForm(details):details};};
 const types=u=>[...String(u.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m=>m[1]);
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method,body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,query:Object.fromEntries(u.searchParams)});
  if(method==='GET'){
   const a=/^\/v4\/(firstPartyAndPartnerAudiences|googleAudiences|customLists|combinedAudiences)(?:\/(\d+))?$/.exec(path);
   if(a){
    assert.equal(u.searchParams.get('advertiserId'),'123');reads++;
    // Sizes change on every read; they are not part of the reviewed state.
    const row=(id,v)=>({name:a[1]+'/'+id,[collections[a[1]]]:id,...v,...(a[1]==='firstPartyAndPartnerAudiences'?{activeDisplayAudienceSize:String(1000+reads)}:{}),...(mode==='partner'&&id==='501'?{firstPartyAndPartnerAudienceType:'TYPE_PARTNER'}:{}),...(mode==='renamed'&&id==='501'?{displayName:'Renamed elsewhere'}:{})});
    if(!a[2])return Response.json({[a[1]]:Object.entries(audiences[a[1]]).map(([id,v])=>row(id,v))});
    const v=audiences[a[1]][a[2]];return v?Response.json(row(a[2],v)):Response.json({error:{code:404,message:'Not found',status:'NOT_FOUND'}},{status:404});
   }
   if(path==='/v4/advertisers/123')return Response.json({name:'advertisers/123',advertiserId:'123',displayName:'Advertiser',entityStatus:'ENTITY_STATUS_ACTIVE',generalConfig:{currencyCode:'USD'}});
   let m=/^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path);
   if(m&&lineItems[m[1]])return Response.json({name:'advertisers/123/lineItems/'+m[1],advertiserId:'123',campaignId:'10',insertionOrderId:'20',lineItemId:m[1],...lineItems[m[1]]});
   m=/^\/v4\/advertisers\/123\/adGroups\/(\d+)$/.exec(path);
   if(m&&adGroups[m[1]])return Response.json({name:'advertisers/123/adGroups/'+m[1],advertiserId:'123',adGroupId:m[1],...adGroups[m[1]]});
   if(path==='/v4/advertisers/123/lineItems:bulkListAssignedTargetingOptions'){const ts=types(u);return Response.json({lineItemAssignedTargetingOptions:u.searchParams.getAll('lineItemIds').flatMap(l=>(targeting.get('lineItems/'+l)??[]).filter(o=>ts.includes(o.targetingType)).map(o=>({lineItemId:l,assignedTargetingOption:o})))});}
   if(path==='/v4/advertisers/123/adGroups:bulkListAssignedTargetingOptions'){const ts=types(u);return Response.json({adGroupAssignedTargetingOptions:u.searchParams.getAll('adGroupIds').flatMap(g=>(targeting.get('adGroups/'+g)??[]).filter(o=>ts.includes(o.targetingType)).map(o=>({adGroupId:g,assignedTargetingOption:o})))});}
   return Response.json({error:{code:404,message:'Not found',status:'NOT_FOUND'}},{status:404});
  }
  writes++;
  const bulk=/^\/v4\/advertisers\/123\/(lineItems|adGroups):bulkEditAssignedTargetingOptions$/.exec(path);
  if(bulk){
   const level=bulk[1],ids=level==='lineItems'?body.lineItemIds:body.adGroupIds;
   for(const id of ids){const key=level+'/'+id;
    for(const d of body.deleteRequests??[])targeting.set(key,(targeting.get(key)??[]).filter(o=>!(o.targetingType===d.targetingType&&d.assignedTargetingOptionIds.includes(o.assignedTargetingOptionId))));
    for(const c of body.createRequests??[])for(const o of c.assignedTargetingOptions)if(mode!=='ignore')targeting.set(key,[...targeting.get(key)??[],option(level,id,c.targetingType,o[detailsField(c.targetingType)])]);}
   return Response.json(level==='lineItems'?{updatedLineItemIds:ids}:{updatedAdGroupIds:ids});
  }
  throw new Error('Unexpected write '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const bulk=(b,level='LINE_ITEMS')=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'DV360_ADVERTISERS_'+level+'_BULK_EDIT_ASSIGNED_TARGETING_OPTIONS',params:{advertiserId:'123'},body:b}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 const read=(action,params)=>service.call(gateway,{action,params,dry_run:false},actor);
 return {store,calls,targeting,bulk,execute,verify,read,writes:()=>writes,audienceReads:()=>calls.filter(c=>/^\/v4\/(firstPartyAndPartnerAudiences|googleAudiences|customLists|combinedAudiences)/.test(c.path)).length,mode:m=>{mode=m;}};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const create=(details,lineItemIds=['456'])=>({lineItemIds,createRequests:[{targetingType:AG,assignedTargetingOptions:[{audienceGroupDetails:details}]}]});
const full={
 includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_30_DAYS'},{firstPartyAndPartnerAudienceId:'503',recency:'RECENCY_NO_LIMIT'}]},{settings:[{firstPartyAndPartnerAudienceId:'502',recency:'RECENCY_NO_LIMIT'}]}],
 includedGoogleAudienceGroup:{settings:[{googleAudienceId:'603'},{googleAudienceId:'602'}]},
 includedCustomListGroup:{settings:[{customListId:'701'}]},
 includedCombinedAudienceGroup:{settings:[{combinedAudienceId:'801'}]},
 excludedGoogleAudienceGroup:{settings:[{googleAudienceId:'601'}]}
};

test('audiences the selected advertiser can access are listed and read by advertiserId; partner and other advertiser reads are refused',async()=>{
 const f=fixture();try{
  const list=ok(await f.read('DV360_GOOGLE_AUDIENCES_LIST',{advertiserId:'123',filter:'displayName : "Sports"',pageSize:50}));assert.equal(JSON.stringify(list.data).includes('Sports fans'),true);
  ok(await f.read('DV360_FIRST_PARTY_AND_PARTNER_AUDIENCES_GET',{firstPartyAndPartnerAudienceId:'501',advertiserId:'123'}));
  ok(await f.read('DV360_CUSTOM_LISTS_GET',{customListId:'701',advertiserId:'123'}));ok(await f.read('DV360_COMBINED_AUDIENCES_LIST',{advertiserId:'123'}));
  const before=f.calls.length;
  assert.equal((await f.read('DV360_GOOGLE_AUDIENCES_LIST',{partnerId:'77'})).error?.code,'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await f.read('DV360_GOOGLE_AUDIENCES_LIST',{advertiserId:'123',partnerId:'77'})).error?.code,'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await f.read('DV360_GOOGLE_AUDIENCES_LIST',{advertiserId:'999'})).error?.code,'CONNECTION_REQUIRED');
  assert.equal((await f.read('DV360_GOOGLE_AUDIENCES_GET',{googleAudienceId:'601',advertiserId:'123',filter:'x'})).success,false);
  assert.equal(f.calls.length,before);
 }finally{f.store.close();}
 const unscoped=fixture([]);try{assert.equal((await unscoped.read('DV360_GOOGLE_AUDIENCES_LIST',{advertiserId:'123'})).error?.code,'INSUFFICIENT_SCOPE');assert.equal(unscoped.calls.length,0);}finally{unscoped.store.close();}
});

test('a line item audience group reads each audience once, is written once and verifies against DV360 order and recency form',async()=>{
 const f=fixture();try{
  const p=ok(await f.bulk(create(full)));assert.equal(f.audienceReads(),8);assert.equal(p.data.creative_impact.scope,'line_item_targeting');
  const reads=f.calls.filter(c=>c.path.startsWith('/v4/googleAudiences/'));assert.deepEqual(reads.map(c=>c.query),reads.map(()=>({advertiserId:'123'})));
  ok(await f.execute(p));assert.equal(f.writes(),1);
  const stored=f.targeting.get('lineItems/456')[0].audienceGroupDetails;assert.deepEqual(stored.includedFirstPartyAndPartnerAudienceGroups.map(g=>g.settings.map(s=>s.firstPartyAndPartnerAudienceId)),[['502'],['503','501']]);
  assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}
});

test('an audience group is replaced by deleting audienceGroup and creating the new one in one bulk edit; a second one is refused',async()=>{
 const f=fixture();try{
  const next={includedGoogleAudienceGroup:{settings:[{googleAudienceId:'603'}]},excludedFirstPartyAndPartnerAudienceGroup:{settings:[{firstPartyAndPartnerAudienceId:'503',recency:'RECENCY_NO_LIMIT'}]}};
  const second=await f.bulk(create(next,['457']));assert.equal(second.error?.code,'INVALID_DV360_TARGETING');assert.match(second.error.message,/only one/);
  const same=await f.bulk(create({includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'503',recency:'RECENCY_NO_LIMIT'}]}]},['457']));assert.equal(same.error?.code,'CONFIGURATION_EXISTS');
  const p=ok(await f.bulk({lineItemIds:['457'],deleteRequests:[{targetingType:AG,assignedTargetingOptionIds:['audienceGroup']}],createRequests:[{targetingType:AG,assignedTargetingOptions:[{audienceGroupDetails:next}]}]}));
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal(f.targeting.get('lineItems/457').length,1);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('malformed audience groups are refused before any request',async()=>{
 const cases=[
  ['no group',{}],
  ['unknown group',{includedPartnerGroup:{settings:[{firstPartyAndPartnerAudienceId:'501'}]}},'INVALID_VENDOR_BODY'],
  ['empty settings',{includedGoogleAudienceGroup:{settings:[]}}],
  ['empty first-party groups',{includedFirstPartyAndPartnerAudienceGroups:[]}],
  ['numeric ID',{includedCustomListGroup:{settings:[{customListId:701}]}}],
  ['recency on a Google audience',{includedGoogleAudienceGroup:{settings:[{googleAudienceId:'601',recency:'RECENCY_1_DAY'}]}},'INVALID_VENDOR_BODY'],
  ['first-party audience without recency',{includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501'}]}]},'INVALID_VENDOR_BODY'],
  ['unknown recency',{includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_2_WEEKS'}]}]},'INVALID_VENDOR_BODY'],
  ['repeated audience',{includedGoogleAudienceGroup:{settings:[{googleAudienceId:'601'},{googleAudienceId:'601'}]}}],
  ['repeated first-party group',{includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_NO_LIMIT'}]},{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_NO_LIMIT'}]}]}],
  ['first-party audience twice in a group',{includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_1_DAY'},{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_NO_LIMIT'}]}]}],
  ['six combined audiences',{includedCombinedAudienceGroup:{settings:['801','802','803','804','805','806'].map(combinedAudienceId=>({combinedAudienceId}))}}],
  ['included and excluded',{includedGoogleAudienceGroup:{settings:[{googleAudienceId:'601'}]},excludedGoogleAudienceGroup:{settings:[{googleAudienceId:'601'}]}}],
  ['101 audiences',{includedGoogleAudienceGroup:{settings:Array.from({length:101},(_,i)=>({googleAudienceId:String(1000+i)}))}}]
 ];
 for(const [label,details,code] of cases){
  const f=fixture();try{const r=await f.bulk(create(details));assert.equal(r.error?.code,code??'INVALID_DV360_TARGETING',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}
 }
});

test('audiences the advertiser cannot use, recency on partner audiences and excluded life events are refused after reading, without writes',async()=>{
 const f=fixture();try{
  const missing=await f.bulk(create({includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'599',recency:'RECENCY_NO_LIMIT'}]}]}));
  assert.equal(missing.error?.code,'STATE_TARGET_MISMATCH');assert.match(missing.error.message,/audience 599 is not available to advertiser 123/);assert.equal(missing.error.details.firstPartyAndPartnerAudienceId,'599');
  const partner=await f.bulk(create({includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'502',recency:'RECENCY_7_DAYS'}]}]}));
  assert.equal(partner.error?.code,'INVALID_DV360_TARGETING');assert.match(partner.error.message,/Recency applies only to first-party audiences/);
  const life=await f.bulk(create({excludedGoogleAudienceGroup:{settings:[{googleAudienceId:'602'}]}}));
  assert.equal(life.error?.code,'INVALID_DV360_TARGETING');assert.match(life.error.message,/affinity, in-market and installed-apps/);
  ok(await f.bulk(create({excludedGoogleAudienceGroup:{settings:[{googleAudienceId:'603'}]}})));
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('Demand Gen ad groups take audience groups; Demand Gen line items still do not',async()=>{
 const f=fixture();try{
  const p=ok(await f.bulk({adGroupIds:['901'],createRequests:[{targetingType:AG,assignedTargetingOptions:[{audienceGroupDetails:{includedGoogleAudienceGroup:{settings:[{googleAudienceId:'603'}]},includedCustomListGroup:{settings:[{customListId:'701'}]}}}]}]},'AD_GROUPS'));
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');
  const line=await f.bulk(create({includedGoogleAudienceGroup:{settings:[{googleAudienceId:'603'}]}},['460']));assert.equal(line.error?.code,'INVALID_DV360_TARGETING');assert.match(line.error.message,/Demand Gen/);
 }finally{f.store.close();}
});

test('audience sizes do not block execution; a renamed audience or one that became a partner audience does; a write DV360 ignored is not verified',async()=>{
 const f=fixture();try{
  const details={includedFirstPartyAndPartnerAudienceGroups:[{settings:[{firstPartyAndPartnerAudienceId:'501',recency:'RECENCY_1_DAY'}]}]};
  const p=ok(await f.bulk(create(details)));f.mode('renamed');
  assert.equal((await f.execute(p)).error?.code,'STATE_CHANGED');assert.equal(f.writes(),0);
  f.mode('');const r=ok(await f.bulk(create(details)));f.mode('partner');
  const partner=await f.execute(r);assert.equal(partner.error?.code,'INVALID_DV360_TARGETING');assert.match(partner.error.message,/Recency applies only to first-party audiences/);assert.equal(f.writes(),0);f.mode('');
  const q=ok(await f.bulk(create(details)));ok(await f.execute(q));assert.equal(f.writes(),1);assert.equal(ok(await f.verify(q)).data.status,'verified');
  const g=fixture();try{g.mode('ignore');const r=ok(await g.bulk(create(details)));ok(await g.execute(r));assert.notEqual(ok(await g.verify(r)).data.status,'verified');}finally{g.store.close();}
 }finally{f.store.close();}
});

test('the audience group model and audience reads match the pinned Discovery document',()=>{
 const doc=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')).document,S=doc.schemas,R=doc.resources;
 assert.deepEqual(Object.keys(S.AudienceGroupAssignedTargetingOptionDetails.properties).sort(),['excludedFirstPartyAndPartnerAudienceGroup','excludedGoogleAudienceGroup','includedCombinedAudienceGroup','includedCustomListGroup','includedFirstPartyAndPartnerAudienceGroups','includedGoogleAudienceGroup']);
 assert.match(S.AudienceGroupAssignedTargetingOptionDetails.properties.excludedGoogleAudienceGroup.description,/Only contains Affinity, In-market and Installed-apps type Google audiences/);
 assert.match(S.FirstPartyAndPartnerAudienceTargetingSetting.properties.recency.description,/Only applicable to first party audiences/);
 assert.match(S.CombinedAudienceGroup.properties.settings.description,/no more than five/);
 assert.match(S.FirstPartyAndPartnerAudienceGroup.properties.settings.description,/Repeated settings with the same id are not allowed/);
 assert.deepEqual(S.FirstPartyAndPartnerAudience.properties.firstPartyAndPartnerAudienceType.enum,['FIRST_PARTY_AND_PARTNER_AUDIENCE_TYPE_UNSPECIFIED','TYPE_FIRST_PARTY','TYPE_PARTNER']);
 for(const r of ['firstPartyAndPartnerAudiences','googleAudiences','customLists','combinedAudiences']){const m=R[r].methods;assert.equal(m.get.parameters.advertiserId.location,'query',r);assert.equal(m.list.parameters.advertiserId.location,'query',r);assert.match(m.get.parameters.advertiserId.description,/advertiser that has access/i,r);}
});
