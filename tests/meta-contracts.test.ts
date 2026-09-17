import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {Actor} from '../src/types.js';

test('Meta inspect rejects documented legacy campaign fields locally without blocking ordinary objective-based creation',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,41).toString('base64')),actor:Actor={tenantId:'t',userId:'u',role:'operator'};let egress=0;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async()=>{egress++;throw Error('No provider call in inspection');}),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const inspect=(extra:Record<string,unknown>)=>service.call('amcp_write',{action:'inspect',gateway:'meta_native_action',arguments:{action:'meta_campaign_create',account_id:'123',payload:{name:'Synthetic',objective:'OUTCOME_SALES',status:'PAUSED',special_ad_categories:[],...extra}}},actor);
 try{
  for(const field of [{smart_promotion_type:'AUTOMATED_SHOPPING_ADS'},{smart_promotion_type:'SMART_APP_PROMOTION'},{existing_customer_budget_percentage:0},{advantage_state:'ADVANTAGE_PLUS_SALES'}]){
   const r=await inspect(field);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.review_contract_supported,false);assert.equal(r.data.error.code,'INVALID_META_CAMPAIGN');assert.deepEqual(r.data.error.details.fields,Object.keys(field));
  }
  const supported=await inspect({});assert.equal(supported.data.review_contract_supported,true,JSON.stringify(supported));assert.equal(egress,0);
 }finally{store.close();}
});
