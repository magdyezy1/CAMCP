import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {actionContracts} from '../src/action-contracts.js';

test('conversion-action RPC and create/update/remove aliases have an executable reviewed family',()=>{
 const names=['google_ads_v23_conversion_action_mutate_conversion_actions','CREATE_CONVERSION_ACTION','UPDATE_CONVERSION_ACTION','REMOVE_CONVERSION_ACTION'];
 const rows=actionContracts(new Registry());
 for(const name of names){const row=rows.find(r=>r.gateway==='google_ads_native_action'&&r.action===name);assert.ok(row,name);assert.equal(row.family,'google_conversion_actions',name);assert.equal(row.status,'reviewed_write_family');}
});

import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {assertGoogleConversionAction,googleConversionActionKind,googleConversionActionTypes,googleConversionActionCategories,readGoogleConversionActionState} from '../src/google-conversion-actions.js';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject} from '../src/types.js';

test('workflow references validate the native result index and resource-name pointer before writes',async()=>{for(const pointer of ['/data/results/99/resourceName','/data/results/0/name','/data/results/0']){const f=fixture();try{
 const steps=[{id:'definition',kind:'write',gateway,connection_id:f.c.id,account_id:'123',arguments:f.args([{create:create()}]),depends_on:[]},{id:'goal',kind:'write',gateway,connection_id:f.c.id,account_id:'123',arguments:{action:'google_ads_v23_custom_conversion_goal_mutate_custom_conversion_goals',account_id:'123',payload:{operations:[{create:{name:'Goal',conversionActions:[{$ref:'definition#'+pointer}]}}]}},depends_on:['definition']}];
 const made=await f.service.call('amcp_campaign',{action:'create',name:'Invalid result pointer',brief:'Synthetic local contract check.',steps},actor);assert.equal(made.success,true,JSON.stringify(made));
 const p=await f.service.call('amcp_campaign',{action:'prepare_next',id:made.data.id},actor);assert.equal(p.data.blocked,true,JSON.stringify(p));assert.equal(p.data.missing_requirements[0].error.code,'INVALID_REFERENCE');assert.equal(f.writes(),0);
 }finally{f.store.close();}}});


test('a verified new conversion can immediately enter a separately reviewed custom goal',async()=>{const f=fixture();try{
 const steps=[
  {id:'definition',kind:'write',gateway,connection_id:f.c.id,account_id:'123',arguments:f.args([{create:create()}]),depends_on:[]},
  {id:'goal',kind:'write',gateway,connection_id:f.c.id,account_id:'123',arguments:{action:'google_ads_v23_custom_conversion_goal_mutate_custom_conversion_goals',account_id:'123',connection_id:f.c.id,payload:{operations:[{create:{name:'Approved goal',conversionActions:[{$ref:'definition#/data/results/0/resourceName'}]}}]}},depends_on:['definition']}
 ];
 const workflow=await f.service.call('amcp_campaign',{action:'create',name:'User-approved conversion and goal',brief:'Synthetic secondary purchase definition and custom goal. Campaign attachment is separately authorized.',steps},actor);assert.equal(workflow.success,true,JSON.stringify(workflow));
 for(const step of ['definition','goal']){const p=await f.service.call('amcp_campaign',{action:'prepare_next',id:workflow.data.id},actor);assert.equal(p.success,true,JSON.stringify(p));assert.equal(p.data.step_id,step,JSON.stringify(p));const done=await f.service.call('amcp_campaign',{action:'execute_next',id:workflow.data.id,review_id:p.data.review.review_id,idempotency_key:p.data.review.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);assert.equal(done.success,true,JSON.stringify(done));assert.equal(done.data.steps.find((s:JsonObject)=>s.id===step).status,'verified',JSON.stringify(done));if(step==='goal')assert.equal(done.data.state,'complete');}
 assert.deepEqual(f.tables.custom_conversion_goal![0]!.conversionActions,[rn('conversionActions','1000')]);assert.equal(f.writes(),2);
 }finally{f.store.close();}});
test('direct conversion execution still requires server-verified preparation',async()=>{const f=fixture();try{const out=await f.service.call(gateway,{...f.args([update()]),dry_run:false,confirmed:true,spend_change_confirmed:true,idempotency_key:'11111111-1111-4111-8111-111111111111'},actor);assert.equal(out.error.code,'WRITE_REVIEW_REQUIRED');assert.equal(f.writes(),0);}finally{f.store.close();}});


test('missing existing standard goals cannot become a complete conversion-definition review',async()=>{for(const table of ['customer_conversion_goal','campaign_conversion_goal']){const f=fixture();try{f.tables[table]!.shift();assert.equal((await f.prepare()).success,false,table);assert.equal(f.writes(),0);}finally{f.store.close();}}});
test('native evidence covers every conversion query field, allowed enum and mutation surface',async()=>{const proof=JSON.parse(readFileSync('tests/fixtures/google-conversion-actions-v23.json','utf8')),f=fixture();try{
 assert.equal(proof.version,'v23');assert.equal(proof.route,'/v23/customers/{customer_id=*}/conversionActions:mutate');
 for(const type of googleConversionActionTypes)assert.ok(proof.enums.conversion_action_type[type]>1,type);
 for(const category of googleConversionActionCategories)assert.ok(proof.enums.conversion_action_category[category]>1,category);
 assert.deepEqual(proof.fields.ValueSettings,['always_use_default_value','default_currency_code','default_value']);
 for(const source of Object.values(proof.sources)as JsonObject[])assert.match(source.sha256,/^[a-f0-9]{64}$/);
 const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));for(const query of f.calls.map(c=>c.body.query).filter(q=>q?.includes(' FROM conversion_action'))){for(const field of query.slice(7,query.indexOf(' FROM ')).split(', ').map((s:string)=>s.replace('conversion_action.',''))){assert.equal(proof.fieldEvidence.fields[field]?.selectable,true,field);assert.equal(proof.fieldEvidence.fields[field]?.repeated,false,field);const [parent,child]=field.split('.');assert.ok(proof.fields.ConversionAction.includes(parent),field);if(child)assert.ok(proof.fields[parent==='value_settings'?'ValueSettings':'AttributionModelSettings'].includes(child),field);}}
 }finally{f.store.close();}});

