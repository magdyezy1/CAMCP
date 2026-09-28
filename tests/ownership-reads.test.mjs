import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const actor={tenantId:'owned',userId:'operator',role:'operator'},admin={...actor,role:'admin'},registry=new Registry();
function fixture(gateway,accounts,respond){
 const store=new Store(':memory:',Buffer.alloc(32,81).toString('base64')),connection={id:'33333333-3333-4333-8333-333333333333',tenantId:actor.tenantId,gateway,accounts,writeAccounts:[],enabled:true,label:'Synthetic',scopes:['adsread'],...(gateway==='reddit_native_action'?{userAgent:'server:amcp-tests:0.1.0 (local mock)'}:{})};
 store.putConnection(admin,connection,{accessToken:'synthetic'});
 const service=new MirrorService(registry,store,new NativeTransport(async(url)=>respond(new URL(String(url)).pathname)),undefined,{allowWrites:false,requireBeforeState:true,maxBudgetChange:0});
 return {store,connection,call:(tool,input)=>service.call(tool,input,actor)};
}

test('a Snapchat ownership refusal names the one collection read that establishes it, and that read works',async()=>{
 const f=fixture('snapchat_native_action',['acct1'],path=>{
  const ok=(kind,rows)=>Response.json({request_status:'SUCCESS',request_id:'r',paging:{},[kind]:rows.map(r=>({sub_request_status:'SUCCESS',[kind.slice(0,-1)]:r}))});
  if(path==='/v1/adaccounts/acct1/campaigns')return ok('campaigns',[{id:'c1',name:'Mine',ad_account_id:'acct1'}]);
  if(path==='/v1/campaigns/c1')return ok('campaigns',[{id:'c1',name:'Mine',ad_account_id:'acct1'}]);
  throw new Error('unexpected '+path);
 });
 try{
  const read={action:'snapchat_campaign_get',account_id:'acct1',campaign_id:'c1'};
  const refused=await f.call('snapchat_native_action',read);
  assert.equal(refused.error.code,'RESOURCE_SCOPE_REQUIRED');assert.match(refused.error.message,/five minutes/);
  assert.deepEqual(refused.error.details.next_call,{tool:'snapchat_native_action',arguments:{action:'snapchat_campaign_list',account_id:'acct1',connection_id:f.connection.id}});
  const listed=await f.call(refused.error.details.next_call.tool,refused.error.details.next_call.arguments);assert.equal(listed.success,true,JSON.stringify(listed));
  const again=await f.call('snapchat_native_action',read);assert.equal(again.success,true,JSON.stringify(again));
 }finally{f.store.close();}
});

test('a Meta ownership refusal lists one read per collection, because a Meta ID does not reveal its type',async()=>{
 const f=fixture('meta_native_action',['111'],path=>{
  if(path==='/v25.0/act_111/adsets')return Response.json({data:[{id:'555'}]});
  if(path==='/v25.0/555')return Response.json({id:'555',name:'Ad set'});
  throw new Error('unexpected '+path);
 });
 try{
  const read={action:'meta_adset_get',account_id:'111',ad_set_id:'555'};
  const refused=await f.call('meta_native_action',read);
  assert.equal(refused.error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(refused.error.details.next_call,undefined);
  const reads=refused.error.details.ownership_reads;assert.deepEqual(reads.map(r=>r.arguments.action),['meta_campaign_list','meta_adset_list','meta_ad_list','meta_creative_list','meta_custom_audience_list']);
  const adsets=reads.find(r=>r.arguments.action==='meta_adset_list');
  assert.equal((await f.call(adsets.tool,adsets.arguments)).success,true);
  const again=await f.call('meta_native_action',read);assert.equal(again.success,true,JSON.stringify(again));
 }finally{f.store.close();}
});

test('a Reddit ownership refusal names the account collection of the entity',async()=>{
 const f=fixture('reddit_native_action',['a2_111'],path=>{
  if(path==='/api/v3/ad_accounts/a2_111/campaigns')return Response.json({data:[{id:'900',ad_account_id:'a2_111'}],pagination:{next_url:null}});
  if(path==='/api/v3/campaigns/900')return Response.json({data:{id:'900',ad_account_id:'a2_111'}});
  throw new Error('unexpected '+path);
 });
 try{
  const read={operation:'reddit_campaign_ops',arguments:{action:'GET_CAMPAIGN',account_id:'a2_111',params:{campaign_id:'900'}}};
  const refused=await f.call('reddit_native_action',read);
  assert.equal(refused.error.code,'RESOURCE_SCOPE_REQUIRED');
  const next=refused.error.details.next_call;assert.equal(next.arguments.arguments.action,'LIST_CAMPAIGNS');
  assert.equal((await f.call(next.tool,next.arguments)).success,true);
  assert.equal((await f.call('reddit_native_action',read)).success,true);
 }finally{f.store.close();}
});
