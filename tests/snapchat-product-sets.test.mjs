import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat product sets of catalogs (Dynamic Product Ads guide, "Product Set", checked 2026-09-27).
 */
const gateway='snapchat_native_action',registry=new Registry(),account='acct1';
const actions={create:'snapchat_catalogs_catalog_id_product_sets_create',createAlias:'snapchat_catalog_product_set_create',update:'snapchat_catalogs_catalog_id_product_sets_update',updateAlias:'snapchat_catalog_product_set_update',updateById:'snapchat_product_sets_update',remove:'snapchat_product_sets_product_set_id_delete'};
const actor={tenantId:'snap-product-sets',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,65).toString('base64')),calls=[];let writes=0,next=10,n=0;
 store.putConnection(owner,{id:'44444444-4444-4444-8444-444444444448',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]},{accessToken:'synthetic'});
 const catalogs={
  'cat-1':{name:'Shop',default:'ps-d1',sets:new Map([['ps-d1',{name:'All products',filter:null}],['ps-1',{name:'In stock',filter:{AVAILABILITY:{EQ:'IN_STOCK'}}}],['ps-squad',{name:'Shoes',filter:{PRODUCT_TYPE:{I_CONTAINS:'shoe'}}}]])},
  'cat-2':{name:'Outlet',default:'ps-d2',sets:new Map([['ps-d2',{name:'All products',filter:null}],['ps-2',{name:'Red',filter:{COLOR:{IS_ANY:['red']}}}],['ps-creative',{name:'Sale',filter:{CUSTOM_LABEL_0:{EQ:'sale'}}}],['ps-audience',{name:'Viewed',filter:{BRAND:{IS_ANY:['acme']}}}]])}
 };
 const foreign={'ps-foreign':{catalog:'cat-9',name:'Other organization',filter:{BRAND:{EQ:'x'}}}};
 const squads=[{id:'sq-1',name:'DPA',status:'ACTIVE',product_properties:{product_set_id:'ps-squad'},targeting:{geos:[{country_code:'us'}]}},{id:'sq-2',name:'Retarget',status:'PAUSED',product_properties:{product_set_id:'ps-d1'},targeting:{product_audiences:[{product_set:'ps-audience',event_type:'VIEW_CONTENT',retention_seconds:86400,operation:'INCLUDE'}]}}];
 const creatives=[{id:'cr-1',name:'Dynamic',dynamic_render_properties:{dynamic_template_id:'t1',product_set_id:'ps-creative'}},{id:'cr-2',name:'Static'}];
 const find=id=>{for(const [c,v] of Object.entries(catalogs))if(v.sets.has(id))return [c,v.sets.get(id)];return undefined;};
 const wrap=(c,id,x)=>({sub_request_status:'SUCCESS',product_set:{id,catalog_id:c,...x,created_at:'2026-09-27T10:00:00Z',updated_at:'2026-09-27T10:00:00Z'}});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname,method=init.method??'GET';calls.push(method+' '+path+u.search);
  const ok=body=>Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,...body});
  if(method==='GET'){
   if(path==='/v1/adaccounts/acct1')return ok({adaccounts:[{sub_request_status:'SUCCESS',adaccount:{id:account,name:'Synthetic',organization_id:'org-1'}}]});
   if(path==='/v1/organizations/org-1/catalogs'){
    const rows=Object.entries(catalogs).map(([id,c])=>({sub_request_status:'SUCCESS',catalog:{id,name:c.name,organization_id:'org-1',default_product_set_id:c.default,vertical:'COMMERCE'}}));
    return u.searchParams.get('cursor')==='p2'?ok({catalogs:rows.slice(1),paging:{}}):ok({catalogs:rows.slice(0,1),paging:{next_link:'https://adsapi.snapchat.com/v1/organizations/org-1/catalogs?cursor=p2&limit=100'}});
   }
   let m=/^\/v1\/catalogs\/([\w-]+)\/product_sets$/.exec(path);
   if(m&&catalogs[m[1]])return ok({product_sets:[...catalogs[m[1]].sets].map(([id,x])=>wrap(m[1],id,x)),paging:{}});
   m=/^\/v1\/product_sets\/([\w-]+)$/.exec(path);
   if(m){
    const f=find(m[1]),o=foreign[m[1]];
    if(f)return ok({product_sets:[wrap(f[0],m[1],f[1])]});
    if(o)return ok({product_sets:[wrap(o.catalog,m[1],{name:o.name,filter:o.filter})]});
    return Response.json({request_status:'ERROR',request_id:'r'+ ++n,debug_message:'Product set not found'},{status:404});
   }
   if(path==='/v1/adaccounts/acct1/adsquads')return ok({adsquads:squads.map(adsquad=>({sub_request_status:'SUCCESS',adsquad})),paging:{}});
   if(path==='/v1/adaccounts/acct1/creatives')return ok({creatives:creatives.map(creative=>({sub_request_status:'SUCCESS',creative})),paging:{}});
   throw new Error('Unexpected '+method+' '+path);
  }
  writes++;
  const body=init.body===undefined?undefined:JSON.parse(String(init.body));
  if(mode==='error')return Response.json({request_status:'ERROR',request_id:'r'+ ++n,product_sets:(body?.product_sets??[]).map(()=>({sub_request_status:'ERROR',sub_request_error_reason:'CAT_VALIDATION_ERROR_INVALID_PRODUCT_SET_FILTER'}))});
  let m=/^\/v1\/catalogs\/([\w-]+)\/product_sets$/.exec(path);
  if(method==='POST'&&m&&catalogs[m[1]])return ok({product_sets:body.product_sets.map(x=>{const id='ps-'+next++;if(mode!=='ignore')catalogs[m[1]].sets.set(id,x);return wrap(m[1],id,x);})});
  if(method==='PUT'&&(m&&catalogs[m[1]]||path==='/v1/product_sets'))return ok({product_sets:body.product_sets.map(({id,...x})=>{const f=find(id);if(mode!=='ignore')Object.assign(f[1],x);return wrap(f[0],id,mode==='ignore'?f[1]:x);})});
  m=/^\/v1\/product_sets\/([\w-]+)$/.exec(path);
  if(method==='DELETE'&&m){if(mode!=='ignore')for(const c of Object.values(catalogs))c.sets.delete(m[1]);return ok({product_sets:[]});}
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,params,payload)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,ad_account_id:account,params,...(payload?{payload}:{})}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,catalogs,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const set=(extra={})=>({name:'Summer',filter:{CUSTOM_LABEL_0:{EQ:'summer_2026'}},...extra});

