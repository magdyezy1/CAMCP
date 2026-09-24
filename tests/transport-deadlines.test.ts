import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {NativeTransport} from '../src/transport.js';
import type {CompiledRequest,Connection} from '../src/types.js';

const cases:[string,Partial<CompiledRequest>,string][]=[
 ['Criteo campaign',{gateway:'criteo_native_action',action:'AMCP_CRITEO_CAMPAIGN_READ',origin:'https://api.criteo.com',path:'/2026-01/retail-media/accounts',criteoCampaignDeadline:1200},'CRITEO_CAMPAIGN_STATE_UNVERIFIED'],
 ['Criteo report',{gateway:'criteo_native_action',action:'AMCP_CRITEO_REPORT_READ',origin:'https://api.criteo.com',path:'/2026-01/retail-media/reports/synthetic/status',criteoReportRead:{kind:'status'},criteoReportDeadline:1200},'CRITEO_REPORT_STATE_UNVERIFIED'],
 ['TikTok report',{gateway:'tiktok_native_action',action:'AMCP_TIKTOK_REPORT_READ',origin:'https://business-api.tiktok.com',path:'/v1.3/report/task/check/',tiktokReportDeadline:1200},'TIKTOK_REPORT_STATE_UNVERIFIED'],
 ['Google discovery',{gateway:'ga4_native_action',action:'AMCP_MEASUREMENT_ASSET_SYNC',origin:'https://analyticsadmin.googleapis.com',path:'/v1beta/accountSummaries',measurementSyncDeadline:1200},'ASSET_SYNC_LIMIT'],
 ['Business Profile discovery',{gateway:'google_business_native_action',action:'AMCP_BUSINESS_ASSET_SYNC',origin:'https://mybusinessaccountmanagement.googleapis.com',path:'/v1/accounts',measurementSyncDeadline:1200},'ASSET_SYNC_LIMIT'],
 ['Adjust report',{gateway:'adjust_native_action',action:'AMCP_ADJUST_REPORT_READ',origin:'https://automate.adjust.com',path:'/reports-service/report',adjustReportRead:true,adjustReportDeadline:1200},'ADJUST_REPORT_LIMIT']
];
function request(partial:Partial<CompiledRequest>):CompiledRequest{return {gateway:'',action:'',method:'GET',path:'/',query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'synthetic deadline regression',warnings:[],...partial};}
function connection(p:CompiledRequest):Connection{return {id:'synthetic',label:'Synthetic',tenantId:'deadline-test',gateway:p.gateway,enabled:true,accounts:['123'],writeAccounts:[],scopes:[]};}
function earlyTimer(){return mock.method(AbortSignal,'timeout',()=>{const controller=new AbortController();queueMicrotask(()=>controller.abort(new DOMException('Timer expired','TimeoutError')));return controller.signal;});}
function blockedFetch(counter:()=>void):typeof fetch{return async(_u,init)=>{counter();return new Promise<Response>((_resolve,reject)=>{const signal=init!.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};}

// Timers and performance.now() need not agree at a fractional millisecond boundary.
// Model a deadline timer firing while the monotonic reading is still just before it.
for(const [name,partial,code]of cases)test(name+' deadline timer is terminal even if the clock still reads before the deadline',async()=>{
 const clock=mock.method(performance,'now',()=>1199.8),timer=earlyTimer();let calls=0;try{
  const p=request(partial),transport=new NativeTransport(blockedFetch(()=>calls++),async()=>{}),error=await transport.request(p,connection(p),{accessToken:'synthetic'}).then(()=>undefined,e=>e);
  assert.equal(calls,1,'an expired operation timer must never dispatch a second request');assert.equal(error?.code,code);assert.equal(transport.metrics.retries,0);
 }finally{timer.mock.restore();clock.mock.restore();}
});

test('shorter per-attempt timeouts retain bounded retries inside the original operation budget',async()=>{
 const clock=mock.method(performance,'now',()=>1000),timer=earlyTimer();try{for(const [,partial]of cases){const p=request(partial);let calls=0;const transport=new NativeTransport(async(u,init)=>{if(++calls===1)return blockedFetch(()=>{})(u,init);return Response.json({});},async()=>{},25);await transport.request(p,connection(p),{accessToken:'synthetic'});assert.equal(calls,2);assert.equal(transport.metrics.retries,1);}}finally{timer.mock.restore();clock.mock.restore();}
});

test('already expired and non-finite operation budgets cannot reach a provider',async()=>{
 const clock=mock.method(performance,'now',()=>1300);try{for(const [,partial,code]of cases)for(const value of [1200,NaN,Infinity]){const p=request(partial),field=Object.keys(partial).find(k=>k.endsWith('Deadline'))!;(p as any)[field]=value;let calls=0;const native=new NativeTransport(async()=>{calls++;return Response.json({});},async()=>{});await assert.rejects(native.request(p,connection(p),{accessToken:'synthetic'}),{code});assert.equal(calls,0);assert.equal(native.metrics.retries,0);}}finally{clock.mock.restore();}
});

test('late response headers and late response bodies are withheld after the operation deadline',async()=>{
 let now=1000;const clock=mock.method(performance,'now',()=>now);try{for(const [,partial,code]of cases)for(const late of ['headers','body']){now=1000;const p=request(partial);let calls=0;const transport=new NativeTransport(async()=>{calls++;if(late==='headers'){now=1201;return Response.json({});}return new Response(new ReadableStream({pull(controller){now=1201;controller.enqueue(new TextEncoder().encode('{}'));controller.close();}}),{headers:{'content-type':'application/json'}});},async()=>{});await assert.rejects(transport.request(p,connection(p),{accessToken:'synthetic'}),{code});assert.equal(calls,1);assert.equal(transport.metrics.retries,0);}}finally{clock.mock.restore();}
});

test('transient HTTP recovery retains one deadline instead of restarting its budget on retry',async()=>{
 let now=1000;const clock=mock.method(performance,'now',()=>now);try{for(const [,partial,code]of cases){now=1000;const p=request(partial);let calls=0;const transport=new NativeTransport(async()=>{calls++;return Response.json({},{status:503});},async()=>{now=1201;});await assert.rejects(transport.request(p,connection(p),{accessToken:'synthetic'}),{code});assert.equal(calls,1);}}finally{clock.mock.restore();}
});

test('a timeout before the operation deadline can still recover from a transient network failure',async()=>{
 const clock=mock.method(performance,'now',()=>1000);try{for(const [,partial]of cases){const p=request(partial);let calls=0;const transport=new NativeTransport(async()=>{if(++calls===1)throw Error('connection reset');return Response.json({});},async()=>{});await transport.request(p,connection(p),{accessToken:'synthetic'});assert.equal(calls,2);}}finally{clock.mock.restore();}
});