const gateway='google_ads_native_action',rpc='google_ads_v23_conversion_action_mutate_conversion_actions';
const actor={tenantId:'conversion-actions',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const};
const rn=(collection:string,id:string)=>'customers/123/'+collection+'/'+id;
const actionId=rn('conversionActions','900'),budgetId=rn('campaignBudgets','10');
const create=(extra:JsonObject={})=>({name:'Approved purchase definition',status:'ENABLED',type:'WEBPAGE',category:'PURCHASE',primaryForGoal:false,countingType:'ONE_PER_CLICK',clickThroughLookbackWindowDays:'30',viewThroughLookbackWindowDays:'1',valueSettings:{defaultValue:0,defaultCurrencyCode:'SAR',alwaysUseDefaultValue:false},attributionModelSettings:{attributionModel:'GOOGLE_ADS_LAST_CLICK'},...extra});
const update=(fields:JsonObject={name:'Renamed'},id=actionId)=>({update:{resourceName:id,...fields},updateMask:Object.keys(fields).flatMap(k=>['valueSettings','attributionModelSettings'].includes(k)?Object.keys(fields[k]).map(f=>k+'.'+f):[k]).join(',')});
const camel=(s:string)=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
function fixture(file=':memory:',allowWrites=true){
 const store=new Store(file,Buffer.alloc(32,39).toString('base64')),c:Connection={id:'11111111-1111-4111-8111-111111111111',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],scopes:['https://www.googleapis.com/auth/adwords'],enabled:true,label:'Synthetic conversion customer'};
 if(!store.listConnections(actor.tenantId).length)store.putConnection(owner,c,{accessToken:'synthetic',developerToken:'synthetic'});
 const native=(id:string,extra:JsonObject={})=>({...create({name:'Existing '+id,primaryForGoal:true}),resourceName:rn('conversionActions',id),id,origin:'WEBSITE',ownerCustomer:'customers/123',...extra});
 const tables:Record<string,JsonObject[]>={
  customer:[{id:'123',currencyCode:'SAR',timeZone:'Asia/Riyadh',conversionTrackingSetting:{googleAdsConversionCustomer:'customers/123'}}],
  conversion_action:[native('900'),native('901',{status:'REMOVED'}),{resourceName:rn('conversionActions','902'),id:'902',name:'System observation',status:'HIDDEN',type:'GOOGLE_HOSTED',origin:'GOOGLE_HOSTED',category:'GET_DIRECTIONS'}],
  customer_conversion_goal:[{resourceName:rn('customerConversionGoals','4~2'),category:'PURCHASE',origin:'WEBSITE',biddable:true}],
  campaign_conversion_goal:['100','101'].map((id,i)=>({resourceName:rn('campaignConversionGoals',id+'~4~2'),campaign:rn('campaigns',id),category:'PURCHASE',origin:'WEBSITE',biddable:!i})),
  conversion_goal_campaign_config:['100','101'].map((id,i)=>({resourceName:rn('conversionGoalCampaignConfigs',id),campaign:rn('campaigns',id),goalConfigLevel:i?'CAMPAIGN':'CUSTOMER'})),
  custom_conversion_goal:[],
  campaign:['100','101'].map(id=>({resourceName:rn('campaigns',id),name:'Campaign '+id,status:'PAUSED',advertisingChannelType:'SEARCH',biddingStrategyType:'MAXIMIZE_CONVERSIONS',campaignBudget:budgetId})),
  campaign_budget:[{resourceName:budgetId,name:'Budget',status:'ENABLED',amountMicros:'50000000'}],
  bidding_strategy:[]
 };
 let reads=0,writes=0,nextId=1000,mode='success',afterRead:((resource:string,query:string)=>void)|undefined;
 const calls:JsonObject[]=[];
 function addGoals(row:JsonObject){
  const category={PURCHASE:4,PAGE_VIEW:3,SIGNUP:5,PHONE_CALL_LEAD:11}[row.category as 'PURCHASE']??2,origin=row.origin==='CALL_FROM_ADS'?5:2;
  if(!tables.customer_conversion_goal!.some(g=>g.category===row.category&&g.origin===row.origin))tables.customer_conversion_goal!.push({resourceName:rn('customerConversionGoals',category+'~'+origin),category:row.category,origin:row.origin,biddable:true});
  for(const campaign of tables.campaign!){if(tables.campaign_conversion_goal!.some(g=>g.campaign===campaign.resourceName&&g.category===row.category&&g.origin===row.origin))continue;
   const biddable=!tables.campaign_conversion_goal!.some(g=>g.campaign===campaign.resourceName&&g.category===row.category&&g.biddable===false);
   tables.campaign_conversion_goal!.push({resourceName:rn('campaignConversionGoals',campaign.resourceName.split('/').at(-1)+'~'+category+'~'+origin),campaign:campaign.resourceName,category:row.category,origin:row.origin,biddable});
  }
 }
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),body=JSON.parse(String(init?.body));assert.equal(u.origin,'https://googleads.googleapis.com');assert.equal(init?.method,'POST');calls.push({path:u.pathname,body});
  if(u.pathname.endsWith('googleAds:search')){
   reads++;const entity=/ FROM ([a-z_]+)/.exec(body.query)![1]!,all=structuredClone(tables[entity]??[]);let rows=all;
   if(entity==='campaign'&&body.query.includes("campaign.advertising_channel_type = 'MULTI_CHANNEL'"))rows=all.filter(r=>r.advertisingChannelType==='MULTI_CHANNEL');
   else if(body.query.includes("campaign.advertising_channel_type != 'MULTI_CHANNEL'"))rows=all.filter(r=>r.advertisingChannelType!=='MULTI_CHANNEL');
   if(entity==='conversion_action'&&body.query.includes("!= 'REMOVED'"))rows=rows.filter(r=>r.status!=='REMOVED');
   if(mode==='missing_budget'&&entity==='campaign_budget')rows=[];
   if(mode==='missing_target'&&entity==='conversion_action')rows=rows.filter(r=>r.resourceName!==actionId);
   if(mode==='duplicate'&&entity==='conversion_action')rows.push(rows[0]!);
   if(mode==='foreign'&&entity==='conversion_action')rows[0]!.resourceName='customers/999/conversionActions/900';
   if(mode==='missing_config'&&entity==='conversion_goal_campaign_config')rows=[];
   if(mode==='reverse')rows.reverse();
   let page:string|undefined;if(mode==='pages'&&entity==='conversion_action'){if(!body.pageToken){rows=rows.slice(0,1);page='page2';}else rows=rows.slice(1);}
   if(mode==='loop'&&entity==='conversion_action')page='same';
   const data:JsonObject={...(rows.length?{results:rows.map(v=>({[camel(entity)]:v}))}:{}),queryResourceConsumption:String(reads),...(page?{nextPageToken:page}:{})};
   if(mode==='count'&&entity==='conversion_action')data.totalResultsCount='999';
   if(mode==='partial')data.partialFailureError={code:3};
   if(mode==='unknown')data.invented=true;
   afterRead?.(entity,body.query);
   if(mode==='read_error')return Response.json({error:{code:403}},{status:403});
   return Response.json(data);
  }
  if(u.pathname==='/v23/customers/123/customConversionGoals:mutate'){
   writes++;const results=body.operations.map((op:JsonObject,i:number)=>{assert.ok(op.create);const id=String(500+i),name=rn('customConversionGoals',id);tables.custom_conversion_goal!.push({...op.create,resourceName:name,id,status:'ENABLED'});return {resourceName:name};});return Response.json({results});
  }
  assert.equal(u.pathname,'/v23/customers/123/conversionActions:mutate');writes++;
  const results=body.operations.map((op:JsonObject)=>{
   const id=op.create?String(nextId++):String(op.update?.resourceName??op.remove).split('/').at(-1)!,name=rn('conversionActions',id);
   if(mode!=='ignored'){
    if(op.create){const row={...op.create,resourceName:name,id,ownerCustomer:'customers/123',origin:['AD_CALL','UPLOAD_CALLS'].includes(op.create.type)?'CALL_FROM_ADS':'WEBSITE'};tables.conversion_action!.push(row);if(mode!=='ignore_goals')addGoals(row);}
    else{const row=tables.conversion_action!.find(a=>a.resourceName===name)!;if(op.remove)row.status='REMOVED';else for(const [k,v]of Object.entries(op.update))row[k]=['valueSettings','attributionModelSettings'].includes(k)?{...row[k],...v as JsonObject}:v;}
   }return {resourceName:name};
  });
  if(mode==='lost')throw Error('Synthetic lost response after native commit');
  if(mode==='empty')return Response.json({});
  if(mode==='partial_receipt')return Response.json({results,partialFailureError:{code:3}});
  if(mode==='foreign_receipt')results[0].resourceName='customers/999/conversionActions/1000';
  if(mode==='reused')results[0].resourceName=actionId;
  if(mode==='duplicate_receipt')results[1].resourceName=results[0].resourceName;
  return Response.json({results});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites,requireBeforeState:true,maxBudgetChange:0});
 const args=(operations:JsonObject[],extra:JsonObject={})=>({action:rpc,account_id:'123',connection_id:c.id,payload:{operations,partialFailure:false,validateOnly:false},...extra});
 const prepare=(operations:JsonObject[]=[update()],extra:JsonObject={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:args(operations,extra)},actor);
 const execute=(r:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:r.data.review_id,idempotency_key:r.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 const verify=(r:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:r.data.review_id},actor);
 return {store,c,tables,service,args,prepare,execute,verify,calls,mode:(v:string)=>{mode=v;},onRead:(fn:typeof afterRead)=>{afterRead=fn;},writes:()=>writes,addGoals};
}
async function roundtrip(f:ReturnType<typeof fixture>,ops:JsonObject[]){
 const prepared=await f.prepare(ops);assert.equal(prepared.success,true,JSON.stringify(prepared));const executed=await f.execute(prepared);assert.equal(executed.data?.success,true,JSON.stringify(executed));const verified=await f.verify(prepared);assert.equal(verified.data?.status,'verified',JSON.stringify(verified));return prepared;
}
for(const type of googleConversionActionTypes)test('conversion definition '+type+' creates, verifies and replays once',async()=>{
 const f=fixture();try{const call=['AD_CALL','WEBSITE_CALL'].includes(type),value=create({type,name:'Explicit '+type,primaryForGoal:true,...(call?{phoneCallDurationSeconds:'60',valueSettings:{defaultValue:12.5,defaultCurrencyCode:'SAR',alwaysUseDefaultValue:true}}:{})});if(call)delete (value as JsonObject).viewThroughLookbackWindowDays;
  const r=await roundtrip(f,[{create:value}]);assert.equal((await f.execute(r)).data.replayed,true);assert.equal(f.writes(),1);assert.equal(f.tables.conversion_action!.at(-1)!.valueSettings.defaultValue,call?12.5:0);
 }finally{f.store.close();}
});
test('new category creates standard goals without changing existing campaign-specific biddability',async()=>{const f=fixture();try{await roundtrip(f,[{create:create({category:'PAGE_VIEW',primaryForGoal:true})}]);assert.equal(f.tables.customer_conversion_goal!.length,2);assert.equal(f.tables.campaign_conversion_goal!.length,4);assert.equal(f.tables.campaign_conversion_goal![1]!.biddable,false);}finally{f.store.close();}});
test('a new origin respects an existing disabled goal in the same category',async()=>{const f=fixture();try{const row=create({type:'AD_CALL',phoneCallDurationSeconds:'120',valueSettings:{defaultValue:20,defaultCurrencyCode:'SAR',alwaysUseDefaultValue:true}});delete (row as JsonObject).viewThroughLookbackWindowDays;await roundtrip(f,[{create:row}]);assert.equal(f.tables.campaign_conversion_goal!.find(g=>g.campaign===rn('campaigns','101')&&g.origin==='CALL_FROM_ADS')!.biddable,false);}finally{f.store.close();}});
test('exact leaf updates preserve unrelated value settings and secondary custom-goal relationships',async()=>{const f=fixture();try{
 f.tables.custom_conversion_goal!.push({resourceName:rn('customConversionGoals','50'),id:'50',name:'Custom',status:'ENABLED',conversionActions:[actionId]});
 await roundtrip(f,[update({primaryForGoal:false,valueSettings:{defaultValue:100},attributionModelSettings:{attributionModel:'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN'}})]);
 assert.equal(f.tables.conversion_action![0]!.valueSettings.defaultCurrencyCode,'SAR');assert.equal(f.tables.conversion_action![0]!.primaryForGoal,false);assert.deepEqual(f.tables.custom_conversion_goal![0]!.conversionActions,[actionId]);
 }finally{f.store.close();}});
