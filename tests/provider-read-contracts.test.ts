import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {independentlyReadOnly} from '../src/execution-risk.js';
import {qualifiedProviderRead} from '../src/provider-read-contracts.js';
import type {Connection,JsonObject} from '../src/types.js';

const actor={tenantId:'read-contracts',userId:'reader',role:'reader' as const},owner={...actor,role:'admin' as const},account='123',registry=new Registry(),compiler=new Compiler(registry),options={mode:'strict' as const,flags:{}};
const key='owner=urn:li:company:456&loggedInMember=urn:li:person:member&agent=urn:li:sponsoredAccount:123';
const cases:[string,string,JsonObject,JsonObject?][]=[
 ['meta_native_action','meta_ad_account_id_value_rule_set_get',{},undefined],
 ['tiktok_native_action','tiktok_catalog_set_get',{bc_id:'456',catalog_id:'789'},{bc_id:'456',catalog_id:'789'}],
 ['tiktok_native_action','tiktok_catalog_set_list',{bc_id:'456',catalog_id:'789'},{bc_id:'456',catalog_id:'789'}],
 ['tiktok_native_action','tiktok_catalog_set_product_get',{bc_id:'456',catalog_id:'789',product_set_id:'10',page:1,page_size:10},{bc_id:'456',catalog_id:'789'}],
 ['tiktok_native_action','tiktok_business_publish_status_get',{business_id:'456',publish_id:'publish_1'},{business_id:'456'}],
 ['tiktok_native_action','tiktok_business_publish_location_get',{business_id:'456',search_query:'Cairo'},{business_id:'456'}],
 ['tiktok_native_action','tiktok_business_post_authorize_status',{business_id:'456',item_id:'789'},{business_id:'456'}],
 ['tiktok_native_action','tiktok_business_mention_hashtag_verify_list',{business_id:'456',username:'example'},{business_id:'456'}],
 ['tiktok_native_action','tiktok_tool_brand_safety_partner_authorize_status_get',{advertiser_id:account,partner:'IAS'},undefined],
 ['tiktok_native_action','tiktok_ctm_message_event_set_get',{advertiser_id:account,messaging_app_type:'WHATSAPP',messaging_app_account_id:'456'},{advertiser_id:account,messaging_app_type:'WHATSAPP',messaging_app_account_id:'456'}],
 ['tiktok_native_action','tiktok_gmv_max_exclusive_authorization_get',{advertiser_id:account,store_id:'456',store_authorized_bc_id:'789'},{advertiser_id:account,store_id:'456',store_authorized_bc_id:'789'}],
 ['tiktok_native_action','tiktok_identity_music_authorization_get',{advertiser_id:account,item_id:'456',identity_id:'789',identity_type:'AUTH_CODE',locations:['SA'],start_time:'2026-09-19 00:00:00',end_time:'2026-09-20 00:00:00'},{advertiser_id:account,identity_id:'789',identity_type:'AUTH_CODE'}],
 ['linkedin_native_action','linkedin_rest_organizational_entity_create_share_authorizations_organizational_entity_create_share_authorization_id_get',{organizational_entity_create_share_authorization_id:key},{}]
];
function fixture(gateway:string,input:JsonObject,binding?:JsonObject){
 const store=new Store(':memory:',Buffer.alloc(32,41).toString('base64')),p=compiler.compile(gateway,input,options),calls:JsonObject[]=[];
 const connection:Connection={id:'connection',tenantId:actor.tenantId,gateway,accounts:[account],label:'Synthetic',enabled:true,scopes:gateway==='linkedin_native_action'?['rw_ads']:['ads_read'],resourceBindings:binding===undefined?[]:[{accountId:account,pathPrefix:decodeURIComponent(p.path).replace(/\/$/,''),query:binding}]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 let error=false,revoke=false;
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{assert.equal(init!.method,'GET');calls.push({url:String(url),method:init!.method});if(revoke)store.putConnection(owner,{...connection,accounts:[],enabled:false},{accessToken:'synthetic'});return Response.json(error?{error:{message:'Synthetic provider rejection'}}:gateway==='tiktok_native_action'?{code:0,data:{list:[{id:'row'}]},request_id:'synthetic'}:gateway==='linkedin_native_action'?{status:{'com.linkedin.sharingauth.Denied':{}}}:{data:[{id:'rule-set',rules:[{id:'rule'}]}]});}),undefined,{allowWrites:false,requireBeforeState:true,maxBudgetChange:0});
 return {store,service,connection,calls,p,error:()=>{error=true;},revoke:()=>{revoke=true;}};
}
for(const [gateway,action,params,binding]of cases)test(action+' executes as a scoped read through the read-only deployment',async()=>{
 const input={action,account_id:account,params,dry_run:false},f=fixture(gateway,input,binding);try{
  assert.equal(qualifiedProviderRead(f.p),true);assert.equal(independentlyReadOnly(f.p),true);
  const r=await f.service.call(gateway,input,actor);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.success,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.method,'GET');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get()!.n,0);
  if(gateway==='linkedin_native_action')assert.ok(r.data.data.status['com.linkedin.sharingauth.Denied']);
 }finally{f.store.close();}
});
test('business and catalog reads require exact account/connection resource bindings',async()=>{
 for(const [gateway,action,params,binding]of cases.filter(c=>c[3]!==undefined))for(const mode of ['missing','query','account','connection']as const){const input={action,account_id:account,params,dry_run:false},f=fixture(gateway,input,binding);try{
  const bindings=mode==='missing'?[]:mode==='query'?f.connection.resourceBindings!.map(b=>({...b,query:{...b.query,business_id:'different',catalog_id:'different'}})):f.connection.resourceBindings;
  f.store.putConnection(owner,{...f.connection,resourceBindings:bindings,...(mode==='account'?{accounts:['999'],resourceBindings:[]}:mode==='connection'?{enabled:false}:{})},{accessToken:'synthetic'});
  const r=await f.service.call(gateway,input,actor);assert.equal(r.success,false);assert.equal(f.calls.length,0);
 }finally{f.store.close();}}
});
test('qualified reads cannot conceal mutations through verb, path, method, batch, REST.li or header overrides',()=>{
 for(const [gateway,action,params]of cases){const p=compiler.compile(gateway,{action,account_id:account,params},options);assert.equal(independentlyReadOnly(p),true);
  for(const method of ['POST','PUT','PATCH','DELETE'])assert.equal(independentlyReadOnly({...p,method}),false);
  assert.equal(independentlyReadOnly({...p,path:p.path+'/update'}),false);assert.equal(independentlyReadOnly({...p,path:p.path+'?method=DELETE'}),false);
  for(const name of ['method','_method','http_method','method_override'])assert.equal(independentlyReadOnly({...p,query:{...p.query,[name]:'DELETE'}}),false);
  for(const name of ['X-HTTP-Method-Override','x-http-method-override','X-Http-Method-Override'])assert.equal(independentlyReadOnly({...p,headers:{...p.headers,[name]:'POST'}}),false);
  for(const name of ['X-RestLi-Method','x-restli-method'])assert.equal(independentlyReadOnly({...p,headers:{...p.headers,[name]:'ACTION'}}),false);
  assert.equal(qualifiedProviderRead({...p,body:{name:'mutation'}}),false);assert.equal(qualifiedProviderRead({...p,origin:'https://attacker.example'}),false);
  if(gateway==='meta_native_action')assert.equal(independentlyReadOnly({...p,query:{batch:'[]'}}),false);
 }
});
test('share authorization enforces the selected account, explicit member tuple and rw_ads scope',async()=>{
 const [gateway,action,params,binding]=cases.at(-1)!;
 for(const mode of ['account','member','scope']as const){const input={action,account_id:account,params,dry_run:false},f=fixture(gateway,input,binding);try{
  if(mode==='scope')f.store.putConnection(owner,{...f.connection,scopes:['r_ads']},{accessToken:'synthetic'});
  const r=await f.service.call(gateway,{...input,params:{organizational_entity_create_share_authorization_id:mode==='account'?key.replace('sponsoredAccount:123','sponsoredAccount:999'):mode==='member'?key.replace('person:member','person:other'):key}},actor);
  assert.equal(r.success,false);assert.equal(f.calls.length,0);
 }finally{f.store.close();}}
});
test('provider errors and in-flight revocation do not become successful reads',async()=>{
 for(const mode of ['provider','revoke']){const [gateway,action,params,binding]=cases[0]!,input={action,account_id:account,params,dry_run:false},f=fixture(gateway,input,binding);try{if(mode==='provider')f.error();else f.revoke();assert.equal((await f.service.call(gateway,input,actor)).success,false);assert.equal(f.calls.length,1);}finally{f.store.close();}}
});
test('a broad administrator binding cannot replace the exact additional resource tuple',async()=>{
 for(const [gateway,action,params,binding]of cases.filter(c=>c[3]!==undefined)){
  const input={action,account_id:account,params,dry_run:false},f=fixture(gateway,input,binding);try{
   f.store.putConnection(owner,{...f.connection,resourceBindings:[{accountId:account,pathPrefix:gateway==='tiktok_native_action'?'/v1.3':'/rest',query:{}}]},{accessToken:'synthetic'});
   const r=await f.service.call(gateway,input,actor);assert.equal(r.success,false);assert.equal(f.calls.length,0);
  }finally{f.store.close();}
 }
});
test('case-folded conflicting override headers and mutation query keys stay blocked',()=>{
 const [gateway,action,params]=cases[0]!,p=compiler.compile(gateway,{action,account_id:account,params},options);
 assert.equal(independentlyReadOnly({...p,headers:{'X-HTTP-Method-Override':'GET','x-http-method-override':'DELETE'}}),false);
 assert.equal(independentlyReadOnly({...p,headers:{'X-RestLi-Method':'GET','x-restli-method':'ACTION'}}),false);
 assert.equal(independentlyReadOnly({...p,query:{Method:'DELETE'}}),false);
 assert.equal(independentlyReadOnly({...p,query:{Batch:'[]'}}),false);
});
