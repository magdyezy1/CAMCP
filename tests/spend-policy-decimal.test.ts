import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {Store} from '../src/store.js';
import {saveSpendPolicy,checkSpendPolicy,spendPolicyKey} from '../src/spend-policy.js';
import type {Actor,CompiledRequest,JsonObject} from '../src/types.js';

const key=Buffer.alloc(32,73).toString('base64');
const actor:Actor={tenantId:'decimal-policy',userId:'owner',role:'admin'};
const gateway='linkedin_native_action';
function setup(policy:JsonObject,filename=':memory:'){
 const store=new Store(filename,key);
 store.putConnection(actor,{id:'login',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],label:'Synthetic',enabled:true,scopes:[]},{accessToken:'fixture'});
 saveSpendPolicy(store,actor,{scope:'workspace',confirmed:true,policy});
 return store;
}
const budget=(amount:string|number)=>({dailyBudget:{amount,currencyCode:'USD'}});
function request(amount:string|number,update=false):CompiledRequest{return {gateway,accountId:'123',action:update?'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post':'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',method:'POST',path:'/rest/adAccounts/123/adCampaigns'+(update?'/456':''),query:{},body:update?{patch:{$set:budget(amount)}}:budget(amount),headers:update?{'X-RestLi-Method':'PARTIAL_UPDATE'}:{},readOnly:false,destructive:false,requiresConfirmation:true,evidence:'synthetic native money fixture',warnings:[]};}

test('two native decimal creations exactly at a daily cap both succeed',()=>{
 const store=setup({max_daily_increase_native:66.3});
 try{
  checkSpendPolicy(store,actor,request('33.1'),[],'one');
  assert.equal(checkSpendPolicy(store,actor,request('33.2'),[],'two').requested_increase_native,33.2);
  assert.throws(()=>checkSpendPolicy(store,actor,request('0.01'),[],'three'),{code:'POLICY_DAILY_INCREASE_LIMIT'});
 }finally{store.close();}
});

test('a native REST.li decimal increase exactly at ten percent succeeds',()=>{
 const store=setup({max_budget_increase_percent:10});
 try{
  assert.equal(checkSpendPolicy(store,actor,request('110.11',true),[budget('100.10')]).requested_increase_native,10.01);
  assert.throws(()=>checkSpendPolicy(store,actor,request('110.12',true),[budget('100.10')]),{code:'POLICY_INCREASE_LIMIT'});
 }finally{store.close();}
});

test('native string amounts above a limit are not rounded down to the limit',()=>{
 const store=setup({max_budget_native:100.1});
 try{
  assert.throws(()=>checkSpendPolicy(store,actor,request('100.10000000000000001'),[]),{code:'POLICY_BUDGET_LIMIT'});
  assert.equal(checkSpendPolicy(store,actor,request('100.1000'),[]).requested_increase_native,100.1);
 }finally{store.close();}
});

test('many cent-valued changes agree with an integer-cents oracle at the exact cap',()=>{
 const store=setup({max_daily_increase_native:66.3});
 try{
  let cents=0;
  for(let i=0;i<102;i++){
   const value=i%2?32:98;cents+=value;
   const result=checkSpendPolicy(store,actor,request((value/100).toFixed(2)),[],'cent-'+i);
   assert.equal(result.reserved_today_native,(cents-value)/100);
  }
  assert.equal(cents,6630);
  assert.throws(()=>checkSpendPolicy(store,actor,request('0.00000000000000001'),[]),{code:'POLICY_DAILY_INCREASE_LIMIT'});
  assert.equal(checkSpendPolicy(store,actor,request(0),[]).reserved_today_decimal,'66.3');
 }finally{store.close();}
});

