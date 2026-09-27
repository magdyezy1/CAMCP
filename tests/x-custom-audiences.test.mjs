import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Custom audiences of an X Ads account, Ads API v12 (Audiences reference, "Custom Audiences"; checked 2026-09-27).
 */
const registry=new Registry(),gateway='x_ads_native_action',account='acct1';
const actor={tenantId:'x-custom-audiences',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const secret={accessToken:'synthetic-token',consumerKey:'synthetic-key',consumerSecret:'synthetic-secret',tokenSecret:'synthetic-token-secret'};
const actions={create:'x_accounts_account_id_custom_audiences_post',update:'x_accounts_account_id_custom_audiences_custom_audience_id_put',remove:'x_accounts_account_id_custom_audiences_custom_audience_id_delete'};
const copy=x=>structuredClone(x);
const owned=(id,name,extra={})=>({id,name,description:null,audience_type:'CRM',audience_size:null,targetable:false,is_owner:true,owner_account_id:account,permission_level:'READ_WRITE',deleted:false,...extra});
function setup(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,94).toString('base64'));
 store.putConnection(admin,{id:'x',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic',scopes:[]},secret);
 const audiences={ca1:owned('ca1','Site visitors',{description:'Pixel',audience_type:'WEB',audience_size:12000,targetable:true}),ca2:owned('ca2','Newsletter',{audience_size:5000,targetable:true}),ca3:owned('ca3','Partner list',{is_owner:false,owner_account_id:'other',permission_level:'READ_ONLY'}),ca4:owned('ca4','Old list',{deleted:true})};
 const targeted={ca2:[{campaign_id:'camp1',campaign_name:'Spring',line_items:[{id:'line1',name:'Newsletter readers',servable:false}]}]};
 const calls=[];let writes=0,next=5;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET',suffix=u.pathname.replace('/12/accounts/'+account,'');calls.push({method,path:u.pathname,query:Object.fromEntries(u.searchParams)});
  const reply=data=>Response.json({data:copy(data),request:{params:{account_id:account}},...(Array.isArray(data)?{next_cursor:null}:{})});
  const missing=()=>Response.json({errors:[{code:'NOT_FOUND',message:'Not found'}],request:{params:{}}},{status:404});
  if(method==='GET'){
   if(!suffix)return reply({id:account,name:'Account',deleted:false});
   if(suffix==='/custom_audiences'){const q=(u.searchParams.get('q')??'').toLowerCase();return reply(Object.values(audiences).filter(a=>a.is_owner&&!a.deleted&&a.name.toLowerCase().startsWith(q)));}
   let m=/^\/custom_audiences\/(\w+)\/targeted$/.exec(suffix);if(m)return audiences[m[1]]?reply(targeted[m[1]]??[]):missing();
   m=/^\/custom_audiences\/(\w+)$/.exec(suffix);if(m)return audiences[m[1]]&&(!audiences[m[1]].deleted||u.searchParams.get('with_deleted')==='true')?reply(audiences[m[1]]):missing();
   return missing();
  }
  writes++;const form=Object.fromEntries(new URLSearchParams(String(init.body??'')));
  if(method==='POST'&&suffix==='/custom_audiences'){const id='ca'+(next++),row=owned(id,form.name,{description:form.description??null});if(mode!=='ignore')audiences[id]=row;return reply(mode==='other'?{...row,name:'Something else'}:row);}
  const m=/^\/custom_audiences\/(\w+)$/.exec(suffix);
  if(method==='PUT'&&m){const row={...audiences[m[1]],...form};if(mode!=='ignore')audiences[m[1]]=row;return reply(row);}
  if(method==='DELETE'&&m){const row={...audiences[m[1]],deleted:true};if(mode!=='ignore')audiences[m[1]]=row;return reply(row);}
  throw Error('Unexpected write '+method+' '+suffix);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,payload,params={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:account,params,...(payload?{payload}:{})}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,audiences,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('a placeholder audience is created and verifies; an audience is renamed and redescribed, each verified; a replay sends nothing',async()=>{
 const x=setup();try{
  const p=ok(await x.prepare(actions.create,{name:'Spring buyers',description:'CRM upload for the spring sale'}));assert.equal(p.data.creative_impact.scope,'custom_audience');assert.match(p.data.creative_impact.effect,/empty placeholder/);
  ok(await x.execute(p));assert.equal(ok(await x.verify(p)).data.status,'verified');assert.equal((await x.execute(p)).data.replayed,true);assert.equal(x.writes(),1);
  const u=ok(await x.prepare(actions.update,{name:'Site visitors 30 days'},{custom_audience_id:'ca1'}));assert.equal(u.data.creative_impact.before.name,'Site visitors');ok(await x.execute(u));assert.equal(ok(await x.verify(u)).data.status,'verified');
  const v=ok(await x.prepare(actions.update,{description:'Pixel, 30 days'},{custom_audience_id:'ca1'}));ok(await x.execute(v));assert.equal(x.audiences.ca1.description,'Pixel, 30 days');assert.equal(ok(await x.verify(v)).data.status,'verified');
 }finally{x.store.close();}
});

test('an untargeted audience is deleted and verifies; targeted and shared audiences are refused; owner deletion rules apply',async()=>{
 const x=setup();try{
  const d=ok(await x.prepare(actions.remove,undefined,{custom_audience_id:'ca1'}));assert.deepEqual(d.data.creative_impact.targeted_by_line_items,[]);
  ok(await x.execute(d));assert.equal(x.audiences.ca1.deleted,true);assert.equal(ok(await x.verify(d)).data.status,'verified');
  const used=await x.prepare(actions.remove,undefined,{custom_audience_id:'ca2'});assert.equal(used.error?.code,'AUDIENCE_IN_USE');assert.match(used.error?.message??'',/line1/);
  assert.equal((await x.prepare(actions.remove,undefined,{custom_audience_id:'ca3'})).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.equal((await x.prepare(actions.update,{name:'Mine now'},{custom_audience_id:'ca3'})).error?.code,'ACCOUNT_SCOPE_MISMATCH');
  assert.equal(x.writes(),1);
 }finally{x.store.close();}
 const owner=setup();try{saveSpendPolicy(owner.store,admin,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await owner.prepare(actions.remove,undefined,{custom_audience_id:'ca1'})).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await owner.prepare(actions.create,{name:'Allowed'}));}finally{owner.store.close();}
});

test('malformed audience requests are refused before any request',async()=>{
 const cases=[
  ['missing name',actions.create,{description:'No name'}],
  ['empty name',actions.create,{name:''}],
  ['long name',actions.create,{name:'n'.repeat(256)}],
  ['surrounding spaces',actions.create,{name:' Buyers '}],
  ['control character',actions.create,{name:'Buy\u0007ers'}],
  ['long description',actions.create,{name:'Buyers',description:'d'.repeat(1001)}],
  ['audience type',actions.create,{name:'Buyers',audience_type:'CRM'}],
  ['users',actions.create,{name:'Buyers',users:[{email:'x'}]}],
  ['empty update',actions.update,{}],
  ['non-string name',actions.update,{name:7}]
 ];
 for(const [label,action,payload] of cases){const x=setup();try{const r=await x.prepare(action,payload,action===actions.update?{custom_audience_id:'ca1'}:{});assert.equal(r.error?.code,'INVALID_X_CUSTOM_AUDIENCE',label+': '+JSON.stringify(r).slice(0,300));assert.equal(x.calls.length,0,label);}finally{x.store.close();}}
});

test('taken names in any case, unchanged values, deleted and unknown audiences are refused after reading, without writes',async()=>{
 const x=setup();try{
  assert.equal((await x.prepare(actions.create,{name:'site VISITORS'})).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await x.prepare(actions.update,{name:'Newsletter'},{custom_audience_id:'ca1'})).error?.code,'CONFIGURATION_EXISTS');
  assert.match((await x.prepare(actions.update,{name:'Site visitors',description:'Pixel'},{custom_audience_id:'ca1'})).error?.message??'',/already has these values/);
  assert.match((await x.prepare(actions.update,{name:'Back'},{custom_audience_id:'ca4'})).error?.message??'',/ca4 is deleted/);
  assert.equal((await x.prepare(actions.remove,undefined,{custom_audience_id:'ca9'})).error?.code,'STATE_NOT_FOUND');
  ok(await x.prepare(actions.create,{name:'Site visitors (EU)'}));
  assert.equal(x.writes(),0);
 }finally{x.store.close();}
});

test('a receipt with another name is never resubmitted, an ignored change is not verified, and the ledger lists the three writes',async()=>{
 const other=setup('other');try{const p=ok(await other.prepare(actions.create,{name:'Spring buyers'}));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=setup('ignore');try{for(const p of [ok(await ignored.prepare(actions.update,{name:'Renamed'},{custom_audience_id:'ca1'})),ok(await ignored.prepare(actions.remove,undefined,{custom_audience_id:'ca1'}))]){ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}}finally{ignored.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'x_custom_audiences',action);}
});
