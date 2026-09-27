import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * System-managed experiments, Google Ads API v23 (pinned Discovery document and the "System-managed experiments" guide,
 * checked 2026-09-27): experiments in SETUP and their arms are created, edited and removed.
 */
const gateway='google_ads_native_action',registry=new Registry(),C='customers/123/';
const actor={tenantId:'google-experiments',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const actions={experiments:'google_ads_v23_experiment_mutate_experiments',arms:'google_ads_v23_experiment_arm_mutate_experiment_arms',create:'CREATE_EXPERIMENT',update:'UPDATE_EXPERIMENT',remove:'REMOVE_EXPERIMENT',createArm:'CREATE_EXPERIMENT_ARM',updateArm:'UPDATE_EXPERIMENT_ARM',removeArm:'REMOVE_EXPERIMENT_ARM'};
const experiment=id=>C+'experiments/'+id,arm=(e,id)=>C+'experimentArms/'+e+'~'+id,campaign=id=>C+'campaigns/'+id;
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,99).toString('base64')),calls=[];let writes=0,nextExperiment=600,nextArm=10,nextCampaign=9000;
 store.putConnection(owner,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Google Ads',scopes:['https://www.googleapis.com/auth/adwords']},{accessToken:'synthetic',developerToken:'synthetic'});
 const campaigns={
  1001:{name:'Search brand',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'BASE',budget:{explicitlyShared:false,period:'DAILY'}},
  1002:{name:'Display',status:'ENABLED',advertisingChannelType:'DISPLAY',experimentType:'BASE',budget:{explicitlyShared:false,period:'DAILY'}},
  1003:{name:'Shared budget',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'BASE',budget:{explicitlyShared:true,period:'DAILY'}},
  1004:{name:'Old',status:'REMOVED',advertisingChannelType:'SEARCH',experimentType:'BASE',budget:{explicitlyShared:false,period:'DAILY'}},
  1005:{name:'Trial copy',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'EXPERIMENT',budget:{explicitlyShared:false,period:'DAILY'}},
  1006:{name:'Undeclared',status:'ENABLED',advertisingChannelType:'SEARCH',experimentType:'BASE',missingEuPoliticalAdvertisingDeclaration:true,budget:{explicitlyShared:false,period:'DAILY'}}
 };
 const experiments=new Map([
  ['501',{name:'Bidding test',type:'SEARCH_CUSTOM',suffix:'[test]',status:'SETUP',startDate:'2030-01-01',endDate:'2030-02-01',syncEnabled:false}],
  ['502',{name:'Running test',type:'SEARCH_CUSTOM',suffix:'[run]',status:'ENABLED',startDate:'2026-09-01',endDate:'2026-12-01',syncEnabled:true}],
  ['503',{name:'Arms ready',type:'SEARCH_CUSTOM',suffix:'[ready]',status:'SETUP',syncEnabled:false}],
  ['504',{name:'Removed test',type:'SEARCH_CUSTOM',suffix:'[old]',status:'REMOVED',syncEnabled:false}]
 ]);
 const arms=new Map([
  ['502~1',{experiment:'502',name:'Control',control:true,trafficSplit:'50',campaigns:[campaign(1001)]}],
  ['502~2',{experiment:'502',name:'Treatment',control:false,trafficSplit:'50',campaigns:[],inDesignCampaigns:[campaign(8001)]}],
  ['503~1',{experiment:'503',name:'Control',control:true,trafficSplit:'50',campaigns:[campaign(1001)]}],
  ['503~2',{experiment:'503',name:'Treatment',control:false,trafficSplit:'50',campaigns:[],inDesignCampaigns:[campaign(8002)]}]
 ]);
 const inList=(query,field)=>[...(new RegExp(field+' IN \\(([^)]*)\\)').exec(query)?.[1]??'').matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const armRow=(key,a)=>({resourceName:C+'experimentArms/'+key,experiment:experiment(a.experiment),name:a.name,control:a.control,trafficSplit:a.trafficSplit,campaigns:a.campaigns,...(a.inDesignCampaigns?{inDesignCampaigns:a.inDesignCampaigns}:{})});
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=decodeURIComponent(u.pathname),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});
  if(path==='/v23/customers/123/googleAds:search'){
   const q=body.query+' ';
   if(/FROM customer /.test(q))return Response.json({results:[{customer:{resourceName:'customers/123',id:'123',manager:false}}]});
   if(/FROM experiment WHERE experiment.status != 'REMOVED'/.test(q))return Response.json({results:[...experiments].filter(([,e])=>e.status!=='REMOVED').map(([id,e])=>({experiment:{resourceName:experiment(id),experimentId:id,...e}}))});
   if(/FROM experiment_arm WHERE experiment_arm.resource_name IN/.test(q)){const names=inList(q,'experiment_arm.resource_name');return Response.json({results:[...arms].filter(([k])=>names.includes(C+'experimentArms/'+k)).map(([k,a])=>({experimentArm:{resourceName:C+'experimentArms/'+k,experiment:experiment(a.experiment)}}))});}
   if(/FROM experiment_arm WHERE experiment_arm.experiment IN/.test(q)){const names=inList(q,'experiment_arm.experiment');return Response.json({results:[...arms].filter(([,a])=>names.includes(experiment(a.experiment))).map(([k,a])=>({experimentArm:armRow(k,a)}))});}
   if(/FROM campaign /.test(q)){const names=inList(q,'campaign.resource_name');return Response.json({results:names.filter(n=>campaigns[n.split('/').at(-1)]).map(n=>{const {budget,...v}=campaigns[n.split('/').at(-1)];return {campaign:{resourceName:n,id:n.split('/').at(-1),missingEuPoliticalAdvertisingDeclaration:false,...v},campaignBudget:budget};})});}
   throw new Error('Unexpected query '+q);
  }
  if(path==='/v23/customers/123/experiments:mutate'){
   writes++;
   return Response.json({results:body.operations.map(op=>{
    if(op.create){const id=String(nextExperiment++);if(mode!=='ignore')experiments.set(id,{syncEnabled:false,...op.create});return {resourceName:mode==='other'?'customers/999/experiments/'+id:experiment(id)};}
    const name=op.update?.resourceName??op.remove,id=name.split('/').at(-1);
    if(mode!=='ignore'){if(op.update)for(const f of op.updateMask.split(','))experiments.get(id)[f]=op.update[f];else experiments.get(id).status='REMOVED';}
    return {resourceName:name};
   })});
  }
  if(path==='/v23/customers/123/experimentArms:mutate'){
   writes++;
   return Response.json({results:body.operations.map(op=>{
    if(op.create){const e=op.create.experiment.split('/').at(-1),key=e+'~'+(nextArm++);if(mode!=='ignore')arms.set(key,{experiment:e,name:op.create.name,control:op.create.control,trafficSplit:String(op.create.trafficSplit),campaigns:op.create.campaigns??[],...(op.create.control?{}:{inDesignCampaigns:[campaign(nextCampaign++)]})});return {resourceName:C+'experimentArms/'+key};}
    const name=op.update?.resourceName??op.remove,key=name.split('/').at(-1);
    if(mode!=='ignore'){if(op.update)for(const f of op.updateMask.split(','))arms.get(key)[f]=f==='trafficSplit'?String(op.update[f]):op.update[f];else arms.delete(key);}
    return {resourceName:name};
   })});
  }
  throw new Error('Unexpected '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const mutate=(action,operations,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload:{operations,...extra}}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,experiments,arms,mutate,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const newExperiment=(extra={})=>({name:'Smart bidding test',type:'SEARCH_CUSTOM',suffix:'[exp]',status:'SETUP',description:'Target CPA against manual CPC',startDate:'2030-03-01',endDate:'2030-04-01',syncEnabled:true,...extra});
const armSet=(e='501',base=1001)=>[{experiment:experiment(e),name:'Control',control:true,trafficSplit:50,campaigns:[campaign(base)]},{experiment:experiment(e),name:'Treatment A',control:false,trafficSplit:25},{experiment:experiment(e),name:'Treatment B',control:false,trafficSplit:'25'}];

test('an experiment is created in SETUP, edited and removed, each verified; no spending confirmation is needed and a replay sends nothing',async()=>{
 const f=fixture();try{
  const created=ok(await f.mutate(actions.experiments,[{create:newExperiment()}]));
  assert.equal(created.data.creative_impact.scope,'experiment');assert.equal(created.data.creative_impact.may_affect_serving,false);assert.match(created.data.creative_impact.effect,/Nothing serves until an experiment is scheduled/);
  ok(await f.execute(created));assert.equal(f.writes(),1);assert.equal(ok(await f.verify(created)).data.status,'verified');assert.equal(f.experiments.get('600').status,'SETUP');
  assert.equal((await f.execute(created)).data.replayed,true);assert.equal(f.writes(),1);
  const edited=ok(await f.mutate(actions.update,[{update:{resource_name:experiment(600),name:'Smart bidding test v2',end_date:'2030-04-15'},update_mask:'name,end_date'}]));
  ok(await f.execute(edited));assert.equal(ok(await f.verify(edited)).data.status,'verified');assert.equal(f.experiments.get('600').endDate,'2030-04-15');
  const removed=ok(await f.mutate(actions.remove,[{remove:experiment(600)}]));
  ok(await f.execute(removed));assert.equal(ok(await f.verify(removed)).data.status,'verified');assert.equal(f.experiments.get('600').status,'REMOVED');
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('the arms of a SETUP experiment are created together with a matching control campaign, then edited and removed, each verified',async()=>{
 const f=fixture();try{
  const created=ok(await f.mutate(actions.createArm,armSet().map(create=>({create}))));
  assert.equal(created.data.creative_impact.scope,'experiment_arm');assert.deepEqual(created.data.creative_impact.changes.map(c=>c.arm.trafficSplit),[50,25,25]);
  ok(await f.execute(created));assert.equal(ok(await f.verify(created)).data.status,'verified');
  const [control,a,b]=[...f.arms].filter(([,x])=>x.experiment==='501').map(([k])=>arm(...k.split('~')));
  assert.ok(f.arms.get(a.split('/').at(-1)).inDesignCampaigns.length,'Google created an in-design campaign');
  const split=ok(await f.mutate(actions.updateArm,[{update:{resourceName:a,trafficSplit:30},updateMask:'trafficSplit'},{update:{resourceName:b,trafficSplit:20,name:'Treatment B2'},updateMask:'trafficSplit,name'}]));
  ok(await f.execute(split));assert.equal(ok(await f.verify(split)).data.status,'verified');
  const narrowed=ok(await f.mutate(actions.arms,[{remove:b},{update:{resourceName:a,trafficSplit:50},updateMask:'trafficSplit'}]));
  ok(await f.execute(narrowed));assert.equal(ok(await f.verify(narrowed)).data.status,'verified');assert.equal(f.arms.has(b.split('/').at(-1)),false);
  const cleared=ok(await f.mutate(actions.removeArm,[{remove:control},{remove:a}]));
  ok(await f.execute(cleared));assert.equal(ok(await f.verify(cleared)).data.status,'verified');assert.equal([...f.arms.values()].filter(x=>x.experiment==='501').length,0);
  assert.equal(f.writes(),4);
 }finally{f.store.close();}
});

test('malformed requests are refused before any request',async()=>{
 const cases=[
  ['created enabled',actions.experiments,[{create:newExperiment({status:'ENABLED'})}]],
  ['other experiment type',actions.experiments,[{create:newExperiment({type:'AD_VARIATION'})}]],
  ['missing suffix',actions.experiments,[{create:newExperiment({suffix:undefined})}]],
  ['sync for video',actions.experiments,[{create:newExperiment({type:'YOUTUBE_CUSTOM'})}]],
  ['ends before it starts',actions.experiments,[{create:newExperiment({endDate:'2030-02-01'})}]],
  ['impossible date',actions.experiments,[{create:newExperiment({startDate:'2030-02-30'})}]],
  ['goals',actions.experiments,[{create:newExperiment({goals:[]})}]],
  ['status in a mask',actions.experiments,[{update:{resourceName:experiment(501),status:'ENABLED'},updateMask:'status'}]],
  ['unmasked field',actions.experiments,[{update:{resourceName:experiment(501),name:'X',description:'Y'},updateMask:'name'}]],
  ['partial failure',actions.experiments,[{create:newExperiment()}],{partialFailure:true}],
  ['alias verb',actions.create,[{remove:experiment(501)}]],
  ['foreign experiment',actions.remove,[{remove:'customers/999/experiments/501'}],undefined,'ACCOUNT_SCOPE_MISMATCH'],
  ['one arm',actions.arms,[{create:armSet()[0]}]],
  ['two controls',actions.arms,armSet().map((create,i)=>({create:{...create,control:i<2,...(i===1?{campaigns:[campaign(1002)]}:{})}}))],
  ['splits sum to 90',actions.arms,armSet().map((create,i)=>({create:{...create,trafficSplit:i?20:50}}))],
  ['treatment with a campaign',actions.arms,armSet().map((create,i)=>({create:i===1?{...create,campaigns:[campaign(1002)]}:create}))],
  ['control without a campaign',actions.arms,armSet().map((create,i)=>({create:i?create:{...create,campaigns:undefined}}))],
  ['two experiments',actions.arms,armSet().map((create,i)=>({create:i===2?{...create,experiment:experiment(503)}:create}))],
  ['create mixed with update',actions.arms,[...armSet().map(create=>({create})),{update:{resourceName:arm(503,1),name:'X'},updateMask:'name'}]],
  ['arm control flag in a mask',actions.arms,[{update:{resourceName:arm(503,1),control:false},updateMask:'control'}]]
 ].map(([label,action,ops,extra,code])=>[label,action,JSON.parse(JSON.stringify(ops)),extra,code??'INVALID_GOOGLE_EXPERIMENT']);
 for(const [label,action,ops,extra,code] of cases){const f=fixture();try{const r=await f.mutate(action,ops,extra);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
});

test('duplicate names, experiments past SETUP, arms already present, unsuitable control campaigns, unchanged values and broken arm sets are refused without writes',async()=>{
 const f=fixture();try{
  const code=async(action,ops)=>(await f.mutate(action,ops)).error?.code;
  assert.equal(await code(actions.create,[{create:newExperiment({name:'Arms ready'})}]),'CONFIGURATION_EXISTS');
  ok(await f.mutate(actions.create,[{create:newExperiment({name:'Removed test'})}]));
  assert.equal(await code(actions.update,[{update:{resourceName:experiment(502),name:'Renamed'},updateMask:'name'}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.remove,[{remove:experiment(502)}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.remove,[{remove:experiment(504)}]),'STATE_TARGET_MISMATCH');
  assert.equal(await code(actions.update,[{update:{resourceName:experiment(501),name:'Bidding test'},updateMask:'name'}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.update,[{update:{resourceName:experiment(501),endDate:'2029-12-01'},updateMask:'endDate'}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.createArm,armSet('503').map(create=>({create}))),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.createArm,armSet('502').map(create=>({create}))),'INVALID_GOOGLE_EXPERIMENT');
  for(const [base,why] of [[1002,/tests a SEARCH campaign/],[1003,/shared budget/],[1004,/removed/],[1005,/BASE/],[1006,/EU political/]]){
   const r=await f.mutate(actions.createArm,armSet('501',base).map(create=>({create})));assert.equal(r.error?.code,'INVALID_GOOGLE_EXPERIMENT',String(base));assert.match(r.error.message,why);
  }
  assert.equal(await code(actions.createArm,armSet('501',1999).map(create=>({create}))),'STATE_TARGET_MISMATCH');
  assert.equal(await code(actions.updateArm,[{update:{resourceName:arm(503,2),trafficSplit:40},updateMask:'trafficSplit'}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.updateArm,[{update:{resourceName:arm(503,2),name:'Treatment'},updateMask:'name'}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.removeArm,[{remove:arm(503,1)}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.removeArm,[{remove:arm(502,2)}]),'INVALID_GOOGLE_EXPERIMENT');
  assert.equal(await code(actions.removeArm,[{remove:arm(503,9)}]),'STATE_TARGET_MISMATCH');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('a receipt naming an experiment of another customer is a failure never resubmitted, an ignored change is not verified, the models match the pinned document and the ledger lists the eight writes',async()=>{
 const other=fixture('other');try{const p=ok(await other.mutate(actions.experiments,[{create:newExperiment()}]));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=fixture('ignore');try{const p=ok(await ignored.mutate(actions.update,[{update:{resourceName:experiment(501),description:'Changed'},updateMask:'description'}]));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
 const d=JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v23.json','utf8')),S=(d.document??d).schemas,R='GoogleAdsGoogleadsV23Resources__';
 for(const f of ['name','type','suffix','status','description','startDate','endDate','syncEnabled'])assert.ok(S[R+'Experiment'].properties[f],f);
 for(const f of ['experiment','name','control','trafficSplit','campaigns','inDesignCampaigns'])assert.ok(S[R+'ExperimentArm'].properties[f],f);
 const types=S[R+'Experiment'].properties.type.enum;for(const t of ['SEARCH_CUSTOM','DISPLAY_CUSTOM','YOUTUBE_CUSTOM','HOTEL_CUSTOM'])assert.ok(types.includes(t),t);
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'google_experiments',action);}
});
