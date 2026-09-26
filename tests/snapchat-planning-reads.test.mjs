import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Snapchat planning reads (Marketing API "Audience Insights" and the reach and frequency forecasting request, checked
 * 2026-09-26): POST requests that estimate and create nothing, so a reader can run them on a read-only deployment.
 */
const gateway='snapchat_native_action',account='8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',registry=new Registry();
const actor={tenantId:'snapchat-planning',userId:'reader',role:'reader'},owner={...actor,role:'admin'};
const insights='snapchat_adaccounts_ad_account_id_targeting_insights_create',forecast='snapchat_adaccounts_ad_account_id_reserved_forecasting_create';
const iso=h=>new Date(Date.now()+h*3600000).toISOString();
const spec={geos:[{country_code:'us'}],demographics:[{gender:'MALE'}]};
const forecastBody=(extra={})=>({placement_v2:{config:'AUTOMATIC'},targeting:spec,delivery_constraint:'REACH_AND_FREQUENCY',start_time:iso(48),end_time:iso(48+24*30),type:'SNAP_ADS',optimization_goal:'VIDEO_VIEWS',cap_and_exclusion_config:{frequency_cap_config:[{frequency_cap_count:1,frequency_cap_type:'IMPRESSIONS',time_interval:7,frequency_cap_interval:'DAYS'}]},...extra});
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,92).toString('base64')),connection={id:'33333333-3333-4333-8333-333333333333',tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[],enabled:true,label:'Synthetic Snapchat',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});const calls=[];
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url));calls.push({path:u.pathname,method:init.method,query:Object.fromEntries(u.searchParams),body:init.body?JSON.parse(String(init.body)):undefined});
  if(u.pathname.endsWith('/targeting_insights'))return Response.json({request_status:'SUCCESS',request_id:'r1',targeting_insights:{target_audience:{audience_size_minimum:'10500000',audience_size_maximum:'10800000'},reference_audience:{audience_size_minimum:'1110000',audience_size_maximum:'1125000'},categories:{}}});
  if(u.pathname.endsWith('/reserved_forecasting'))return Response.json({request_status:'SUCCESS',request_id:'r2',reach_frequency_curve:[{impression:254240,reach:250320,budget_micro:610557576},{impression:1300320,reach:1211840,budget_micro:3121198726}],display_message:'',debug_message:''});
  throw new Error('Unexpected Snapchat request '+u.pathname);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:false,requireBeforeState:true,maxBudgetChange:0});
 const call=(action,payload,extra={})=>service.call(gateway,{action,ad_account_id:account,connection_id:connection.id,payload,dry_run:false,...extra},actor);
 return {store,calls,call};
}

test('audience insights run as a read for a reader on a read-only deployment and return Snapchat\'s estimate unchanged',async()=>{
 const f=fixture();try{
  const out=await f.call(insights,{base_spec:spec,targeting_spec:{...spec,interests:[{category_id:['SLC_37']}]}},{query:{dimension_category:'demo'}});
  assert.equal(out.success,true,JSON.stringify(out).slice(0,600));assert.equal(f.calls.length,1);
  assert.deepEqual([f.calls[0].method,f.calls[0].path,f.calls[0].query.dimension_category],['POST','/v1/adaccounts/'+account+'/targeting_insights','demo']);
  assert.deepEqual(f.calls[0].body.base_spec,spec);
  assert.match(JSON.stringify(out),/10500000/);
 }finally{f.store.close();}
});

test('a reach and frequency forecast runs as a read and books nothing',async()=>{
 const f=fixture();try{
  const out=await f.call(forecast,forecastBody());assert.equal(out.success,true,JSON.stringify(out).slice(0,600));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.delivery_constraint,'REACH_AND_FREQUENCY');assert.match(JSON.stringify(out),/reach_frequency_curve/);
  const preview=await f.call(forecast,forecastBody(),{dry_run:true});assert.equal(preview.success,true,JSON.stringify(preview).slice(0,400));assert.equal(preview.data.request.readOnly,true);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('malformed insights and forecasts, and another ad account, are refused before any request',async()=>{
 const cases=[
  ['insights without a base spec',insights,{targeting_spec:spec}],
  ['insights with an extra field',insights,{base_spec:spec,targeting_spec:spec,bid_micro:1}],
  ['unknown dimension category',insights,{base_spec:spec,targeting_spec:spec},{query:{dimension_category:'income'}}],
  ['auction delivery',forecast,forecastBody({delivery_constraint:'DAILY_BUDGET'})],
  ['start within 12 hours',forecast,forecastBody({start_time:iso(2)})],
  ['start beyond a year',forecast,forecastBody({start_time:iso(24*400),end_time:iso(24*401)})],
  ['end before start',forecast,forecastBody({end_time:iso(24)})],
  ['lens with video views',forecast,forecastBody({type:'LENS'})],
  ['unknown attribute',forecast,forecastBody({bid_micro:1000000})],
  ['no frequency cap',forecast,forecastBody({cap_and_exclusion_config:undefined})],
  ['date without time',forecast,forecastBody({start_time:'2030-01-01'})]
 ];
 for(const [label,action,payload,extra] of cases){const f=fixture();try{const out=await f.call(action,JSON.parse(JSON.stringify(payload)),extra);assert.equal(out.error?.code,'INVALID_SNAPCHAT_PLANNING_READ',label+': '+JSON.stringify(out).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 const f=fixture();try{const out=await f.call(insights,{base_spec:spec,targeting_spec:spec},{ad_account_id:'00000000-0000-4000-8000-000000000000'});assert.equal(out.error?.code,'CONNECTION_REQUIRED',JSON.stringify(out).slice(0,300));assert.equal(f.calls.length,0);}finally{f.store.close();}
});

test('both planning routes are native reads in the action ledger, not blocked writes',()=>{
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&[insights,forecast].includes(r.action));
 assert.equal(rows.length,2);for(const row of rows)assert.equal(row.status,'native_read',row.action);
});