test('removal requires custom-goal detachment and verifies retained removed status',async()=>{const f=fixture();try{f.tables.custom_conversion_goal!.push({resourceName:rn('customConversionGoals','50'),id:'50',name:'Custom',status:'ENABLED',conversionActions:[actionId]});assert.equal((await f.prepare([{remove:actionId}])).success,false);assert.equal(f.writes(),0);f.tables.custom_conversion_goal=[];await roundtrip(f,[{remove:actionId}]);assert.equal(f.tables.conversion_action![0]!.status,'REMOVED');}finally{f.store.close();}});
test('legacy conversion create/update/remove share RPC validation, reads and verification',async()=>{const f=fixture();try{
 const rows=[['CREATE_CONVERSION_ACTION',{resource:create()}],['UPDATE_CONVERSION_ACTION',{resource_name:rn('conversionActions','1000'),resource:{name:'Legacy rename'},update_mask:'name'}],['REMOVE_CONVERSION_ACTION',{resource_name:rn('conversionActions','1000')}]] as const;
 for(const [action,payload]of rows){const p=await f.prepare([],{action,payload});assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).data.success,true);assert.equal((await f.verify(p)).data.status,'verified');}assert.equal(f.writes(),3);
 }finally{f.store.close();}});
test('invalid business definitions and mutation envelopes stop before provider reads',async()=>{const f=fixture();try{
 const bad:JsonObject[]=[{create:create({primaryForGoal:undefined})},{create:create({primaryForGoal:'true'})},{create:create({name:' x '})},{create:create({name:'a'.repeat(101)})},{create:create({type:'GOOGLE_ANALYTICS_4_CUSTOM'})},{create:create({type:'WEBPAGE_ONCLICK'})},{create:create({status:'PAUSED'})},{create:create({includeInConversionsMetric:true})},{create:create({appId:'app'})},{create:create({phoneCallDurationSeconds:'60'})},{create:create({type:'AD_CALL',phoneCallDurationSeconds:'60'})},{create:create({clickThroughLookbackWindowDays:'31'})},{create:create({viewThroughLookbackWindowDays:0})},{create:create({valueSettings:{defaultValue:1}})},{create:create({valueSettings:{defaultValue:-1,defaultCurrencyCode:'SAR',alwaysUseDefaultValue:true}})},{create:create({attributionModelSettings:{attributionModel:'GOOGLE_SEARCH_ATTRIBUTION_LINEAR'}})},update({type:'AD_CALL'}),update({status:'REMOVED'}),update({ownerCustomer:'customers/999'}),update({name:null}),{...update(),updateMask:'*'},{...update({valueSettings:{defaultValue:2}}),updateMask:'valueSettings'},{...update(),updateMask:'name,name'},{remove:'customers/999/conversionActions/900'},{remove:actionId,updateMask:'name'},{create:create(),remove:actionId}];
 for(const op of bad)assert.equal((await f.prepare([op])).success,false,JSON.stringify(op));
 for(const extra of [{partialFailure:true},{partialFailure:'false'},{validateOnly:true},{responseContentType:'MUTABLE_RESOURCE'}])assert.equal((await f.prepare([],{payload:{operations:[{create:create()}],...extra}})).success,false,JSON.stringify(extra));
 assert.equal(f.calls.length,0);
 }finally{f.store.close();}});
