import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {googleConfigurationContracts} from '../src/google-configuration-writes.js';
import {googleFeedFields} from '../src/google-asset-set-writes.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {JsonObject} from '../src/types.js';

const gateway='google_ads_native_action',registry=new Registry(),actor={tenantId:'configuration',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const};
const resource=(kind:string,id:string)=>'customers/123/'+kind+'/'+id;
const camel=(s:string)=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
const get=(o:any,key:string):any=>key.split('.').reduce((v,k)=>v?.[camel(k)],o);
const set=(o:JsonObject,key:string,value:unknown)=>{const keys=key.split('.').map(camel);let target=o;for(const k of keys.slice(0,-1))target=target[k]??= {};target[keys.at(-1)!]=structuredClone(value);};
const cases:{route:string;rpc:string;entity:string;create:JsonObject;id:string;update?:JsonObject}[]=[
 {route:'labels',rpc:'label_mutate_labels',entity:'label',create:{name:'Launch EN / AR',textLabel:{backgroundColor:'#012abc',description:'Approved brief'}},id:'500',update:{name:'Updated label'}},
 {route:'campaignLabels',rpc:'campaign_label_mutate_campaign_labels',entity:'campaign_label',create:{campaign:resource('campaigns','100'),label:resource('labels','900')},id:'100~900'},
 {route:'adGroupLabels',rpc:'ad_group_label_mutate_ad_group_labels',entity:'ad_group_label',create:{adGroup:resource('adGroups','200'),label:resource('labels','900')},id:'200~900'},
 {route:'adGroupAdLabels',rpc:'ad_group_ad_label_mutate_ad_group_ad_labels',entity:'ad_group_ad_label',create:{adGroupAd:resource('adGroupAds','200~300'),label:resource('labels','900')},id:'200~300~900'},
 {route:'adGroupCriterionLabels',rpc:'ad_group_criterion_label_mutate_ad_group_criterion_labels',entity:'ad_group_criterion_label',create:{adGroupCriterion:resource('adGroupCriteria','200~400'),label:resource('labels','900')},id:'200~400~900'},
 {route:'customizerAttributes',rpc:'customizer_attribute_mutate_customizer_attributes',entity:'customizer_attribute',create:{name:'Offer',type:'TEXT'},id:'500'},
 {route:'campaignCustomizers',rpc:'campaign_customizer_mutate_campaign_customizers',entity:'campaign_customizer',create:{campaign:resource('campaigns','100'),customizerAttribute:resource('customizerAttributes','600'),value:{type:'TEXT',stringValue:'Summer'}},id:'100~600'},
 {route:'adGroupCustomizers',rpc:'ad_group_customizer_mutate_ad_group_customizers',entity:'ad_group_customizer',create:{adGroup:resource('adGroups','200'),customizerAttribute:resource('customizerAttributes','600'),value:{type:'TEXT',stringValue:'Summer'}},id:'200~600'},
 {route:'AdGroupCriterionCustomizers',rpc:'ad_group_criterion_customizer_mutate_ad_group_criterion_customizers',entity:'ad_group_criterion_customizer',create:{adGroupCriterion:resource('adGroupCriteria','200~400'),customizerAttribute:resource('customizerAttributes','600'),value:{type:'TEXT',stringValue:'Summer'}},id:'200~400~600'},
 {route:'CustomerCustomizers',rpc:'customer_customizer_mutate_customer_customizers',entity:'customer_customizer',create:{customizerAttribute:resource('customizerAttributes','600'),value:{type:'TEXT',stringValue:'Summer'}},id:'600'},
 {route:'adParameters',rpc:'ad_parameter_mutate_ad_parameters',entity:'ad_parameter',create:{adGroupCriterion:resource('adGroupCriteria','200~400'),parameterIndex:'1',insertionText:'99.99USD'},id:'200~400~1',update:{insertionText:'89.99USD'}},
 {route:'campaignGroups',rpc:'campaign_group_mutate_campaign_groups',entity:'campaign_group',create:{name:'Launch portfolio'},id:'500',update:{name:'Updated portfolio'}},
 {route:'conversionCustomVariables',rpc:'conversion_custom_variable_mutate_conversion_custom_variables',entity:'conversion_custom_variable',create:{name:'Product category',tag:'product_category',status:'PAUSED'},id:'500',update:{name:'Product family'}},
 {route:'remarketingActions',rpc:'remarketing_action_mutate_remarketing_actions',entity:'remarketing_action',create:{name:'Product views'},id:'500',update:{name:'Detailed product views'}},
 {route:'assetGroupSignals',rpc:'asset_group_signal_mutate_asset_group_signals',entity:'asset_group_signal',create:{assetGroup:resource('assetGroups','700'),searchTheme:{text:'family homes'}},id:'700~500'},
 {route:'customerNegativeCriteria',rpc:'customer_negative_criterion_mutate_customer_negative_criteria',entity:'customer_negative_criterion',create:{placement:{url:'example.com'}},id:'500'},
 {route:'assetSets',rpc:'asset_set_mutate_asset_sets',entity:'asset_set',create:{name:'Landing pages',type:'PAGE_FEED'},id:'500',update:{name:'Revised page feed'}},
 {route:'assetSetAssets',rpc:'asset_set_asset_mutate_asset_set_assets',entity:'asset_set_asset',create:{assetSet:resource('assetSets','850'),asset:resource('assets','851')},id:'850~851'},
 {route:'campaignAssetSets',rpc:'campaign_asset_set_mutate_campaign_asset_sets',entity:'campaign_asset_set',create:{campaign:resource('campaigns','100'),assetSet:resource('assetSets','850')},id:'100~850'},
 {route:'adGroupAssetSets',rpc:'ad_group_asset_set_mutate_ad_group_asset_sets',entity:'ad_group_asset_set',create:{adGroup:resource('adGroups','200'),assetSet:resource('assetSets','861')},id:'200~861'},
 {route:'customerAssetSets',rpc:'customer_asset_set_mutate_customer_asset_sets',entity:'customer_asset_set',create:{customer:'customers/123',assetSet:resource('assetSets','860')},id:'860'},
 {route:'keywordPlans',rpc:'keyword_plan_mutate_keyword_plans',entity:'keyword_plan',create:{name:'Expansion research',forecastPeriod:{dateInterval:'NEXT_MONTH'}},id:'500',update:{name:'Reviewed research'}},
 {route:'keywordPlanCampaigns',rpc:'keyword_plan_campaign_mutate_keyword_plan_campaigns',entity:'keyword_plan_campaign',create:{name:'Planning campaign',keywordPlan:resource('keywordPlans','810'),cpcBidMicros:'1000000',keywordPlanNetwork:'GOOGLE_SEARCH',geoTargets:[{geoTargetConstant:'geoTargetConstants/2682'}],languageConstants:['languageConstants/1000']},id:'500',update:{cpcBidMicros:'2000000'}},
 {route:'keywordPlanAdGroups',rpc:'keyword_plan_ad_group_mutate_keyword_plan_ad_groups',entity:'keyword_plan_ad_group',create:{name:'Planning group',keywordPlanCampaign:resource('keywordPlanCampaigns','801')},id:'500',update:{cpcBidMicros:'1500000'}},
 {route:'keywordPlanAdGroupKeywords',rpc:'keyword_plan_ad_group_keyword_mutate_keyword_plan_ad_group_keywords',entity:'keyword_plan_ad_group_keyword',create:{keywordPlanAdGroup:resource('keywordPlanAdGroups','802'),text:'family homes',matchType:'PHRASE',negative:false},id:'500',update:{matchType:'EXACT'}},
 {route:'keywordPlanCampaignKeywords',rpc:'keyword_plan_campaign_keyword_mutate_keyword_plan_campaign_keywords',entity:'keyword_plan_campaign_keyword',create:{keywordPlanCampaign:resource('keywordPlanCampaigns','801'),text:'jobs',matchType:'BROAD',negative:true},id:'500',update:{text:'careers'}}
];
const fields=JSON.parse(fs.readFileSync('tests/fixtures/google-configuration-fields-v23.json','utf8')).resources;
function fixture(row=cases[0]!,allowWrites=true){
 const store=new Store(':memory:',Buffer.alloc(32,79).toString('base64')),records=new Map<string,JsonObject>(),calls:JsonObject[]=[];
 const connection={id:'google',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:[]};
 const credentials={accessToken:'synthetic',developerToken:'synthetic'};store.putConnection(owner,connection,credentials);
 const seed=(kind:string,id:string,value:JsonObject)=>records.set(resource(kind,id),{resourceName:resource(kind,id),...value});
 for(const id of ['800','810'])seed('keywordPlans',id,{name:'Existing planning workspace',forecastPeriod:{dateInterval:'NEXT_MONTH'}});
 seed('keywordPlanCampaigns','801',{name:'Existing research campaign',keywordPlan:resource('keywordPlans','800'),cpcBidMicros:'1000000',keywordPlanNetwork:'GOOGLE_SEARCH',geoTargets:[{geoTargetConstant:'geoTargetConstants/2682'},{geoTargetConstant:'geoTargetConstants/2784'}],languageConstants:['languageConstants/1000']});
 seed('keywordPlanAdGroups','802',{name:'Existing research group',keywordPlanCampaign:resource('keywordPlanCampaigns','801')});
 seed('keywordPlanAdGroupKeywords','803',{keywordPlanAdGroup:resource('keywordPlanAdGroups','802'),text:'existing positive',matchType:'EXACT'});
 seed('keywordPlanCampaignKeywords','804',{keywordPlanCampaign:resource('keywordPlanCampaigns','801'),text:'existing negative',matchType:'BROAD',negative:true});
 seed('campaigns','100',{name:'Campaign',status:'PAUSED',advertisingChannelType:'SEARCH',campaignBudget:resource('campaignBudgets','50')});
 seed('adGroups','200',{name:'Group',status:'PAUSED',campaign:resource('campaigns','100')});
 seed('adGroupAds','200~300',{status:'PAUSED',ad:{id:'300',finalUrls:['https://example.com']}});
 seed('adGroupCriteria','200~400',{adGroup:resource('adGroups','200'),type:'KEYWORD',status:'PAUSED',keyword:{text:'family homes',matchType:'EXACT'}});
 seed('labels','900',{name:'Existing label',status:'ENABLED',textLabel:{backgroundColor:'#fff',description:'Existing description'}});
 seed('customizerAttributes','600',{name:'Season',type:'TEXT',status:'ENABLED'});
 seed('assetGroups','700',{name:'Asset group',status:'PAUSED',campaign:resource('campaigns','100')});
 seed('assetSets','850',{name:'Page feed',type:'PAGE_FEED',status:'ENABLED'});
 seed('assetSets','860',{name:'Locations',type:'LOCATION_SYNC',status:'ENABLED',locationSet:{locationOwnershipType:'BUSINESS_OWNER',businessProfileLocationSet:{labelFilters:['Retail']}}});
 seed('assetSets','861',{name:'Selected locations',type:'STATIC_LOCATION_GROUP',status:'ENABLED',locationGroupParentAssetSetId:'860'});
 for(const [asset,page]of [['851','new'],['854','existing']])seed('assets',asset!,{type:'PAGE_FEED',source:'ADVERTISER',pageFeedAsset:{pageUrl:'https://example.com/'+page,labels:['AR','EN']}});
 seed('assets','853',{type:'LOCATION',source:'AUTOMATICALLY_CREATED',locationAsset:{locationOwnershipType:'BUSINESS_OWNER',placeId:'synthetic-place',businessProfileLocations:['locations/1']}});
 for(const [set,asset]of [['850','854'],['860','853'],['861','853']])seed('assetSetAssets',set+'~'+asset,{assetSet:resource('assetSets',set!),asset:resource('assets',asset!),status:'ENABLED'});
 let writes=0,reads=0,foreignReceipt=false,partialReceipt=false,lostResponse=false,incomplete=false,revoke=false;
 let readHook:(body:JsonObject,result:JsonObject)=>JsonObject=(_body,result)=>result;
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const body=JSON.parse(String(init?.body)),path=new URL(String(url)).pathname;calls.push({path,body});
  if(path.endsWith('googleAds:search')){
   reads++;const match=/^SELECT (.+) FROM ([a-z_]+)/.exec(body.query)!;assert.ok(match,'The request must be an exact GAQL query.');const entity=match[2]!;
   const feed=/asset_set_asset\.asset_set = '(customers\/[^']+)'/.exec(body.query);
   const planning=/FROM (keyword_plan[a-z_]*) WHERE \1\.([a-z_]+) IN/.exec(body.query),ids=[...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]);
   const selected=planning?[...records.values()].filter(record=>record.resourceName.split('/')[2]===camel(planning[1]!)+'s'&&ids.includes(record[camel(planning[2]!)])):feed?[...records.values()].filter(r=>r.assetSet===feed[1]&&r.status==='ENABLED'&&r.resourceName.includes('/assetSetAssets/')):[...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m=>records.get(m[1])).filter(Boolean);
   const data=entity==='customer'?[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC'}}]:selected.flatMap(record=>{
    const projected:JsonObject={};for(const f of match[1]!.split(', ')){assert.ok(f.startsWith(entity+'.'));const key=f.slice(entity.length+1);if(fields[entity])assert.equal(fields[entity].fields[key]?.selectable,true,'Undocumented GAQL field '+f);const value=get(record,key);if(value!==undefined&&value!=='')set(projected,key,value);}
    return [{[camel(entity)]:projected}];
   });
   if(revoke)store.putConnection(owner,{...connection,writeAccounts:[]},credentials);
   return Response.json(readHook(body,{...(data.length?{results:data}:{}),fieldMask:match[1],queryResourceConsumption:String(100+reads),...(incomplete?{nextPageToken:'remaining'}:{})}));
  }
  assert.equal(path,'/v23/customers/123/'+row.route+':mutate');writes++;
  const results=body.operations.map((op:JsonObject)=>{
   const collection=({AdGroupCriterionCustomizers:'adGroupCriterionCustomizers',CustomerCustomizers:'customerCustomizers'} as Record<string,string>)[row.route]??row.route;
   const name=op.remove??op.update?.resourceName??resource(collection,row.id);
   if(op.remove)records.delete(name);
   else if(op.update){const record=records.get(name)!;for(const f of op.updateMask.split(','))set(record,f,get(op.update,f));}
   else records.set(name,{...op.create,resourceName:name,...(['labels','customizerAttributes','campaignCustomizers','adGroupCustomizers','AdGroupCriterionCustomizers','CustomerCustomizers','campaignGroups','assetSets','assetSetAssets','campaignAssetSets','adGroupAssetSets','customerAssetSets'].includes(row.route)?{status:'ENABLED'}:{}),...(row.route==='customerNegativeCriteria'?{type:'PLACEMENT'}:{})});
   return {resourceName:foreignReceipt?name.replace('customers/123/','customers/999/'):name};
  });
  if(lostResponse)throw Error('Synthetic response lost after provider mutation');
  return Response.json({...(!partialReceipt?{results}:{results:[]}),...(partialReceipt?{partialFailureError:{code:3,message:'Synthetic error'}}:{})});
 // These are provider-contract fixtures; pacing has its own transport tests.
 // A large synthetic burst avoids real-time sleeps during complete hierarchy reads.
 },async()=>{},30000,8*1024*1024,10000),undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(operations:JsonObject[])=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'google_ads_v23_'+row.rpc,account_id:'123',payload:{operations}}},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 return {store,service,records,calls,prepare,execute,writes:()=>writes,reads:()=>reads,foreign:()=>{foreignReceipt=true;},partial:()=>{partialReceipt=true;},lose:()=>{lostResponse=true;},paginate:()=>{incomplete=true;},revoke:()=>{revoke=true;},onRead:(fn:typeof readHook)=>{readHook=fn;}};
}

