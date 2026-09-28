import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

// Reddit Ads API v3 (pinned reddit-v3 OpenAPI): an ad group goal_value is "Measured in microcurrency for monetary goal
// types" and ad group goal_type allows only DAILY_SPEND, LIFETIME_SPEND or null, so it is a budget under the owner policy.
const gateway='reddit_native_action',actor={tenantId:'reddit-policy',userId:'u',role:'operator'},owner={...actor,role:'admin'},registry=new Registry();
function fixture(groupState){
 const store=new Store(':memory:',Buffer.alloc(32,75).toString('base64')),c={id:'r',tenantId:actor.tenantId,gateway,accounts:['a2_111'],writeAccounts:['a2_111'],enabled:true,label:'Synthetic',scopes:['adsread','adsedit'],userAgent:'server:amcp-tests:0.1.0 (local mock)'};
 store.putConnection(owner,c,{accessToken:'synthetic'});store.rememberResource(c,'a2_111','campaigns/100');store.rememberResource(c,'a2_111','ad_groups/200');
 let writes=0;
 const state={'/api/v3/ad_accounts/a2_111':{id:'a2_111',name:'Account'},'/api/v3/campaigns/100':{id:'100',ad_account_id:'a2_111',name:'Campaign',configured_status:'PAUSED'},'/api/v3/ad_groups/200':{id:'200',ad_account_id:'a2_111',campaign_id:'100',name:'Group',configured_status:'PAUSED',...groupState}};
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if((init?.method??'GET')!=='GET'){writes++;throw Error('No mutation is expected in a policy refusal test.');}
  assert.ok(state[path],'Missing fixture state '+path);return Response.json({data:state[path]});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(action,data,params={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{operation:'reddit_campaign_ops',arguments:{action,account_id:'a2_111',payload:{data},params}}},actor);
 return {store,prepare,writes:()=>writes};
}
const group={name:'Group',configured_status:'PAUSED',campaign_id:'100',conversion_pixel_id:'pixel123',bid_strategy:'MANUAL_BIDDING',bid_type:'CPC',bid_value:1000000};

test('a Reddit ad group spend goal above the owner budget cap is refused before any write',async()=>{
 const f=fixture({});try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_native:200000000}});
  const high=await f.prepare('CREATE_AD_GROUP',{...group,goal_type:'DAILY_SPEND',goal_value:1000000000000});
  assert.equal(high.success,false,JSON.stringify(high));assert.equal(high.error.code,'POLICY_BUDGET_LIMIT');
  assert.match(JSON.stringify(high.error.details),/goal_value/);
  const within=await f.prepare('CREATE_AD_GROUP',{...group,goal_type:'LIFETIME_SPEND',goal_value:150000000});
  assert.equal(within.success,true,JSON.stringify(within));
  // A campaign budget optimization ad group sets no goal_value of its own.
  const inherited=await f.prepare('CREATE_AD_GROUP',{...group,goal_type:null,goal_value:null});
  assert.equal(inherited.success,true,JSON.stringify(inherited));
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('a Reddit ad group budget raise is measured against the reviewed goal, including an inherited goal type',async()=>{
 const f=fixture({goal_type:'DAILY_SPEND',goal_value:100000000});try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:20}});
  // The update names only goal_value; the ad group's current DAILY_SPEND goal makes it a budget.
  const raise=await f.prepare('UPDATE_AD_GROUP',{goal_value:150000000},{ad_group_id:'200'});
  assert.equal(raise.success,false,JSON.stringify(raise));assert.equal(raise.error.code,'POLICY_INCREASE_LIMIT');
  const small=await f.prepare('UPDATE_AD_GROUP',{goal_value:110000000},{ad_group_id:'200'});
  assert.equal(small.success,true,JSON.stringify(small));
  assert.equal(small.data.spend_policy.requested_increase_decimal,'10000000');
  // Every Reddit write needs the spending acknowledgement; prepare says so before execute is attempted.
  assert.equal(small.data.execute_requirements.spend_change_confirmed,true);assert.equal(small.data.expires_in_seconds,300);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});
