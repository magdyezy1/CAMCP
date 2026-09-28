import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * TikTok pixel custom conversions (API for Business v1.3, checked 2026-09-26): 1–10 rules on a standard pixel
 * event, at most 100 per pixel, and a details read that returns the definition with activity observations.
 */
const TIKTOK='14141414-1414-4141-8141-141414141414',gateway='tiktok_native_action',account='123';
const actor={tenantId:'tiktok-custom-conversions',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,71).toString('base64');
const conversion=()=>({name:'Signup thank you',description:'Thank-you page after sign-up',event_source_type:'PIXEL',event_source_id:'7001',optimization_event:'ON_WEB_REGISTER',
 rules:[{parameter:'URL',operator:'CONTAIN',values:['/thank-you','/bid/thanks']},{parameter:'VALUE',operator:'GTE',values:['10.50']},{parameter:'CURRENCY',operator:'EQUAL',values:['USD','EUR']}]});
const pixel=(id,ownership,extra={})=>({pixel_id:id,pixel_code:'C'+id,pixel_name:'Pixel '+id,pixel_category:'CUSTOMIZE_EVENTS',activity_status:'ACTIVE',asset_ownership:ownership,events:[{name:'Complete Registration',event_type:'ON_WEB_REGISTER',optimization_event:'ON_WEB_REGISTER',event_id:'1'}],...extra});
const existing=(id,n,name)=>({custom_conversion_id:String(id),name,description:'',event_source_type:'PIXEL',event_source_id:n,optimization_event:'SHOPPING',rules:[{parameter:'URL',operator:'CONTAIN',values:['/order-complete']}],activity_info:{activity_status:'ACTIVE',total_count:12,last_record_time:'2026-09-25 10:00:00'},create_time:'2026-01-01 00:00:00',update_time:'2026-01-01 00:00:00'});
function fixture({readDrift}={}){
 const store=new Store(':memory:',key),connection={id:TIKTOK,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic TikTok',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const pixels=new Map([['7001',pixel('7001',{ownership_status:true,updated_at:0})],['7002',pixel('7002',{ownership_status:false,asset_relation_status:'SHARED'})],
  ['7003',pixel('7003',{ownership_status:false,asset_relation_status:'UNBOUND'})],['7004',pixel('7004',{ownership_status:true,asset_relation_status:'TRANSFERRED',owner_bc_id:'55'})]]);
 const conversions=[existing(8000001,'7001','Existing purchase'),...Array.from({length:100},(_,i)=>existing(8100000+i,'7004','Full '+i))];
 const requests=[],writes=[];let n=0,mode='';
 const ok=data=>Response.json({code:0,message:'OK',request_id:'r'+ ++n,data});
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname.replace(/^\/open_api/,''),method=init.method??'GET',q=k=>url.searchParams.get(k);requests.push(method+' '+path);
  if(method==='GET'&&path==='/v1.3/pixel/list/'){const list=pixels.has(q('pixel_id'))?[pixels.get(q('pixel_id'))]:[];return ok({pixels:list,page_info:{page:1,page_size:10,total_number:list.length,total_page:1}});}
  if(method==='GET'&&path==='/v1.3/custom_conversion/list/'){assert.equal(q('page_size'),'1000');const list=conversions.filter(c=>c.event_source_id===q('event_source_id'));return ok({list,page_info:{page:1,page_size:1000,total_number:list.length,total_page:list.length?1:0}});}
  if(method==='GET'&&path==='/v1.3/custom_conversion/get/'){const c=conversions.find(c=>c.custom_conversion_id===q('custom_conversion_id')&&c.event_source_id===q('event_source_id'));
   if(!c)return Response.json({code:40001,message:'Custom conversion not found',request_id:'r'+ ++n,data:{}});
   const {activity_info,...details}=structuredClone(c);return ok(readDrift?readDrift({...details,activity_status:activity_info.activity_status}):{...details,activity_status:activity_info.activity_status});}
  if(method==='POST'&&path==='/v1.3/custom_conversion/create/'){
   const b=JSON.parse(init.body);writes.push(b);
   // TikTok stores the definition; it may return rules and values in another order and numbers in another format.
   const rules=[...b.rules].reverse().map(r=>({...r,values:[...r.values].reverse().map(v=>r.parameter==='VALUE'?String(Number(v)):v)}));
   conversions.push({custom_conversion_id:'8800001',name:b.name,description:b.description??'',event_source_type:b.event_source_type,event_source_id:b.event_source_id,optimization_event:b.optimization_event,rules,activity_info:{activity_status:'WAITING_FOR_ACTIVITY',total_count:0},create_time:'2026-09-26 12:00:00',update_time:'2026-09-26 12:00:00'});
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return mode==='error'?Response.json({code:40002,message:'Duplicate name',request_id:'r'+ ++n,data:{}}):ok({custom_conversion_id:'8800001'});
  }
  throw new Error('Unexpected TikTok request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const args=(payload,action='tiktok_custom_conversion_create')=>({action,account_id:account,payload});
 const prepare=payload=>call('amcp_write',{action:'prepare',gateway,connection_id:TIKTOK,arguments:args(payload)});
 const execute=(id,extra={})=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true,...extra});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,pixels,conversions,requests,writes,call,args,prepare,execute,verify,mode:v=>{mode=v;},restart:()=>{service=start();}};
}