test('all configuration snapshot fields are selectable in the official v23 resource references',()=>{
 assert.equal(cases.length,Object.keys(googleConfigurationContracts).length);
 for(const c of Object.values(googleConfigurationContracts))for(const field of ['resource_name',...c.fields])assert.equal(fields[c.resource]?.fields[field]?.selectable,true,c.resource+'.'+field);
 const assetFields=JSON.parse(fs.readFileSync('tests/fixtures/google-asset-fields-v23.json','utf8')).fields;
 for(const field of googleFeedFields)assert.equal(assetFields[field]?.selectable,true,'asset.'+field);
});
for(const row of cases)test('Google configuration lifecycle: '+row.route,async()=>{
 const x=fixture(row);try{
  const prepared=await x.prepare([{create:row.create}]);assert.equal(prepared.success,true,JSON.stringify(prepared));assert.equal(x.writes(),0);
  const result=await x.execute(prepared);assert.equal(result.success,true,JSON.stringify(result));assert.equal(x.writes(),1);
  const verified=await x.service.call('amcp_campaign',{action:'verify',review_id:prepared.data.review_id},actor);assert.equal(verified.data.status,'verified',JSON.stringify(verified));
  const replay=await x.execute(prepared);assert.equal(replay.data.replayed,true);assert.equal(x.writes(),1);
  const name=result.data.data.results[0].resourceName;
  if(row.update){
   const changed=await x.prepare([{update:{resourceName:name,...row.update},updateMask:Object.keys(row.update).join(',')}]);assert.equal(changed.success,true,JSON.stringify(changed));
   assert.equal((await x.execute(changed)).success,true);
   const v=await x.service.call('amcp_campaign',{action:'verify',review_id:changed.data.review_id},actor);assert.equal(v.data.status,'verified',JSON.stringify(v));
  }
  // Some provider services deliberately do not expose remove. Their Discovery
  // request schema is checked separately instead of inventing a delete operation.
  if(!['conversionCustomVariables','remarketingActions'].includes(row.route)){
   const removed=await x.prepare([{remove:name}]);assert.equal(removed.success,true,JSON.stringify(removed));assert.equal((await x.execute(removed)).success,true);
   const v=await x.service.call('amcp_campaign',{action:'verify',review_id:removed.data.review_id},actor);assert.equal(v.data.status,'verified',JSON.stringify(v));
  }
 }finally{x.store.close();}
});

