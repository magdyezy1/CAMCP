import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';

const registry=new Registry();
const operator={tenantId:'pause',userId:'u',role:'operator'},owner={...operator,userId:'owner',role:'admin'};

function fixture(tenant='pause'){
 const store=new Store(':memory:',Buffer.alloc(32,71).toString('base64')),actor={...operator,tenantId:tenant},admin={...owner,tenantId:tenant};
 const c={id:'r',tenantId:tenant,gateway:'reddit_native_action',accounts:['a2_111'],writeAccounts:['a2_111'],enabled:true,label:'Reddit',scopes:['adsread','adsedit'],userAgent:'server:amcp-tests:0.1.0 (local mock)'};
 store.putConnection(admin,c,{accessToken:'synthetic'});store.rememberResource(c,'a2_111','campaigns/100');
 let writes=0;const state={'/api/v3/ad_accounts/a2_111':{id:'a2_111',name:'Account'},'/api/v3/campaigns/100':{id:'100',ad_account_id:'a2_111',name:'Campaign',configured_status:'PAUSED'}};
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if((init?.method??'GET')==='GET')return Response.json({data:state[path]});
  writes++;const b=JSON.parse(String(init.body)).data;state[path]={...state[path],...b};return Response.json({data:state[path]});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=()=>service.call('amcp_write',{action:'prepare',gateway:'reddit_native_action',arguments:{operation:'reddit_campaign_ops',arguments:{action:'UPDATE_CAMPAIGN',account_id:'a2_111',payload:{data:{name:'Renamed'}},params:{campaign_id:'100'}}}},actor);
 const workspace=(input,who=admin)=>service.call('amcp_workspace',input,who);
 return {store,service,actor,admin,prepare,workspace,writes:()=>writes};
}

test('only an owner pauses writes, with a reason and confirmation',async()=>{
 const f=fixture();try{
  assert.equal((await f.workspace({action:'pause_writes',reason:'Audit',confirmed:true},f.actor)).error.code,'OWNER_REQUIRED');
  assert.equal((await f.workspace({action:'pause_writes',confirmed:true})).error.code,'INVALID_ARGUMENT');
  assert.equal((await f.workspace({action:'pause_writes',reason:'Audit'})).error.code,'INVALID_ARGUMENT');
  const paused=await f.workspace({action:'pause_writes',reason:'Client asked to freeze changes',confirmed:true});
  assert.equal(paused.success,true,JSON.stringify(paused));assert.equal(paused.data.paused,true);assert.equal(paused.data.paused_by,'owner');
  const dashboard=await f.workspace({action:'dashboard'},f.actor);assert.equal(dashboard.data.writes_paused.reason,'Client asked to freeze changes');
  const audit=f.store.db.prepare("SELECT count(*) AS n FROM audit WHERE tenant_id=? AND request_id='write_pause/workspace'").get('pause');assert.equal(audit.n,1);
 }finally{f.store.close();}
});

test('a paused workspace refuses execute before anything is sent; prepare continues and resume restores execute',async()=>{
 const f=fixture();try{
  const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));
  await f.workspace({action:'pause_writes',reason:'Quarterly freeze',confirmed:true});
  const refused=await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,confirmed:true,spend_change_confirmed:true},f.actor);
  assert.equal(refused.error.code,'WRITES_PAUSED');assert.match(refused.error.message,/Quarterly freeze/);assert.equal(f.writes(),0);
  // Reviewing continues while writes are paused.
  const again=await f.prepare();assert.equal(again.success,true,JSON.stringify(again));
  const resumed=await f.workspace({action:'resume_writes',confirmed:true});assert.equal(resumed.data.was_paused,true);
  const done=await f.service.call('amcp_write',{action:'execute',review_id:again.data.review_id,confirmed:true,spend_change_confirmed:true},f.actor);
  assert.equal(done.success,true,JSON.stringify(done));assert.equal(f.writes(),1);
  assert.equal((await f.workspace({action:'dashboard'},f.actor)).data.writes_paused,null);
 }finally{f.store.close();}
});

test('a pause applies to its own workspace only',async()=>{
 const a=fixture('pause'),b=fixture('other');try{
  await a.workspace({action:'pause_writes',reason:'Freeze',confirmed:true});
  const p=await b.prepare();const done=await b.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,confirmed:true,spend_change_confirmed:true},b.actor);
  assert.equal(done.success,true,JSON.stringify(done));
 }finally{a.store.close();b.store.close();}
});

test('a plan step refused by a pause stays ready to execute',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,72).toString('base64'));
 store.putConnection(owner,{id:'m',tenantId:owner.tenantId,gateway:'meta_native_action',accounts:['123'],writeAccounts:['123'],enabled:true,label:'Meta',scopes:[]},{accessToken:'fixture'});
 const runner=new CampaignRunner(store,async(_tool,input)=>input.action==='prepare'?{success:true,data:{review_id:'review-1',idempotency_key:'review-1',expires_at:new Date(Date.now()+300000).toISOString()}}:{success:false,error:{code:'WRITES_PAUSED',message:'An owner paused every reviewed write.'}},async()=>({status:'verified'}),async()=>({}),async()=>({status:'ready',checks:[]}));
 try{
  const run=await runner.handle({action:'create',name:'Plan',brief:'Synthetic',steps:[{id:'c',kind:'write',gateway:'meta_native_action',connection_id:'m',account_id:'123',arguments:{action:'meta_campaign_create',payload:{name:'c'}},depends_on:[]}]},operator);
  const first=await runner.handle({action:'prepare_next',id:run.id},operator);
  const after=await runner.handle({action:'execute_next',id:run.id,review_id:first.review.review_id,confirmed:true},operator);
  assert.equal(after.steps[0].status,'review_ready');
 }finally{store.close();}
});
