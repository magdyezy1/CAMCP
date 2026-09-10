import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {CampaignRunner} from '../src/campaign-runner.js';
import type {Actor,JsonObject} from '../src/types.js';

const actor:Actor={tenantId:'recovery',userId:'operator',role:'operator'};
test('correcting an unsubmitted step preserves predecessors and cannot replay an uncertain write',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,63).toString('base64'));
 store.putConnection({...actor,role:'admin'},{id:'fixture',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Fixture',scopes:[]},{accessToken:'fixture'});
 let count=0,submissions=0,failPreparation=true;
 const runner=new CampaignRunner(store,async(_name,input)=>{
  if(input.action==='prepare'){
   if(input.arguments.payload.name==='second'&&failPreparation)return {success:false,error:{code:'INPUT_REQUIRED',message:'Supply a corrected name.'}};
   const id='review-'+ ++count;return {success:true,data:{review_id:id,idempotency_key:id,expires_at:new Date(Date.now()+300000).toISOString()}};
  }
  submissions++;store.claim(actor.tenantId,input.review_id,'request');
  if(submissions>1){store.uncertain(actor.tenantId,input.review_id);return {success:false,error:{code:'WRITE_OUTCOME_UNCERTAIN',message:'Response lost.'}};}
  store.complete(actor.tenantId,input.review_id,{data:{id:'456'}});return {success:true,data:{data:{id:'456'}}};
 },async()=>({status:'verified'}),async()=>({}),async()=>({status:'ready',checks:[]}));
 try{
  const run=await runner.handle({action:'create',name:'Two steps',brief:'Synthetic recovery test.',steps:['first','second'].map((id,i)=>({id,kind:'write',gateway:'meta_native_action',connection_id:'fixture',account_id:'123',arguments:{action:'meta_campaign_create',payload:{name:id}},depends_on:i?['first']:[]}))},actor);
  const prepared=await runner.handle({action:'prepare_next',id:run.id},actor);
  await runner.handle({action:'execute_next',id:run.id,review_id:prepared.review.review_id,idempotency_key:prepared.review.idempotency_key,confirmed:true},actor);
  const blocked=await runner.handle({action:'prepare_next',id:run.id},actor);
  assert.equal(blocked.steps[0].status,'verified');assert.equal(blocked.steps[1].status,'failed');assert.equal(blocked.steps[1].submission,'not_submitted');
  const recovered=await runner.handle({action:'recover_step',id:run.id,step_id:'second',arguments:{action:'meta_campaign_create',payload:{name:'Corrected'}},confirmed:true},actor);
  assert.equal(recovered.steps[0].status,'verified');assert.equal(recovered.steps[1].status,'pending');assert.equal(submissions,1);
  failPreparation=false;const next=await runner.handle({action:'prepare_next',id:run.id},actor);assert.equal(next.step_id,'second');
  const uncertain=await runner.handle({action:'execute_next',id:run.id,review_id:next.review.review_id,idempotency_key:next.review.idempotency_key,confirmed:true},actor);assert.equal(uncertain.steps[1].status,'uncertain');
  await assert.rejects(()=>runner.handle({action:'recover_step',id:run.id,step_id:'second',confirmed:true},actor),/Unknown|uncertain|unsubmitted/);
  assert.equal((await runner.handle({action:'prepare_next',id:run.id},actor)).blocked,true);assert.equal(submissions,2);
 }finally{store.close();}
});

test('preflight-blocked inputs can be corrected before any review or submission',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,63).toString('base64'));
 store.putConnection({...actor,role:'admin'},{id:'fixture',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Fixture',scopes:[]},{accessToken:'fixture'});
 const runner=new CampaignRunner(store,async()=>{throw Error('No writes allowed');},async()=>({}),async()=>({}),async()=>({status:'blocked',checks:[{step:'campaign',status:'blocked',error:{code:'INPUT_REQUIRED'}}]}));
 try{
  const run=await runner.handle({action:'create',name:'Blocked',brief:'Correct before creation.',steps:[{id:'campaign',kind:'write',gateway:'meta_native_action',connection_id:'fixture',account_id:'123',arguments:{action:'meta_campaign_create',payload:{}},depends_on:[]}]},actor);
  assert.equal((await runner.handle({action:'prepare_next',id:run.id},actor)).blocked,true);
  const fixed=await runner.handle({action:'recover_step',id:run.id,step_id:'campaign',arguments:{action:'meta_campaign_create',payload:{name:'Corrected'}},confirmed:true},actor);
  assert.equal(fixed.steps[0].arguments.payload.name,'Corrected');assert.equal(fixed.preflight,undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM idempotency').get()!.n,0);
 }finally{store.close();}
});