test('exact association absence is frozen and a concurrent attachment conflicts before mutation',async()=>{
 const row=cases[1]!,x=fixture(row);try{
  const p=await x.prepare([{create:row.create}]);assert.equal(p.success,true,JSON.stringify(p));
  const name=resource('campaignLabels',row.id);x.records.set(name,{resourceName:name,...row.create});
  const conflict=await x.execute(p);assert.equal(conflict.error.code,'STATE_CHANGED');assert.equal(x.writes(),0);
  const duplicate=await x.prepare([{create:row.create}]);assert.equal(duplicate.error.code,'CONFIGURATION_EXISTS');
 }finally{x.store.close();}
});
test('label content changes conflict while variable provider telemetry never changes the reviewed configuration',async()=>{
 const x=fixture(cases[1]);try{
  const p=await x.prepare([{create:cases[1]!.create}]);assert.equal(p.success,true,JSON.stringify(p));x.records.get(resource('labels','900'))!.textLabel.description='Changed';
  const changed=await x.execute(p);assert.equal(changed.error.code,'STATE_CHANGED');assert.ok(JSON.stringify(changed.error.details.changed_fields).includes('description'));assert.equal(x.writes(),0);
 }finally{x.store.close();}
});
test('cleared text-label fields verify against omitted ProtoJSON defaults',async()=>{
 const x=fixture();try{
  const p=await x.prepare([{update:{resourceName:resource('labels','900'),textLabel:{}},updateMask:'text_label'}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);
  const v=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(v.data.status,'verified',JSON.stringify(v));
 }finally{x.store.close();}
});
test('configuration mutations reject foreign references, immutable masks and incomplete values without egress',async()=>{
 const invalidCases:[number,JsonObject][]=[
  [1,{create:{...cases[1]!.create,label:'customers/999/labels/900'}}],
  [1,{update:{resourceName:resource('campaignLabels','100~900'),label:resource('labels','901')},updateMask:'label'}],
  [0,{update:{resourceName:resource('labels','900'),name:'x',textLabel:{description:'unmasked'}},updateMask:'name'}],
  [0,{update:{resourceName:resource('labels','900')},updateMask:'name'}],
  [0,{create:{name:'x',status:'ENABLED'}}],
  [5,{create:{name:'x',type:'UNKNOWN'}}],
  [10,{create:{...cases[10]!.create,parameterIndex:'3'}}],
  [14,{create:{...cases[14]!.create,audience:{audience:resource('audiences','800')}}}],
  [15,{create:{placement:{}}}]
 ];
 for(const [i,op]of invalidCases){const x=fixture(cases[i]);try{assert.equal((await x.prepare([op])).success,false,JSON.stringify(op));assert.equal(x.reads(),0);assert.equal(x.writes(),0);}finally{x.store.close();}}
});
test('customizer prerequisites and serving policies are enforced using the exact attribute and parent',async()=>{
 const x=fixture(cases[8]);try{
  x.records.get(resource('customizerAttributes','600'))!.type='NUMBER';const wrong=await x.prepare([{create:cases[8]!.create}]);assert.equal(wrong.error.code,'INVALID_CONFIGURATION_MUTATION');
  x.records.get(resource('customizerAttributes','600'))!.type='TEXT';x.records.get(resource('adGroupCriteria','200~400'))!.type='PLACEMENT';assert.equal((await x.prepare([{create:cases[8]!.create}])).success,false);
  x.records.get(resource('adGroupCriteria','200~400'))!.type='KEYWORD';const p=await x.prepare([{create:cases[8]!.create}]);assert.equal(p.success,true,JSON.stringify(p));
  assert.equal((await x.execute(p,{spend_change_confirmed:false})).error.code,'SPEND_CONFIRMATION_REQUIRED');
  saveSpendPolicy(x.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await x.execute(p)).error.code,'POLICY_ACTIVATION_FORBIDDEN');assert.equal(x.writes(),0);
 }finally{x.store.close();}
});
test('paginated state, in-flight grant revocation and deletion policies prevent dispatch',async()=>{
 for(const mode of ['paginate','revoke','delete']as const){const x=fixture();try{
  if(mode==='paginate'){x.paginate();assert.equal((await x.prepare([{create:cases[0]!.create}])).error.code,'INCOMPLETE_STATE');}
  if(mode==='revoke'){x.revoke();assert.equal((await x.prepare([{create:cases[0]!.create}])).success,false);}
  if(mode==='delete'){saveSpendPolicy(x.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:false}});assert.equal((await x.prepare([{remove:resource('labels','900')}])).error.code,'POLICY_DELETION_FORBIDDEN');}
  assert.equal(x.writes(),0);
 }finally{x.store.close();}}
});
test('foreign and partial receipts cannot succeed; a lost response cannot resubmit the original review',async()=>{
 for(const mode of ['foreign','partial','lose']as const){const x=fixture();try{
  const p=await x.prepare([{create:cases[0]!.create}]);assert.equal(p.success,true);x[mode]();const result=await x.execute(p);
  if(mode==='lose'){assert.equal(result.success,false);assert.equal((await x.execute(p)).error.code,'WRITE_OUTCOME_UNCERTAIN');}
  else{assert.equal(result.data.success,false,JSON.stringify(result));assert.equal(result.data.verification,undefined);assert.equal((await x.execute(p)).data.replayed,true);}
  assert.equal(x.writes(),1);
 }finally{x.store.close();}}
});
test('concurrent execution of a configuration review dispatches at most one mutation',async()=>{
 const x=fixture();try{const p=await x.prepare([{create:cases[0]!.create}]);assert.equal(p.success,true);const results=await Promise.all([x.execute(p),x.execute(p)]);assert.ok(results.some(r=>r.success));assert.equal(x.writes(),1);}finally{x.store.close();}
});