test('sets are created, updated through either path and deleted, each verified; a replay sends nothing; owner deletion rules apply',async()=>{
 const f=fixture();try{
  const c=ok(await f.prepare(actions.create,{catalog_id:'cat-1'},{product_sets:[{name:'Under 20',filter:{AND:[{PRICE_AMOUNT:{LT:'20.00'}},{PRICE_CURRENCY:{EQ:'USD'}}]}},{name:'Kids',filter:{AGE_GROUP:{EQ:'KIDS'}}},{name:'Hero items',filter:{ID:{IS_ANY:Array.from({length:12},(_,i)=>'sku-'+i)}}}]}));
  assert.equal(c.data.creative_impact.scope,'product_set');assert.ok(f.calls.some(x=>x.includes('/catalogs?')&&x.includes('cursor=p2')),'the catalog cursor is followed');
  ok(await f.execute(c));assert.equal(ok(await f.verify(c)).data.status,'verified');assert.equal((await f.execute(c)).data.replayed,true);assert.equal(f.writes(),1);
  const u=ok(await f.prepare(actions.updateAlias,{catalog_id:'cat-1'},{product_sets:[{id:'ps-squad',name:'All shoes',filter:{OR:[{PRODUCT_TYPE:{I_CONTAINS:'shoe'}},{TITLE:{I_CONTAINS:'sneaker'}}]}}]}));
  assert.equal(u.data.creative_impact.may_affect_serving,true);assert.equal(u.data.creative_impact.used_by[0].ad_squads[0].id,'sq-1');
  ok(await f.execute(u));assert.equal(ok(await f.verify(u)).data.status,'verified');
  const b=ok(await f.prepare(actions.updateById,{},{product_sets:[{id:'ps-2',name:'Red or pink',filter:{COLOR:{I_IS_ANY:['red','pink']}}}]}));
  assert.equal(b.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(b));assert.equal(ok(await f.verify(b)).data.status,'verified');assert.equal(f.catalogs['cat-2'].sets.get('ps-2').name,'Red or pink');
  const d=ok(await f.prepare(actions.remove,{product_set_id:'ps-1'}));assert.equal(d.data.creative_impact.deleting.name,'In stock');
  ok(await f.execute(d));assert.equal(f.catalogs['cat-1'].sets.has('ps-1'),false);assert.equal(ok(await f.verify(d)).data.status,'verified');
  assert.equal(f.writes(),4);
 }finally{f.store.close();}
 const g=fixture();try{
  saveSpendPolicy(g.store,owner,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});
  assert.equal((await g.prepare(actions.remove,{product_set_id:'ps-1'})).error?.code,'POLICY_DELETION_FORBIDDEN');
  ok(await g.prepare(actions.createAlias,{catalog_id:'cat-1'},{product_sets:[set({filter:{CONDITION:{EQ:'USED'}}})]}));
 }finally{g.store.close();}
});

