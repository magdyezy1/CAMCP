import {randomUUID} from 'node:crypto';
import type {Actor,JsonObject} from './types.js';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
export const reportingOperations=new Set(['bind_reporting_workbook','create_reporting_query','update_reporting_query','create_reporting_schedule','update_reporting_schedule','save_workbook_preferences','execute_reporting_run','get_reporting_run','get_reporting_run_status','get_reporting_bootstrap','get_reporting_workbook_bootstrap','get_reporting_storage_overview','list_reporting_templates']);
export function nextSchedule(schedule:JsonObject,after=Date.now()):number{
 const config=schedule.schedule_config??{},kind=schedule.schedule_kind;
 if(!['hourly','daily','weekly'].includes(kind)||!Number.isInteger(config.minute??0)||(config.minute??0)<0||(config.minute??0)>59||!Number.isInteger(config.hour??0)||(config.hour??0)<0||(config.hour??0)>23||kind==='weekly'&&(!Number.isInteger(config.weekday)||config.weekday<0||config.weekday>6))throw new MirrorError('INVALID_SCHEDULE','Use minute 0-59, hour 0-23, and weekday 0-6 (Sunday=0) for weekly schedules.');
 let format:Intl.DateTimeFormat;try{format=new Intl.DateTimeFormat('en-US',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{throw new MirrorError('INVALID_TIMEZONE','Provide an IANA timezone.');}
 const previous=schedule.next_run_at!==undefined&&schedule.next_run_at<=after?format.format(schedule.next_run_at):undefined;
 const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
 for(let at=Math.floor(after/60000)*60000+60000;at<=after+8*86400000;at+=60000){
  const parts=format.formatToParts(at),value=(key:string)=>parts.find(p=>p.type===key)!.value;
  if(Number(value('minute'))===(config.minute??0)&&(kind==='hourly'||Number(value('hour'))===(config.hour??0))&&(kind!=='weekly'||weekdays.indexOf(value('weekday'))===config.weekday)&&format.format(at)!==previous)return at;
 }
 throw new MirrorError('SCHEDULE_UNRESOLVED','No occurrence was found within eight days.');
}
export function resolveReportConfig(config:JsonObject,now=Date.now()):JsonObject{
 const result=structuredClone(config),range=result.date_range;
 if(!range?.preset)return result;
 if(range.preset!=='last_complete_days'||!Number.isInteger(range.days)||range.days<1||range.days>366||typeof range.timezone!=='string')throw new MirrorError('INVALID_ROLLING_WINDOW','Use {preset:last_complete_days, days:1..366, timezone:IANA_timezone}.');
 let parts:Intl.DateTimeFormatPart[];try{parts=new Intl.DateTimeFormat('en-US',{timeZone:range.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);}catch{throw new MirrorError('INVALID_TIMEZONE','Rolling windows require an explicit IANA timezone.');}
 const part=(kind:string)=>Number(parts.find(p=>p.type===kind)!.value),today=Date.UTC(part('year'),part('month')-1,part('day'));
 result.date_range={since:new Date(today-range.days*86400000).toISOString().slice(0,10),until:new Date(today-86400000).toISOString().slice(0,10)};return result;
}
export class ReportingService {
 constructor(readonly store:Store){}
 prepareRun(tenantId:string,queryId:string):string{
  const query=this.store.document(tenantId,'reporting_query',queryId);
  return this.store.enqueue(tenantId,'report',{query_id:queryId,query_revision:query.revision,query_config:query.query_config},Number.MAX_SAFE_INTEGER);
 }
 handle(operation:string,args:JsonObject,actor:Actor):unknown{
  const tenant=actor.tenantId;
  if(operation==='list_reporting_templates')return [{id:'00000000-0000-4000-8000-000000000001',name:'Campaign performance',output:'local JSON and CSV',required:['platform','account_id','date_range'],evidence:'INDEPENDENT_DESIGN'}];
  if(['get_reporting_run','get_reporting_run_status'].includes(operation))return this.store.job(tenant,args.run_id);
  if(['get_reporting_bootstrap','get_reporting_workbook_bootstrap','get_reporting_storage_overview'].includes(operation))return {workspace_id:tenant,workbooks:this.store.documents(tenant,'workbook').filter(w=>!args.spreadsheet_id||w.spreadsheet_id===args.spreadsheet_id),queries:this.store.documents(tenant,'reporting_query'),schedules:this.store.documents(tenant,'reporting_schedule'),destination:'local',google_sheets_connected:false,external_writes:false};
  if(actor.role==='reader'&&args.dry_run===false)throw new MirrorError('FORBIDDEN','Reader role cannot change reporting configuration or enqueue jobs.',{},403);
  if(operation==='execute_reporting_run'){
   const job=this.store.job(tenant,args.run_id);if(job.kind!=='report')throw new MirrorError('INVALID_REPORT_RUN','The job is not a reporting run.');
   if(args.dry_run!==false)return {dry_run:true,executed:false,run_id:args.run_id,input:job.input};
   this.store.activateJob(tenant,args.run_id);return {run_id:args.run_id,state:this.store.job(tenant,args.run_id).state};
  }
  const kind=operation.includes('schedule')?'reporting_schedule':operation.includes('query')?'reporting_query':'workbook';
  const oldId=args.query_id??args.schedule_id??args.workbook_binding_id;
  let previous:JsonObject|undefined;
  if(operation.startsWith('update_')||operation==='save_workbook_preferences')previous=this.store.document(tenant,kind,String(oldId));
  if(args.workbook_binding_id&&kind!=='workbook')this.store.document(tenant,'workbook',args.workbook_binding_id);
  if(operation==='bind_reporting_workbook')previous=this.store.documents(tenant,'workbook').find(w=>w.spreadsheet_id===args.spreadsheet_id);
  const id=previous?.id??randomUUID(),{dry_run,...changes}=args;
  const value:JsonObject={...previous,...changes,updated_at:new Date().toISOString()};delete value.id;delete value.revision;
  if(kind==='reporting_schedule'){
   if(value.destination_id)throw new MirrorError('DESTINATION_UNAVAILABLE','This worker currently stores report outputs locally; external destinations require a separately configured adapter.');
   const queryId=value.schedule_config?.query_id;if(typeof queryId!=='string')throw new MirrorError('REPORT_QUERY_REQUIRED','schedule_config.query_id must identify a saved query.');
   const query=this.store.document(tenant,'reporting_query',queryId);if(query.workbook_binding_id!==value.workbook_binding_id)throw new MirrorError('REPORT_BINDING_MISMATCH','Query and schedule must use the same workbook binding.');
   value.is_active??=true;value.next_run_at=nextSchedule(value);
  }
  if(args.dry_run!==false)return {dry_run:true,executed:false,kind,id,payload:value,destination:'local'};
  this.store.ensureTenant(tenant);
  const result=this.store.putDocument(tenant,kind,id,value,previous?.revision);
  this.store.appendAudit(tenant,'reporting/'+id,{event:operation,id,revision:result.revision});
  return {...result,...(kind==='workbook'?{workbook_binding_id:id}:kind==='reporting_query'?{query_id:id,prepared_run_id:this.prepareRun(tenant,id)}:{schedule_id:id}),destination:'local',external_writes:false};
 }
}
