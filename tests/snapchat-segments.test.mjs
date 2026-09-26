import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Snapchat audience segment metadata (official Audiences guides, checked 2026-09-26): customer-list containers
 * and lookalikes are created; name, description and retention are updated. User uploads and removals carry
 * customer data and stay blocked, as do segment deletion and pixel/mobile/engagement rule audiences.
 */
const SNAP='44444444-4444-4444-8444-444444444444',gateway='snapchat_native_action',account='acct1';
const actor={tenantId:'snap-segments',userId:'operator',role:'operator'},admin={...actor,role:'admin'},key=Buffer.alloc(32,62).toString('base64');
const list=(extra={})=>({ad_account_id:account,name:'Newsletter subscribers',description:'Customer list container',source_type:'FIRST_PARTY',retention_in_days:180,...extra});
const lookalike=(spec={},extra={})=>({ad_account_id:account,name:'Subscribers lookalike',source_type:'LOOKALIKE',retention_in_days:180,creation_spec:{seed_segment_id:'seed1',type:'BALANCE',countries:['us','sa'],...spec},...extra});
const telemetry=()=>({status:'ACTIVE',targetable_status:'READY',upload_status:'COMPLETE',approximate_number_users:Math.floor(Math.random()*1e6),created_at:'2026-09-26T00:00:00.000Z',updated_at:new Date().toISOString()});
function fixture({seedAccount=account,readAccount,readRetention}={}){
 const store=new Store(':memory:',key),connection={id:SNAP,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]};
 store.putConnection(admin,connection,{accessToken:'synthetic'});
 const segments=new Map([['seed1',{id:'seed1',ad_account_id:seedAccount,name:'Seed',source_type:'FIRST_PARTY',retention_in_days:9999}],['list1',{id:'list1',ad_account_id:account,name:'Old name',description:'Old description',source_type:'LOOKALIKE',retention_in_days:90,creation_spec:{seed_segment_id:'seed1',country:'US',type:'BALANCE'}}]]);
 const requests=[],writes=[];let n=0,mode='';
 const wrap=(rows,status='SUCCESS')=>rows.map(r=>({sub_request_status:status,segment:r}));
 const ok=rows=>Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,paging:{},segments:wrap(rows)});
 // Snapchat reads a lookalike back with the deprecated singular country; a list reads back without description.
 const readBack=s=>{const {creation_spec,...rest}=s;const spec=creation_spec&&{seed_segment_id:creation_spec.seed_segment_id,type:creation_spec.type??'BALANCE',country:(creation_spec.countries??[creation_spec.country])[0].toUpperCase()};return {...rest,...(spec?{creation_spec:spec}:{}),...telemetry(),...(readAccount?{ad_account_id:readAccount}:{}),...(readRetention?{retention_in_days:readRetention}:{})};};
 const transport=new NativeTransport(async(raw,init={})=>{
  const path=new URL(String(raw)).pathname,method=init.method??'GET';requests.push(method+' '+path);let m;
  if(method==='GET'&&path==='/v1/adaccounts/acct1')return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,adaccounts:[{sub_request_status:'SUCCESS',adaccount:{id:account,currency:'USD'}}]});
  if(method==='GET'&&path==='/v1/adaccounts/acct1/segments')return ok([...segments.values()].map(s=>({...s,...telemetry()})));
  if(method==='GET'&&(m=/^\/v1\/segments\/([^/]+)$/.exec(path))){const s=segments.get(m[1]);return s?ok([s.creation_spec?.countries?readBack(s):{...s,...telemetry(),...(readAccount?{ad_account_id:readAccount}:{}),...(readRetention?{retention_in_days:readRetention}:{})}]):Response.json({request_status:'ERROR'},{status:404});}
  if(path==='/v1/adaccounts/acct1/segments'&&['POST','PUT'].includes(method)){writes.push(method+' '+path);
   const out=JSON.parse(init.body).segments.map(s=>{const row=method==='POST'?{...s,id:'segment'+(segments.size+1)}:{...segments.get(s.id),...s};segments.set(row.id,row);return {sub_request_status:mode==='write_error'?'ERROR':'SUCCESS',segment:{...row,status:'PENDING'}};});
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   return Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,segments:mode==='empty_receipt'?[]:mode==='duplicate_receipt'?[...out,...out]:out});}
  throw new Error('Unexpected Snapchat request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const prepare=(action,payload)=>call('amcp_write',{action:'prepare',gateway,connection_id:SNAP,arguments:{action,account_id:account,payload}});
 const execute=id=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 const discover=()=>call(gateway,{action:'snapchat_audience_list',connection_id:SNAP,account_id:account});
 return {store,transport,segments,requests,writes,call,prepare,execute,verify,discover,mode:v=>{mode=v;},restart:()=>{service=start();}};
}

