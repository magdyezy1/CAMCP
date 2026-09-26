import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * TikTok manual ad group budgets (API for Business v1.3, checked 2026-09-26): lifetime budgets change immediately;
 * scheduled daily budgets take effect the next day and read back as scheduled_budget. Every change is compared
 * with its own ad group's current budget under the owner spending policy.
 */
const TIKTOK='13131313-1313-4131-8131-131313131313',gateway='tiktok_native_action',account='123';
const actor={tenantId:'tiktok-budgets',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,69).toString('base64');
const seed=()=>new Map(Object.entries({
 700:{adgroup_id:'700',campaign_id:'70',advertiser_id:account,adgroup_name:'Lifetime A',budget_mode:'BUDGET_MODE_TOTAL',budget:1000,scheduled_budget:0,campaign_automation_type:'MANUAL',operation_status:'DISABLE'},
 701:{adgroup_id:'701',campaign_id:'70',advertiser_id:account,adgroup_name:'Lifetime B',budget_mode:'BUDGET_MODE_TOTAL',budget:500,scheduled_budget:0,campaign_automation_type:'MANUAL',operation_status:'DISABLE'},
 710:{adgroup_id:'710',campaign_id:'71',advertiser_id:account,adgroup_name:'Daily',budget_mode:'BUDGET_MODE_DAY',budget:100,scheduled_budget:0,campaign_automation_type:'MANUAL',operation_status:'ENABLE'},
 720:{adgroup_id:'720',campaign_id:'72',advertiser_id:account,adgroup_name:'Campaign budget',budget_mode:'BUDGET_MODE_INFINITE',budget:0,scheduled_budget:0,campaign_automation_type:'MANUAL',operation_status:'ENABLE'},
 730:{adgroup_id:'730',campaign_id:'73',advertiser_id:account,adgroup_name:'Smart+',budget_mode:'BUDGET_MODE_DAY',budget:80,scheduled_budget:0,campaign_automation_type:'UPGRADED_SMART_PLUS',operation_status:'ENABLE'}}));
function fixture({readDrift}={}){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const groups=seed(),requests=[],writes=[];let n=0,mode='';
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname.replace(/^\/open_api/,''),method=init.method??'GET';requests.push(method+' '+path);
  if(method==='GET'&&path==='/v1.3/adgroup/get/'){const ids=JSON.parse(url.searchParams.get('filtering')).adgroup_ids;
   const list=ids.filter(id=>groups.has(id)).map(id=>({...groups.get(id),...(readDrift?.[id]??{})}));
   return Response.json({code:0,message:'OK',request_id:'r'+ ++n,data:{list,page_info:{page:1,page_size:100,total_number:list.length,total_page:1}}});}
  if(method==='POST'&&path==='/v1.3/adgroup/budget/update/'){writes.push(path);const b=JSON.parse(init.body),field=b.budget?'budget':'scheduled_budget';
   for(const r of b[field])groups.set(r.adgroup_id,{...groups.get(r.adgroup_id),[field]:r[field]});
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return mode==='error'?Response.json({code:40002,message:'Budget locked',request_id:'r'+ ++n,data:{}}):Response.json({code:0,message:'OK',request_id:'r'+ ++n,data:{}});}
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const prepare=payload=>call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:{action:'tiktok_adgroup_budget_update',account_id:account,payload}});
 const execute=(id,extra={spend_change_confirmed:true})=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true,...extra});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,groups,requests,writes,call,prepare,execute,verify,mode:v=>{mode=v;},restart:()=>{service=start();}};
}