test('malformed product sets are refused before any request; unknown catalogs and sets, taken names, default sets, full catalogs and sets in use after reading',async()=>{
 const cases=[
  ['empty list',actions.create,{catalog_id:'cat-1'},{product_sets:[]}],
  ['short name',actions.create,{catalog_id:'cat-1'},{product_sets:[set({name:'ab'})]}],
  ['duplicate names',actions.create,{catalog_id:'cat-1'},{product_sets:[set(),set({name:'summer'})]}],
  ['unknown attribute',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{COLOUR:{EQ:'red'}}})]}],
  ['comparison on text',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{BRAND:{GT:'a'}}})]}],
  ['text operator on an enumeration',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{AVAILABILITY:{CONTAINS:'STOCK'}}})]}],
  ['unknown enumeration value',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{GENDER:{EQ:'ANY'}}})]}],
  ['price as a number',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{PRICE_AMOUNT:{GT:15.5}}})]}],
  ['price with three decimals',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{PRICE_AMOUNT:{GT:'15.505'}}})]}],
  ['two-letter currency',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{PRICE_CURRENCY:{EQ:'US'}}})]}],
  ['eleven brands',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{BRAND:{IS_ANY:Array.from({length:11},(_,i)=>'b'+i)}}})]}],
  ['nested logic',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{AND:[{OR:[{COLOR:{EQ:'red'}}]}]}})]}],
  ['eleven rules',actions.create,{catalog_id:'cat-1'},{product_sets:[set({filter:{AND:Array.from({length:11},(_,i)=>({SIZE:{EQ:'s'+i}}))}})]}],
  ['update without filter',actions.update,{catalog_id:'cat-1'},{product_sets:[{id:'ps-1',name:'Stocked'}]}],
  ['a set listed twice',actions.updateById,{},{product_sets:[set({id:'ps-1'}),set({id:'ps-1',name:'Other'})]}],
  ['eleven sets by ID',actions.updateById,{},{product_sets:Array.from({length:11},(_,i)=>set({id:'ps-'+i,name:'Set '+i}))}]
 ];
 for(const [label,action,params,payload] of cases){const f=fixture();try{const r=await f.prepare(action,params,payload);assert.equal(r.error?.code,'INVALID_SNAPCHAT_PRODUCT_SET',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare(actions.create,{catalog_id:'cat-9'},{product_sets:[set()]})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare(actions.create,{catalog_id:'cat-1'},{product_sets:[set({name:'in STOCK'})]})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.prepare(actions.update,{catalog_id:'cat-1'},{product_sets:[set({id:'ps-1',name:'Shoes'})]})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.prepare(actions.update,{catalog_id:'cat-1'},{product_sets:[{id:'ps-1',name:'In stock',filter:{AVAILABILITY:{EQ:'IN_STOCK'}}}]})).error?.code,'INVALID_SNAPCHAT_PRODUCT_SET');
  assert.equal((await f.prepare(actions.update,{catalog_id:'cat-2'},{product_sets:[set({id:'ps-1'})]})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare(actions.updateById,{},{product_sets:[set({id:'ps-d2'})]})).error?.code,'INVALID_SNAPCHAT_PRODUCT_SET');
  assert.equal((await f.prepare(actions.remove,{product_set_id:'ps-d1'})).error?.code,'INVALID_SNAPCHAT_PRODUCT_SET');
  for(const [id,field] of [['ps-squad','ad_squads'],['ps-audience','ad_squads'],['ps-creative','creatives']]){const r=await f.prepare(actions.remove,{product_set_id:id});assert.equal(r.error?.code,'PRODUCT_SET_IN_USE',id);assert.equal(r.error.details[field].length,1,id);}
  assert.equal((await f.prepare(actions.remove,{product_set_id:'ps-foreign'})).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.prepare(actions.remove,{product_set_id:'ps-missing'})).error?.code,'STATE_NOT_FOUND');
  for(let i=0;i<47;i++)f.catalogs['cat-2'].sets.set('ps-fill-'+i,{name:'Fill '+i,filter:{SIZE:{EQ:'s'+i}}});
  assert.equal((await f.prepare(actions.create,{catalog_id:'cat-2'},{product_sets:[set()]})).error?.code,'INVALID_SNAPCHAT_PRODUCT_SET');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error reply is never resubmitted, ignored writes are not verified, and the ledger lists all six writes',async()=>{
 const e=fixture('error');try{const p=ok(await e.prepare(actions.create,{catalog_id:'cat-1'},{product_sets:[set()]}));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture('ignore');try{
  const reviews=[ok(await g.prepare(actions.create,{catalog_id:'cat-1'},{product_sets:[set()]})),ok(await g.prepare(actions.update,{catalog_id:'cat-2'},{product_sets:[set({id:'ps-2'})]})),ok(await g.prepare(actions.remove,{product_set_id:'ps-1'}))];
  for(const p of reviews){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}
 }finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'snapchat_product_sets',action);}
});
