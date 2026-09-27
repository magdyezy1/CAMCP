import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat offer disclaimers (Marketing API "Offer Disclaimers", checked 2026-09-27): created in the ad account and deleted.
 */
const gateway='snapchat_native_action',registry=new Registry(),account='acct1';
const actions={create:'snapchat_adaccounts_ad_account_id_offer_disclaimers_create',remove:'snapchat_adaccounts_ad_account_id_offer_disclaimers_offer_disclaimer_id_delete'};
const actor={tenantId:'snap-disclaimers',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,61).toString('base64')),calls=[];let writes=0,next=1,n=0;
 store.putConnection(owner,{id:'44444444-4444-4444-8444-444444444445',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]},{accessToken:'synthetic'});
 const disclaimers=new Map([['disc-1',{ad_account_id:account,name:'Auto lease terms',disclaimer_render_type:'STATIC',disclaimer_text:'Lease offer for qualified buyers.'}]]);
 const shown=(id,d)=>({sub_request_status:'SUCCESS',offer_disclaimer:{id,...d,created_at:'2026-09-27T00:00:00.000Z',updated_at:new Date().toISOString()}});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname,method=init.method??'GET';calls.push(method+' '+path);
  if(method==='GET'&&path==='/v1/adaccounts/acct1/offer_disclaimers')return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,paging:{},offer_disclaimers:[...disclaimers].map(([id,d])=>shown(id,d))});
  writes++;
  if(method==='POST'&&path==='/v1/adaccounts/acct1/offer_disclaimers'){
   const body=JSON.parse(String(init.body));
   if(mode==='error')return Response.json({request_status:'ERROR',request_id:'r'+ ++n,offer_disclaimers:body.offer_disclaimers.map(()=>({sub_request_status:'ERROR',sub_request_error_reason:'Invalid'}))});
   const rows=body.offer_disclaimers.map(d=>{const id='disc-'+ ++next;if(mode!=='ignore')disclaimers.set(id,{...d,disclaimer_text:d.disclaimer_text??null});return shown(id,d);});
   return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,offer_disclaimers:rows});
  }
  const m=/^\/v1\/adaccounts\/acct1\/offer_disclaimers\/([A-Za-z0-9-]+)$/.exec(path);
  if(method==='DELETE'&&m){if(mode!=='ignore')disclaimers.delete(m[1]);return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n});}
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const create=list=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.create,ad_account_id:account,payload:{offer_disclaimers:list}}},actor);
 const remove=id=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.remove,ad_account_id:account,params:{offer_disclaimer_id:id}}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,disclaimers,create,remove,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const statik=(extra={})=>({ad_account_id:account,name:'Finance APR',disclaimer_render_type:'STATIC',disclaimer_text:'Representative APR 19.9%.',...extra});

test('a static and a dynamic disclaimer are created and verify; deletion counts as a deletion and verifies gone',async()=>{
 const f=fixture();try{
  const p=ok(await f.create([statik(),{ad_account_id:account,name:'Catalog terms',disclaimer_render_type:'DYNAMIC'}]));assert.equal(p.data.creative_impact.disclaimers_in_account,1);assert.equal(p.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  const d=ok(await f.remove('disc-1'));assert.match(d.data.creative_impact.effect,/lose the required disclosure/);
  ok(await f.execute(d));assert.equal(ok(await f.verify(d)).data.status,'verified');assert.equal(f.disclaimers.has('disc-1'),false);
 }finally{f.store.close();}
 const g=fixture();try{saveSpendPolicy(g.store,owner,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await g.remove('disc-1')).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await g.create([statik()]));}finally{g.store.close();}
});

test('malformed disclaimers are refused before any request; duplicate names and unknown disclaimers are refused after reading',async()=>{
 const cases=[
  ['empty list',f=>f.create([])],
  ['static without text',f=>f.create([statik({disclaimer_text:undefined})])],
  ['dynamic with text',f=>f.create([statik({disclaimer_render_type:'DYNAMIC'})])],
  ['other account',f=>f.create([statik({ad_account_id:'acct2'})])],
  ['long name',f=>f.create([statik({name:'x'.repeat(256)})])],
  ['long text',f=>f.create([statik({disclaimer_text:'x'.repeat(5001)})])],
  ['unknown type',f=>f.create([statik({disclaimer_render_type:'IMAGE'})])],
  ['duplicate names',f=>f.create([statik(),statik()])]
 ];
 for(const [label,run] of cases){const f=fixture();try{const r=await run(f);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label+': '+JSON.stringify(r).slice(0,300));}finally{f.store.close();}}
 const f=fixture();try{
  assert.equal((await f.create([statik({name:'Auto lease terms'})])).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.remove('disc-9')).error?.code,'STATE_NOT_FOUND');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error response is a failure never resubmitted, an ignored creation or deletion is not verified, and the ledger lists both writes',async()=>{
 const e=fixture('error');try{const p=ok(await e.create([statik()]));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const ignored=fixture('ignore');try{for(const p of [ok(await ignored.create([statik()])),ok(await ignored.remove('disc-1'))]){ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}}finally{ignored.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'snapchat_offer_disclaimers',action);}
});
