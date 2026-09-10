import {Store} from './store.js';
import {nextSchedule,resolveReportConfig} from './reporting.js';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
export class ReportWorker {
 constructor(readonly store:Store,readonly execute:(tenantId:string,config:JsonObject)=>Promise<unknown>,readonly auxiliary?:(tenant:string,kind:string,input:JsonObject)=>Promise<unknown>){}
 tickSchedules(){for(const tenant of this.store.listTenants())for(const schedule of this.store.documents(tenant,'reporting_schedule'))if(schedule.is_active&&schedule.next_run_at<=Date.now()){
  try{this.store.enqueueSchedule(tenant,schedule.id,schedule.revision,nextSchedule(schedule));}catch(e){this.store.appendAudit(tenant,'scheduler/'+schedule.id,{event:'schedule_failed',error:e instanceof MirrorError?{code:e.code,message:e.message}:{code:'SCHEDULER_ERROR'}});}
 }}
 async once():Promise<boolean>{
  this.tickSchedules();const job=this.store.leaseJob(60000);if(!job)return false;
  let lostLease=false;const heartbeat=setInterval(()=>{try{this.store.renewJob(job.id,job.lease_token);}catch{lostLease=true;}},15000);heartbeat.unref();
  try{
   if(job.kind!=='report'&&!this.auxiliary)throw new MirrorError('UNKNOWN_JOB_KIND','No worker is registered for this job kind.');
   const result=job.kind==='report'?await this.execute(job.tenant_id,resolveReportConfig(job.input.query_config)):await this.auxiliary!(job.tenant_id,job.kind,{...job.input,__job_id:job.id,__lease_token:job.lease_token});
   if(!lostLease)this.store.finishJob(job.id,job.lease_token,result);
  }catch(e){
   const error=e instanceof MirrorError?{code:e.code,message:e.message,details:e.details}:{code:'REPORT_FAILED',message:'Report execution failed.'};
   if(!lostLease)try{if(e instanceof MirrorError&&e.retryable&&['report_overview','sheets_export'].includes(job.kind)&&job.attempts<8)this.store.retryJob(job.id,job.lease_token,error,Number(e.details.retry_after_ms??Math.min(300000,5000*2**job.attempts)));else this.store.failJob(job.id,job.lease_token,error);}catch{lostLease=true;}
   this.store.appendAudit(job.tenant_id,job.id,{event:lostLease?'report_lease_lost':'report_failed',error});
  }finally{clearInterval(heartbeat);}
  return true;
 }
}
