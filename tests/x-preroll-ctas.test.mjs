import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Call-to-action buttons of X Ads pre-roll line items, Ads API v12 (Creatives reference, "Preroll Call To Actions";
 * checked 2026-09-27).
 */
const registry=new Registry(),gateway='x_ads_native_action',account='acct1';
const actor={tenantId:'x-preroll-ctas',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const secret={accessToken:'synthetic-token',consumerKey:'synthetic-key',consumerSecret:'synthetic-secret',tokenSecret:'synthetic-token-secret'};
const actions={create:'x_accounts_account_id_preroll_call_to_actions_post',update:'x_accounts_account_id_preroll_call_to_actions_preroll_call_to_action_id_put',remove:'x_accounts_account_id_preroll_call_to_actions_preroll_call_to_action_id_delete'};
const copy=x=>structuredClone(x);
function setup(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,97).toString('base64'));
 store.putConnection(admin,{id:'x',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic',scopes:[]},secret);
 const lines={pre:{id:'pre',campaign_id:'camp1',name:'Trailer',product_type:'MEDIA',objective:'PREROLL_VIEWS',entity_status:'ACTIVE',deleted:false},pre2:{id:'pre2',campaign_id:'camp1',name:'Teaser',product_type:'MEDIA',objective:'PREROLL_VIEWS',entity_status:'PAUSED',deleted:false},eng:{id:'eng',campaign_id:'camp1',name:'Posts',product_type:'PROMOTED_TWEETS',objective:'ENGAGEMENTS',entity_status:'ACTIVE',deleted:false},gone:{id:'gone',campaign_id:'camp1',name:'Old',product_type:'MEDIA',objective:'PREROLL_VIEWS',entity_status:'PAUSED',deleted:true}};
 const campaigns={camp1:{id:'camp1',entity_status:'ACTIVE',deleted:false}};
 const ctas={cta1:{id:'cta1',line_item_id:'pre2',call_to_action:'WATCH_NOW',call_to_action_url:'https://example.com/watch',deleted:false},cta2:{id:'cta2',line_item_id:'pre2',call_to_action:'SHOP',call_to_action_url:'https://example.com/shop',deleted:true}};
 const calls=[];let writes=0,next=3;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET',suffix=u.pathname.replace('/12/accounts/'+account,'');calls.push({method,path:u.pathname,query:Object.fromEntries(u.searchParams)});
  const reply=data=>Response.json({data:copy(data),request:{params:{account_id:account,...Object.fromEntries(u.searchParams)}},...(Array.isArray(data)?{next_cursor:null}:{})});
  if(method==='GET'){
   if(!suffix)return reply({id:account,name:'Account',deleted:false});
   const m=/^\/(line_items|campaigns|preroll_call_to_actions)\/(\w+)$/.exec(suffix);
   if(m){const src={line_items:lines,campaigns,preroll_call_to_actions:ctas}[m[1]];if(src[m[2]])return reply(src[m[2]]);}
   if(suffix==='/preroll_call_to_actions')return reply(Object.values(ctas).filter(c=>u.searchParams.get('line_item_ids').split(',').includes(c.line_item_id)&&!c.deleted));
   return Response.json({errors:[{code:'NOT_FOUND',message:'Not found'}],request:{params:{}}},{status:404});
  }
  writes++;const form=Object.fromEntries(new URLSearchParams(String(init.body??'')));
  if(method==='POST'&&suffix==='/preroll_call_to_actions'){const id='cta'+(next++),row={id,...form,deleted:false};if(mode!=='ignore')ctas[id]=row;return reply(mode==='other'?{...row,line_item_id:'pre2'}:row);}
  const m=/^\/preroll_call_to_actions\/(\w+)$/.exec(suffix);
  if(method==='PUT'&&m){const row={...ctas[m[1]],...form};if(mode!=='ignore')ctas[m[1]]=row;return reply(row);}
  if(method==='DELETE'&&m){const row={...ctas[m[1]],deleted:true};if(mode!=='ignore')ctas[m[1]]=row;return reply(row);}
  throw Error('Unexpected write '+method+' '+suffix);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,payload,params={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:account,params,...(payload?{payload}:{})}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,ctas,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const cta=(extra={})=>({line_item_id:'pre',call_to_action:'VISIT_SITE',call_to_action_url:'https://example.com/trailer?utm_source=x',...extra});

test('a button is set once without spending confirmation and verifies; its button and URL change and it is deleted, each verified',async()=>{
 const x=setup();try{
  const p=ok(await x.prepare(actions.create,cta())),impact=p.data.creative_impact;
  assert.equal(impact.scope,'preroll_call_to_action');assert.equal(impact.may_affect_serving,true);assert.match(impact.effect,/active, so this applies at once/);
  ok(await x.execute(p));assert.equal(x.writes(),1);assert.equal(ok(await x.verify(p)).data.status,'verified');assert.equal((await x.execute(p)).data.replayed,true);assert.equal(x.writes(),1);
  const u=ok(await x.prepare(actions.update,{call_to_action:'SHOP'},{preroll_call_to_action_id:'cta1'}));assert.deepEqual(u.data.creative_impact.after,{button:'SHOP',url:'https://example.com/watch'});assert.equal(u.data.creative_impact.may_affect_serving,false);
  ok(await x.execute(u));assert.equal(x.ctas.cta1.call_to_action,'SHOP');assert.equal(ok(await x.verify(u)).data.status,'verified');
  const v=ok(await x.prepare(actions.update,{call_to_action_url:'https://example.com/store'},{preroll_call_to_action_id:'cta1'}));ok(await x.execute(v));assert.equal(ok(await x.verify(v)).data.status,'verified');
  const d=ok(await x.prepare(actions.remove,undefined,{preroll_call_to_action_id:'cta1'}));ok(await x.execute(d));assert.equal(x.ctas.cta1.deleted,true);assert.equal(ok(await x.verify(d)).data.status,'verified');
 }finally{x.store.close();}
});

test('malformed calls to action are refused before any request',async()=>{
 const cases=[
  ['unknown button',actions.create,cta({call_to_action:'BUY_NOW'})],
  ['relative URL',actions.create,cta({call_to_action_url:'/trailer'})],
  ['URL with spaces',actions.create,cta({call_to_action_url:'https://example.com/a b'})],
  ['URL with credentials',actions.create,cta({call_to_action_url:'https://user:pw@example.com/'})],
  ['other scheme',actions.create,cta({call_to_action_url:'ftp://example.com/file'})],
  ['over-long URL',actions.create,cta({call_to_action_url:'https://example.com/'+'a'.repeat(2030)})],
  ['missing URL',actions.create,(()=>{const {call_to_action_url,...b}=cta();return b;})()],
  ['missing button',actions.create,(()=>{const {call_to_action,...b}=cta();return b;})()],
  ['missing line item',actions.create,(()=>{const {line_item_id,...b}=cta();return b;})()],
  ['unknown field',actions.create,cta({name:'Button'})],
  ['empty update',actions.update,{}],
  ['line item change',actions.update,{line_item_id:'pre',call_to_action:'SHOP'}]
 ];
 for(const [label,action,payload] of cases){const x=setup();try{const r=await x.prepare(action,payload,action===actions.update?{preroll_call_to_action_id:'cta1'}:{});assert.equal(r.error?.code,'INVALID_X_PREROLL_CTA',label+': '+JSON.stringify(r).slice(0,300));assert.equal(x.calls.length,0,label);}finally{x.store.close();}}
});

test('other objectives, deleted line items and buttons, a second button, unchanged buttons and unknown IDs are refused after reading, without writes',async()=>{
 const x=setup();try{
  assert.match((await x.prepare(actions.create,cta({line_item_id:'eng'}))).error?.message??'',/ENGAGEMENTS objective/);
  assert.match((await x.prepare(actions.create,cta({line_item_id:'gone'}))).error?.message??'',/Line item gone is deleted/);
  const second=await x.prepare(actions.create,cta({line_item_id:'pre2'}));assert.equal(second.error?.code,'CONFIGURATION_EXISTS');assert.match(second.error?.message??'',/cta1; change it with PUT/);
  assert.match((await x.prepare(actions.update,{call_to_action:'WATCH_NOW',call_to_action_url:'https://example.com/watch'},{preroll_call_to_action_id:'cta1'})).error?.message??'',/already has this button and URL/);
  assert.match((await x.prepare(actions.remove,undefined,{preroll_call_to_action_id:'cta2'})).error?.message??'',/cta2 is deleted/);
  assert.equal((await x.prepare(actions.remove,undefined,{preroll_call_to_action_id:'cta9'})).success,false);
  assert.equal((await x.prepare(actions.create,cta({line_item_id:'line9'}))).success,false);
  assert.equal(x.writes(),0);
 }finally{x.store.close();}
});

test('a receipt for another line item is never resubmitted, an ignored change is not verified, and owner deletion rules apply',async()=>{
 const other=setup('other');try{const p=ok(await other.prepare(actions.create,cta()));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=setup('ignore');try{const p=ok(await ignored.prepare(actions.update,{call_to_action_url:'https://example.com/new'},{preroll_call_to_action_id:'cta1'}));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
 const owner=setup();try{saveSpendPolicy(owner.store,admin,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await owner.prepare(actions.remove,undefined,{preroll_call_to_action_id:'cta1'})).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await owner.prepare(actions.create,cta()));}finally{owner.store.close();}
});

test('the ledger lists the three pre-roll call-to-action writes in the family',()=>{
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'x_preroll_ctas',action);}
});
