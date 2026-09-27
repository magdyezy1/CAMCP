import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {eventInstant} from '../dist/src/snapchat-event-details.js';

/**
 * Snapchat event details for Reminder creatives ("Event Details", checked 2026-09-27).
 */
const gateway='snapchat_native_action',registry=new Registry(),account='acct1';
const actions={create:'snapchat_adaccounts_ad_account_id_event_details_create',remove:'snapchat_event_details_event_details_id_delete'};
const actor={tenantId:'snap-events',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const day=(n,time='T09:00:00')=>new Date(Date.now()+n*86400000).toISOString().slice(0,10)+time;
const event=(extra={})=>({event_name:'Store opening',event_start_time:day(30),ad_account_id:account,...extra});
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,67).toString('base64')),calls=[];let writes=0,next=10,n=0;
 store.putConnection(owner,{id:'44444444-4444-4444-8444-44444444444a',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]},{accessToken:'synthetic'});
 const stored=t=>new Date(Date.parse(eventInstant(t))).toISOString();
 const events=new Map([['ev-1',{event_name:'Launch party',event_start_time:stored(day(10)),event_time_zone:'Europe/London'}],['ev-used',{event_name:'Film premiere',event_start_time:stored(day(20)),event_time_zone:'America/New_York'}],['ev-alias',{event_name:'Concert',event_start_time:stored(day(25)),event_time_zone:'UTC'}]]);
 const creatives=[{id:'cr-1',name:'Reminder',type:'WEB_VIEW',reminder_properties:{event_detail_id:'ev-used'}},{id:'cr-2',name:'Reminder two',type:'WEB_VIEW',reminder_properties:{event_details_id:'ev-alias'}},{id:'cr-3',name:'Plain',type:'SNAP_AD'}];
 const wrap=(id,e)=>({sub_request_status:'SUCCESS',event_detail:{id,ad_account_id:account,created_at:'2026-09-27T10:00:00.000Z',updated_at:'2026-09-27T10:00:00.000Z',...e}});
 const transport=new NativeTransport(async(raw,init={})=>{
  const u=new URL(String(raw)),path=u.pathname,method=init.method??'GET';calls.push(method+' '+path+u.search);
  const ok=body=>Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,...body});
  if(method==='GET'){
   if(path==='/v1/adaccounts/acct1/event_details'){
    // Two pages: the cursor must be followed.
    const all=[...events].map(([id,e])=>wrap(id,e));
    return u.searchParams.get('cursor')==='p2'?ok({event_details:all.slice(1),paging:{}}):ok({event_details:all.slice(0,1),paging:{next_link:'https://adsapi.snapchat.com/v1/adaccounts/acct1/event_details?cursor=p2&limit=1000'}});
   }
   if(path==='/v1/adaccounts/acct1/creatives')return ok({creatives:creatives.map(creative=>({sub_request_status:'SUCCESS',creative:{...creative,ad_account_id:account}})),paging:{}});
   throw new Error('Unexpected '+method+' '+path);
  }
  writes++;
  if(mode==='error')return Response.json({request_status:'ERROR',request_id:'r'+ ++n,event_details:[{sub_request_status:'ERROR'}]});
  if(method==='POST'&&path==='/v1/adaccounts/acct1/event_details'){
   const body=JSON.parse(String(init.body));
   // Snapchat answers with the start converted to UTC and the account time zone when none is sent.
   return ok({event_details:body.event_details.map(e=>{const id='ev-'+next++,row={event_name:e.event_name,event_start_time:stored(e.event_start_time),event_time_zone:e.event_time_zone??'America/Los_Angeles'};if(mode!=='ignore')events.set(id,row);return wrap(id,row);})});
  }
  const m=/^\/v1\/event_details\/([\w-]+)$/.exec(path);
  if(method==='DELETE'&&m){if(mode!=='ignore')events.delete(m[1]);return Response.json({request_status:'success',request_id:'r'+ ++n,ads:[]});}
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const create=list=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.create,ad_account_id:account,params:{ad_account_id:account},payload:{event_details:list}}},actor);
 const remove=id=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:actions.remove,ad_account_id:account,params:{event_details_id:id}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,events,create,remove,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('start times are read as UTC unless they carry an offset, as in the guide',()=>{
 assert.equal(eventInstant('2025-11-16T00:00:00-04:00:00'),'2025-11-16T04:00:00.000Z');
 assert.equal(eventInstant('2025-11-16T09:00:00'),'2025-11-16T09:00:00.000Z');
 assert.equal(eventInstant('2025-11-16'),'2025-11-16T00:00:00.000Z');
 assert.equal(eventInstant('2025-11-16T09'),'2025-11-16T09:00:00.000Z');
 assert.equal(eventInstant('2025-11-16T04:00:00.000Z'),'2025-11-16T04:00:00.000Z');
 for(const bad of ['2025-02-30','2025-11-16 09:00','16/11/2025','2025-11-16T25:00'])assert.equal(eventInstant(bad),undefined,bad);
});