test('own customer, full target settings and complete goal dependencies are mandatory',async()=>{for(const mode of ['manager','tracking','app','foreign_owner','hidden','imported','missing_primary','missing_values','missing_id','missing_config','missing_budget','missing_target','duplicate_name','new_category']){const f=fixture();try{
 let ops=[update()];if(mode==='manager')f.tables.customer![0]!.manager=true;if(mode==='tracking')f.tables.customer![0]!.conversionTrackingSetting.googleAdsConversionCustomer='customers/999';
 if(mode==='app')f.tables.campaign!.push({...f.tables.campaign![0],resourceName:rn('campaigns','200'),advertisingChannelType:'MULTI_CHANNEL'});
 if(mode==='foreign_owner')f.tables.conversion_action![0]!.ownerCustomer='customers/999';if(mode==='hidden')f.tables.conversion_action![0]!.status='HIDDEN';if(mode==='imported')f.tables.conversion_action![0]!.type='GOOGLE_ANALYTICS_4_CUSTOM';
 if(mode==='missing_primary')delete f.tables.conversion_action![0]!.primaryForGoal;if(mode==='missing_values')delete f.tables.conversion_action![0]!.valueSettings;if(mode==='missing_id')delete f.tables.conversion_action![0]!.id;
 if(mode.startsWith('missing_')&&!['missing_primary','missing_values','missing_id'].includes(mode))f.mode(mode);
 if(mode==='duplicate_name')ops=[update({name:'Existing 901'})];if(mode==='new_category')ops=[update({category:'PAGE_VIEW'})];
 assert.equal((await f.prepare(ops)).success,false,mode);assert.equal(f.writes(),0);
 }finally{f.store.close();}}});