test('equivalent decimal baselines agree while distinct values never collapse into one',()=>{
 const store=setup({max_budget_increase_percent:10});
 try{
  assert.equal(checkSpendPolicy(store,actor,request('110.11',true),[budget('100.1'),budget('100.1000'),budget('1.001e2')]).requested_increase_decimal,'10.01');
  assert.throws(()=>checkSpendPolicy(store,actor,request('110.11',true),[budget('100.1'),budget('100.10000000000000001')]),{code:'POLICY_BASELINE_REQUIRED'});
  assert.throws(()=>checkSpendPolicy(store,actor,request('0.01',true),[budget(0)]),{code:'POLICY_INCREASE_LIMIT'});
  assert.equal(checkSpendPolicy(store,actor,request(0,true),[budget(0)]).requested_increase_decimal,'0');
 }finally{store.close();}
});

test('percentages have no tolerance and decreases cannot offset another positive increase',()=>{
 const store=setup({max_budget_increase_percent:10,max_daily_increase_native:10.01});
 try{
  assert.throws(()=>checkSpendPolicy(store,actor,request('110.11000000000000001',true),[budget('100.1')]),{code:'POLICY_INCREASE_LIMIT'});
  const update={...request('110.11',true),body:{patch:{$set:{dailyBudget:{amount:'110.11'},totalBudget:{amount:'90.09'}}}}};
  assert.equal(checkSpendPolicy(store,actor,update,[{dailyBudget:{amount:'100.1'},totalBudget:{amount:'100.1'}}],'increase').requested_increase_decimal,'10.01');
  assert.throws(()=>checkSpendPolicy(store,actor,request('100.11',true),[budget('100.1')],'extra'),{code:'POLICY_DAILY_INCREASE_LIMIT'});
 }finally{store.close();}
});

test('new exact reservations survive SQLite restart and the same reservation is not double counted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-policy-restart-')),filename=join(dir,'fixture.sqlite');
 let store=setup({max_daily_increase_native:66.3},filename);
 try{
  checkSpendPolicy(store,actor,request('33.10000000000000001'),[],'one');
  assert.equal(store.document(actor.tenantId,'spend_reservation','one').increase_decimal,'33.10000000000000001');
  store.close();store=new Store(filename,key);
  assert.throws(()=>checkSpendPolicy(store,actor,request('33.2'),[],'two'),{code:'POLICY_DAILY_INCREASE_LIMIT'});
  const first=checkSpendPolicy(store,actor,request('33.10000000000000001'),[],'one');
  assert.equal(first.reserved_today_decimal,'0');
  assert.equal(first.requested_increase_decimal,'33.10000000000000001');
  assert.equal(checkSpendPolicy(store,actor,request('33.19999999999999999'),[],'two').reserved_today_decimal,'33.10000000000000001');
 }finally{store.close();for(const suffix of ['', '-wal','-shm'])if(existsSync(filename+suffix))unlinkSync(filename+suffix);rmdirSync(dir);}
});

test('legacy numeric reservations remain authoritative and inconsistent exact metadata refuses writes',()=>{
 const store=setup({max_daily_increase_native:66.3}),day=new Date().toISOString().slice(0,10),policyId=spendPolicyKey(gateway,'123');
 try{
  store.putDocument(actor.tenantId,'spend_reservation','old',{policy_id:policyId,day,increase_native:33.1});
  assert.equal(checkSpendPolicy(store,actor,request('33.2'),[]).reserved_today_decimal,'33.1');
  store.putDocument(actor.tenantId,'spend_reservation','old',{policy_id:policyId,day,increase_native:33.10000000000001});
  assert.throws(()=>checkSpendPolicy(store,actor,request('33.2'),[]),{code:'POLICY_DAILY_INCREASE_LIMIT'});
  store.putDocument(actor.tenantId,'spend_reservation','old',{policy_id:policyId,day,increase_native:33.1,increase_decimal:'0'});
  assert.throws(()=>checkSpendPolicy(store,actor,request(0),[]),{code:'POLICY_AMOUNT_INVALID'});
  store.putDocument(actor.tenantId,'spend_reservation','old',{policy_id:policyId,day,increase_native:null});
  assert.throws(()=>checkSpendPolicy(store,actor,request(0),[]),{code:'POLICY_AMOUNT_INVALID'});
 }finally{store.close();}
});

