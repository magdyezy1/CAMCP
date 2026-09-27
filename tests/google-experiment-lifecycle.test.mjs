import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Google Ads experiment lifecycle, API v23 (pinned Discovery document: ExperimentService ScheduleExperiment,
 * EndExperiment, PromoteExperiment and GraduateExperiment; the "System-managed experiments" guide; checked 2026-09-27).
 */
const gateway='google_ads_native_action',registry=new Registry(),C='customers/123/';
const actor={tenantId:'google-experiment-lifecycle',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const v23={schedule:'google_ads_v23_experiment_schedule_experiment',end:'google_ads_v23_experiment_end_experiment',promote:'google_ads_v23_experiment_promote_experiment',graduate:'google_ads_v23_experiment_graduate_experiment'};
const legacy={schedule:'SCHEDULE_EXPERIMENT',end:'END_EXPERIMENT',promote:'PROMOTE_EXPERIMENT',graduate:'GRADUATE_EXPERIMENT'};
const paths={schedule:'resource_name',end:'experiment',promote:'resource_name',graduate:'experiment'};
const experiment=id=>C+'experiments/'+id,campaign=id=>C+'campaigns/'+id,budget=id=>C+'campaignBudgets/'+id;
const zone='America/New_York',today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,97).toString('base64')),calls=[];let writes=0,next=7100;
 store.putConnection(owner,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Google Ads',scopes:['https://www.googleapis.com/auth/adwords']},{accessToken:'synthetic',developerToken:'synthetic'});
 const campaigns={1001:{name:'Search brand',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'BASE',campaignBudget:budget(3000)},7002:{name:'Search brand [run]',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'EXPERIMENT',campaignBudget:budget(3000)}};
 const budgets={3000:{status:'ENABLED',explicitlyShared:false,period:'DAILY',referenceCount:2,amountMicros:'50000000'},3001:{status:'ENABLED',explicitlyShared:false,period:'DAILY',referenceCount:0,amountMicros:'20000000'},3002:{status:'ENABLED',explicitlyShared:false,period:'DAILY',referenceCount:1,amountMicros:'20000000'},3003:{status:'ENABLED',explicitlyShared:true,period:'DAILY',referenceCount:0,amountMicros:'20000000'}};
 const experiments=new Map([
  ['501',{name:'Ready',type:'SEARCH_CUSTOM',suffix:'[ready]',status:'SETUP',promoteStatus:'NOT_STARTED'}],
  ['502',{name:'Running',type:'SEARCH_CUSTOM',suffix:'[run]',status:'ENABLED',startDate:'2026-09-01',endDate:'2031-01-01',promoteStatus:'NOT_STARTED'}],
  ['503',{name:'No arms',type:'SEARCH_CUSTOM',suffix:'[none]',status:'SETUP',promoteStatus:'NOT_STARTED'}],
  ['504',{name:'Ended',type:'SEARCH_CUSTOM',suffix:'[ended]',status:'ENABLED',startDate:'2026-01-01',endDate:'2026-02-01',promoteStatus:'NOT_STARTED'}],
  ['505',{name:'Promoted',type:'SEARCH_CUSTOM',suffix:'[done]',status:'PROMOTED',promoteStatus:'COMPLETED'}]
 ]);
 const arms=new Map([
  ['501~1',{experiment:'501',name:'Control',control:true,trafficSplit:'50',campaigns:[campaign(1001)]}],
  ['501~2',{experiment:'501',name:'Treatment',control:false,trafficSplit:'50',campaigns:[],inDesignCampaigns:[campaign(8001)]}],
  ['502~1',{experiment:'502',name:'Control',control:true,trafficSplit:'50',campaigns:[campaign(1001)]}],
  ['502~2',{experiment:'502',name:'Treatment',control:false,trafficSplit:'50',campaigns:[campaign(7002)]}]
 ]);
 const inList=(query,field)=>[...(new RegExp(field+' IN \\(([^)]*)\\)').exec(query)?.[1]??'').matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=decodeURIComponent(u.pathname),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});
  if(path==='/v23/customers/123/googleAds:search'){
   const q=body.query+' ';
   if(/FROM customer /.test(q))return Response.json({results:[{customer:{resourceName:'customers/123',id:'123',manager:false,timeZone:zone}}]});
   if(/FROM experiment WHERE experiment.status != 'REMOVED'/.test(q))return Response.json({results:[...experiments].filter(([,e])=>e.status!=='REMOVED').map(([id,e])=>({experiment:{resourceName:experiment(id),experimentId:id,...e}}))});
   if(/FROM experiment_arm WHERE experiment_arm.experiment IN/.test(q)){const names=inList(q,'experiment_arm.experiment');return Response.json({results:[...arms].filter(([,a])=>names.includes(experiment(a.experiment))).map(([k,a])=>({experimentArm:{resourceName:C+'experimentArms/'+k,experiment:experiment(a.experiment),name:a.name,control:a.control,trafficSplit:a.trafficSplit,campaigns:a.campaigns,...(a.inDesignCampaigns?{inDesignCampaigns:a.inDesignCampaigns}:{})}}))});}
   if(/FROM campaign_budget /.test(q)){const names=inList(q,'campaign_budget.resource_name');return Response.json({results:names.filter(n=>budgets[n.split('/').at(-1)]).map(n=>({campaignBudget:{resourceName:n,...budgets[n.split('/').at(-1)]}}))});}
   if(/FROM campaign /.test(q)){const names=inList(q,'campaign.resource_name');return Response.json({results:names.filter(n=>campaigns[n.split('/').at(-1)]).map(n=>({campaign:{resourceName:n,id:n.split('/').at(-1),missingEuPoliticalAdvertisingDeclaration:false,...campaigns[n.split('/').at(-1)]},campaignBudget:{explicitlyShared:false,period:'DAILY'}}))});}
   throw new Error('Unexpected query '+q);
  }
  const m=/^\/v23\/customers\/123\/experiments\/(\d+):(schedule|end|promote|graduate)Experiment$/.exec(path);
  if(!m)throw new Error('Unexpected '+path);
  writes++;const e=experiments.get(m[1]);
  if(mode==='ignore')return Response.json(m[2]==='schedule'||m[2]==='promote'?{name:C+'operations/op-'+m[1]}:{});
  if(m[2]==='schedule'){e.status=mode==='slow'?'INITIATED':'ENABLED';for(const a of arms.values())if(a.experiment===m[1]&&!a.control){a.campaigns=[campaign(next++)];delete a.inDesignCampaigns;}return Response.json({name:C+'operations/op-'+m[1],done:false});}
  if(m[2]==='end'){e.endDate=today();return Response.json({});}
  if(m[2]==='promote'){e.promoteStatus=mode==='slow'?'IN_PROGRESS':mode==='failed'?'FAILED':'COMPLETED';if(mode===''||mode==='graduate')e.status='PROMOTED';return Response.json({name:C+'operations/op-'+m[1],done:false});}
  const map=body.campaignBudgetMappings[0],id=map.experimentCampaign.split('/').at(-1);e.status='GRADUATED';campaigns[id].campaignBudget=map.campaignBudget;campaigns[id].experimentType='BASE';budgets[map.campaignBudget.split('/').at(-1)].referenceCount++;return Response.json({});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const act=(kind,id,payload={},names=v23)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:names[kind],account_id:'123',path_params:{[paths[kind]]:experiment(id)},payload}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,experiments,arms,campaigns,act,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const mapping=(c=7002,b=3001)=>({campaignBudgetMappings:[{experimentCampaign:campaign(c),campaignBudget:budget(b)}]});

