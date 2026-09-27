import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Tracking tags of X Ads line items, Ads API v12 (Campaign Management reference, "Tracking Tags"; checked 2026-09-27).
 */
const registry=new Registry(),gateway='x_ads_native_action',account='acct1';
const actor={tenantId:'x-tracking-tags',userId:'operator',role:'operator'},admin={...actor,role:'admin'};
const secret={accessToken:'synthetic-token',consumerKey:'synthetic-key',consumerSecret:'synthetic-secret',tokenSecret:'synthetic-token-secret'};
const actions={create:'x_accounts_account_id_tracking_tags_post',update:'x_accounts_account_id_tracking_tags_tracking_tag_id_put',remove:'x_accounts_account_id_tracking_tags_tracking_tag_id_delete'};
const dcm='https://ad.doubleclick.net/ddm/trackimp/N1234.2061500TWITTER-OFFICIAL/B9156151.125630439;dc_trk_aid=1355;dc_trk_cid=8675309';
const copy=x=>structuredClone(x);
function setup(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,95).toString('base64'));
 store.putConnection(admin,{id:'x',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic',scopes:[]},secret);
 const lines={line1:{id:'line1',campaign_id:'camp1',name:'Launch',entity_status:'ACTIVE',deleted:false},line2:{id:'line2',campaign_id:'camp1',name:'Old',entity_status:'PAUSED',deleted:true}};
 const tags={tag1:{id:'tag1',line_item_id:'line1',tracking_tag_type:'IMPRESSION_TAG',tracking_tag_url:dcm,deleted:false},tag2:{id:'tag2',line_item_id:'line1',tracking_tag_type:'CLICK_TRACKER',tracking_tag_url:'https://ad.doubleclick.net/ddm/clk/1;2;3',deleted:true}};
 const calls=[];let writes=0,next=3;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET',suffix=u.pathname.replace('/12/accounts/'+account,'');calls.push({method,path:u.pathname,query:Object.fromEntries(u.searchParams)});
  const reply=data=>Response.json({data:copy(data),request:{params:{account_id:account,...Object.fromEntries(u.searchParams)}},...(Array.isArray(data)?{next_cursor:null}:{})});
  if(method==='GET'){
   if(!suffix)return reply({id:account,name:'Account',deleted:false});
   let m=/^\/line_items\/(\w+)$/.exec(suffix);if(m&&lines[m[1]])return reply(lines[m[1]]);
   m=/^\/tracking_tags\/(\w+)$/.exec(suffix);if(m&&tags[m[1]])return reply(tags[m[1]]);
   if(suffix==='/tracking_tags')return reply(Object.values(tags).filter(t=>u.searchParams.get('line_item_ids').split(',').includes(t.line_item_id)&&!t.deleted));
   return Response.json({errors:[{code:'NOT_FOUND',message:'Not found'}],request:{params:{}}},{status:404});
  }
  writes++;const form=Object.fromEntries(new URLSearchParams(String(init.body??'')));
  if(method==='POST'&&suffix==='/tracking_tags'){const id='tag'+(next++),row={id,...form,deleted:false};if(mode!=='ignore')tags[id]=row;return reply(mode==='other'?{...row,line_item_id:'line9'}:row);}
  const m=/^\/tracking_tags\/(\w+)$/.exec(suffix);
  if(method==='PUT'&&m){const row={...tags[m[1]],...form};if(mode!=='ignore')tags[m[1]]=row;return reply(row);}
  if(method==='DELETE'&&m){const row={...tags[m[1]],deleted:true};if(mode!=='ignore')tags[m[1]]=row;return reply(row);}
  throw Error('Unexpected write '+method+' '+suffix);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(action,payload,params={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:account,params,...(payload?{payload}:{})}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,tags,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const tag=(extra={})=>({line_item_id:'line1',tracking_tag_type:'CLICK_TRACKER',tracking_tag_url:'https://ad.doubleclick.net/ddm/clk/9;8;7',...extra});

test('a click tracker is created once without spending confirmation and verifies; its URL is replaced and the tag deleted, each verified',async()=>{
 const x=setup();try{
  const p=ok(await x.prepare(actions.create,tag())),impact=p.data.creative_impact;
  assert.equal(impact.scope,'tracking_tag');assert.equal(impact.may_affect_serving,false);assert.match(impact.effect,/each click/);
  ok(await x.execute(p));assert.equal(x.writes(),1);assert.equal(ok(await x.verify(p)).data.status,'verified');assert.equal((await x.execute(p)).data.replayed,true);assert.equal(x.writes(),1);
  const u=ok(await x.prepare(actions.update,{tracking_tag_url:dcm+';ord=1'},{tracking_tag_id:'tag1'}));assert.equal(u.data.creative_impact.before.url,dcm);
  ok(await x.execute(u));assert.equal(x.tags.tag1.tracking_tag_url,dcm+';ord=1');assert.equal(ok(await x.verify(u)).data.status,'verified');
  const d=ok(await x.prepare(actions.remove,undefined,{tracking_tag_id:'tag1'}));ok(await x.execute(d));assert.equal(x.tags.tag1.deleted,true);assert.equal(ok(await x.verify(d)).data.status,'verified');
 }finally{x.store.close();}
});

test('malformed tracking tags are refused before any request',async()=>{
 const cases=[
  ['http URL',actions.create,tag({tracking_tag_url:'http://ad.doubleclick.net/x'})],
  ['relative URL',actions.create,tag({tracking_tag_url:'/ddm/clk/1'})],
  ['URL with spaces',actions.create,tag({tracking_tag_url:'https://ad.doubleclick.net/a b'})],
  ['URL with credentials',actions.create,tag({tracking_tag_url:'https://user:pw@ad.doubleclick.net/x'})],
  ['over-long URL',actions.create,tag({tracking_tag_url:'https://ad.doubleclick.net/'+'a'.repeat(2030)})],
  ['unknown type',actions.create,tag({tracking_tag_type:'VIEWABILITY_TAG'})],
  ['missing line item',actions.create,(()=>{const {line_item_id,...b}=tag();return b;})()],
  ['unknown field',actions.create,tag({name:'Tag'})],
  ['type change',actions.update,{tracking_tag_url:dcm,tracking_tag_type:'CLICK_TRACKER'}]
 ];
 for(const [label,action,payload] of cases){const x=setup();try{const r=await x.prepare(action,payload,action===actions.update?{tracking_tag_id:'tag1'}:{});assert.equal(r.error?.code,'INVALID_X_TRACKING_TAG',label+': '+JSON.stringify(r).slice(0,300));assert.equal(x.calls.length,0,label);}finally{x.store.close();}}
});

test('deleted line items and tags, duplicates, unchanged URLs and unknown tags are refused after reading, without writes',async()=>{
 const x=setup();try{
  assert.match((await x.prepare(actions.create,tag({line_item_id:'line2'}))).error?.message??'',/Line item line2 is deleted/);
  assert.equal((await x.prepare(actions.create,tag({tracking_tag_type:'IMPRESSION_TAG',tracking_tag_url:dcm}))).error?.code,'CONFIGURATION_EXISTS');
  ok(await x.prepare(actions.create,tag({tracking_tag_url:'https://ad.doubleclick.net/ddm/clk/1;2;3'})));
  assert.match((await x.prepare(actions.update,{tracking_tag_url:dcm},{tracking_tag_id:'tag1'})).error?.message??'',/already has this URL/);
  assert.match((await x.prepare(actions.remove,undefined,{tracking_tag_id:'tag2'})).error?.message??'',/tag2 is deleted/);
  assert.equal((await x.prepare(actions.remove,undefined,{tracking_tag_id:'tag9'})).success,false);
  assert.equal((await x.prepare(actions.create,tag({line_item_id:'line9'}))).success,false);
  assert.equal(x.writes(),0);
 }finally{x.store.close();}
});

test('a receipt for another line item is a failure that is never resubmitted, and an ignored change is not verified',async()=>{
 const other=setup('other');try{const p=ok(await other.prepare(actions.create,tag()));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=setup('ignore');try{const p=ok(await ignored.prepare(actions.update,{tracking_tag_url:dcm+';ord=2'},{tracking_tag_id:'tag1'}));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
});

test('the ledger lists the three tracking tag writes in the family',()=>{
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'x_tracking_tags',action);}
});
