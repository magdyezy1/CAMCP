import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {googleConfigurationContracts} from '../src/google-configuration-writes.js';
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
 {route:'customerNegativeCriteria',rpc:'customer_negative_criterion_mutate_customer_negative_criteria',entity:'customer_negative_criterion',create:{placement:{url:'example.com'}},id:'500'}
];
const fields=JSON.parse(fs.readFileSync('tests/fixtures/google-configuration-fields-v23.json','utf8')).resources;
function fixture(row=cases[0]!){
 const store=new Store(':memory:',Buffer.alloc(32,79).toString('base64')),records=new Map<string,JsonObject>(),calls:JsonObject[]=[];
 const connection={id:'google',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:[]};
 const credentials={accessToken:'synthetic',developerToken:'synthetic'};store.putConnection(owner,connection,credentials);
 const seed=(kind:string,id:string,value:JsonObject)=>records.set(resource(kind,id),{resourceName:resource(kind,id),...value});
 seed('campaigns','100',{name:'Campaign',status:'PAUSED',advertisingChannelType:'SEARCH',campaignBudget:resource('campaignBudgets','50')});
 seed('adGroups','200',{name:'Group',status:'PAUSED',campaign:resource('campaigns','100')});
 seed('adGroupAds','200~300',{status:'PAUSED',ad:{id:'300',finalUrls:['https://example.com']}});
 seed('adGroupCriteria','200~400',{adGroup:resource('adGroups','200'),type:'KEYWORD',status:'PAUSED',keyword:{text:'family homes',matchType:'EXACT'}});
 seed('labels','900',{name:'Existing label',status:'ENABLED',textLabel:{backgroundColor:'#fff',description:'Existing description'}});
 seed('customizerAttributes','600',{name:'Season',type:'TEXT',status:'ENABLED'});
 seed('assetGroups','700',{name:'Asset group',status:'PAUSED',campaign:resource('campaigns','100')});
 let writes=0,reads=0,foreignReceipt=false,partialReceipt=false,lostResponse=false,incomplete=false,revoke=false;
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const body=JSON.parse(String(init?.body)),path=new URL(String(url)).pathname;calls.push({path,body});
  if(path.endsWith('googleAds:search')){
   reads++;const match=/^SELECT (.+) FROM ([a-z_]+)/.exec(body.query)!;assert.ok(match,'The request must be an exact GAQL query.');const entity=match[2]!;
   const data=entity==='customer'?[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC'}}]:[...body.query.matchAll(/'(customers\/[^']+)'/g)].flatMap(m=>{
    const record=records.get(m[1]);if(!record)return [];
    const projected:JsonObject={};for(const f of match[1]!.split(', ')){assert.ok(f.startsWith(entity+'.'));const key=f.slice(entity.length+1);if(fields[entity])assert.equal(fields[entity].fields[key]?.selectable,true,'Undocumented GAQL field '+f);const value=get(record,key);if(value!==undefined&&value!=='')set(projected,key,value);}
    return [{[camel(entity)]:projected}];
   });
   if(revoke)store.putConnection(owner,{...connection,writeAccounts:[]},credentials);
   return Response.json({...(data.length?{results:data}:{}),fieldMask:match[1],queryResourceConsumption:String(100+reads),...(incomplete?{nextPageToken:'remaining'}:{})});
  }
  assert.equal(path,'/v23/customers/123/'+row.route+':mutate');writes++;
  const results=body.operations.map((op:JsonObject)=>{
   const collection=({AdGroupCriterionCustomizers:'adGroupCriterionCustomizers',CustomerCustomizers:'customerCustomizers'} as Record<string,string>)[row.route]??row.route;
   const name=op.remove??op.update?.resourceName??resource(collection,row.id);
   if(op.remove)records.delete(name);
   else if(op.update){const record=records.get(name)!;for(const f of op.updateMask.split(','))set(record,f,get(op.update,f));}
   else records.set(name,{...op.create,resourceName:name,...(['labels','customizerAttributes','campaignCustomizers','adGroupCustomizers','AdGroupCriterionCustomizers','CustomerCustomizers','campaignGroups'].includes(row.route)?{status:'ENABLED'}:{}),...(row.route==='customerNegativeCriteria'?{type:'PLACEMENT'}:{})});
   return {resourceName:foreignReceipt?name.replace('customers/123/','customers/999/'):name};
  });
  if(lostResponse)throw Error('Synthetic response lost after provider mutation');
  return Response.json({...(!partialReceipt?{results}:{results:[]}),...(partialReceipt?{partialFailureError:{code:3,message:'Synthetic error'}}:{})});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(operations:JsonObject[])=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'google_ads_v23_'+row.rpc,account_id:'123',payload:{operations}}},actor);
 const execute=(p:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 return {store,service,records,calls,prepare,execute,writes:()=>writes,reads:()=>reads,foreign:()=>{foreignReceipt=true;},partial:()=>{partialReceipt=true;},lose:()=>{lostResponse=true;},paginate:()=>{incomplete=true;},revoke:()=>{revoke=true;}};
}

test('all configuration snapshot fields are selectable in the official v23 resource references',()=>{
 assert.equal(cases.length,Object.keys(googleConfigurationContracts).length);
 for(const c of Object.values(googleConfigurationContracts))for(const field of ['resource_name',...c.fields])assert.equal(fields[c.resource]?.fields[field]?.selectable,true,c.resource+'.'+field);
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