test('foreign and system observations never authorize their mutation or block an unrelated owned target',async()=>{const f=fixture();try{f.tables.conversion_action!.push({...f.tables.conversion_action![0],resourceName:rn('conversionActions','903'),id:'903',name:'Former manager',ownerCustomer:'customers/999'});await roundtrip(f,[update()]);assert.equal((await f.prepare([update({name:'Attempt'},rn('conversionActions','903'))])).success,false);assert.equal((await f.prepare([update({name:'Attempt'},rn('conversionActions','902'))])).success,false);assert.equal(f.writes(),1);}finally{f.store.close();}});
test('configuration conflicts remain meaningful while telemetry and ordering are ignored',async()=>{for(const change of ['telemetry','value','window','primary','budget','campaign','goal','membership']){const f=fixture();try{const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));f.mode('reverse');
 if(change==='value')f.tables.conversion_action![0]!.valueSettings.defaultValue=50;if(change==='window')f.tables.conversion_action![0]!.clickThroughLookbackWindowDays='20';if(change==='primary')f.tables.conversion_action![0]!.primaryForGoal=false;if(change==='budget')f.tables.campaign_budget![0]!.amountMicros='60000000';if(change==='campaign')f.tables.campaign![0]!.name='Changed';if(change==='goal')f.tables.campaign_conversion_goal![0]!.biddable=false;if(change==='membership')f.tables.custom_conversion_goal!.push({resourceName:rn('customConversionGoals','55'),id:'55',name:'New membership',status:'ENABLED',conversionActions:[actionId]});
 const out=await f.execute(p);if(change==='telemetry')assert.equal(out.data.success,true,JSON.stringify(out));else{assert.equal(out.error.code,'STATE_CHANGED',JSON.stringify(out));assert.ok(out.error.details.changed_fields.length);assert.equal(f.writes(),0);}
 }finally{f.store.close();}}});
