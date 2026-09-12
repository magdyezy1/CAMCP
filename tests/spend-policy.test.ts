import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {saveSpendPolicy,checkSpendPolicy,activatesEntity,unprotectedAccounts,activationFields} from '../src/spend-policy.js';
import {MirrorError} from '../src/errors.js';
import {writeContractGateways} from '../src/write-review.js';
import type {Actor,CompiledRequest,JsonObject} from '../src/types.js';

const key=Buffer.alloc(32,19).toString('base64');
const actor:Actor={tenantId:'spend',userId:'owner',role:'admin'};
const connection=(store:Store,gateway:string)=>store.putConnection(actor,{id:gateway,tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],label:'Fixture',enabled:true,scopes:[]},{accessToken:'fixture',developerToken:'fixture'});

const plan=(gateway:string,body:unknown,over:Partial<CompiledRequest>={}):CompiledRequest=>({
 gateway,accountId:'123',action:'activate',method:'POST',path:'/activate',query:{},body:body as JsonObject,
 headers:{},readOnly:false,destructive:false,requiresConfirmation:true,evidence:'fixture',warnings:[],...over});

/**
 * Every gateway that can execute a reviewed write, with the payload that provider actually
 * sends to start delivery. The cases are indexed by the gateway list rather than hand-written
 * per provider: a gateway added to the write contract without declaring how it spells
 * activation must fail here rather than silently pass the owner's policy.
 */
const activations:[string,unknown][]=[
 ['meta_native_action',{status:'ACTIVE'}],
 ['google_ads_native_action',{operations:[{update:{status:'ENABLED'},updateMask:'status'}]}],
 ['tiktok_native_action',{operation_status:'ENABLE'}],
 ['snapchat_native_action',{campaigns:[{status:'ACTIVE'}]}],
 ['linkedin_native_action',{patch:{$set:{status:'ACTIVE'}}}],
 ['x_ads_native_action',{entity_status:'ACTIVE'}],
 ['dv360_native_action',{entityStatus:'ENTITY_STATUS_ACTIVE'}],
 ['reddit_native_action',{data:{configured_status:'ACTIVE'}}],
 ['microsoft_ads_native_action',{Campaigns:[{Status:'Active'}]}],
 ['apple_ads_native_action',{status:'ENABLED'}],
];

const thrown=(fn:()=>unknown):MirrorError=>{
 try{fn();}catch(e){if(e instanceof MirrorError)return e;throw e;}
 throw new Error('expected a MirrorError, but the call returned normally');
};
const forbids=(store:Store,p:CompiledRequest)=>{
 const e=thrown(()=>checkSpendPolicy(store,actor,p,[]));
 assert.equal(e.code,'POLICY_ACTIVATION_FORBIDDEN',JSON.stringify({gateway:p.gateway,body:p.body}));
 return e;
};

test('every reviewed-write gateway is refused when the owner forbids activation',()=>{
 const store=new Store(':memory:',key);
 try{
  for(const [gateway] of activations){
   connection(store,gateway);
   saveSpendPolicy(store,actor,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  }
  for(const [gateway,body] of activations)forbids(store,plan(gateway,body));
 }finally{store.close();}
});

test('a Snapchat JSON Patch is refused whichever order its keys are serialized in',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'snapchat_native_action');
  saveSpendPolicy(store,actor,{gateway:'snapchat_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false}});
  const patch=(op:JsonObject)=>plan('snapchat_native_action',[op],{method:'PATCH'});
  forbids(store,patch({op:'replace',path:'/status',value:'ACTIVE'}));
  forbids(store,patch({op:'replace',value:'ACTIVE',path:'/status'}));   // same operation, keys swapped
  forbids(store,patch({op:'replace',path:'/',value:{status:'ACTIVE'}})); // whole record replaced
 }finally{store.close();}
});

test('a platform with no declared activation contract is refused rather than assumed paused',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'amazon_native_action');
  saveSpendPolicy(store,actor,{gateway:'amazon_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false}});
  const e=forbids(store,plan('amazon_native_action',{state:'ENABLED'}));
  assert.equal(e.details.gateway,'amazon_native_action');
  // Even an unrelated payload is refused: the request cannot be shown to leave entities paused.
  forbids(store,plan('amazon_native_action',{name:'Renamed'}));
 }finally{store.close();}
});