test('feed content changes conflict; order-only label and membership changes do not',async()=>{
 for(const change of ['content','labels','members']as const){const x=fixture(cases[18]);try{
  const p=await x.prepare([{create:cases[18]!.create}]);assert.equal(p.success,true,JSON.stringify(p));
  if(change==='content')x.records.get(resource('assets','854'))!.pageFeedAsset.pageUrl='https://example.com/changed';
  if(change==='labels')x.records.get(resource('assets','854'))!.pageFeedAsset.labels.reverse();
  if(change==='members'){x.records.set(resource('assetSetAssets','850~851'),{resourceName:resource('assetSetAssets','850~851'),assetSet:resource('assetSets','850'),asset:resource('assets','851'),status:'ENABLED'});}
  const result=await x.execute(p);if(change==='labels')assert.equal(result.success,true,JSON.stringify(result));else{assert.equal(result.error.code,'STATE_CHANGED');assert.equal(x.writes(),0);}
 }finally{x.store.close();}}
});

test('complete feed membership pagination is consumed; loops, foreign rows, duplicates and provider errors fail',async()=>{
 for(const mode of ['pages','loop','foreign','duplicate','error','bytes']as const){const x=fixture(cases[18]);try{
  x.records.set(resource('assetSetAssets','850~851'),{resourceName:resource('assetSetAssets','850~851'),assetSet:resource('assetSets','850'),asset:resource('assets','851'),status:'ENABLED'});
  x.onRead((body,data)=>{
   if(!body.query.includes('asset_set_asset.asset_set ='))return data;
   if(mode==='pages')return {...data,results:body.pageToken?data.results.slice(1):data.results.slice(0,1),...(body.pageToken?{}:{nextPageToken:'page-2'})};
   if(mode==='loop')return {results:[],nextPageToken:'loop'};
   if(mode==='foreign')data.results[0].assetSetAsset.asset='customers/999/assets/854';
   if(mode==='duplicate')data.results.push(data.results[0]);
   if(mode==='error')data.error={code:403,message:'Synthetic permission failure'};
   if(mode==='bytes')data.unknownEnvelope='x'.repeat(17*1024*1024);
   return data;
  });
  const p=await x.prepare([{create:cases[18]!.create}]);if(mode==='pages'){assert.equal(p.success,true,JSON.stringify(p));assert.ok(x.calls.some(c=>c.body.pageToken==='page-2'));assert.equal((await x.execute(p)).success,true);}else{assert.equal(p.success,false,JSON.stringify(p));assert.equal(x.writes(),0);}
 }finally{x.store.close();}}
});