test('conversion definition pagination is complete and invalid or partial reads cannot authorize writes',async()=>{for(const mode of ['pages','loop','read_error','count','partial','unknown','duplicate','foreign']){const f=fixture();try{f.mode(mode);const p=await f.prepare();assert.equal(p.success,mode==='pages',mode+' '+JSON.stringify(p.error));assert.equal(f.writes(),0);if(mode==='pages')assert.equal(Object.keys(p.data.before_state[0].conversionActions).length,3);}finally{f.store.close();}}});
test('definitions changing during discovery invalidate the snapshot',async()=>{const f=fixture();try{let once=false;f.onRead(entity=>{if(entity==='conversion_action'&&!once){once=true;f.tables.conversion_action![0]!.valueSettings.defaultValue=50;}});const p=await f.prepare();assert.equal(p.error.code,'CONVERSION_GOAL_STATE_UNVERIFIED');assert.equal(f.writes(),0);}finally{f.store.close();}});
test('conversion values do not become budgets, while serving and deletion policies remain enforced',async()=>{const f=fixture();try{
 saveSpendPolicy(f.store,owner,{gateway,account_id:'123',policy:{max_budget_native:1,max_daily_increase_native:0,max_budget_increase_percent:0},confirmed:true});
 const p=await f.prepare([update({valueSettings:{defaultValue:10000}})]);assert.equal(p.success,true,JSON.stringify(p));assert.equal(p.data.spend_policy.requested_increase_native,0);assert.equal((await f.execute(p,{spend_change_confirmed:false})).error.code,'SPEND_CONFIRMATION_REQUIRED');
 saveSpendPolicy(f.store,owner,{gateway,account_id:'123',policy:{allow_activation:false},confirmed:true});assert.equal((await f.execute(p)).error.code,'POLICY_ACTIVATION_FORBIDDEN');assert.equal((await f.prepare([{create:create({primaryForGoal:false})}])).error.code,'POLICY_ACTIVATION_FORBIDDEN');
 const rename=await f.prepare([update({name:'Budget and bid conversion'})]);assert.equal(rename.success,true,JSON.stringify(rename));assert.equal((await f.execute(rename,{spend_change_confirmed:false})).data.success,true);
 saveSpendPolicy(f.store,owner,{gateway,account_id:'123',policy:{allow_deletion:false},confirmed:true});assert.equal((await f.prepare([{remove:actionId}])).error.code,'POLICY_DELETION_FORBIDDEN');assert.equal(f.writes(),1);
 }finally{f.store.close();}});
