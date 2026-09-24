import test from 'node:test';
import assert from 'node:assert/strict';
import {collectReportPeriods,reportPeriods} from '../src/report-periods.js';
import {nextSchedule,resolveReportConfig} from '../src/reporting.js';
import {MirrorError} from '../src/errors.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {reportTable,exportCsv} from '../src/google-sheets.js';
import type {Actor,JsonObject} from '../src/types.js';

test('calendar grouping clips edge periods and respects Monday weeks and leap months',()=>{
 assert.deepEqual(reportPeriods({since:'2024-02-28',until:'2024-03-02'},'monthly'),[{since:'2024-02-28',until:'2024-02-29'},{since:'2024-03-01',until:'2024-03-02'}]);
 assert.deepEqual(reportPeriods({since:'2026-09-20',until:'2026-09-29'},'weekly'),[{since:'2026-09-20',until:'2026-09-20'},{since:'2026-09-21',until:'2026-09-27'},{since:'2026-09-28',until:'2026-09-29'}]);
 assert.equal(reportPeriods({since:'2024-01-01',until:'2024-12-31'},'daily').length,366);
 assert.throws(()=>reportPeriods({since:'2024-02-30',until:'2024-03-01'},'daily'));
 assert.deepEqual(resolveReportConfig({date_range:{preset:'last_complete_week',timezone:'America/Los_Angeles'}},Date.parse('2026-09-21T06:59:00Z')).date_range,{since:'2026-09-07',until:'2026-09-13'});
 assert.deepEqual(resolveReportConfig({date_range:{preset:'last_complete_week',timezone:'America/Los_Angeles'}},Date.parse('2026-09-21T07:00:00Z')).date_range,{since:'2026-09-14',until:'2026-09-20'});
});

test('month-end schedules, DST gaps and repeated hours produce valid single local occurrences',()=>{
 assert.equal(new Date(nextSchedule({schedule_kind:'monthly',timezone:'Pacific/Auckland',schedule_config:{day:31,hour:8}},Date.parse('2026-02-01T00:00:00Z'))).toISOString(),'2026-02-27T19:00:00.000Z');
 assert.equal(new Date(nextSchedule({schedule_kind:'monthly',timezone:'America/New_York',schedule_config:{day:8,hour:2,minute:30}},Date.parse('2026-03-01T00:00:00Z'))).toISOString(),'2026-04-08T06:30:00.000Z');
 const first=Date.parse('2026-11-01T05:30:00Z');
 assert.equal(new Date(nextSchedule({schedule_kind:'hourly',timezone:'America/New_York',schedule_config:{minute:30},next_run_at:first},first)).toISOString(),'2026-11-01T07:30:00.000Z');
 assert.throws(()=>nextSchedule({schedule_kind:'monthly',timezone:'UTC',schedule_config:{day:0}}),{code:'INVALID_SCHEDULE'});
 assert.throws(()=>nextSchedule({schedule_kind:'monthly',timezone:'Not/AZone'}),{code:'INVALID_TIMEZONE'});
});

test('period retries retain completed data and native async checkpoints across serialization',async()=>{
 let state:JsonObject={},calls:string[]=[];
 const dates={since:'2026-09-01',until:'2026-09-03'},source={platform:'microsoft',connection_id:'login',account_id:'123'};
 const good=(range:JsonObject)=>({rows:[{campaign_id:'one',metrics:{reach:10}}],complete:true,date_range:range,currency:'USD'});
 await assert.rejects(()=>collectReportPeriods(source,dates,'daily',state,async(range,_checkpoint,save)=>{calls.push(range.since);if(range.since==='2026-09-02'){save({report_id:'native-job'});throw new MirrorError('REPORT_PENDING','Still working',{retry_after_ms:30000},503,true);}return good(range);},v=>state=JSON.parse(JSON.stringify(v))),{code:'REPORT_PENDING'});
 const result=await collectReportPeriods(source,dates,'daily',state,async(range,checkpoint)=>{calls.push(range.since);if(range.since==='2026-09-02')assert.equal(checkpoint.report_id,'native-job');return good(range);},v=>state=JSON.parse(JSON.stringify(v)));
 assert.deepEqual(calls,['2026-09-01','2026-09-02','2026-09-02','2026-09-03']);assert.equal(result.rows.length,3);assert.equal(result.complete,true);
 await assert.rejects(()=>collectReportPeriods(source,dates,'monthly',state,async()=>{throw Error('No request');},()=>{}),{code:'REPORT_DEFINITION_CHANGED'});
});