test('feed contracts bind the parent, asset type and account and retain policy controls',async()=>{
 const trials:[number,JsonObject][]=[
  [17,{create:{...cases[17]!.create,asset:resource('assets','853')}}],
  [19,{create:{...cases[19]!.create,assetSet:resource('assetSets','850')}}],
  [20,{create:{...cases[20]!.create,assetSet:resource('assetSets','850')}}],
  [20,{create:{...cases[20]!.create,customer:'customers/999'}}],
  [16,{create:{name:'Location',type:'LOCATION_SYNC'}}],
  [16,{create:{name:'Group',type:'STATIC_LOCATION_GROUP',locationGroupParentAssetSetId:'850'}}],
  [16,{create:{name:'Page feed',type:'PAGE_FEED',merchantCenterFeed:{merchantId:'1'}}}]
 ];
 for(const [i,op]of trials){const x=fixture(cases[i]);try{const p=await x.prepare([op]);assert.equal(p.success,false,JSON.stringify(p));assert.equal(x.writes(),0);}finally{x.store.close();}}
 const x=fixture(cases[18]);try{const p=await x.prepare([{create:cases[18]!.create}]);assert.equal(p.success,true);assert.equal((await x.execute(p,{spend_change_confirmed:false})).error.code,'SPEND_CONFIRMATION_REQUIRED');saveSpendPolicy(x.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});assert.equal((await x.execute(p)).error.code,'POLICY_ACTIVATION_FORBIDDEN');assert.equal(x.writes(),0);}finally{x.store.close();}
});