test('actors, account grants, Ads scope, deployment and in-flight login changes fence egress',async()=>{for(const mode of ['reader','tenant','scope','grant','disabled','deployment','inflight_scope','inflight_grant','inflight_login']){const f=fixture(':memory:',mode!=='deployment');try{
 if(mode==='reader'||mode==='tenant'){const result=await f.service.call('amcp_write',{action:'prepare',gateway,arguments:f.args([update()])},mode==='reader'?{...actor,role:'reader'}:{...actor,tenantId:'other'});assert.equal(result.success,false);assert.equal(f.calls.length,0);continue;}
 const p=await f.prepare();if(mode==='deployment'){assert.equal(p.error.code,'LIVE_WRITES_DISABLED');continue;}assert.equal(p.success,true,JSON.stringify(p));
 const change=()=>f.store.putConnection(owner,{...f.c,...(mode.includes('scope')?{scopes:[]}:mode.includes('grant')?{writeAccounts:[]}:mode==='disabled'?{enabled:false}:{})},{accessToken:mode==='inflight_login'?'changed':'synthetic',developerToken:'synthetic'});
 if(mode.startsWith('inflight'))f.onRead(change);else change();assert.equal((await f.execute(p)).success,false,mode);assert.equal(f.writes(),0);
 }finally{f.store.close();}}});
test('empty, partial, foreign, reused and duplicate receipts cannot manufacture success or repeat a write',async()=>{for(const mode of ['empty','partial_receipt','foreign_receipt','reused','duplicate_receipt','lost']){const f=fixture();try{const p=await f.prepare([{create:create()},{create:create({name:'Second'})}]);assert.equal(p.success,true,JSON.stringify(p));f.mode(mode);const out=await f.execute(p);assert.ok(!out.success||!out.data.success,mode);await f.execute(p);assert.equal(f.writes(),1);assert.notEqual((await f.verify(p)).data?.status,'verified');}finally{f.store.close();}}});
test('read-back distinguishes successful receipt from saved definition and automatic goal effects',async()=>{for(const mode of ['ignored_create','ignored_update','ignored_remove','ignore_goals','later_value','later_budget','later_goal']){const f=fixture();try{
 const op=mode.includes('create')||mode==='ignore_goals'?{create:create({category:'PAGE_VIEW'})}:mode==='ignored_remove'?{remove:actionId}:update();
 const p=await f.prepare([op]);assert.equal(p.success,true,JSON.stringify(p));if(mode.startsWith('ignored'))f.mode('ignored');if(mode==='ignore_goals')f.mode(mode);assert.equal((await f.execute(p)).data.success,true);
 if(mode==='later_value')f.tables.conversion_action![0]!.valueSettings.defaultValue=33;if(mode==='later_budget')f.tables.campaign_budget![0]!.amountMicros='70000000';if(mode==='later_goal')f.tables.campaign_conversion_goal![0]!.biddable=false;
 const v=await f.verify(p);assert.equal(v.data.status,'inconclusive',mode+' '+JSON.stringify(v));assert.ok(v.data.checks.some((c:JsonObject)=>c.changed_fields?.length));
 }finally{f.store.close();}}});