test('daily reservations are streamed only for the current tenant, account and day',()=>{
 const store=setup({max_daily_increase_native:66.3}),day=new Date().toISOString().slice(0,10),policyId=spendPolicyKey(gateway,'123');
 try{
  store.transaction(()=>{for(let i=0;i<2000;i++)store.putDocument(actor.tenantId,'spend_reservation','history-'+i,{policy_id:policyId,day:'2000-01-01',increase_native:'invalid historical fixture'});});
  store.putDocument('other-tenant','spend_reservation','foreign',{policy_id:policyId,day,increase_native:'invalid foreign fixture'});
  store.putDocument(actor.tenantId,'spend_reservation','other-account',{policy_id:spendPolicyKey(gateway,'456'),day,increase_native:'invalid other-account fixture'});
  assert.equal(checkSpendPolicy(store,actor,request('33.1'),[],'one').reserved_today_decimal,'0');
  const prepare=store.db.prepare.bind(store.db);let yielded=0;
  store.db.prepare=(sql:string)=>{
   const statement=prepare(sql);
   if(sql.includes("kind='spend_reservation'")){
    statement.all=(()=>{throw Error('Do not materialize reservation history');}) as typeof statement.all;
    const iterate=statement.iterate.bind(statement);
    statement.iterate=function*(...args:Parameters<typeof iterate>){for(const row of iterate(...args)){yielded++;yield row;}} as typeof statement.iterate;
   }
   return statement;
  };
  try{assert.equal(checkSpendPolicy(store,actor,request('33.2'),[]).reserved_today_decimal,'33.1');assert.equal(yielded,1);}
  finally{store.db.prepare=prepare;}
 }finally{store.close();}
});

test('native integer micros keep their range and unit without currency scaling',()=>{
 const store=setup({max_budget_native:Number.MAX_SAFE_INTEGER,max_budget_increase_percent:10});
 try{
  const plan:CompiledRequest={...request(0),gateway:'google_ads_native_action',action:'google_ads_v23_campaign_budget_mutate_campaign_budgets',path:'/v23/customers/123/campaignBudgets:mutate',body:{operations:[{update:{amountMicros:'110000000'},updateMask:'amount_micros'}]}};
  assert.equal(checkSpendPolicy(store,actor,plan,[{campaignBudget:{amountMicros:'100000000'}}]).requested_increase_decimal,'10000000');
  assert.equal(checkSpendPolicy(store,actor,request('9007199254740991'),[]).requested_increase_decimal,'9007199254740991');
  assert.throws(()=>checkSpendPolicy(store,actor,request('9007199254740991.00001'),[]),{code:'POLICY_AMOUNT_INVALID'});
  assert.throws(()=>checkSpendPolicy(store,actor,request('9007199254740992'),[]),{code:'POLICY_AMOUNT_INVALID'});
 }finally{store.close();}
});

test('a valid multi-operation reservation can exceed the safe per-field integer range without a SQLite read crash',()=>{
 const s=setup({max_budget_native:Number.MAX_SAFE_INTEGER});
 try{
  const p:CompiledRequest={...request(0),gateway:'google_ads_native_action',action:'google_ads_v23_campaign_budget_mutate_campaign_budgets',path:'/v23/customers/123/campaignBudgets:mutate',body:{operations:[{create:{name:'Synthetic A',amountMicros:'9007199254740991'}},{create:{name:'Synthetic B',amountMicros:'9007199254740991'}}]}};
  assert.equal(checkSpendPolicy(s,actor,p,[],'aggregate').requested_increase_decimal,'18014398509481982');
  const result=checkSpendPolicy(s,actor,{...p,body:{operations:[{create:{name:'Synthetic C',amountMicros:'1'}}]}},[],'next');
  assert.equal(result.reserved_today_decimal,'18014398509481982');
  assert.equal(checkSpendPolicy(s,actor,{...p,body:{}},[]).reserved_today_decimal,'18014398509481983');
 }finally{s.close();}
});