test('all nine advertiser feed types attach, verify and reject a changed creative field',async()=>{
 const variants:Record<string,JsonObject>={PAGE_FEED:{pageUrl:'https://example.com/page',labels:['Approved']},DYNAMIC_EDUCATION:{programId:'degree',programName:'Degree',schoolName:'School'},DYNAMIC_CUSTOM:{id:'offer',itemTitle:'Offer',price:'100 USD'},DYNAMIC_HOTELS_AND_RENTALS:{propertyId:'hotel',propertyName:'Hotel',price:'100 USD'},DYNAMIC_REAL_ESTATE:{listingId:'home',listingName:'Home',price:'100 USD'},DYNAMIC_LOCAL:{dealId:'deal',dealName:'Deal',price:'100 USD'},DYNAMIC_FLIGHTS:{destinationId:'RUH',destinationName:'Riyadh',flightPrice:'100 USD'},DYNAMIC_JOBS:{jobId:'role',jobTitle:'Engineer'},DYNAMIC_TRAVEL:{destinationId:'city',destinationName:'City',price:'100 USD'}};
 for(const [type,content]of Object.entries(variants)){const x=fixture(cases[17]);try{
  x.records.get(resource('assetSets','850'))!.type=type;
  for(const assetId of ['851','854'])x.records.set(resource('assets',assetId),{resourceName:resource('assets',assetId),type,source:'ADVERTISER',[camel(type.toLowerCase())+'Asset']:structuredClone(content)});
  const p=await x.prepare([{create:cases[17]!.create}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);
  const verified=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(verified.data.status,'verified',JSON.stringify(verified));
  const removal=await x.prepare([{remove:resource('assetSetAssets','850~851')}]);assert.equal(removal.success,true,JSON.stringify(removal));
  const key=Object.keys(content)[0]!;x.records.get(resource('assets','851'))![camel(type.toLowerCase())+'Asset'][key]='Changed';
  assert.equal((await x.execute(removal)).error.code,'STATE_CHANGED');
 }finally{x.store.close();}}
});

test('feed replacements verify removed filters and preserve unmasked Merchant Center labels',async()=>{
 for(const preserve of [false,true]){const x=fixture(cases[16]);try{
  const target=resource('assetSets','850');x.records.set(target,{resourceName:target,name:'Dynamic group',type:'BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP',status:'ENABLED',locationGroupParentAssetSetId:'860',businessProfileLocationGroup:{dynamicBusinessProfileLocationGroupFilter:{labelFilters:['Old'],businessNameFilter:{businessName:'Old name',filterType:'EXACT'}}}});x.records.delete(resource('assetSetAssets','850~854'));
  const p=await x.prepare([{update:{resourceName:target,businessProfileLocationGroup:{dynamicBusinessProfileLocationGroupFilter:{}}},updateMask:'businessProfileLocationGroup'}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);
  if(preserve)x.records.get(target)!.businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter.businessNameFilter={businessName:'Old name',filterType:'EXACT'};
  const verified=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(verified.data.status,preserve?'inconclusive':'verified',JSON.stringify(verified));
 }finally{x.store.close();}}
 const x=fixture(cases[16]);try{
  const target=resource('assetSets','850');x.records.set(target,{resourceName:target,name:'Merchant feed',type:'MERCHANT_CENTER_FEED',status:'ENABLED',merchantCenterFeed:{merchantId:'99',feedLabel:'SA'}});x.records.delete(resource('assetSetAssets','850~854'));
  const p=await x.prepare([{update:{resourceName:target,merchantCenterFeed:{merchantId:'100'}},updateMask:'merchantCenterFeed.merchantId'}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);
  const verified=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.equal(x.records.get(target)!.merchantCenterFeed.feedLabel,'SA');
 }finally{x.store.close();}
});

test('revocation inside a feed page and a race during fan-out prevent execution',async()=>{
 for(const mode of ['revoke','race']as const){const x=fixture(cases[18]);try{
  let changed=false;x.onRead((body,data)=>{if(body.query.includes('asset_set_asset.asset_set =')&&!changed){changed=true;if(mode==='revoke')x.revoke();else x.records.get(resource('assetSets','850'))!.name='Concurrent edit';}return data;});
  const p=await x.prepare([{create:cases[18]!.create}]);assert.equal(p.success,false,JSON.stringify(p));assert.equal(x.writes(),0);
 }finally{x.store.close();}}
});

test('feed creation supports declared types, static groups and signed Business Profile location IDs',async()=>{
 const variants:JsonObject[]=[...['PAGE_FEED','DYNAMIC_EDUCATION','DYNAMIC_CUSTOM','DYNAMIC_HOTELS_AND_RENTALS','DYNAMIC_REAL_ESTATE','DYNAMIC_LOCAL','DYNAMIC_FLIGHTS','DYNAMIC_JOBS','DYNAMIC_TRAVEL'].map(type=>({name:'Feed',type})),{name:'Merchant',type:'MERCHANT_CENTER_FEED',merchantCenterFeed:{merchantId:'99',feedLabel:'SA'}},{name:'Static locations',type:'STATIC_LOCATION_GROUP',locationGroupParentAssetSetId:'860'},{name:'Filtered locations',type:'BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP',locationGroupParentAssetSetId:'860',businessProfileLocationGroup:{dynamicBusinessProfileLocationGroupFilter:{listingIdFilters:['-9223372036854775808','5'],labelFilters:['EN','AR']}}}];
 for(const create of variants){const x=fixture(cases[16]);try{
  const p=await x.prepare([{create}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);const v=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(v.data.status,'verified',JSON.stringify(v));
 }finally{x.store.close();}}
});

test('planning snapshots preserve full hierarchy, inherit bids and compare native geo membership as a set',async()=>{
 for(const mode of ['reorder','bid','descendant','forecast','new-child']as const){const x=fixture(cases[23]);try{
  const target=resource('keywordPlanAdGroups','802'),p=await x.prepare([{update:{resourceName:target,name:'Reviewed group'},updateMask:'name'}]);assert.equal(p.success,true,JSON.stringify(p));
  assert.ok(JSON.stringify(p).includes('existing positive'));assert.ok(JSON.stringify(p).includes('existing negative'));
  if(mode==='reorder')x.records.get(resource('keywordPlanCampaigns','801'))!.geoTargets.reverse();
  if(mode==='bid')x.records.get(resource('keywordPlanCampaigns','801'))!.cpcBidMicros='9000000';
  if(mode==='descendant')x.records.get(resource('keywordPlanAdGroupKeywords','803'))!.text='Changed';
  if(mode==='forecast')x.records.get(resource('keywordPlans','800'))!.forecastPeriod={dateInterval:'NEXT_QUARTER'};
  if(mode==='new-child'){const name=resource('keywordPlanAdGroupKeywords','805');x.records.set(name,{resourceName:name,keywordPlanAdGroup:target,text:'new keyword',matchType:'EXACT'});}
  const r=await x.execute(p,{spend_change_confirmed:false});assert.equal(r.success,mode==='reorder',JSON.stringify(r));
  if(mode!=='reorder'){assert.equal(r.error.code,'STATE_CHANGED');assert.ok(r.error.details.changed_fields.length);assert.equal(x.writes(),0);}
 }finally{x.store.close();}}
});

test('planning hierarchy follows pages and rejects loops, duplicates, foreign parents, missing ancestors and provider failures',async()=>{
 for(const mode of ['paged','loop','duplicate','foreign','missing','error','partial']as const){const x=fixture(cases[23]);try{
  if(mode==='missing')x.records.delete(resource('keywordPlans','800'));
  x.onRead((body,data)=>{
   if(!body.query.includes('FROM keyword_plan_ad_group_keyword WHERE keyword_plan_ad_group_keyword.keyword_plan_ad_group IN'))return data;
   if(mode==='error')return {error:{code:503,message:'Synthetic failure'}};
   if(mode==='partial')return {...data,hasMore:true};
   if(mode==='foreign')return {...data,results:[{keywordPlanAdGroupKeyword:{...data.results[0].keywordPlanAdGroupKeyword,keywordPlanAdGroup:resource('keywordPlanAdGroups','999')}}]};
   if(mode==='duplicate')return {...data,results:[...data.results,...data.results]};
   if(mode==='loop')return {results:[],nextPageToken:'same'};
   if(mode==='paged')return body.pageToken?data:{results:[],nextPageToken:'page-two'};
   return data;
  });
  const p=await x.prepare([{create:cases[23]!.create}]);assert.equal(p.success,mode==='paged',JSON.stringify(p));assert.equal(x.writes(),0);
  if(mode==='paged')assert.ok(x.calls.some(c=>c.body.pageToken==='page-two'));
 }finally{x.store.close();}}
});

test('planning writes reject invalid dates, negative bids, mismatched scope and impossible campaign counts',async()=>{
 const invalid: [number,JsonObject][]=[
  [21,{create:{name:'Plan',forecastPeriod:{dateInterval:'NEXT_MONTH',dateRange:{startDate:'2027-01-01',endDate:'2027-02-01'}}}}],
  [21,{create:{name:'Plan',forecastPeriod:{dateRange:{startDate:'2027-02-30',endDate:'2027-03-31'}}}}],
  [21,{create:{name:'Plan',forecastPeriod:{dateRange:{startDate:'2027-01-01',endDate:'2028-01-01'}}}}],
  [22,{create:{...cases[22]!.create,keywordPlan:resource('keywordPlans','800')}}],
  [22,{create:{...cases[22]!.create,cpcBidMicros:'-1'}}],
  [22,{create:{...cases[22]!.create,languageConstants:['languageConstants/1000','languageConstants/1001']}}],
  [22,{create:{...cases[22]!.create,geoTargets:[{geoTargetConstant:'geoTargetConstants/2682'},{geoTargetConstant:'geoTargetConstants/2682'}]}}],
  [23,{create:{...cases[23]!.create,keywordPlanCampaign:'customers/999/keywordPlanCampaigns/801'}}],
  [24,{create:{...cases[24]!.create,negative:true,cpcBidMicros:'10'}}],
  [25,{create:{...cases[25]!.create,negative:false}}],
  [24,{update:{resourceName:resource('keywordPlanAdGroupKeywords','803'),negative:true},updateMask:'negative'}],
  [23,{update:{resourceName:resource('keywordPlanAdGroups','802'),name:'Unmasked',cpcBidMicros:'1'},updateMask:'name'}]
 ];
 for(const [index,op]of invalid){const x=fixture(cases[index]);try{const p=await x.prepare([op]);assert.equal(p.success,false,JSON.stringify(p));assert.equal(x.writes(),0);}finally{x.store.close();}}
 const x=fixture(cases[24]);try{x.records.get(resource('keywordPlanAdGroupKeywords','803'))!.negative=true;const p=await x.prepare([{update:{resourceName:resource('keywordPlanAdGroupKeywords','803'),cpcBidMicros:'1000000'},updateMask:'cpcBidMicros'}]);assert.equal(p.success,false);assert.equal(x.writes(),0);}finally{x.store.close();}
});

test('planning replacements and explicit clears detect provider-ignored fields without requiring spend approval',async()=>{
 for(const [index,id,update]of [[21,'800',{forecastPeriod:{dateRange:{startDate:'2027-01-01',endDate:'2027-02-01'}}}],[21,'800',{forecastPeriod:null}],[22,'801',{geoTargets:[],languageConstants:[]}],[23,'802',{cpcBidMicros:null}]] as [number,string,JsonObject][]){
  for(const ignored of [false,true]){const row=cases[index]!,x=fixture(row);try{
   const target=resource(row.route,id);if(index===23)x.records.get(target)!.cpcBidMicros='1000000';const old=structuredClone(x.records.get(target)!);
   const p=await x.prepare([{update:{resourceName:target,...update},updateMask:Object.keys(update).join(',')}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p,{spend_change_confirmed:false})).success,true);
   if(ignored){if(index===21&&update.forecastPeriod)x.records.get(target)!.forecastPeriod.dateInterval='NEXT_MONTH';else for(const key of Object.keys(update))x.records.get(target)![key]=old[key];}
   else for(const key of Object.keys(update))if(update[key]===null||Array.isArray(update[key])&&!update[key].length)delete x.records.get(target)![key]; // ProtoJSON defaults are omitted.
   const v=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(v.data.status,ignored?'inconclusive':'verified',JSON.stringify(v));
  }finally{x.store.close();}}
 }
});

test('planning bids stay hypothetical while deletion, deployment and account grants remain enforced',async()=>{
 const x=fixture(cases[22]);try{
  saveSpendPolicy(x.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false,allow_deletion:false,max_budget_native:0,max_daily_increase_native:0}});
  const p=await x.prepare([{create:cases[22]!.create}]);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p,{spend_change_confirmed:false})).success,true);
  const removed=await x.prepare([{remove:resource('keywordPlanCampaigns','500')}]);assert.equal(removed.success,false);assert.equal(removed.error.code,'POLICY_DELETION_FORBIDDEN');
 }finally{x.store.close();}
 const revoked=fixture(cases[24]);try{const p=await revoked.prepare([{create:cases[24]!.create}]);assert.equal(p.success,true);revoked.revoke();const r=await revoked.execute(p);assert.equal(r.success,false);assert.equal(revoked.writes(),0);}finally{revoked.store.close();}
 const disabled=fixture(cases[24],false);try{const p=await disabled.prepare([{create:cases[24]!.create}]);if(p.success)assert.equal((await disabled.execute(p)).error.code,'LIVE_WRITES_DISABLED');else assert.equal(p.error.code,'LIVE_WRITES_DISABLED');assert.equal(disabled.writes(),0);}finally{disabled.store.close();}
});

