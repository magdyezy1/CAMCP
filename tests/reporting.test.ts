import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.js';
import {ReportingService,nextSchedule,resolveReportConfig} from '../src/reporting.js';
import {ReportWorker} from '../src/worker.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createReportExecutor} from '../src/report-executor.js';
import type {Actor} from '../src/types.js';
import {removeTestDirectory} from './temp.js';
const actor:Actor={tenantId:'t',userId:'a',role:'admin'};
test('captured reporting schemas bind, save, prepare, execute and fetch a run through MCP',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,9).toString('base64'));try{
  const service=new MirrorService(new Registry(),store);
  const call=(operation:string,args:any)=>service.call('amcp_native_action',{operation,arguments:args},actor);
  const preview=await call('bind_reporting_workbook',{spreadsheet_id:'test',dry_run:true});assert.equal(preview.data.executed,false);assert.equal(store.documents('t','workbook').length,0);
  const bind=await call('bind_reporting_workbook',{spreadsheet_id:'test',dry_run:false});assert.equal(bind.success,true);
  const query=await call('create_reporting_query',{workbook_binding_id:bind.data.workbook_binding_id,name:'Test',query_config:{platform:'google',account_id:'111',date_range:{since:'2026-08-01',until:'2026-08-31'}},dry_run:false});assert.equal(query.success,true);
  const runId=query.data.prepared_run_id;assert.ok(runId);assert.equal(store.leaseJob(),undefined);
  assert.equal((await call('execute_reporting_run',{run_id:runId,dry_run:false})).success,true);
  let executed=0;const worker=new ReportWorker(store,async(tenant,config)=>{executed++;assert.equal(tenant,'t');assert.equal(config.account_id,'111');return {rows:[{spend:5,currency:'SAR'}]};});assert.equal(await worker.once(),true);assert.equal(executed,1);
  const run=await call('get_reporting_run',{run_id:runId});assert.equal(run.data.state,'complete');assert.equal(run.data.result.rows[0].spend,5);assert.equal(run.data.lease_token,undefined);
  await call('execute_reporting_run',{run_id:runId,dry_run:false});assert.equal(await worker.once(),false);
  assert.throws(()=>new ReportingService(store).handle('get_reporting_run',{run_id:runId},{...actor,tenantId:'other'}),/not found/);
 }finally{store.close();}
});
test('schedules enqueue atomically and keep one job per claimed occurrence',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,9).toString('base64'));try{
  const reporting=new ReportingService(store);
  const binding=reporting.handle('bind_reporting_workbook',{spreadsheet_id:'test',dry_run:false},actor) as any;
  const query=reporting.handle('create_reporting_query',{workbook_binding_id:binding.id,name:'R',query_config:{platform:'google'},dry_run:false},actor) as any;
  const schedule=reporting.handle('create_reporting_schedule',{workbook_binding_id:binding.id,name:'Daily',timezone:'Africa/Cairo',schedule_kind:'daily',schedule_config:{hour:9,minute:0,query_id:query.id},dry_run:false},actor) as any;
  const doc=store.document('t','reporting_schedule',schedule.id);store.putDocument('t','reporting_schedule',schedule.id,{...doc,next_run_at:Date.now()-1},doc.revision);
  const worker=new ReportWorker(store,async()=>({rows:[]}));worker.tickSchedules();worker.tickSchedules();
  const jobs=store.db.prepare('SELECT id FROM jobs WHERE available_at<?').all(Date.now()+1000);assert.equal(jobs.length,1);
  assert.equal(await worker.once(),true);assert.equal(await worker.once(),false);
 }finally{store.close();}
});
test('daily/weekly schedules use IANA timezones, skip nonexistent local times and validate config',()=>{
 assert.equal(nextSchedule({timezone:'Africa/Cairo',schedule_kind:'daily',schedule_config:{hour:9,minute:0}},Date.parse('2026-09-05T00:00:00Z')),Date.parse('2026-09-05T06:00:00Z'));
 assert.equal(nextSchedule({timezone:'America/New_York',schedule_kind:'daily',schedule_config:{hour:2,minute:30}},Date.parse('2026-03-08T00:00:00Z')),Date.parse('2026-03-09T06:30:00Z'));
 assert.throws(()=>nextSchedule({timezone:'UTC',schedule_kind:'weekly',schedule_config:{weekday:8}}),/weekday/);
 const repeated={timezone:'America/New_York',schedule_kind:'daily',schedule_config:{hour:1,minute:30},next_run_at:Date.parse('2026-11-01T05:30:00Z')};
 assert.equal(nextSchedule(repeated,Date.parse('2026-11-01T05:31:00Z')),Date.parse('2026-11-02T06:30:00Z'));
});
test('rolling windows resolve complete local calendar days without modifying the saved query',()=>{
 const config={platform:'google',date_range:{preset:'last_complete_days',days:7,timezone:'America/New_York'}};
 assert.deepEqual(resolveReportConfig(config,Date.parse('2026-09-06T02:00:00Z')).date_range,{since:'2026-08-29',until:'2026-09-04'});
 assert.equal(config.date_range.preset,'last_complete_days');assert.throws(()=>resolveReportConfig({date_range:{preset:'last_complete_days',days:7}}),/timezone/);
});
test('queued jobs and completed results survive database close and reopen',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-persistence-')),file=path.join(directory,'test.sqlite');let store=new Store(file,Buffer.alloc(32,9).toString('base64'));
 try{store.ensureTenant('t');const id=store.enqueueReport(actor,{query_config:{test:true}});store.close();store=new Store(file,Buffer.alloc(32,9).toString('base64'));
  const worker=new ReportWorker(store,async()=>({value:42}));assert.equal(await worker.once(),true);store.close();store=new Store(file,Buffer.alloc(32,9).toString('base64'));assert.equal(store.job('t',id).state,'complete');assert.equal(store.job('t',id).result.value,42);
 }finally{store.close();removeTestDirectory(directory,'amcp-persistence-');}
});
test('worker failure is durable and never converted to an empty successful report',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,9).toString('base64'));try{const id=store.enqueueReport(actor,{query_config:{}});const worker=new ReportWorker(store,async()=>{throw Error('do not expose internal credentials');});await worker.once();assert.equal(store.job('t',id).state,'failed');assert.equal(store.job('t',id).error.code,'REPORT_FAILED');assert.ok(!JSON.stringify(store.job('t',id)).includes('credentials'));}finally{store.close();}
});