test('event details are created and verify after the list cursor, with or without a time zone; unused ones are deleted and verify gone; a replay sends nothing; owner deletion rules apply',async()=>{
 const f=fixture();try{
  const offset=day(40,'T00:00:00-04:00:00');
  const c=ok(await f.create([event({event_time_zone:'America/New_York',event_start_time:offset}),event({event_name:'Webinar',event_start_time:day(45,'T18:30')})]));
  assert.equal(c.data.creative_impact.scope,'event_details');assert.equal(c.data.creative_impact.creating[0].start,eventInstant(offset));assert.ok(f.calls.some(x=>x.includes('cursor=p2')),'the list cursor is followed');
  ok(await f.execute(c));assert.equal(ok(await f.verify(c)).data.status,'verified');assert.equal((await f.execute(c)).data.replayed,true);assert.equal(f.writes(),1);
  const d=ok(await f.remove('ev-1'));assert.equal(d.data.creative_impact.deleting.event_name,'Launch party');
  ok(await f.execute(d));assert.equal(f.events.has('ev-1'),false);assert.equal(ok(await f.verify(d)).data.status,'verified');assert.equal(f.writes(),2);
 }finally{f.store.close();}
 const g=fixture();try{saveSpendPolicy(g.store,owner,{gateway,account_id:account,confirmed:true,policy:{allow_deletion:false}});assert.equal((await g.remove('ev-1')).error?.code,'POLICY_DELETION_FORBIDDEN');ok(await g.create([event()]));}finally{g.store.close();}
});

test('malformed event details are refused before any request; taken events, unknown ones and ones that creatives promote after reading',async()=>{
 const cases=[
  ['empty list',[]],
  ['eleven events',Array.from({length:11},(_,i)=>event({event_name:'Event '+i}))],
  ['another account',[event({ad_account_id:'acct2'})]],
  ['long name',[event({event_name:'x'.repeat(301)})]],
  ['unknown time zone',[event({event_time_zone:'Mars/Olympus'})]],
  ['past start',[event({event_start_time:day(-1)})]],
  ['far start',[event({event_start_time:day(1200)})]],
  ['unreadable start',[event({event_start_time:'next Friday'})]],
  ['another field',[event({event_end_time:day(31)})]],
  ['the same event twice',[event(),event({event_name:'STORE OPENING'})]]
 ];
 for(const [label,list] of cases){const f=fixture();try{const r=await f.create(list);assert.equal(r.error?.code,'INVALID_SNAPCHAT_EVENT_DETAILS',label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{
  const launch=[...f.events.values()][0];
  assert.equal((await f.create([event({event_name:'launch PARTY',event_start_time:launch.event_start_time})])).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.remove('ev-9')).error?.code,'STATE_NOT_FOUND');
  for(const id of ['ev-used','ev-alias']){const r=await f.remove(id);assert.equal(r.error?.code,'EVENT_DETAILS_IN_USE',id);assert.equal(r.error.details.creatives.length,1,id);}
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('an error reply is never resubmitted, ignored writes are not verified, and the ledger lists both writes',async()=>{
 const e=fixture('error');try{const p=ok(await e.create([event()]));assert.equal((await e.execute(p)).success,false);assert.equal((await e.execute(p)).success,false);assert.equal(e.writes(),1);}finally{e.store.close();}
 const g=fixture('ignore');try{for(const p of [ok(await g.create([event()])),ok(await g.remove('ev-1'))]){ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}}finally{g.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'snapchat_event_details',action);}
});