test('segment create and update join the reviewed Snapchat family; users, deletion and rule audiences stay blocked',async()=>{
 const f=fixture();try{
  for(const [action,payload] of [['snapchat_audience_create',{segments:[list()]}],['snapchat_adaccounts_ad_account_id_segments_create',{segments:[list()]}],['snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',retention_in_days:90}]}],['snapchat_adaccounts_ad_account_id_segments_update',{segments:[{id:'list1',name:'Renamed',retention_in_days:90}]}]]){
   const inspected=await f.call('amcp_write',{action:'inspect',gateway,connection_id:SNAP,arguments:{action,account_id:account,payload}});
   assert.equal(inspected.data.review_contract_supported,true,action+' '+JSON.stringify(inspected));
  }
  const contracts=(await f.call('amcp_workspace',{action:'contracts',gateway,search:'segment',limit:100})).data.actions,status=Object.fromEntries(contracts.map(r=>[r.action,r.status]));
  for(const action of ['snapchat_segments_segment_id_users_create','snapchat_segments_segment_id_users_delete','snapchat_segments_segment_id_all_users_delete','snapchat_segments_segment_id_delete'])assert.equal(status[action],'blocked_write',action);
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('documented segment rules are enforced before any provider request',async()=>{
 const f=fixture();try{
  const cases={
   'missing account':list({ad_account_id:undefined}),'another account':list({ad_account_id:'acct2'}),'empty name':list({name:' '}),'name over 375':list({name:'x'.repeat(376)}),
   'non-text description':list({description:5}),'pixel audience':list({source_type:'PIXEL',pixel_id:'pixel1'}),'mobile audience':list({source_type:'MOBILE'}),'engagement audience':list({source_type:'ENGAGEMENT'}),
   'retention zero':list({retention_in_days:0}),'retention over lifetime':list({retention_in_days:10000}),'fractional retention':list({retention_in_days:1.5}),'undocumented key':list({status:'ACTIVE'}),'list with spec':list({creation_spec:{seed_segment_id:'seed1',country:'US'}}),
   'lookalike retention over 180':lookalike({},{retention_in_days:181}),'lookalike without spec':lookalike({},{creation_spec:undefined}),'bad seed':lookalike({seed_segment_id:'../seed'}),'bad type':lookalike({type:'WIDE'}),
   'empty countries':lookalike({countries:[]}),'duplicate countries':lookalike({countries:['US','us']}),'bad country code':lookalike({countries:['USA']}),'no country':lookalike({countries:undefined}),
   'country outside countries':lookalike({country:'GB'}),'undocumented spec key':lookalike({audience_size:1})};
  for(const [name,row] of Object.entries(cases)){const r=await f.prepare('snapchat_audience_create',{segments:[row]});assert.equal(r.error?.code,'INVALID_SNAPCHAT_SEGMENT',name+': '+JSON.stringify(r.error??r.data).slice(0,300));}
  for(const [name,row] of Object.entries({'missing id':{name:'x',retention_in_days:30},'missing retention':{id:'list1',name:'x'},'status field':{id:'list1',name:'x',retention_in_days:30,status:'PAUSED'},'source change':{id:'list1',name:'x',retention_in_days:30,source_type:'FIRST_PARTY'}})){
   const r=await f.prepare('snapchat_audience_update',{segments:[row]});assert.equal(r.error?.code,'INVALID_SNAPCHAT_SEGMENT',name+': '+JSON.stringify(r.error??r.data).slice(0,300));
  }
  assert.equal(f.requests.length,0,'validation happens before any read or write');
 }finally{f.store.close();}
});

test('a customer-list container is created once and verifies despite provider size and status fields',async()=>{
 const f=fixture();try{
  const p=await f.prepare('snapchat_audience_create',{segments:[list()]});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads,[{method:'GET',path:'/v1/adaccounts/acct1'}]);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));const id=done.data.data.segments[0].segment.id;
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.deepEqual(f.writes,['POST /v1/adaccounts/acct1/segments']);
  const read=await f.call(gateway,{action:'snapchat_audience_get',connection_id:SNAP,account_id:account,path_params:{segment_id:id}});assert.equal(read.success,true,JSON.stringify(read));
 }finally{f.store.close();}
});

