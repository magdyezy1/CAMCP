import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn Audience Network publisher lists ("Manage Audience Restrictions", li-lms-2025-10 to li-lms-2026-09, checked
 * 2026-09-27): registering an uploaded list and replacing the account-level allow and block lists.
 */
const registry=new Registry(),gateway='linkedin_native_action';
const actor={tenantId:'linkedin-publisher-lists',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const actions={restriction:'linkedin_rest_ad_publisher_restrictions_post',preferences:'linkedin_rest_ad_account_trust_preferences_account_id_put'};
const urn=id=>'urn:li:sponsoredAccount:'+id,file=id=>'urn:li:adPublisherFile:'+id;
const csv='urn:li:media:/AAUQAQCwAAQAAQAAAAAAAADPAAAAJDIxYTllNzllLTQ0Y2EtNDgdfgfd4i05NTcyLTEwYWVmYTgxNWY4Yg.csv';
function fixture(o={}){
 const store=new Store(':memory:',Buffer.alloc(32,95).toString('base64'));
 store.putConnection(admin,{id:'li',tenantId:actor.tenantId,gateway,enabled:true,accounts:['508','509'],writeAccounts:['508','509'],scopes:['rw_ads'],label:'Synthetic LinkedIn'},{accessToken:'synthetic'});
 // Account 508 has an allowlist (11), two blocklists (15 processed, 16 processing) and preferences blocking 15; 509 has none.
 const files=new Map([[11,{entity:urn(508),fileName:'Allow.csv',type:'ALLOWLIST',status:'SUCCESS',dataId:'urn:li:media:/AAAA1111bbbb.csv'}],[15,{entity:urn(508),fileName:'Block.csv',type:'BLOCKLIST',status:'SUCCESS',dataId:'urn:li:media:/AAAA1515bbbb.csv'}],[16,{entity:urn(508),fileName:'New block.csv',type:'BLOCKLIST',status:'PROCESSING',dataId:'urn:li:media:/AAAA1616bbbb.csv'}],[99,{entity:urn(509),fileName:'Other.csv',type:'BLOCKLIST',status:'SUCCESS',dataId:'urn:li:media:/AAAA9999bbbb.csv'}]]);
 const prefs=new Map([['508',{include:[],exclude:[file(15)]}]]);
 let next=200,writes=0;const calls=[];
 const fetcher=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET',headers=new Headers(init?.headers);calls.push({method,path:url.pathname,query:Object.fromEntries(url.searchParams)});
  assert.equal(headers.get('x-restli-protocol-version'),'2.0.0');
  const a=/^\/rest\/adAccounts\/(\d+)$/.exec(url.pathname);
  if(method==='GET'&&a)return Response.json({id:Number(a[1]),status:'ACTIVE',currency:'USD'});
  if(method==='GET'&&url.pathname==='/rest/adPublisherRestrictions'){
   assert.equal(url.searchParams.get('q'),'entity');const start=Number(url.searchParams.get('start')),count=Number(url.searchParams.get('count'));
   const rows=[...files].filter(([,f])=>f.entity===url.searchParams.get('entity')).map(([id,f])=>({id,...f,compressionFormat:'NONE'}));
   return Response.json({elements:rows.slice(start,start+count),paging:{total:rows.length,count,start,links:[]}});
  }
  const t=/^\/rest\/adAccountTrustPreferences\/(\d+)$/.exec(url.pathname);
  if(method==='GET'&&t){const p=prefs.get(t[1]);return p?Response.json({offsiteAccountPreferences:{publisherRestrictionFiles:p},changeAuditStamps:{created:{time:1},lastModified:{time:Date.now()}}}):Response.json({status:404,message:'Not found'},{status:404});}
  writes++;const b=JSON.parse(String(init.body));
  if(url.pathname==='/rest/adPublisherRestrictions'&&method==='POST'){const id=next++;if(o.mode!=='ignore')files.set(id,{...b,type:b.type??'BLOCKLIST',status:'PROCESSING'});return new Response(null,{status:201,headers:{location:'/adPublisherRestrictions/'+id,'x-restli-id':String(id)}});}
  if(t&&method==='PUT'){if(o.mode==='error')return Response.json({status:422,message:'Invalid file'},{status:422});if(o.mode!=='ignore')prefs.set(t[1],b.offsiteAccountPreferences.publisherRestrictionFiles);return new Response(null,{status:204});}
  throw Error('Unexpected '+method+' '+url.pathname);
 };
 const service=new MirrorService(registry,store,new NativeTransport(fetcher),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const register=(account,payload,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.restriction,account_id:account,payload,...extra}},actor);
 const apply=(account,include,exclude,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.preferences,account_id:account,path_params:{account_id:account},payload:{offsiteAccountPreferences:{publisherRestrictionFiles:{include,exclude}}},...extra}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,files,prefs,register,apply,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an uploaded list is registered and verifies; account preferences are replaced, including for an account without any, and verify; a replay sends nothing',async()=>{
 const f=fixture();try{
  const r=ok(await f.register('508',{dataId:csv,entity:urn(508),fileName:'Allowlist.csv',type:'ALLOWLIST'}));assert.equal(r.data.creative_impact.scope,'publisher_restriction');assert.equal(r.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(r));assert.equal(f.files.get(200).type,'ALLOWLIST');assert.equal(ok(await f.verify(r)).data.status,'verified');assert.equal((await f.execute(r)).data.replayed,true);assert.equal(f.writes(),1);
  const p=ok(await f.apply('508',[file(11)],[file(15)]));assert.equal(p.data.creative_impact.scope,'account_trust_preferences');assert.equal(p.data.creative_impact.may_affect_serving,true);assert.match(p.data.creative_impact.effect,/Only the allowlisted/);
  ok(await f.execute(p));assert.deepEqual(f.prefs.get('508'),{include:[file(11)],exclude:[file(15)]});assert.equal(ok(await f.verify(p)).data.status,'verified');
  const c=ok(await f.apply('508',[],[]));assert.match(c.data.creative_impact.effect,/No account allowlist/);ok(await f.execute(c));assert.equal(ok(await f.verify(c)).data.status,'verified');
  const b=ok(await f.register('508',{dataId:'urn:li:media:/AAAA2020bbbb.csv',entity:urn(508),fileName:'Blocklist.csv'}));ok(await f.execute(b));assert.equal(f.files.get(201).type,'BLOCKLIST');assert.equal(ok(await f.verify(b)).data.status,'verified');
  assert.equal(f.writes(),4);
 }finally{f.store.close();}
 const g=fixture();try{
  // No preferences exist yet for 509: the upsert creates them.
  const p=ok(await g.apply('509',[],[file(99)]));assert.equal(p.data.creative_impact.before.present,false);ok(await g.execute(p));assert.equal(ok(await g.verify(p)).data.status,'verified');
 }finally{g.store.close();}
});