test('native reporting persists malformed responses as failures and accepts valid empty reports',async()=>{
 for(const body of ['', '  ', '{"results":[', 'null', 'true', '42', '{}', '{"results":[]}']){
  const store=new Store(':memory:',Buffer.alloc(32,7).toString('base64'));
  try{
   store.putConnection(actor,{id:'mock',tenantId:'t',gateway:'google_ads_native_action',accounts:['111'],enabled:true,label:'mock',scopes:[]},{accessToken:'mock',developerToken:'mock'});
   let calls=0;const transport=new NativeTransport((async()=>{calls++;return new Response(body,{headers:{'content-type':'application/json'}});}) as typeof fetch,async()=>{});
   const service=new MirrorService(new Registry(),store,transport);
   const id=store.enqueueReport(actor,{query_config:{gateway:'google_ads_native_action',arguments:{action:'google_ads_v23_google_ads_search',account_id:'111',payload:{query:'SELECT campaign.id FROM campaign LIMIT 1'}}}});
   await new ReportWorker(store,createReportExecutor(service)).once();
   const job=store.job('t',id),valid=body==='{}'||body==='{"results":[]}';assert.equal(job.state,valid?'complete':'failed',body);assert.equal(calls,1);
   if(valid)assert.deepEqual(job.result.data,JSON.parse(body));else {assert.equal(job.error.code,'UPSTREAM_RESPONSE_INVALID');assert.equal(job.result,null);}
  }finally{store.close();}
 }
});