test('planning parent deletion freezes descendants and rejects a concurrent child edit',async()=>{
 const x=fixture(cases[21]);try{const p=await x.prepare([{remove:resource('keywordPlans','800')}]);assert.equal(p.success,true,JSON.stringify(p));assert.ok(JSON.stringify(p).includes('existing positive'));x.records.get(resource('keywordPlanAdGroupKeywords','803'))!.text='Changed before deletion';const r=await x.execute(p);assert.equal(r.error.code,'STATE_CHANGED');assert.equal(x.writes(),0);}finally{x.store.close();}
});

test('planning context detects a race or revocation while reading paged descendants',async()=>{
 for(const mode of ['race','revoke']as const){const x=fixture(cases[24]);try{
  let seen=false;x.onRead((body,data)=>{if(!seen&&body.query.includes('FROM keyword_plan_ad_group_keyword WHERE keyword_plan_ad_group_keyword.keyword_plan_ad_group IN')){seen=true;if(mode==='race')x.records.get(resource('keywordPlans','800'))!.name='Concurrent rename';else x.revoke();}return data;});
  assert.equal((await x.prepare([{create:cases[24]!.create}])).success,false);assert.equal(x.writes(),0);
 }finally{x.store.close();}}
});

test('planning receipts and concurrency retain uncertainty without duplicate provider mutations',async()=>{
 for(const mode of ['foreign','partial','lost','concurrent']as const){const x=fixture(cases[24]);try{
  const p=await x.prepare([{create:cases[24]!.create}]);assert.equal(p.success,true);
  if(mode==='foreign')x.foreign();if(mode==='partial')x.partial();if(mode==='lost')x.lose();
  if(mode==='concurrent'){await Promise.all([x.execute(p),x.execute(p)]);assert.equal(x.writes(),1);}
  else{assert.equal((await x.execute(p)).success,false);assert.equal(x.writes(),1);const replay=await x.execute(p);assert.equal(replay.success,false);assert.equal(x.writes(),1);}
 }finally{x.store.close();}}
});

test('planning parent moves capture both hierarchies and verification binds the new parent',async()=>{
 const x=fixture(cases[23]);try{
  const newCampaign=resource('keywordPlanCampaigns','811');x.records.set(newCampaign,{resourceName:newCampaign,name:'Other planning campaign',keywordPlan:resource('keywordPlans','810'),cpcBidMicros:'9000000',keywordPlanNetwork:'GOOGLE_SEARCH'});
  const target=resource('keywordPlanAdGroups','802'),p=await x.prepare([{update:{resourceName:target,keywordPlanCampaign:newCampaign},updateMask:'keywordPlanCampaign'}]);assert.equal(p.success,true,JSON.stringify(p));
  const snapshot=p.data.before_state.find((v:JsonObject)=>v.amcpKeywordPlanTree);assert.deepEqual(snapshot.amcpKeywordPlanTree.roots,[resource('keywordPlans','800'),resource('keywordPlans','810')]);
  assert.equal((await x.execute(p)).success,true);const v=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);assert.equal(v.data.status,'verified',JSON.stringify(v));
 }finally{x.store.close();}
});
