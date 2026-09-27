import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Advertiser-owned DV360 inventory source groups, Display & Video 360 API v4 (pinned Discovery document, checked
 * 2026-09-27): groups are created, renamed and deleted; inventory sources are assigned and removed one by one or in bulk.
 */
const gateway='dv360_native_action',registry=new Registry();
const actor={tenantId:'dv360-inventory-groups',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const G='DV360_INVENTORY_SOURCE_GROUPS_',S=G+'ASSIGNED_INVENTORY_SOURCES_';
const actions=[G+'CREATE',G+'PATCH',G+'DELETE',S+'CREATE',S+'DELETE',S+'BULK_EDIT'];
const error=(code,status,message)=>Response.json({error:{code,status,message}},{status:code});
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,74).toString('base64')),calls=[];
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'synthetic'});
 // Inventory sources advertiser 123 can use; 399 exists but is not shared with it.
 const sources=[['301','Sports PMP deal','INVENTORY_SOURCE_TYPE_PRIVATE'],['302','News auction package','INVENTORY_SOURCE_TYPE_AUCTION_PACKAGE'],['303','Video deal','INVENTORY_SOURCE_TYPE_PRIVATE'],['304','Audio deal','INVENTORY_SOURCE_TYPE_PRIVATE'],['305','Games deal','INVENTORY_SOURCE_TYPE_PRIVATE']]
  .map(([id,displayName,inventorySourceType])=>({name:'inventorySources/'+id,inventorySourceId:id,displayName,inventorySourceType,exchange:'EXCHANGE_GOOGLE_AD_MANAGER',dealId:'deal-'+id,status:{entityStatus:'ENTITY_STATUS_ACTIVE'},readAdvertiserIds:['123']}));
 // Group 502 belongs to the partner and is shared with the advertiser: readable, but not writable with advertiser access.
 const groups=new Map([['501',{displayName:'Premium deals',owner:'123',assigned:new Map([['11','301'],['12','302']])}],['502',{displayName:'Partner deals',owner:'partner',assigned:new Map([['21','301']])}]]);
 let writes=0,nextGroup=700,nextAssignment=40;
 const shownGroup=(id,g)=>({name:'inventorySourceGroups/'+id,inventorySourceGroupId:id,displayName:g.displayName});
 const shownAssignment=(g,a,s)=>({name:'inventorySourceGroups/'+g+'/assignedInventorySources/'+a,assignedInventorySourceId:a,inventorySourceId:s});
 // DV360 may return fewer rows than pageSize; two per page exercises the cursors.
 const page=(rows,key,u)=>{const start=Number(u.searchParams.get('pageToken')??0),slice=rows.slice(start,start+2);return Response.json({...(slice.length?{[key]:slice}:{}),...(start+2<rows.length?{nextPageToken:String(start+2)}:{})});};
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method,body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,query:u.search});
  if(u.searchParams.has('partnerId'))return error(400,'INVALID_ARGUMENT','Unexpected partner access.');
  if(method==='GET'){
   if(path==='/v4/advertisers/123')return Response.json({name:'advertisers/123',advertiserId:'123',partnerId:'1',displayName:'Advertiser',entityStatus:'ENTITY_STATUS_ACTIVE',generalConfig:{currencyCode:'USD'}});
   if(u.searchParams.get('advertiserId')!=='123')return error(403,'PERMISSION_DENIED','Advertiser access required.');
   if(path==='/v4/inventorySources')return page(sources,'inventorySources',u);
   let m=/^\/v4\/inventorySourceGroups\/(\d+)$/.exec(path);
   if(m&&groups.has(m[1]))return Response.json(shownGroup(m[1],groups.get(m[1])));
   m=/^\/v4\/inventorySourceGroups\/(\d+)\/assignedInventorySources$/.exec(path);
   if(m&&groups.has(m[1]))return page([...groups.get(m[1]).assigned].map(([a,s])=>shownAssignment(m[1],a,s)),'assignedInventorySources',u);
   return error(404,'NOT_FOUND','Not found.');
  }
  writes++;
  const advertiser=u.searchParams.get('advertiserId')??body?.advertiserId;
  if(path==='/v4/inventorySourceGroups'&&method==='POST'){const id=String(nextGroup++),g={displayName:body.displayName,owner:advertiser,assigned:new Map()};groups.set(id,g);return Response.json(shownGroup(id,g));}
  const m=/^\/v4\/inventorySourceGroups\/(\d+)(\/assignedInventorySources(?::bulkEdit|\/(\d+))?)?$/.exec(path),g=m&&groups.get(m[1]);
  if(!g)return error(404,'NOT_FOUND','Not found.');
  if(g.owner!==advertiser)return error(403,'PERMISSION_DENIED','Only the owner can change this inventory source group.');
  if(!m[2]&&method==='PATCH'){if(mode!=='ignore')g.displayName=body.displayName;return Response.json(shownGroup(m[1],{...g,displayName:body.displayName}));}
  if(!m[2]&&method==='DELETE'){if(mode!=='ignore')groups.delete(m[1]);return Response.json({});}
  if(m[3]&&method==='DELETE'){if(!g.assigned.has(m[3]))return error(404,'NOT_FOUND','Not found.');if(mode!=='ignore')g.assigned.delete(m[3]);return Response.json({});}
  const create=list=>list.map(({inventorySourceId})=>{const a=String(nextAssignment++);if(mode!=='ignore')g.assigned.set(a,inventorySourceId);return shownAssignment(m[1],a,inventorySourceId);});
  if(path.endsWith(':bulkEdit')){if(mode!=='ignore')for(const a of body.deletedAssignedInventorySources??[])g.assigned.delete(a);const rows=create(body.createdAssignedInventorySources??[]);return Response.json(rows.length?{assignedInventorySources:rows}:{});}
  if(method==='POST')return Response.json(create([body])[0]);
  throw new Error('Unexpected write '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,params,body)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,params,...(body===undefined?{}:{body})}},actor);
 const execute=(p,extra={spend_change_confirmed:true})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,groups,service,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const members=(f,g)=>[...f.groups.get(g).assigned.values()].sort();