test('paused and unrelated writes still pass while activation is forbidden',()=>{
 const store=new Store(':memory:',key);
 try{
  for(const gateway of ['meta_native_action','reddit_native_action','snapchat_native_action']){
   connection(store,gateway);
   saveSpendPolicy(store,actor,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  }
  assert.equal(checkSpendPolicy(store,actor,plan('meta_native_action',{status:'PAUSED'}),[]).configured,true);
  assert.equal(checkSpendPolicy(store,actor,plan('reddit_native_action',{data:{configured_status:'PAUSED'}}),[]).configured,true);
  assert.equal(checkSpendPolicy(store,actor,plan('snapchat_native_action',{campaigns:[{name:'Renamed'}]}),[]).configured,true);
  // Measurement gateways have no serving-activation surface and are not constrained by it.
  connection(store,'ga4_native_action');
  saveSpendPolicy(store,actor,{gateway:'ga4_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal(checkSpendPolicy(store,actor,plan('ga4_native_action',{status:'ACTIVE'}),[]).configured,true);
 }finally{store.close();}
});

test('activation detection reads structure, not the serialized request',()=>{
 const rule={field:'status',active:['ACTIVE']};
 assert.equal(activatesEntity({status:'ACTIVE'},rule),true);
 assert.equal(activatesEntity({adsets:[{inner:{status:'active'}}]},rule),true,'value comparison is case-insensitive');
 assert.equal(activatesEntity({status:'PAUSED'},rule),false);
 assert.equal(activatesEntity({note:'set status to ACTIVE'},rule),false,'prose mentioning the value is not an activation');
 assert.equal(activatesEntity({status_reason:'ACTIVE'},rule),false,'a different field that merely contains the name is not a match');
 assert.equal(activatesEntity({entity_status:'ACTIVE'},{field:'entityStatus',active:['ACTIVE']}),true,'underscores and case are normalized');
});

test('reservations are summed for the current day only and do not accumulate forever',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'meta_native_action');
  saveSpendPolicy(store,actor,{gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{max_daily_increase_native:100}});
  const budget=(amount:number)=>plan('meta_native_action',{daily_budget:amount},{action:'meta_adset_update',path:'/v25.0/456'});
  const policyId=(checkSpendPolicy(store,actor,budget(110),[{daily_budget:100}],'first') as JsonObject).policy_id as string;
  // A reservation left over from an earlier day must not count against today's allowance.
  store.putDocument(actor.tenantId,'spend_reservation','stale',{policy_id:policyId,day:'2000-01-01',increase_native:1000,created_at:Date.now()});
  const again=checkSpendPolicy(store,actor,budget(110),[{daily_budget:100}],'second');
  assert.equal(again.reserved_today_native,10,'only the same-day reservation is counted');
  const e=thrown(()=>checkSpendPolicy(store,actor,budget(300),[{daily_budget:100}],'third'));
  assert.equal(e.code,'POLICY_DAILY_INCREASE_LIMIT');
 }finally{store.close();}
});

test('reviewer test accounts cannot change a spending policy',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'meta_native_action');
  const reviewer:Actor={tenantId:actor.tenantId,userId:'workspace-test',role:'admin',testAccount:true};
  const e=thrown(()=>saveSpendPolicy(store,reviewer,{gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false}}));
  assert.equal(e.code,'OWNER_REQUIRED');
 }finally{store.close();}
});

test('a workspace default protects accounts nobody configured individually',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'meta_native_action');
  const budget=(amount:number)=>plan('meta_native_action',{daily_budget:amount},{action:'meta_adset_update',path:'/v25.0/456'});

  // Before any policy exists the response says so plainly rather than looking protected.
  const none=checkSpendPolicy(store,actor,budget(500),[{daily_budget:100}]);
  assert.equal(none.configured,false);
  assert.equal(none.unprotected,true);
  assert.match(String(none.advice),/workspace default/i);

  saveSpendPolicy(store,actor,{scope:'workspace',confirmed:true,policy:{max_budget_native:200,allow_activation:false}});

  // The same unconfigured account is now covered by the default.
  const covered=thrown(()=>checkSpendPolicy(store,actor,budget(500),[{daily_budget:100}]));
  assert.equal(covered.code,'POLICY_BUDGET_LIMIT');
  forbids(store,plan('meta_native_action',{status:'ACTIVE'}));
  const ok=checkSpendPolicy(store,actor,budget(150),[{daily_budget:100}]);
  assert.equal(ok.configured,true);
  assert.equal(ok.scope,'workspace_default');

  // An account-specific policy still wins over the default.
  saveSpendPolicy(store,actor,{gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{max_budget_native:1000}});
  const specific=checkSpendPolicy(store,actor,budget(500),[{daily_budget:100}]);
  assert.equal(specific.scope,'account');
 }finally{store.close();}
});