test('custom conversion creation is a reviewed TikTok family; updates and deletion are reviewed by the edits family',async()=>{
 const f=fixture();try{
  const inspected=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:f.args(conversion())});
  assert.equal(inspected.data.review_contract_supported,true,JSON.stringify(inspected));
  for(const [action,payload] of [['tiktok_custom_conversion_update',{custom_conversion_id:'8000001',name:'Renamed'}],['tiktok_custom_conversion_delete',{custom_conversion_id:'8000001'}]]){
   const r=await f.call('amcp_write',{action:'inspect',gateway,connection_id:TIKTOK,arguments:f.args(payload,action)});assert.equal(r.data?.review_contract_supported,true,action+' '+JSON.stringify(r));
  }
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('only documented pixel custom conversions are accepted, before any request',async()=>{
 const f=fixture();try{
  const change=fn=>{const v=conversion();fn(v);return v;},rule=(parameter,operator,values)=>change(v=>{v.rules=[{parameter,operator,values}];});
  const cases={'name starts with a digit':change(v=>{v.name='1 signup';}),'name with emoji':change(v=>{v.name='Signup 🎉';}),'name with punctuation':change(v=>{v.name='Signup!';}),
   '51-character name':change(v=>{v.name='S'+'x'.repeat(50);}),'standard event name':change(v=>{v.name='Complete Registration';}),'standard event value':change(v=>{v.name='ON_WEB_ORDER';}),
   'long description':change(v=>{v.description='x'.repeat(501);}),'description emoji':change(v=>{v.description='Thanks 🎉';}),'app source':change(v=>{v.event_source_type='APP';}),
   'pixel code instead of ID':change(v=>{v.event_source_id='C4ABCDEF';}),'custom event mapping':change(v=>{v.custom_event_type='MyEvent';}),'no event':change(v=>{delete v.optimization_event;}),
   'app event':change(v=>{v.optimization_event='INSTALL';}),'no rules':change(v=>{v.rules=[];}),'eleven rules':change(v=>{v.rules=Array.from({length:11},(_,i)=>({parameter:'URL',operator:'CONTAIN',values:['/p'+i]}));}),
   'unknown parameter':rule('REFERRER','CONTAIN',['x']),'comparison on text':rule('URL','LT',['x']),'contains on a number':rule('PRICE','CONTAIN',['10']),'starts-with on currency':rule('CURRENCY','START_WITH',['US']),
   'no values':rule('URL','CONTAIN',[]),'101 values':rule('URL','CONTAIN',Array.from({length:101},(_,i)=>'/p'+i)),'101-character value':rule('URL','CONTAIN',['x'.repeat(101)]),'blank value':rule('URL','CONTAIN',[' ']),
   'unknown currency':rule('CURRENCY','EQUAL',['XYZ']),'fractional item count':rule('NUM_ITEMS','GT',['1.5']),'three decimals':rule('PRICE','GT',['1.005']),'above the maximum':rule('VALUE','LT',['1000000000.01']),
   'number instead of text':rule('VALUE','GT',[10]),'two values in a comparison':rule('PRICE','GT',['1','2']),'duplicate values':rule('URL','CONTAIN',['/a','/a']),
   'duplicate rules':change(v=>{v.rules.push(structuredClone(v.rules[0]));}),'extra rule key':change(v=>{v.rules[0].match='ANY';}),'extra key':change(v=>{v.custom_conversion_id='1';})};
  for(const [name,payload] of Object.entries(cases)){const r=await f.prepare(payload);assert.equal(r.error?.code,'INVALID_TIKTOK_CUSTOM_CONVERSION',name+': '+JSON.stringify(r.error??r.data).slice(0,300));}
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('an owned pixel\'s custom conversion is created once and verifies against its rules as a set',async()=>{
 const f=fixture();try{
  const p=await f.prepare(conversion());assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v1.3/pixel/list/','/v1.3/custom_conversion/list/']);
  const impact=p.data.creative_impact;assert.equal(impact.scope,'custom_conversions');assert.equal(impact.may_affect_serving,false);
  assert.deepEqual(impact.pixel_custom_conversions,{existing:1,limit:100});assert.equal(impact.pixel.pixel_id,'7001');assert.match(impact.usable_when,/WAITING_FOR_ACTIVITY/);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,'rule values mentioning bids are not a spending change: '+JSON.stringify(done));
  assert.equal(f.writes.length,1);const {advertiser_id,...sent}=f.writes[0];assert.equal(advertiser_id,account);assert.deepEqual(sent,conversion());
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.equal(verified.data.checks[0].resource_id,'8800001');
  assert.ok(f.requests.includes('GET /v1.3/custom_conversion/get/'));
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});

test('shared, unbound, missing and full pixels and duplicate names are refused before any write',async()=>{
 const f=fixture();try{
  for(const [change,code,pattern] of [[v=>{v.event_source_id='7002';},'INVALID_TIKTOK_CUSTOM_CONVERSION',/not owned.*SHARED/],[v=>{v.event_source_id='7003';},'INVALID_TIKTOK_CUSTOM_CONVERSION',/not owned.*UNBOUND/],
   [v=>{v.event_source_id='7999';},'STATE_TARGET_MISMATCH',/./],[v=>{v.event_source_id='7004';},'INVALID_TIKTOK_CUSTOM_CONVERSION',/already has 100/],[v=>{v.name='Existing purchase';},'INVALID_TIKTOK_CUSTOM_CONVERSION',/already exists/]]){
   const payload=conversion();change(payload);const r=await f.prepare(payload);assert.equal(r.error?.code,code,JSON.stringify(payload)+' '+JSON.stringify(r).slice(0,300));assert.match(r.error.message,pattern);
  }
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('refreshed pixel events and conversion activity keep the review valid; ownership and definition changes stop the write',async()=>{
 const f=fixture();try{
  const p=await f.prepare(conversion());assert.equal(p.success,true);
  f.pixels.get('7001').events=[];f.pixels.get('7001').activity_status='INACTIVE';f.conversions[0].activity_info={activity_status:'NO_RECENT_ACTIVITY',total_count:40,last_record_time:'2026-09-26 11:00:00'};
  assert.equal((await f.execute(p.data.review_id)).success,true);assert.equal(f.writes.length,1);
 }finally{f.store.close();}
 const g=fixture();try{
  const p=await g.prepare(conversion());g.pixels.get('7001').asset_ownership={ownership_status:false,asset_relation_status:'SHARED'};
  const r=await g.execute(p.data.review_id);assert.equal(r.error?.code,'INVALID_TIKTOK_CUSTOM_CONVERSION',JSON.stringify(r));assert.match(r.error.message,/not owned/);
  const q=await g.prepare(conversion());assert.equal(q.success,false,'the shared pixel is refused at review too');assert.equal(g.writes.length,0);
 }finally{g.store.close();}
 const h=fixture();try{
  const p=await h.prepare(conversion());h.pixels.get('7001').pixel_name='Renamed pixel';
  const r=await h.execute(p.data.review_id);assert.equal(r.error?.code,'STATE_CHANGED',JSON.stringify(r));assert.equal(h.writes.length,0);
 }finally{h.store.close();}
});

test('a custom conversion that reads back differently stays inconclusive',async()=>{
 for(const [name,drift,field] of [['renamed',d=>({...d,name:'Other'}),'/name'],['event',d=>({...d,optimization_event:'SHOPPING'}),'/optimization_event'],['rule',d=>({...d,rules:d.rules.slice(1)}),'/rules']]){
  const f=fixture({readDrift:drift});try{
   const p=await f.prepare(conversion());await f.execute(p.data.review_id);const verified=await f.verify(p.data.review_id);
   assert.equal(verified.data.status,'inconclusive',name+' '+JSON.stringify(verified));assert.deepEqual(verified.data.checks[0].changed_fields,[field],name);
  }finally{f.store.close();}
 }
});

test('rejected or lost creations are never resubmitted, and claims survive restart and concurrency',async()=>{
 for(const [mode,first,again] of [['error','PLATFORM_ERROR','WRITE_OUTCOME_UNCERTAIN'],['lost','WRITE_OUTCOME_UNCERTAIN','WRITE_OUTCOME_UNCERTAIN']]){const f=fixture();try{
  const p=await f.prepare(conversion());f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,first,mode);f.mode('');f.restart();
  assert.equal((await f.execute(p.data.review_id)).error?.code,again,mode);assert.equal(f.writes.length,1,mode);
 }finally{f.store.close();}}
 const g=fixture();try{
  const p=await g.prepare(conversion());const results=await Promise.all([g.execute(p.data.review_id),g.execute(p.data.review_id)]);
  assert.ok(results.some(r=>r.success));assert.equal(g.writes.length,1);g.restart();assert.equal((await g.execute(p.data.review_id)).data.replayed,true);
 }finally{g.store.close();}
});