test('a group is created, renamed and deleted, each verified; creation needs no spending confirmation and a replay sends nothing',async()=>{
 const f=fixture();try{
  const created=ok(await f.prepare(G+'CREATE',{advertiserId:'123'},{displayName:'Sports deals'}));
  assert.equal(created.data.creative_impact.scope,'inventory_source_group');assert.equal(created.data.creative_impact.may_affect_serving,false);assert.match(created.data.creative_impact.effect,/empty inventory source group/);
  ok(await f.execute(created,{}));assert.equal(f.writes(),1);assert.equal(ok(await f.verify(created)).data.status,'verified');
  assert.equal((await f.execute(created,{})).data.replayed,true);assert.equal(f.writes(),1);
  const id='700';assert.equal(f.groups.get(id).displayName,'Sports deals');assert.equal(f.groups.get(id).owner,'123');
  const renamed=ok(await f.prepare(G+'PATCH',{advertiserId:'123',inventorySourceGroupId:id,updateMask:'displayName'},{displayName:'Sports and esports deals'}));
  ok(await f.execute(renamed,{}));assert.equal(ok(await f.verify(renamed)).data.status,'verified');assert.equal(f.groups.get(id).displayName,'Sports and esports deals');
  const removed=ok(await f.prepare(G+'DELETE',{advertiserId:'123',inventorySourceGroupId:'501'}));
  assert.equal(removed.data.creative_impact.may_affect_serving,true);assert.deepEqual(removed.data.creative_impact.before.inventorySources,['301','302']);
  assert.equal((await f.execute(removed,{})).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(removed));assert.equal(f.groups.has('501'),false);assert.equal(ok(await f.verify(removed)).data.status,'verified');
 }finally{f.store.close();}
});