test('the ad group budget route is a reviewed TikTok family',async()=>{
 const f=fixture();try{
  const inspected=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:{action:'tiktok_adgroup_budget_update',account_id:account,payload:{budget:[{adgroup_id:'700',budget:900}]}}});
  assert.equal(inspected.data.review_contract_supported,true,JSON.stringify(inspected));assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('only one documented budget list of up to 20 unique ad groups is accepted, before any request',async()=>{
 const f=fixture();try{
  const cases={'both lists':{budget:[{adgroup_id:'700',budget:900}],scheduled_budget:[{adgroup_id:'710',scheduled_budget:120}]},'no list':{},'empty list':{budget:[]},
   'twenty-one':{budget:Array.from({length:21},(_,i)=>({adgroup_id:String(800+i),budget:10}))},'duplicate':{budget:[{adgroup_id:'700',budget:900},{adgroup_id:'700',budget:800}]},
   'non-numeric id':{budget:[{adgroup_id:'ag700',budget:900}]},'zero':{budget:[{adgroup_id:'700',budget:0}]},'negative':{scheduled_budget:[{adgroup_id:'710',scheduled_budget:-5}]},
   'three decimals':{budget:[{adgroup_id:'700',budget:900.125}]},'text amount':{budget:[{adgroup_id:'700',budget:'900'}]},'budget mode':{budget:[{adgroup_id:'700',budget:900,budget_mode:'BUDGET_MODE_TOTAL'}]},
   'wrong field in scheduled list':{scheduled_budget:[{adgroup_id:'710',budget:120}]},'extra key':{budget:[{adgroup_id:'700',budget:900}],campaign_id:'70'}};
  for(const [name,payload] of Object.entries(cases)){const r=await f.prepare(payload);assert.equal(r.error?.code,'INVALID_TIKTOK_BUDGET',name+': '+JSON.stringify(r.error??r.data).slice(0,300));}
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('lifetime budgets for two ad groups need spend confirmation, change once and verify',async()=>{
 const f=fixture();try{
  const p=await f.prepare({budget:[{adgroup_id:'700',budget:1200},{adgroup_id:'701',budget:400.5}]});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/adgroup/get/']);
  assert.deepEqual(p.data.creative_impact.changes.map(c=>[c.adgroup_id,c.before,c.after]),[['700',1000,1200],['701',500,400.5]]);
  assert.equal((await f.execute(p.data.review_id,{})).error.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal(f.writes.length,0);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.equal(verified.data.checks.length,2);
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});

test('a scheduled daily budget verifies from scheduled_budget while today\'s budget is unchanged',async()=>{
 const f=fixture();try{
  const p=await f.prepare({scheduled_budget:[{adgroup_id:'710',scheduled_budget:150}]});assert.equal(p.success,true,JSON.stringify(p));
  assert.match(p.data.creative_impact.effect,/tomorrow/);assert.equal((await f.execute(p.data.review_id)).success,true);
  assert.equal(f.groups.get('710').budget,100);assert.equal(f.groups.get('710').scheduled_budget,150);
  assert.equal((await f.verify(p.data.review_id)).data.status,'verified');
 }finally{f.store.close();}
});

test('budget modes, campaign budget optimization, Smart+ and missing ad groups are refused before any write',async()=>{
 const f=fixture();try{
  for(const [payload,code,pattern] of [[{budget:[{adgroup_id:'710',budget:900}]},'INVALID_TIKTOK_BUDGET',/BUDGET_MODE_TOTAL/],[{scheduled_budget:[{adgroup_id:'700',scheduled_budget:90}]},'INVALID_TIKTOK_BUDGET',/daily/],
   [{scheduled_budget:[{adgroup_id:'720',scheduled_budget:90}]},'INVALID_TIKTOK_BUDGET',/campaign budget optimization/],[{scheduled_budget:[{adgroup_id:'730',scheduled_budget:90}]},'INVALID_TIKTOK_BUDGET',/manual ad groups only/],
   [{budget:[{adgroup_id:'799',budget:900}]},'STATE_TARGET_MISMATCH',/./]]){
   const r=await f.prepare(payload);assert.equal(r.error?.code,code,JSON.stringify(payload)+' '+JSON.stringify(r));assert.match(r.error.message,pattern);
  }
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('each ad group is compared with its own current budget under the owner spending policy',async()=>{
 const f=fixture();try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_increase_percent:50}});
  const raised=await f.prepare({budget:[{adgroup_id:'701',budget:450},{adgroup_id:'700',budget:2000}]});assert.equal(raised.error?.code,'POLICY_INCREASE_LIMIT',JSON.stringify(raised));
  assert.equal((await f.prepare({budget:[{adgroup_id:'700',budget:800},{adgroup_id:'701',budget:700}]})).success,true,'a decrease and a 40% increase fit the policy');
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('a budget that reads back differently stays inconclusive',async()=>{
 const f=fixture({readDrift:{700:{budget:1100}}});try{
  const p=await f.prepare({budget:[{adgroup_id:'701',budget:600}]});await f.execute(p.data.review_id);
  const q=await f.prepare({budget:[{adgroup_id:'700',budget:1200}]});assert.equal(q.success,true,JSON.stringify(q));await f.execute(q.data.review_id);
  const verified=await f.verify(q.data.review_id);assert.equal(verified.data.status,'inconclusive',JSON.stringify(verified));assert.deepEqual(verified.data.checks[0].changed_fields,['/budget']);
 }finally{f.store.close();}
});

test('rejected or lost budget updates are never resubmitted, and claims survive restart',async()=>{
 for(const [mode,first,again] of [['error','PLATFORM_ERROR','WRITE_OUTCOME_UNCERTAIN'],['lost','WRITE_OUTCOME_UNCERTAIN','WRITE_OUTCOME_UNCERTAIN']]){const f=fixture();try{
  const p=await f.prepare({budget:[{adgroup_id:'700',budget:900}]});f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,first,mode);f.mode('');f.restart();
  assert.equal((await f.execute(p.data.review_id)).error?.code,again,mode);assert.equal(f.writes.length,1,mode);
 }finally{f.store.close();}}
 const g=fixture();try{
  const p=await g.prepare({budget:[{adgroup_id:'700',budget:900}]});const results=await Promise.all([g.execute(p.data.review_id),g.execute(p.data.review_id)]);
  assert.ok(results.some(r=>r.success));assert.equal(g.writes.length,1);g.restart();assert.equal((await g.execute(p.data.review_id)).data.replayed,true);
 }finally{g.store.close();}
});