test('malformed lists and preferences are refused before any request; foreign, mismatched, unprocessed and already registered files and unchanged preferences after reading',async()=>{
 const good={dataId:csv,entity:urn(508),fileName:'List.csv'};
 const cases=[
  ['another account',f=>f.register('508',{...good,entity:urn(509)})],
  ['not a CSV media URN',f=>f.register('508',{...good,dataId:'https://example.com/list.csv'})],
  ['blank file name',f=>f.register('508',{...good,fileName:' '})],
  ['unknown type',f=>f.register('508',{...good,type:'GREYLIST'})],
  ['another field',f=>f.register('508',{...good,status:'SUCCESS'})],
  ['an upload URL action',f=>f.register('508',good,{query:{action:'generateRestrictionsUploadUrl'}})],
  ['a missing list',f=>service(f,{offsiteAccountPreferences:{publisherRestrictionFiles:{include:[file(11)]}}})],
  ['a file in both lists',f=>f.apply('508',[file(11)],[file(11)])],
  ['not a publisher file URN',f=>f.apply('508',['urn:li:sponsoredAccount:508'],[])],
  ['another preference field',f=>service(f,{offsiteAccountPreferences:{publisherRestrictionFiles:{include:[],exclude:[]},iabCategories:{exclude:[]}}})]
 ];
 function service(f,payload){return f.apply('508',[],[],{payload});}
 for(const [label,run] of cases){const f=fixture();try{const r=await run(f);assert.equal(r.error?.code,'INVALID_LINKEDIN_PUBLISHER_RESTRICTION',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const x=fixture();try{const r=await x.apply('508',[],[],{path_params:{account_id:'509'}});assert.equal(r.error?.code,'ACCOUNT_SCOPE_MISMATCH','another account in the path');assert.equal(x.calls.length,0);}finally{x.store.close();}
 const f=fixture();try{
  assert.equal((await f.register('508',{dataId:'urn:li:media:/AAAA1515bbbb.csv',entity:urn(508),fileName:'Again.csv'})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.apply('508',[],[file(99)])).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.apply('508',[file(15)],[])).error?.code,'INVALID_LINKEDIN_PUBLISHER_RESTRICTION');
  assert.equal((await f.apply('508',[],[file(16)])).error?.code,'INVALID_LINKEDIN_PUBLISHER_RESTRICTION');
  assert.equal((await f.apply('508',[],[file(15)])).error?.code,'INVALID_LINKEDIN_PUBLISHER_RESTRICTION');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('a refused update is never resubmitted, ignored writes are not verified, and the ledger lists both writes',async()=>{
 const e=fixture({mode:'error'});try{const p=ok(await e.apply('508',[file(11)],[file(15)]));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture({mode:'ignore'});try{for(const p of [ok(await g.register('508',{dataId:csv,entity:urn(508),fileName:'List.csv'})),ok(await g.apply('508',[file(11)],[file(15)]))]){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}}finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'linkedin_publisher_restrictions',action);}
});