test('a workspace default gives each account its own daily allowance',()=>{
 const store=new Store(':memory:',key);
 try{
  store.putConnection(actor,{id:'meta_native_action',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123','456'],writeAccounts:['123','456'],label:'Fixture',enabled:true,scopes:[]},{accessToken:'fixture'});
  saveSpendPolicy(store,actor,{scope:'workspace',confirmed:true,policy:{max_daily_increase_native:50}});
  const budget=(account:string,amount:number)=>({...plan('meta_native_action',{daily_budget:amount},{action:'meta_adset_update',path:'/v25.0/456'}),accountId:account});
  assert.equal(checkSpendPolicy(store,actor,budget('123',140),[{daily_budget:100}],'a').requested_increase_native,40);
  // The second account must not inherit the first account's consumption.
  const second=checkSpendPolicy(store,actor,budget('456',140),[{daily_budget:100}],'b');
  assert.equal(second.reserved_today_native,0,'each account has its own daily bucket under one default');
 }finally{store.close();}
});

test('health names the accounts no policy protects',()=>{
 const store=new Store(':memory:',key);
 try{
  store.putConnection(actor,{id:'meta_native_action',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['123','456'],writeAccounts:[],label:'Fixture',enabled:true,scopes:[]},{accessToken:'fixture'});
  assert.deepEqual(unprotectedAccounts(store,actor).map(r=>r.account_id),['123','456']);
  saveSpendPolicy(store,actor,{gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{max_budget_native:10}});
  assert.deepEqual(unprotectedAccounts(store,actor).map(r=>r.account_id),['456']);
  // A workspace default covers everything, so nothing is left unprotected.
  saveSpendPolicy(store,actor,{scope:'workspace',confirmed:true,policy:{max_budget_native:10}});
  assert.deepEqual(unprotectedAccounts(store,actor),[]);
 }finally{store.close();}
});

test('a workspace default rejects an account-scoped payload',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'meta_native_action');
  const e=thrown(()=>saveSpendPolicy(store,actor,{scope:'workspace',gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{max_budget_native:10}}));
  assert.equal(e.code,'INVALID_POLICY');
  assert.equal(thrown(()=>saveSpendPolicy(store,actor,{scope:'workspace',confirmed:true,policy:{nonsense:1}})).code,'INVALID_POLICY');
 }finally{store.close();}
});

/**
 * The two tables must stay in step. A gateway that can execute a reviewed write but has no
 * activation declaration is refused at runtime, which is safe but only discovered when an owner
 * has already forbidden activation — so the mismatch is caught here instead.
 */
test('every gateway with a write contract declares how it spells activation',()=>{
 const declared=new Set(Object.keys(activationFields));
 const missing=[...writeContractGateways].filter(g=>!declared.has(g));
 assert.deepEqual(missing,[],'add these gateways to activationFields in src/spend-policy.ts');
 const stale=[...declared].filter(g=>!writeContractGateways.has(g));
 assert.deepEqual(stale,[],'these gateways no longer have a write contract; remove them from activationFields');
});

test('activation detection reads wrapped and padded values',()=>{
 const rule={field:'status',active:['ACTIVE']};
 // None of these is a documented provider shape; reading them costs two comparisons and missing
 // one would mean an owner policy quietly not applying.
 assert.equal(activatesEntity({status:['ACTIVE']},rule),true,'single-element array');
 assert.equal(activatesEntity({status:{value:'ACTIVE'}},rule),true,'value wrapper');
 assert.equal(activatesEntity({status:' ACTIVE '},rule),true,'padded value');
 // Widening the match must not start firing on things that are not an activation.
 assert.equal(activatesEntity({status:['ACTIVE','PAUSED']},rule),false,'a multi-value array is not one status');
 assert.equal(activatesEntity({status:{other:'ACTIVE'}},rule),false);
 assert.equal(activatesEntity({status:'INACTIVE'},rule),false);
});

test('a payload nested past the inspection limit is refused, not skipped and not a crash',()=>{
 const store=new Store(':memory:',key);
 try{
  connection(store,'meta_native_action');
  saveSpendPolicy(store,actor,{gateway:'meta_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false,max_budget_native:500}});
  let deep:JsonObject={status:'ACTIVE'};
  for(let i=0;i<200;i++)deep={n:deep};
  // Stopping the descent quietly would hide the activation below it, so the refusal is the
  // point: a request that cannot be inspected cannot be shown to leave entities paused.
  const e=thrown(()=>checkSpendPolicy(store,actor,plan('meta_native_action',deep),[]));
  assert.equal(e.code,'POLICY_PAYLOAD_TOO_DEEP');
  assert.equal(e.details.limit,64);
  // Ordinary nesting is unaffected.
  assert.equal(checkSpendPolicy(store,actor,plan('meta_native_action',{a:{b:{c:{status:'PAUSED'}}}}),[]).configured,true);
 }finally{store.close();}
});

test('unprotected accounts are found with one query regardless of account count',()=>{
 const store=new Store(':memory:',key);
 try{
  const accounts=Array.from({length:200},(_,i)=>String(1000+i));
  store.putConnection(actor,{id:'meta_native_action',tenantId:actor.tenantId,gateway:'meta_native_action',accounts,writeAccounts:[],label:'Fixture',enabled:true,scopes:[]},{accessToken:'fixture'});
  let queries=0;
  const prepare=store.db.prepare.bind(store.db);
  (store.db as unknown as {prepare:typeof prepare}).prepare=(sql:string)=>{if(/spend_policy/.test(sql))queries++;return prepare(sql);};
  try{
   assert.equal(unprotectedAccounts(store,actor).length,200);
   assert.equal(queries,1,'one read of the policy ids, not one per account');
  }finally{(store.db as unknown as {prepare:typeof prepare}).prepare=prepare;}
 }finally{store.close();}
});