test('concurrent and restarted conversion execution never repeats confirmed or uncertain writes',async()=>{for(const lost of [false,true]){const directory=mkdtempSync(join(tmpdir(),'amcp-conversion-actions-'));let f=fixture(join(directory,'store.sqlite'));try{
 const p=await f.prepare([{create:create()}]);assert.equal(p.success,true,JSON.stringify(p));if(lost)f.mode('lost');await Promise.all([f.execute(p),f.execute(p)]);assert.equal(f.writes(),1);f.store.close();f=fixture(join(directory,'store.sqlite'));const again=await f.execute(p);assert.equal(f.writes(),0);assert.equal(lost?again.error.code:again.data.replayed,lost?'WRITE_OUTCOME_UNCERTAIN':true);
 }finally{f.store.close();removeTestDirectory(directory,'amcp-conversion-actions-');}}});
test('expired, edited and cross-actor reviews and direct gateway execution cannot bypass the contract',async()=>{const f=fixture();try{
 const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p,{arguments:{payload:{operations:[]}}})).error.code,'INVALID_ARGUMENT');
 const another=await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},{...actor,userId:'other'});assert.equal(another.success,false);
 const doc=f.store.document(actor.tenantId,'write_review',p.data.review_id);f.store.putDocument(actor.tenantId,'write_review',p.data.review_id,{...doc,expires_at:0});assert.equal((await f.execute(p)).error.code,'REVIEW_EXPIRED');
 const direct=await f.service.call(gateway,{...f.args([update()]),dry_run:false,skip_preflight:true,confirmed:true,idempotency_key:'11111111-1111-4111-8111-111111111111'},actor);assert.equal(direct.success,false);assert.equal(f.writes(),0);
 }finally{f.store.close();}});
test('cached and in-flight verification recheck scope and selected login',async()=>{for(const mode of ['cached_scope','inflight_scope','inflight_login']){const f=fixture();try{const p=await roundtrip(f,[update()]);if(mode==='cached_scope'){f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});assert.equal((await f.verify(p)).error.code,'INSUFFICIENT_SCOPE');}else{
 f.store.putDocument(actor.tenantId,'write_verification',p.data.review_id,{...f.store.document(actor.tenantId,'write_verification',p.data.review_id),checked_at:0});f.onRead(()=>f.store.putConnection(owner,{...f.c,...(mode==='inflight_scope'?{scopes:[]}:{})},{accessToken:mode==='inflight_login'?'changed':'synthetic',developerToken:'synthetic'}));const v=await f.verify(p);assert.equal(v.data.status,'unverified');assert.equal(v.data.checks[0].code,mode==='inflight_scope'?'INSUFFICIENT_SCOPE':'REAUTHORIZATION_REQUIRED');
 }assert.equal(f.writes(),1);}finally{f.store.close();}}});
test('conversion-action route recognition rejects alternate origins, methods and binary transports',()=>{const f=fixture();try{const p=f.service.compiler.compile(gateway,f.args([update()]),{mode:'strict',flags:{}});assert.equal(googleConversionActionKind(p),true);for(const extra of [{origin:'https://other.invalid'},{method:'GET'},{path:p.path+'/run'},{specialTransport:'upload'}])assert.equal(googleConversionActionKind({...p,...extra}),false);for(const extra of [{headers:{'X-Test':'override'}},{query:{validateOnly:'true'}}])assert.throws(()=>assertGoogleConversionAction({...p,...extra}));}finally{f.store.close();}});
test('conversion discovery has monotonic time, page, request and byte limits',async t=>{const f=fixture();try{const p=f.service.compiler.compile(gateway,f.args([update()]),{mode:'strict',flags:{}});for(const mode of ['bytes','pages','deadline']){let count=0,elapsed=0;t.mock.method(performance,'now',()=>elapsed);await assert.rejects(()=>readGoogleConversionActionState(p,async()=>{count++;if(mode==='deadline')elapsed=60001;return {status:200,headers:{},data:{results:[{customer:f.tables.customer![0]}],...(mode==='bytes'?{fieldMask:'x'.repeat(4*1024*1024)}:mode==='pages'?{nextPageToken:String(count)}:{})}};}),{code:'CONVERSION_GOAL_STATE_UNVERIFIED'});assert.equal(count,mode==='pages'?25:1);t.mock.restoreAll();}}finally{t.mock.restoreAll();f.store.close();}});
