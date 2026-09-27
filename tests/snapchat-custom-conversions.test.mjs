import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat custom conversions of a pixel (Marketing API "Custom Conversions", checked 2026-09-27).
 */
const gateway='snapchat_native_action',registry=new Registry(),account='acct1';
const actions={create:'snapchat_pixels_pixel_id_custom_conversions_create',remove:'snapchat_custom_conversions_custom_conversion_id_delete'};
const actor={tenantId:'snap-conversions',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,64).toString('base64')),calls=[];let writes=0,next=10,n=0;
 store.putConnection(owner,{id:'44444444-4444-4444-8444-444444444447',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]},{accessToken:'synthetic'});
 const pixels={'px-1':new Map([['cc-1',{name:'Checkout',event_type:'PURCHASE',rules:[{key:'page_url',operator:'I_CONTAINS',values:['/thank-you']}]}]]),'px-2':new Map()};
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname,method=init.method??'GET';calls.push(method+' '+path);
  if(method==='GET'&&path==='/v1/adaccounts/acct1/pixels')return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,paging:{},pixels:Object.keys(pixels).map(id=>({sub_request_status:'SUCCESS',pixel:{id,ad_account_id:account,name:'Pixel '+id}}))});
  let m=/^\/v1\/pixels\/([\w-]+)\/custom_conversions$/.exec(path);
  if(method==='GET'&&m&&pixels[m[1]])return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,paging:{},custom_conversions:[...pixels[m[1]]].map(([id,c])=>({sub_request_status:'SUCCESS',custom_conversion:{id,...c,event_source:{id:m[1],type:'PIXEL'}}}))});
  writes++;
  if(method==='POST'&&m&&pixels[m[1]]){
   const body=JSON.parse(String(init.body));
   if(mode==='error')return Response.json({request_status:'ERROR',request_id:'r'+ ++n,custom_conversions:body.custom_conversions.map(()=>({sub_request_status:'ERROR'}))});
   return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,custom_conversions:body.custom_conversions.map(c=>{const id='cc-'+next++;if(mode!=='ignore')pixels[m[1]].set(id,c);return {sub_request_status:'SUCCESS',custom_conversion:{id,...c}};})});
  }
  m=/^\/v1\/custom_conversions\/([\w-]+)$/.exec(path);
  if(method==='DELETE'&&m){if(mode!=='ignore')for(const map of Object.values(pixels))map.delete(m[1]);return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,custom_conversions:[]});}
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const create=(pixel,list)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.create,ad_account_id:account,params:{pixel_id:pixel},payload:{custom_conversions:list}}},actor);
 const remove=id=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.remove,ad_account_id:account,params:{custom_conversion_id:id}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,pixels,create,remove,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const conversion=(extra={})=>({name:'Signup',event_type:'SIGN_UP',rules:[{key:'sign_up_method',operator:'EQUAL_TO',values:['email']}],...extra});

test('conversions are created on a pixel of the account and verify; a deletion verifies gone; a replay sends nothing; owner deletion rules apply',async()=>{
 const f=fixture();try{
  const p=ok(await f.create('px-2',[conversion(),conversion({name:'Big basket',event_type:'PURCHASE',rules:[{key:'price',operator:'GREATER_THAN',values:['100']}]})]));assert.equal(p.data.creative_impact.scope,'custom_conversion');
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  const d=ok(await f.remove('cc-1'));assert.equal(d.data.creative_impact.deleting.pixel,'px-1');ok(await f.execute(d));assert.equal(f.pixels['px-1'].has('cc-1'),false);assert.equal(ok(await f.verify(d)).data.status,'verified');
 }finally{f.store.close();}
 const g=fixture();try{saveSpendPolicy(g.store,owner,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await g.remove('cc-1')).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await g.create('px-2',[conversion()]));}finally{g.store.close();}
});

test('malformed conversions are refused before any request; unknown pixels, taken names and unknown conversions after reading',async()=>{
 const cases=[
  ['empty list',[]],
  ['unknown key',[conversion({rules:[{key:'color',operator:'EQUAL_TO',values:['red']}]})]],
  ['unknown operator',[conversion({rules:[{key:'page_url',operator:'MATCHES',values:['x']}]})]],
  ['comparison on text',[conversion({rules:[{key:'page_url',operator:'GREATER_THAN',values:['x']}]})]],
  ['text on price',[conversion({rules:[{key:'price',operator:'I_CONTAINS',values:['1']}]})]],
  ['no rules',[conversion({rules:[]})]],
  ['event type',[conversion({event_type:'buy now'})]],
  ['duplicate names',[conversion(),conversion()]]
 ];
 for(const [label,list] of cases){const f=fixture();try{const r=await f.create('px-2',list);assert.equal(r.error?.code,'INVALID_SNAPCHAT_CUSTOM_CONVERSION',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.create('px-9',[conversion()])).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.create('px-1',[conversion({name:'checkout'})])).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.remove('cc-9')).error?.code,'STATE_NOT_FOUND');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error reply is never resubmitted, an ignored creation or deletion is not verified, and the ledger lists both writes',async()=>{
 const e=fixture('error');try{const p=ok(await e.create('px-2',[conversion()]));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture('ignore');try{for(const p of [ok(await g.create('px-2',[conversion()])),ok(await g.remove('cc-1'))]){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}}finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'snapchat_custom_conversions',action);}
});