test('bounded decimal inputs reject overflow, underflow and alternate syntax before reserving',()=>{
 const store=setup({max_budget_native:100});
 try{
  for(const input of ['1e309','1e-1000','1e-324','0x10',' 1','-1','NaN','Infinity','9'.repeat(513)])assert.throws(()=>checkSpendPolicy(store,actor,request(input),[],'bad'),{code:'POLICY_AMOUNT_INVALID'},input);
  assert.throws(()=>store.document(actor.tenantId,'spend_reservation','bad'),{code:'NOT_FOUND'});
  assert.equal(checkSpendPolicy(store,actor,request('1e-7'),[]).requested_increase_decimal,'0.0000001');
  assert.equal(checkSpendPolicy(store,actor,request(1e-7),[]).requested_increase_decimal,'0.0000001');
  assert.equal(checkSpendPolicy(store,actor,request(Number.MIN_VALUE),[]).requested_increase_decimal,'0.'+'0'.repeat(323)+'5');
 }finally{store.close();}
});

test('independent SQLite workers cannot overbook the decimal daily cap', {timeout:30000}, async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-policy-workers-')),filename=join(dir,'fixture.sqlite');
 const initial=setup({max_daily_increase_native:66.3},filename);initial.close();
 const code=`import {parentPort,workerData} from 'node:worker_threads';
 const {Store}=await import(workerData.storeUrl),{checkSpendPolicy}=await import(workerData.policyUrl);
 const store=new Store(workerData.filename,workerData.key);
 parentPort.once('message',()=>{let result;try{result={ok:true,result:checkSpendPolicy(store,workerData.actor,workerData.request,[],workerData.id)}}catch(e){result={ok:false,code:e.code}}finally{store.close()}parentPort.postMessage(result);parentPort.close()});
 parentPort.postMessage({ready:true});`;
 const workers:Worker[]=[];
 try{
  const jobs=[0,1].map(i=>{
   const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)),{workerData:{filename,key,actor,id:'worker-'+i,request:request('33.2'),storeUrl:new URL('../src/store.js',import.meta.url).href,policyUrl:new URL('../src/spend-policy.js',import.meta.url).href}});workers.push(worker);
   let ready!:()=>void,done!:(result:JsonObject)=>void,failed!:(error:Error)=>void;
   const readyPromise=new Promise<void>(resolve=>{ready=resolve;});
   const result=new Promise<JsonObject>((resolve,reject)=>{done=resolve;failed=reject;});
   worker.on('message',message=>{if(message.ready)ready();else done(message);});
   worker.on('error',error=>{ready();failed(error);});
   return {ready:readyPromise,result};
  });
  await Promise.all(jobs.map(j=>j.ready));workers.forEach(w=>w.postMessage('go'));
  const results=await Promise.all(jobs.map(j=>j.result));
  assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));
  assert.equal(results.find(r=>!r.ok)?.code,'POLICY_DAILY_INCREASE_LIMIT');
  const reopened=new Store(filename,key);
  try{assert.equal(checkSpendPolicy(reopened,actor,request('33.1'),[],'finish').reserved_today_decimal,'33.2');assert.throws(()=>checkSpendPolicy(reopened,actor,request('0.01'),[]),{code:'POLICY_DAILY_INCREASE_LIMIT'});}finally{reopened.close();}
 }finally{await Promise.all(workers.map(w=>w.terminate()));for(const suffix of ['', '-wal','-shm'])if(existsSync(filename+suffix))unlinkSync(filename+suffix);rmdirSync(dir);}
});
