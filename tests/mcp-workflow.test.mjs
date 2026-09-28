import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';

const registry=new Registry(),actor={tenantId:'workflow',userId:'u',role:'operator'},admin={...actor,role:'admin'};

test('plan steps receive account_id only where the target schema accepts it',async()=>{
 assert.equal(registry.acceptsArgument('meta_native_action','account_id'),true);
 assert.equal(registry.acceptsArgument('dv360_native_action','account_id'),false);
 assert.equal(registry.acceptsArgument('amazon_native_action','account_id'),false);
 assert.equal(registry.acceptsArgument('reddit_native_action','account_id','reddit_campaign_ops'),true);
 const store=new Store(':memory:',Buffer.alloc(32,66).toString('base64'));
 store.putConnection(admin,{id:'dv',tenantId:actor.tenantId,gateway:'dv360_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'fixture'});
 const prepared=[];
 const runner=new CampaignRunner(store,async(_tool,input)=>{prepared.push(input);const id='review-'+prepared.length;return {success:true,data:{review_id:id,idempotency_key:id,expires_at:new Date(Date.now()+300000).toISOString()}};},async()=>({status:'verified'}),async()=>({}),async()=>({status:'ready',checks:[]}),(g,op)=>registry.acceptsArgument(g,'account_id',op));
 try{
  const run=await runner.handle({action:'create',name:'DV360 plan',brief:'Synthetic',steps:[{id:'campaign',kind:'write',gateway:'dv360_native_action',connection_id:'dv',account_id:'123',arguments:{action:'DV360_ADVERTISERS_CAMPAIGNS_CREATE',params:{advertiserId:'123'},body:{displayName:'Draft',entityStatus:'ENTITY_STATUS_PAUSED'}},depends_on:[]}]},actor);
  await runner.handle({action:'prepare_next',id:run.id},actor);
  assert.equal(prepared.length,1);assert.equal(prepared[0].arguments.account_id,undefined,JSON.stringify(prepared[0]));
  assert.deepEqual(prepared[0].arguments.params,{advertiserId:'123'});
 }finally{store.close();}
});

function redditFixture(){
 const store=new Store(':memory:',Buffer.alloc(32,67).toString('base64')),c={id:'r',tenantId:actor.tenantId,gateway:'reddit_native_action',accounts:['a2_111'],writeAccounts:['a2_111'],enabled:true,label:'Reddit',scopes:['adsread','adsedit'],userAgent:'server:amcp-tests:0.1.0 (local mock)'};
 store.putConnection(admin,c,{accessToken:'synthetic'});
 // Ownership bindings from account-scoped reads last at most five minutes, like reviews; bind() repeats that read.
 const bind=()=>store.rememberResource(c,'a2_111','campaigns/100');bind();
 let writes=0;const state={'/api/v3/ad_accounts/a2_111':{id:'a2_111',name:'Account'},'/api/v3/campaigns/100':{id:'100',ad_account_id:'a2_111',name:'Campaign',configured_status:'PAUSED'}};
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if((init?.method??'GET')==='GET')return Response.json({data:state[path]});
  writes++;const b=JSON.parse(String(init.body)).data;state[path]={...state[path],...b};return Response.json({data:state[path]});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const args={operation:'reddit_campaign_ops',arguments:{action:'UPDATE_CAMPAIGN',account_id:'a2_111',payload:{data:{name:'Renamed'}},params:{campaign_id:'100'}}};
 return {store,service,args,bind,writes:()=>writes};
}

test('an expired review returns the call that prepares the same request again, and the key defaults to the review id',async t=>{
 t.mock.timers.enable({apis:['Date']});
 const f=redditFixture();try{
  const input={action:'prepare',gateway:'reddit_native_action',arguments:f.args};
  const p=await f.service.call('amcp_write',input,actor);assert.equal(p.success,true,JSON.stringify(p));
  t.mock.timers.tick(301000);f.bind();
  const expired=await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,confirmed:true,spend_change_confirmed:true},actor);
  assert.equal(expired.error.code,'REVIEW_EXPIRED');assert.match(expired.error.next_action,/Nothing was submitted/);
  assert.deepEqual(expired.error.details.next_call,{tool:'amcp_write',arguments:input});assert.equal(f.writes(),0);
  const again=await f.service.call(expired.error.details.next_call.tool,expired.error.details.next_call.arguments,actor);assert.equal(again.success,true,JSON.stringify(again));
  // No idempotency_key: it is the review id. A different key is still refused.
  const wrong=await f.service.call('amcp_write',{action:'execute',review_id:again.data.review_id,idempotency_key:'other',confirmed:true,spend_change_confirmed:true},actor);
  assert.equal(wrong.error.code,'IDEMPOTENCY_REQUIRED');
  const done=await f.service.call('amcp_write',{action:'execute',review_id:again.data.review_id,confirmed:true,spend_change_confirmed:true},actor);
  assert.equal(done.success,true,JSON.stringify(done));assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('a plan step whose review expired is prepared again instead of failing',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,68).toString('base64'));
 store.putConnection(admin,{id:'m',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Meta',scopes:[]},{accessToken:'fixture'});
 let prepares=0;
 const runner=new CampaignRunner(store,async(_tool,input)=>{
  if(input.action==='prepare'){prepares++;const id='review-'+prepares;return {success:true,data:{review_id:id,idempotency_key:id,expires_at:new Date(Date.now()+300000).toISOString()}};}
  return {success:false,error:{code:'REVIEW_EXPIRED',message:'Nothing was submitted.'}};
 },async()=>({status:'verified'}),async()=>({}),async()=>({status:'ready',checks:[]}));
 try{
  const run=await runner.handle({action:'create',name:'Meta plan',brief:'Synthetic',steps:[{id:'c',kind:'write',gateway:'meta_native_action',connection_id:'m',account_id:'123',arguments:{action:'meta_campaign_create',payload:{name:'c'}},depends_on:[]}]},actor);
  const first=await runner.handle({action:'prepare_next',id:run.id},actor);
  const after=await runner.handle({action:'execute_next',id:run.id,review_id:first.review.review_id,confirmed:true},actor);
  assert.equal(after.steps[0].status,'pending');
  const second=await runner.handle({action:'prepare_next',id:run.id},actor);
  assert.equal(second.review.review_id,'review-2');assert.equal(prepares,2);
 }finally{store.close();}
});