test('scheduling needs spending confirmation and verifies once the experiment is ENABLED, not while INITIATED; owner policy treats it as activation',async()=>{
 const f=fixture();try{
  const p=ok(await f.act('schedule','501'));assert.equal(p.data.creative_impact.may_affect_serving,true);assert.match(p.data.creative_impact.effect,/INITIATED, then ENABLED/);
  assert.equal((await f.execute(p)).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(p,{spend_change_confirmed:true}));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal(f.experiments.get('501').status,'ENABLED');
  assert.equal((await f.execute(p,{spend_change_confirmed:true})).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
 const slow=fixture('slow');try{const p=ok(await slow.act('schedule','501',{},legacy));ok(await slow.execute(p,{spend_change_confirmed:true}));assert.notEqual(ok(await slow.verify(p)).data.status,'verified');}finally{slow.store.close();}
 const guarded=fixture();try{saveSpendPolicy(guarded.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});assert.equal((await guarded.act('schedule','501')).error?.code,'POLICY_ACTIVATION_FORBIDDEN');ok(await guarded.act('end','502'));}finally{guarded.store.close();}
});

test('ending a running experiment moves its end date to today in the customer time zone and verifies without spending confirmation',async()=>{
 const f=fixture();try{
  const p=ok(await f.act('end','502',{},legacy));assert.match(p.data.creative_impact.effect,/Ends the experiment today/);
  ok(await f.execute(p));assert.equal(f.experiments.get('502').endDate,today());assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}
 const ignored=fixture('ignore');try{const p=ok(await ignored.act('end','502'));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
});

test('promotion needs spending confirmation and verifies once promote_status is COMPLETED, not while IN_PROGRESS or after FAILED',async()=>{
 const f=fixture();try{
  const p=ok(await f.act('promote','502'));assert.equal(p.data.creative_impact.irreversible,true);
  assert.equal((await f.execute(p)).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(p,{spend_change_confirmed:true}));assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}
 for(const mode of ['slow','failed']){const g=fixture(mode);try{const p=ok(await g.act('promote','502',{},legacy));ok(await g.execute(p,{spend_change_confirmed:true}));assert.notEqual(ok(await g.verify(p)).data.status,'verified',mode);}finally{g.store.close();}}
});

test('graduation keeps the experiment campaign with a new unused daily budget and verifies GRADUATED and the budget on the campaign',async()=>{
 const f=fixture();try{
  const p=ok(await f.act('graduate','502',mapping()));assert.equal(p.data.creative_impact.budget.amountMicros,'20000000');
  assert.equal((await f.execute(p)).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(p,{spend_change_confirmed:true}));assert.equal(f.campaigns[7002].campaignBudget,budget(3001));assert.equal(ok(await f.verify(p)).data.status,'verified');
 }finally{f.store.close();}
 const legacyCall=fixture();try{ok(await legacyCall.act('graduate','502',mapping(),legacy));}finally{legacyCall.store.close();}
});

test('malformed lifecycle requests are refused before any request',async()=>{
 const cases=[
  ['schedule body (Discovery contract)',()=>['schedule','501',{partialFailure:false}],'INVALID_VENDOR_BODY'],
  ['validateOnly true',()=>['end','502',{validateOnly:true}]],
  ['no mapping (required by the compiler)',()=>['graduate','502',{}],'INTERNAL_ERROR'],
  ['two mappings',()=>['graduate','502',{campaignBudgetMappings:[...mapping().campaignBudgetMappings,...mapping(7003,3004).campaignBudgetMappings]}]],
  ['foreign budget',()=>['graduate','502',{campaignBudgetMappings:[{experimentCampaign:campaign(7002),campaignBudget:'customers/999/campaignBudgets/1'}]}]],
  ['budget as a campaign',()=>['graduate','502',{campaignBudgetMappings:[{experimentCampaign:campaign(7002),campaignBudget:campaign(3001)}]}]]
 ];
 for(const [label,make,code='INVALID_GOOGLE_EXPERIMENT'] of cases){const f=fixture();try{const [kind,id,payload]=make();const r=await f.act(kind,id,payload);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
});

test('actions out of order, graduation outside the treatment arms or with a used or shared budget are refused without writes; the ledger lists the eight lifecycle writes',async()=>{
 const f=fixture();try{
  const code=async(kind,id,payload)=>(await f.act(kind,id,payload)).error?.code;
  assert.equal(await code('schedule','502'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('schedule','503'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('end','501'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('end','504'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('promote','501'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('promote','505'),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('graduate','502',mapping(1001)),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('graduate','502',mapping(7002,3002)),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('graduate','502',mapping(7002,3003)),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code('graduate','502',mapping(7002,3999)),'STATE_TARGET_MISMATCH');
  assert.equal(await code('schedule','599'),'STATE_TARGET_MISMATCH');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 for(const action of [...Object.values(v23),...Object.values(legacy)]){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'google_experiments',action);}
});
