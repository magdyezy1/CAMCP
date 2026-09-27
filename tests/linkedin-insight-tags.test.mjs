import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * LinkedIn Insight Tags ("Conversion Tracking", li-lms-2025-10 to li-lms-2026-09, checked 2026-09-27): creation for one ad
 * account and the first-party tracking switch.
 */
const registry=new Registry(),gateway='linkedin_native_action';
const actor={tenantId:'linkedin-insight-tags',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const actions={create:'linkedin_rest_insight_tags_post',update:'linkedin_rest_insight_tags_insight_tag_id_post'};
const urn=id=>'urn:li:sponsoredAccount:'+id;
function fixture(o={}){
 const store=new Store(':memory:',Buffer.alloc(32,93).toString('base64'));
 store.putConnection(admin,{id:'li',tenantId:actor.tenantId,gateway,enabled:true,accounts:['507','508','509'],writeAccounts:['507','508','509'],scopes:['rw_ads'],label:'Synthetic LinkedIn'},{accessToken:'synthetic'});
 // Account 508 owns tag 100 (FULL) and shares it with 509 (USE_ONLY); 507 has none.
 const tags=new Map([[100,{id:100,sponsoredAccounts:[urn(508),urn(509)],firstPartyTrackingEnabled:true,tag:'<script></script>'}]]);
 const roles={508:[{insightTag:'urn:li:insightTag:100',accessRole:'FULL'}],509:[{insightTag:'urn:li:insightTag:100',accessRole:'USE_ONLY'}],507:[]};
 let next=200,writes=0;const calls=[];
 const fetcher=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET',headers=new Headers(init?.headers);calls.push({method,path:url.pathname,query:Object.fromEntries(url.searchParams)});
  assert.equal(headers.get('x-restli-protocol-version'),'2.0.0');
  const a=/^\/rest\/adAccounts\/(\d+)$/.exec(url.pathname);
  if(method==='GET'&&a)return Response.json({id:Number(a[1]),status:'ACTIVE',currency:'USD'});
  if(method==='GET'&&url.pathname==='/rest/insightTags'){const acct=url.searchParams.get('account');return Response.json({elements:[...tags.values()].filter(t=>t.sponsoredAccounts.includes(acct)),paging:{count:10,start:0,links:[]}});}
  if(method==='GET'&&url.pathname==='/rest/insightTagsPermission'){const acct=url.searchParams.get('account').split(':').at(-1);return Response.json({elements:roles[acct]??[],paging:{count:10,start:0,links:[]}});}
  const t=/^\/rest\/insightTags\/(\d+)$/.exec(url.pathname);
  if(method==='GET'&&t)return tags.has(Number(t[1]))?Response.json(tags.get(Number(t[1]))):Response.json({status:404,serviceErrorCode:100,message:'Not found'},{status:404});
  writes++;const b=JSON.parse(String(init.body));
  if(url.pathname==='/rest/insightTags'){const id=next++;const row={id,sponsoredAccounts:b.sponsoredAccounts,firstPartyTrackingEnabled:true,tag:'<script></script>'};if(o.mode!=='ignore')tags.set(id,row);return new Response(JSON.stringify(row),{status:201,headers:{'content-type':'application/json','x-restli-id':String(id)}});}
  if(t){assert.equal(headers.get('x-restli-method'),'PARTIAL_UPDATE');if(o.mode!=='ignore')tags.get(Number(t[1])).firstPartyTrackingEnabled=b.patch.$set.firstPartyTrackingEnabled;return new Response(null,{status:204});}
  throw Error('Unexpected '+method+' '+url.pathname);
 };
 const service=new MirrorService(registry,store,new NativeTransport(fetcher),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const create=(account,payload)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.create,account_id:account,payload}},actor);
 const update=(account,id,value,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.update,account_id:account,restli_method:'PARTIAL_UPDATE',path_params:{insight_tag_id:String(id)},payload:{patch:{$set:{firstPartyTrackingEnabled:value}}},...extra}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,tags,create,update,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an account without a tag gets one and it verifies; the owner switches first-party tracking for every sharing account, verified; a replay sends nothing',async()=>{
 const f=fixture();try{
  const p=ok(await f.create('507',{sponsoredAccounts:[urn(507)]}));assert.equal(p.data.creative_impact.scope,'insight_tag');assert.match(p.data.creative_impact.effect,/tracks nothing until/);
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  const u=ok(await f.update('508',100,false));assert.deepEqual(u.data.creative_impact.shared_with,[urn(508),urn(509)]);assert.match(u.data.creative_impact.effect,/every ad account that shares it/);
  ok(await f.execute(u));assert.equal(f.tags.get(100).firstPartyTrackingEnabled,false);assert.equal(ok(await f.verify(u)).data.status,'verified');
 }finally{f.store.close();}
});

test('malformed requests are refused before any request',async()=>{
 const cases=[
  ['two accounts',f=>f.create('507',{sponsoredAccounts:[urn(507),urn(508)]})],
  ['other account',f=>f.create('507',{sponsoredAccounts:[urn(508)]})],
  ['extra field',f=>f.create('507',{sponsoredAccounts:[urn(507)],firstPartyTrackingEnabled:false})],
  ['text value',f=>f.update('508',100,'no')],
  ['other field',f=>f.update('508',100,true,{payload:{patch:{$set:{tag:'<script></script>'}}}})],
  ['unset',f=>f.update('508',100,true,{payload:{patch:{$delete:['firstPartyTrackingEnabled']}}})],
  ['no partial update',f=>f.update('508',100,true,{restli_method:undefined})]
 ];
 for(const [label,run] of cases){const f=fixture();try{const r=await run(f);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label+': '+JSON.stringify(r).slice(0,300));}finally{f.store.close();}}
});

test('a second tag, a shared tag without FULL access, another account\'s tag and unchanged settings are refused after reading; an ignored change is not verified; the ledger lists both writes',async()=>{
 const f=fixture();try{
  assert.equal((await f.create('508',{sponsoredAccounts:[urn(508)]})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.update('509',100,false)).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.equal((await f.update('507',100,false)).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.match((await f.update('508',100,true)).error?.message??'',/already has first-party tracking enabled/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 const g=fixture({mode:'ignore'});try{const p=ok(await g.update('508',100,false));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'linkedin_insight_tags',action);}
});