test('missing periods remain explicit partial coverage and native period totals are never synthesized by summing days',async()=>{
 const ranges:JsonObject[]=[];const r=await collectReportPeriods({platform:'meta'},{since:'2026-08-01',until:'2026-09-30'},'monthly',{},async range=>{ranges.push(range);if(range.since==='2026-09-01')throw new MirrorError('INSUFFICIENT_SCOPE','Synthetic permission failure',{},403);return {rows:[{campaign_id:'same',metrics:{reach:10,frequency:2.5}}],complete:true};},()=>{});
 assert.deepEqual(ranges,[{since:'2026-08-01',until:'2026-08-31'},{since:'2026-09-01',until:'2026-09-30'}]);assert.equal(r.rows[0].metrics.reach,10);assert.equal(r.complete,false);assert.equal(r.period_errors[0].date_range.since,'2026-09-01');assert.equal(r.period_errors[0].error.code,'INSUFFICIENT_SCOPE');assert.match(r.warnings.join(' '),/calendar period/);
 await assert.rejects(()=>collectReportPeriods({platform:'meta'},{since:'2026-09-01',until:'2026-09-02'},'daily',{},async()=>{throw new MirrorError('JOB_CANCELLED','Cancelled');},()=>{}),{code:'JOB_CANCELLED'});
});

test('one daily fixture reconciles native requests, worker rows, formulas, CSV and typed Sheets cells',async()=>{
 const actor:Actor={tenantId:'period-fixture',userId:'owner',role:'admin'},store=new Store(':memory:',Buffer.alloc(32,71).toString('base64')),ranges:JsonObject[]=[],batches:JsonObject[]=[];
 const source={platform:'meta',connection_id:'meta',account_id:'100'};
 const sheetsFetch:typeof fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://sheets.googleapis.com/v4/spreadsheets/syntheticSheet'));if(init?.method==='POST'){batches.push(JSON.parse(String(init.body)));return Response.json({replies:[]});}return Response.json({sheets:[]});};
 try{
  store.putConnection(actor,{id:'meta',tenantId:actor.tenantId,gateway:'meta_native_action',accounts:['100'],enabled:true,label:'Synthetic',scopes:['ads_read']},{accessToken:'synthetic'});
  store.putConnection(actor,{id:'sheets',tenantId:actor.tenantId,gateway:'google_sheets_native_action',accounts:['syntheticSheet'],enabled:true,label:'Synthetic',scopes:['https://www.googleapis.com/auth/spreadsheets']},{accessToken:'synthetic'});
  store.putDocument(actor.tenantId,'sheets_destination','destination',{spreadsheet_id:'syntheticSheet',connection_id:'sheets',sheet_id:771,tab_name:'Daily test'});
  const transport=new NativeTransport(async url=>{const u=new URL(String(url));if(!u.pathname.endsWith('/insights'))return Response.json({id:'act_100',name:'Fixture',currency:'USD',timezone_name:'America/New_York'});const range=JSON.parse(u.searchParams.get('time_range')!);ranges.push(range);const first=range.since==='2026-09-01';return Response.json({data:[{campaign_id:'123',account_id:'100',campaign_name:'=Synthetic campaign',objective:'OUTCOME_TRAFFIC',date_start:range.since,date_stop:range.until,spend:first?'10':'30',clicks:first?'2':'3',impressions:'100',reach:'80',frequency:'1.25'}]});},async()=>{});
  const service=new MirrorService(new Registry(),store,transport),overview=new ReportingOverview(service,sheetsFetch),worker=new ReportWorker(store,async()=>({}),(t,k,i)=>overview.work(t,k,i));
  const queued=await overview.handle({action:'run',config:{name:'Daily client report',client_name:'Client A',grain:'daily',sources:[source],date_range:{since:'2026-09-01',until:'2026-09-02'},metrics:['spend','clicks','cpc','reach'],custom_metrics:[{id:'spend_per_click',label:'Spend per click',formula:'spend / clicks',format:'currency'}]},confirmed:true},actor);await worker.once();
  const report=await overview.handle({action:'get',id:queued.id},actor);assert.equal(report.state,'complete');assert.equal(report.row_count,2);assert.deepEqual(ranges,[{since:'2026-09-01',until:'2026-09-01'},{since:'2026-09-02',until:'2026-09-02'}]);
  assert.deepEqual(report.rows.map((r:JsonObject)=>[r.date_from,r.date_to,r.metrics.spend,r.metrics.clicks,r.metrics.cpc,r.metrics.spend_per_click]),[['2026-09-01','2026-09-01',10,2,5,5],['2026-09-02','2026-09-02',30,3,10,10]]);
  assert.equal(new Set(report.rows.map((r:JsonObject)=>r.row_key)).size,2);assert.equal(report.summary.length,2);assert.ok(report.summary.every((g:JsonObject)=>g.metrics.reach===null));
  const table=reportTable(report),csv=exportCsv(report);assert.equal(table.length,3);assert.equal(csv.split('\r\n').length,3);assert.match(csv,/'=Synthetic campaign/);
  const e=await overview.handle({action:'export',report_id:report.id,destination_id:'destination',confirmed:true},actor);await worker.once();assert.equal((await overview.handle({action:'export_status',id:e.id},actor)).state,'complete');assert.equal(batches.length,1);
  const cells=batches[0]!.requests.find((r:JsonObject)=>r.updateCells).updateCells.rows.map((r:JsonObject)=>r.values.map((c:JsonObject)=>c.userEnteredValue.numberValue??c.userEnteredValue.stringValue));assert.deepEqual(cells,table);assert.equal(cells[1]![table[0]!.indexOf('spend')],10);
 }finally{store.close();}
});