test('sources are assigned and removed one by one and in bulk after reading every assignment and the advertiser\'s sources page by page, each verified',async()=>{
 const f=fixture();try{
  const add=ok(await f.prepare(S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'305'}));
  assert.deepEqual(add.data.creative_impact.adding.map(s=>[s.inventorySourceId,s.displayName]),[['305','Games deal']]);assert.deepEqual(add.data.creative_impact.after.inventorySources,['301','302','305']);
  assert.ok(f.calls.filter(c=>c.path==='/v4/inventorySources').length>=3,'three pages of sources were read');
  assert.equal((await f.execute(add,{})).error?.code,'SPEND_CONFIRMATION_REQUIRED');
  ok(await f.execute(add));assert.equal(ok(await f.verify(add)).data.status,'verified');assert.deepEqual(members(f,'501'),['301','302','305']);
  const drop=ok(await f.prepare(S+'DELETE',{advertiserId:'123',inventorySourceGroupId:'501',assignedInventorySourceId:'11'}));
  ok(await f.execute(drop));assert.equal(ok(await f.verify(drop)).data.status,'verified');assert.deepEqual(members(f,'501'),['302','305']);
  const bulk=ok(await f.prepare(S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',deletedAssignedInventorySources:['12'],createdAssignedInventorySources:[{inventorySourceId:'303'},{inventorySourceId:'304'}]}));
  assert.deepEqual(bulk.data.creative_impact.removing,[{assignedInventorySourceId:'12',inventorySourceId:'302'}]);
  ok(await f.execute(bulk));assert.equal(ok(await f.verify(bulk)).data.status,'verified');assert.deepEqual(members(f,'501'),['303','304','305']);
  const only=ok(await f.prepare(S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',deletedAssignedInventorySources:['40']}));
  ok(await f.execute(only));assert.equal(ok(await f.verify(only)).data.status,'verified');assert.deepEqual(members(f,'501'),['303','304']);
  assert.equal(f.writes(),4);
 }finally{f.store.close();}
});

test('malformed requests are refused before any request',async()=>{
 const cases=[
  ['partner owner on create',G+'CREATE',{advertiserId:'123',partnerId:'1'},{displayName:'X'},'INVALID_DV360_INVENTORY_GROUP'],
  ['blank name',G+'CREATE',{advertiserId:'123'},{displayName:' '},'INVALID_DV360_INVENTORY_GROUP'],
  ['name over 240 bytes',G+'CREATE',{advertiserId:'123'},{displayName:'é'.repeat(121)},'INVALID_DV360_INVENTORY_GROUP'],
  ['output-only ID',G+'CREATE',{advertiserId:'123'},{displayName:'X',inventorySourceGroupId:'9'},'INVALID_DV360_INVENTORY_GROUP'],
  ['other update mask',G+'PATCH',{advertiserId:'123',inventorySourceGroupId:'501',updateMask:'name'},{displayName:'X'},'INVALID_DV360_INVENTORY_GROUP'],
  ['patch without mask',G+'PATCH',{advertiserId:'123',inventorySourceGroupId:'501'},{displayName:'X'},'INVALID_DV360_INVENTORY_GROUP'],
  ['assignment without numeric source',S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'deal-303'},'INVALID_DV360_INVENTORY_GROUP'],
  ['assignment extra field',S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'303',name:'x'},'INVALID_DV360_INVENTORY_GROUP'],
  ['empty bulk edit',S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123'},'INVALID_DV360_INVENTORY_GROUP'],
  ['duplicate bulk source',S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',createdAssignedInventorySources:[{inventorySourceId:'303'},{inventorySourceId:'303'}]},'INVALID_DV360_INVENTORY_GROUP'],
  ['bulk partner owner',S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',partnerId:'1',deletedAssignedInventorySources:['11']},'INVALID_DV360_INVENTORY_GROUP'],
  ['bulk advertiser in query',S+'BULK_EDIT',{inventorySourceGroupId:'501',advertiserId:'123'},{advertiserId:'123',deletedAssignedInventorySources:['11']},'INVALID_DV360_INVENTORY_GROUP'],
  ['an advertiser without a connection',G+'CREATE',{advertiserId:'124'},{displayName:'X'},'CONNECTION_REQUIRED']
 ];
 for(const [label,action,params,body,code] of cases){const f=fixture();try{const r=await f.prepare(action,params,body);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
});

test('unknown assignments, sources already assigned or not shared with the advertiser, a removed source added again, an unchanged name and a missing group are refused without writes',async()=>{
 const f=fixture();try{
  const code=async(action,params,body)=>(await f.prepare(action,params,body)).error?.code;
  assert.equal(await code(S+'DELETE',{advertiserId:'123',inventorySourceGroupId:'501',assignedInventorySourceId:'19'}),'STATE_NOT_FOUND');
  assert.equal(await code(S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'301'}),'CONFIGURATION_EXISTS');
  const unshared=await f.prepare(S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'399'});assert.equal(unshared.error?.code,'STATE_NOT_FOUND');assert.match(unshared.error.message,/cannot use inventory sources 399/);
  assert.equal(await code(S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',deletedAssignedInventorySources:['11'],createdAssignedInventorySources:[{inventorySourceId:'301'}]}),'INVALID_DV360_INVENTORY_GROUP');
  assert.equal(await code(G+'PATCH',{advertiserId:'123',inventorySourceGroupId:'501',updateMask:'displayName'},{displayName:'Premium deals'}),'INVALID_DV360_INVENTORY_GROUP');
  assert.equal((await f.prepare(G+'PATCH',{advertiserId:'123',inventorySourceGroupId:'599',updateMask:'displayName'},{displayName:'X'})).success,false);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('a shared partner group is refused by DV360 and never resubmitted; an ignored change is not verified; owner activation and deletion rules apply',async()=>{
 const f=fixture();try{
  const shared=ok(await f.prepare(G+'PATCH',{advertiserId:'123',inventorySourceGroupId:'502',updateMask:'displayName'},{displayName:'Renamed'}));
  assert.equal((await f.execute(shared,{})).success,false);assert.equal((await f.execute(shared,{})).success,false);assert.equal(f.writes(),1);
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await f.prepare(S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'303'})).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  ok(await f.prepare(G+'CREATE',{advertiserId:'123'},{displayName:'Still allowed'}));
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:false}});
  assert.equal((await f.prepare(G+'DELETE',{advertiserId:'123',inventorySourceGroupId:'501'})).error?.code,'POLICY_DELETION_FORBIDDEN');
  assert.equal((await f.prepare(S+'BULK_EDIT',{inventorySourceGroupId:'501'},{advertiserId:'123',deletedAssignedInventorySources:['11']})).error?.code,'POLICY_DELETION_FORBIDDEN');
 }finally{f.store.close();}
 const ignored=fixture('ignore');try{
  const p=ok(await ignored.prepare(S+'CREATE',{advertiserId:'123',inventorySourceGroupId:'501'},{inventorySourceId:'303'}));ok(await ignored.execute(p));
  assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');
 }finally{ignored.store.close();}
});

test('the models match the pinned document, native reads are scoped to the advertiser, and the ledger lists the six writes in the family',async()=>{
 const d=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')),M=(d.document??d).schemas;
 assert.deepEqual(Object.keys(M.InventorySourceGroup.properties).sort(),['displayName','inventorySourceGroupId','name']);
 assert.deepEqual(Object.keys(M.AssignedInventorySource.properties).sort(),['assignedInventorySourceId','inventorySourceId','name']);
 assert.deepEqual(Object.keys(M.BulkEditAssignedInventorySourcesRequest.properties).sort(),['advertiserId','createdAssignedInventorySources','deletedAssignedInventorySources','partnerId']);
 const f=fixture();try{
  const list=ok(await f.service.call(gateway,{action:'DV360_INVENTORY_SOURCES_LIST',params:{advertiserId:'123',pageSize:2}},actor));assert.equal(list.data.data.inventorySources.length,2);
  ok(await f.service.call(gateway,{action:G+'GET',params:{advertiserId:'123',inventorySourceGroupId:'501'}},actor));
  assert.equal((await f.service.call(gateway,{action:'DV360_INVENTORY_SOURCES_LIST',params:{advertiserId:'123',partnerId:'1'}},actor)).error?.code,'RESOURCE_SCOPE_REQUIRED');
 }finally{f.store.close();}
 for(const action of actions){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'dv360_inventory_source_groups',action);}
});
