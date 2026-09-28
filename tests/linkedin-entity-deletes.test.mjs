import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Batch deletion of LinkedIn campaign groups and creatives ("Create and Manage Campaign Groups", "Create and Manage
 * Creatives"; li-lms-2026-09, checked 2026-09-28).
 */
const registry=new Registry(),gateway='linkedin_native_action';
const actions={groups:'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_delete',creatives:'linkedin_rest_ad_accounts_ad_account_id_creatives_delete'};
const actor={tenantId:'linkedin-entity-deletes',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const acct='urn:li:sponsoredAccount:507',other='urn:li:sponsoredAccount:999',cu=n=>'urn:li:sponsoredCreative:'+n,gu=n=>'urn:li:sponsoredCampaignGroup:'+n;
function fixture(o={}){
 const store=new Store(':memory:',Buffer.alloc(32,104).toString('base64'));
 store.putConnection(admin,{id:'li',tenantId:actor.tenantId,gateway,enabled:true,accounts:['507'],writeAccounts:['507'],scopes:o.scopes??['rw_ads'],label:'Synthetic LinkedIn'},{accessToken:'synthetic'});
 const groups=new Map([[801,{account:acct,name:'Spring draft',status:'DRAFT'}],[802,{account:acct,name:'Summer draft',status:'DRAFT'}],[803,{account:other,name:'Foreign',status:'DRAFT'}],[804,{account:acct,name:'Always on',status:'ACTIVE'}],[805,{account:acct,name:'Draft with campaigns',status:'DRAFT'}]]);
 const campaigns=new Map([[601,{account:acct,campaignGroup:gu(804),status:'ACTIVE'}],[602,{account:acct,campaignGroup:gu(805),status:'DRAFT'}]]);
 const creatives=new Map([[901,{account:acct,campaign:'urn:li:sponsoredCampaign:601',intendedStatus:'DRAFT',name:'Draft creative'}],[902,{account:acct,campaign:'urn:li:sponsoredCampaign:602',intendedStatus:'ACTIVE',name:'Creative of a draft campaign'}],[903,{account:acct,campaign:'urn:li:sponsoredCampaign:601',intendedStatus:'ACTIVE',name:'Live creative'}],[904,{account:other,campaign:'urn:li:sponsoredCampaign:700',intendedStatus:'DRAFT',name:'Foreign'}],[905,{account:acct,campaign:'urn:li:sponsoredCampaign:601',intendedStatus:'REMOVED',name:'Removed'}]]);
 let writes=0;const calls=[];
 const missing=()=>Response.json({status:404,serviceErrorCode:100,message:'Not found'},{status:404});
 const fetcher=async(raw,init)=>{
  const url=new URL(String(raw)),method=init?.method??'GET',headers=new Headers(init?.headers);calls.push({method,path:url.pathname,search:url.search});
  assert.equal(headers.get('x-restli-protocol-version'),'2.0.0');
  let m;
  if(method==='GET'&&(m=/^\/rest\/adAccounts\/507\/adCampaignGroups\/(\d+)$/.exec(url.pathname)))return groups.has(+m[1])?Response.json({id:+m[1],backfilled:false,test:false,...groups.get(+m[1])}):missing();
  if(method==='GET'&&(m=/^\/rest\/adAccounts\/507\/adCampaigns\/(\d+)$/.exec(url.pathname)))return campaigns.has(+m[1])?Response.json({id:+m[1],...campaigns.get(+m[1])}):missing();
  if(method==='GET'&&url.pathname==='/rest/adAccounts/507/adCampaigns'){
   assert.equal(url.searchParams.get('q'),'search');assert.equal(url.searchParams.get('pageSize'),'1');
   const s=url.searchParams.get('search'),g=/^\(campaignGroup:\(values:List\(urn:li:sponsoredCampaignGroup:(\d+)\)\),status:\(values:List\(ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION\)\)\)$/.exec(s);assert.ok(g,s);
   const rows=[...campaigns].filter(([,c])=>c.campaignGroup===gu(g[1])).map(([id,c])=>({id,...c}));
   return Response.json({elements:rows.slice(0,1),metadata:{nextPageToken:rows.length>1?'next':null}});
  }
  if(method==='GET'&&(m=/^\/rest\/adAccounts\/507\/creatives\/urn%3Ali%3AsponsoredCreative%3A(\d+)$/.exec(url.pathname)))return creatives.has(+m[1])?Response.json({id:cu(m[1]),isServing:false,...creatives.get(+m[1])}):missing();
  if(method==='DELETE'&&/^\/rest\/adAccounts\/507\/(adCampaignGroups|creatives)$/.test(url.pathname)){
   writes++;assert.equal(headers.get('x-restli-method'),'BATCH_DELETE');assert.equal(init.body,undefined);
   const list=/^List\((.*)\)$/.exec(url.searchParams.get('ids'))[1].split(','),isGroups=url.pathname.endsWith('adCampaignGroups');
   if(o.mode==='error')return Response.json({status:400,message:'Entity is not in a deletable state'},{status:400});
   if(o.mode==='partial'){if(isGroups)groups.delete(+list[0]);return Response.json({results:{[list[0]]:{status:204}},errors:{[list[1]]:{status:400,message:'Not deletable'}}});}
   if(o.mode!=='ignore')for(const id of list){if(isGroups){groups.delete(+id);continue;}const n=+id.split(':').at(-1);if(o.keep?.includes(n))creatives.get(n).intendedStatus='REMOVED';else creatives.delete(n);}
   return isGroups?new Response(null,{status:204}):Response.json({results:Object.fromEntries(list.map(id=>[id,{status:204}])),errors:{}});
  }
  throw Error('Unexpected '+method+' '+url.pathname+url.search);
 };
 const service=new MirrorService(registry,store,new NativeTransport(fetcher),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(kind,ids,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions[kind],account_id:'507',restli_method:'BATCH_DELETE',query:{ids},...extra}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,groups,campaigns,creatives,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('draft campaign groups and deletable creatives are deleted in one batch each and verify; a replay sends nothing',async()=>{
 const f=fixture({keep:[902]});try{
  const g=ok(await f.prepare('groups',['801','802']));
  assert.equal(g.data.creative_impact.operation,'batch_delete');assert.deepEqual(g.data.creative_impact.deleting.map(d=>d.name),['Spring draft','Summer draft']);assert.equal(g.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(g));assert.equal(f.groups.has(801)||f.groups.has(802),false);assert.equal(ok(await f.verify(g)).data.status,'verified');
  assert.equal((await f.execute(g)).data.replayed,true);assert.equal(f.writes(),1);
  const c=ok(await f.prepare('creatives',[cu(901),cu(902)]));
  assert.equal(f.calls.some(x=>x.path==='/rest/adAccounts/507/adCampaigns/601'),false,'a DRAFT creative needs no campaign read');
  assert.equal(f.calls.some(x=>x.path==='/rest/adAccounts/507/adCampaigns/602'),true,'a creative that is not DRAFT needs its campaign read');
  ok(await f.execute(c));assert.equal(f.creatives.has(901),false);assert.equal(f.creatives.get(902).intendedStatus,'REMOVED');
  assert.equal(ok(await f.verify(c)).data.status,'verified','a REMOVED creative, kept for reporting, counts as deleted');assert.equal(f.writes(),2);
 }finally{f.store.close();}
});

test('malformed batches are refused before any request; foreign, live, occupied, missing and removed entities after reading',async()=>{
 const cases=[
  ['a single DELETE method','groups',['801'],{restli_method:'DELETE'}],
  ['another query parameter','groups',['801'],{query:{ids:['801'],fields:'id'}}],
  ['a payload','groups',['801'],{payload:{force:true}}],
  ['a repeated ID','groups',['801','801']],
  ['no IDs','groups',[]],
  ['26 IDs','groups',Array.from({length:26},(_,i)=>String(810+i))],
  ['a group URN','groups',[gu(801)]],
  ['a numeric creative ID','creatives',['901']]
 ];
 for(const [label,kind,ids,extra] of cases){const f=fixture();try{const r=await f.prepare(kind,ids,extra);assert.equal(r.error?.code,'INVALID_LINKEDIN_BATCH_DELETE',label+': '+JSON.stringify(r).slice(0,400));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.prepare('groups',['803'])).error?.code,'RESOURCE_SCOPE_REQUIRED');
  assert.match((await f.prepare('groups',['801','804'])).error?.message??'',/ACTIVE; LinkedIn deletes only DRAFT campaign groups.*PENDING_DELETION/);
  assert.match((await f.prepare('groups',['805'])).error?.message??'',/still has campaigns \(urn:li:sponsoredCampaign:602\)/);
  assert.equal((await f.prepare('groups',['899'])).error?.code,'STATE_NOT_FOUND');
  assert.match((await f.prepare('creatives',[cu(903)])).error?.message??'',/ACTIVE in a ACTIVE campaign/);
  assert.equal((await f.prepare('creatives',[cu(904)])).error?.code,'RESOURCE_SCOPE_REQUIRED');
  assert.match((await f.prepare('creatives',[cu(905)])).error?.message??'',/already REMOVED/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 const g=fixture({scopes:['r_ads']});try{assert.equal((await g.prepare('groups',['801'])).error?.code,'INSUFFICIENT_SCOPE');assert.equal(g.writes(),0);}finally{g.store.close();}
});

test('an error or partial reply is never resubmitted, an ignored deletion is not verified, and the ledger lists both rows',async()=>{
 for(const mode of ['error','partial']){const e=fixture({mode});try{const p=ok(await e.prepare('groups',['801','802']));assert.equal((await e.execute(p)).success,false,mode);assert.equal((await e.execute(p)).success,false,mode);assert.equal(e.writes(),1,mode);}finally{e.store.close();}}
 const g=fixture({mode:'ignore'});try{const p=ok(await g.prepare('creatives',[cu(901)]));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}finally{g.store.close();}
 for(const [kind,action] of Object.entries(actions)){const row=actionContracts(registry).find(r=>r.gateway===gateway&&r.action===action);assert.equal(row?.status,'reviewed_write_family',kind);assert.equal(row.family,'linkedin_entity_deletes',kind);}
});
