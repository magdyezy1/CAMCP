import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {executeRequirements} from '../dist/src/write-review.js';

// The confirmations execute will ask for are decided at prepare, and a suggested next call never supplies the
// spending acknowledgement on the user's behalf.
const registry=new Registry(),compiler=new Compiler(registry),actor={tenantId:'t',userId:'u',role:'operator'};
const policy={allowWrites:true,maxBudgetChange:0,requireBeforeState:true};
const metaUpdate=payload=>applyExecutionRisk(compiler.compile('meta_native_action',{action:'meta_ad_set_id_update',params:{ad_set_id:'1234'},payload,dry_run:true},{mode:'strict',flags:{}}));

test('prepare-time execute requirements name the spending acknowledgement and why',()=>{
 const targeting=executeRequirements(actor,metaUpdate({targeting:{geo_locations:{countries:['US']}}}),policy,'r1',false);
 assert.equal(targeting.spend_change_confirmed,true);assert.equal(targeting.confirmed,true);assert.equal(targeting.idempotency_key,'r1');
 assert.deepEqual(targeting.reasons[0].fields,['targeting']);assert.match(targeting.user_approval,/after they approve/);
 const rename=executeRequirements(actor,metaUpdate({name:'Renamed'}),policy,'r2',true);
 assert.equal(rename.spend_change_confirmed,false);assert.equal(rename.creative_edit_confirmed,true);
 assert.deepEqual(rename.reasons.map(r=>r.flag),['creative_edit_confirmed']);
});

test('a campaign plan never pre-fills spend_change_confirmed in its suggested call',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,64).toString('base64'));
 store.putConnection({...actor,role:'admin'},{id:'fixture',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Fixture',scopes:[]},{accessToken:'fixture'});
 let count=0;const spend={first:true,second:false};
 const runner=new CampaignRunner(store,async(_name,input)=>{
  if(input.action!=='prepare')throw Error('This test prepares only.');
  const id='review-'+ ++count,name=input.arguments.payload.name;
  return {success:true,data:{review_id:id,idempotency_key:id,expires_at:new Date(Date.now()+300000).toISOString(),execute_requirements:{confirmed:true,idempotency_key:id,spend_change_confirmed:spend[name],creative_edit_confirmed:false,reasons:[]}}};
 },async()=>({status:'verified'}),async()=>({}),async()=>({status:'ready',checks:[]}));
 try{
  for(const name of ['first','second']){
   const run=await runner.handle({action:'create',name:'Plan '+name,brief:'Synthetic confirmation test.',steps:[{id:name,kind:'write',gateway:'meta_native_action',connection_id:'fixture',account_id:'123',arguments:{action:'meta_campaign_create',payload:{name}},depends_on:[]}]},actor);
   const prepared=await runner.handle({action:'prepare_next',id:run.id},actor);
   assert.equal(prepared.next_call.arguments.spend_change_confirmed,undefined,JSON.stringify(prepared.next_call));
   assert.equal(prepared.next_call.arguments.confirmed,true);
   assert.equal(prepared.execute_requirements.spend_change_confirmed,spend[name]);
   assert.deepEqual(prepared.next_call.add_after_user_approval,spend[name]?{spend_change_confirmed:true}:undefined);
  }
 }finally{store.close();}
});

test('reviewed writes refuse the enhanced native_request extension, which stays available for reads',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,65).toString('base64'));let egress=0;
 store.putConnection({...actor,role:'admin'},{id:'m',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Fixture',scopes:['ads_management']},{accessToken:'fixture'});
 const service=new MirrorService(registry,store,new NativeTransport(async()=>{egress++;return Response.json({data:[]});}),{mode:'enhanced',flags:{nativeRequests:true}},policy);
 try{
  for(const action of ['inspect','prepare']){
   const r=await service.call('amcp_write',{action,gateway:'meta_native_action',arguments:{action:'meta_campaign_id_update',account_id:'123',native_request:{method:'POST',path:'/v25.0/act_123/assigned_users',body:{tasks:['MANAGE']}}}},actor);
   assert.equal(r.success,false,JSON.stringify(r));assert.equal(r.error.code,'WRITE_CONTRACT_UNAVAILABLE');
  }
  assert.equal(egress,0);
 }finally{store.close();}
});
