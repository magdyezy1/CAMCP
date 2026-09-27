import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Deleting Snapchat audience segments (Marketing API "Delete a Segment", checked 2026-09-27): segments listed from the
 * selected ad account are deleted unless an ad squad of the account still targets them.
 */
const SNAP='44444444-4444-4444-8444-444444444446',gateway='snapchat_native_action',account='acct1',registry=new Registry();
const actions=['snapchat_segments_segment_id_delete','snapchat_audience_delete'];
const actor={tenantId:'snap-segment-delete',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,63).toString('base64'));
 store.putConnection(admin,{id:SNAP,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]},{accessToken:'synthetic'});
 const segments=new Map([['seg1',{name:'Old list',source_type:'FIRST_PARTY'}],['seg2',{name:'Buyers',source_type:'FIRST_PARTY'}],['seg3',{name:'Exclusions',source_type:'FIRST_PARTY'}]]);
 // One ad squad includes seg2 and another excludes seg3; three per page exercises the cursors.
 const squads=[{id:'sq1',name:'Buyers retargeting',status:'ACTIVE',targeting:{geos:[{country_code:'us'}],segments:[{segment_id:['seg2']}]}},{id:'sq2',name:'Prospecting',status:'PAUSED',targeting:{segments:[{segment_id:['seg3'],operation:'EXCLUDE'}]}},{id:'sq3',name:'Broad',status:'ACTIVE',targeting:{geos:[{country_code:'us'}]}},{id:'sq4',name:'Lookalikes',status:'ACTIVE',targeting:{segments:[{segment_id:['lal9']}]}}];
 const requests=[];let writes=0,n=0;
 const page=(rows,key,item,u)=>{const start=Number(u.searchParams.get('cursor')??0),slice=rows.slice(start,start+3),more=start+3<rows.length;return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,paging:more?{next_link:'https://adsapi.snapchat.com'+u.pathname+'?cursor='+(start+3)}:{},[key]:slice.map(v=>({sub_request_status:'SUCCESS',[item]:v}))});};
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname,method=init.method??'GET';requests.push(method+' '+path);
  if(method==='GET'&&path==='/v1/adaccounts/acct1/segments')return page([...segments].map(([id,s])=>({id,ad_account_id:account,...s,status:'ACTIVE'})),'segments','segment',u);
  if(method==='GET'&&path==='/v1/adaccounts/acct1/adsquads')return page(squads,'adsquads','adsquad',u);
  const m=/^\/v1\/segments\/([^/]+)$/.exec(path);
  if(method==='DELETE'&&m){writes++;if(mode!=='ignore')segments.delete(m[1]);return Response.json(mode==='error'?{request_status:'ERROR',request_id:'r'+ ++n}:{request_status:'SUCCESS',request_id:'r'+ ++n,segments:[]});}
  throw new Error('Unexpected Snapchat request '+method+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const discover=()=>service.call(gateway,{action:'snapchat_audience_list',connection_id:SNAP,account_id:account},actor);
 const prepare=(id,action=actions[0])=>service.call('amcp_write',{action:'prepare',gateway,connection_id:SNAP,arguments:{action,account_id:account,params:{segment_id:id}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,requests,segments,discover,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('an untargeted segment is deleted after reading every segment and ad squad and verifies gone; a replay sends nothing',async()=>{
 const f=fixture();try{
  ok(await f.discover());
  const p=ok(await f.prepare('seg1'));assert.equal(p.data.creative_impact.scope,'audience_segment');assert.deepEqual(p.data.creative_impact.targeted_by,[]);
  assert.ok(f.requests.filter(r=>r==='GET /v1/adaccounts/acct1/adsquads').length>=2,'the ad squads span two pages');
  ok(await f.execute(p));assert.equal(f.segments.has('seg1'),false);assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('segments that ad squads include or exclude are refused; unlisted and unknown segments are refused; owner deletion rules apply',async()=>{
 const f=fixture();try{
  assert.equal((await f.prepare('seg2')).error?.code,'RESOURCE_SCOPE_REQUIRED');
  ok(await f.discover());
  const used=await f.prepare('seg2');assert.equal(used.error?.code,'AUDIENCE_IN_USE');assert.match(used.error?.message??'',/sq1/);
  assert.match((await f.prepare('seg3',actions[1])).error?.message??'',/sq2/);
  assert.equal((await f.prepare('seg9')).success,false);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 const g=fixture();try{ok(await g.discover());saveSpendPolicy(g.store,admin,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await g.prepare('seg1')).error?.code,'POLICY_DELETION_FORBIDDEN');}finally{g.store.close();}
});

test('an error reply is never resubmitted, an ignored deletion is not verified, and the ledger lists both writes',async()=>{
 const e=fixture('error');try{ok(await e.discover());const p=ok(await e.prepare('seg1'));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture('ignore');try{ok(await g.discover());const p=ok(await g.prepare('seg1'));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}finally{g.store.close();}
 for(const action of actions){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'snapchat_segment_deletions',action);}
});