test('a lookalike reads its owned seed, and verifies when Snapchat reads countries back as the deprecated country',async()=>{
 const f=fixture();try{
  const unknown=await f.prepare('snapchat_audience_create',{segments:[lookalike({countries:['us']})]});assert.equal(unknown.error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(unknown.error.details.path,'/v1/segments/seed1');
  assert.equal((await f.discover()).success,true);
  const p=await f.prepare('snapchat_audience_create',{segments:[lookalike({countries:['us']})]});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads,[{method:'GET',path:'/v1/adaccounts/acct1'},{method:'GET',path:'/v1/segments/seed1'}]);
  assert.equal((await f.execute(p.data.review_id)).success,true);
  assert.equal(f.requests.filter(r=>r==='GET /v1/segments/seed1').length,2,'seed read at preparation and again before execution, despite changing audience size');
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));
 }finally{f.store.close();}
});

test('a seed shared from another ad account is not treated as owned',async()=>{
 const f=fixture({seedAccount:'acct-shared'});try{
  await f.discover();const p=await f.prepare('snapchat_audience_create',{segments:[lookalike()]});
  assert.equal(p.error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(p.error.details.path,'/v1/segments/seed1');assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('an update reads the owned segment, reports retention impact, executes once and verifies',async()=>{
 const f=fixture();try{
  const blind=await f.prepare('snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',description:'Kept',retention_in_days:60}]});assert.equal(blind.error.code,'RESOURCE_SCOPE_REQUIRED');
  await f.discover();
  const p=await f.prepare('snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',description:'Kept',retention_in_days:60}]});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads,[{method:'GET',path:'/v1/segments/list1'}]);
  const impact=p.data.creative_impact;assert.equal(impact.provider,'snapchat');assert.equal(impact.may_affect_serving,true);assert.deepEqual(impact.segments.map(s=>[s.segment_id,s.retention_before,s.retention_after]),[['list1',90,60]]);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.deepEqual(f.writes,['PUT /v1/adaccounts/acct1/segments']);
 }finally{f.store.close();}
});

test('updates cannot drop a description, exceed the source retention or touch another account segment',async()=>{
 const f=fixture();try{
  await f.discover();
  const dropped=await f.prepare('snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',retention_in_days:60}]});assert.equal(dropped.error.code,'INCOMPLETE_SNAPCHAT_SEGMENT_UPDATE');
  const long=await f.prepare('snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',description:'Kept',retention_in_days:181}]});assert.equal(long.error.code,'INVALID_SNAPCHAT_SEGMENT','LOOKALIKE retention stays within 180 days');
 }finally{f.store.close();}
 const g=fixture({readAccount:'acct2'});try{
  await g.discover();const moved=await g.prepare('snapchat_audience_update',{segments:[{id:'list1',name:'Renamed',description:'Kept',retention_in_days:60}]});
  assert.equal(moved.error.code,'STATE_TARGET_MISMATCH',JSON.stringify(moved));assert.equal(g.writes.length,0);
 }finally{g.store.close();}
});

test('a segment that reads back with different retention stays inconclusive',async()=>{
 const f=fixture({readRetention:30});try{
  const p=await f.prepare('snapchat_audience_create',{segments:[list()]});await f.execute(p.data.review_id);
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'inconclusive',JSON.stringify(verified));assert.deepEqual(verified.data.checks[0].changed_fields,['/retention_in_days']);
 }finally{f.store.close();}
});

test('failed, partial or lost segment receipts never submit a second segment',async()=>{
 for(const mode of ['write_error','empty_receipt','duplicate_receipt','lost']){const f=fixture();try{
  const p=await f.prepare('snapchat_audience_create',{segments:[list()]});assert.equal(p.success,true,mode);
  const code=mode==='lost'?'WRITE_OUTCOME_UNCERTAIN':'WRITE_PARTIAL_OR_FAILED';
  f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,code,mode);f.mode('');
  assert.equal((await f.execute(p.data.review_id)).error?.code,code,mode);assert.equal(f.writes.length,1,mode);
  assert.notEqual((await f.verify(p.data.review_id)).data?.status,'verified',mode);
 }finally{f.store.close();}}
});

test('segment claims survive concurrent execution and restart; a lost receipt stays uncertain',async()=>{
 const f=fixture();try{
  const p=await f.prepare('snapchat_audience_create',{segments:[list()]});
  const results=await Promise.all([f.execute(p.data.review_id),f.execute(p.data.review_id)]);assert.ok(results.some(r=>r.success));assert.equal(f.writes.length,1);
  f.restart();assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal((await f.verify(p.data.review_id)).data.status,'verified');assert.equal(f.writes.length,1);
 }finally{f.store.close();}
 const g=fixture();try{
  const p=await g.prepare('snapchat_audience_create',{segments:[list()]});g.mode('lost');assert.equal((await g.execute(p.data.review_id)).success,false);g.mode('');g.restart();
  assert.equal((await g.execute(p.data.review_id)).error.code,'WRITE_OUTCOME_UNCERTAIN');assert.equal(g.writes.length,1);
 }finally{g.store.close();}
});
