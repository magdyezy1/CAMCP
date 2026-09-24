import {MirrorError} from './errors.js';
import {reportRange} from './report-native.js';
import {fingerprint} from './report-quality.js';
import {reportSourceError} from './report-errors.js';
import type {JsonObject} from './types.js';

export const reportGrains=['total','daily','weekly','monthly'];
export function reportPeriods(range:JsonObject,grain='total'):{since:string;until:string}[]{
 const r=reportRange(range);if(!reportGrains.includes(grain))throw new MirrorError('INVALID_REPORT_GRAIN','Choose total, daily, weekly or monthly data grouping.');
 if(grain==='total')return [r];const periods:{since:string;until:string}[]=[],end=Date.parse(r.until),iso=(n:number)=>new Date(n).toISOString().slice(0,10);
 for(let at=Date.parse(r.since);at<=end;){const d=new Date(at);let stop=at;if(grain==='weekly')stop=at+(6-(d.getUTCDay()+6)%7)*86400000;if(grain==='monthly')stop=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0);stop=Math.min(end,stop);periods.push({since:iso(at),until:iso(stop)});at=stop+86400000;}
 return periods;
}

/** Query each native calendar period directly, so reach/ratios are not summed from daily values. */
export async function collectReportPeriods(source:JsonObject,dates:JsonObject,grain:string,checkpoint:JsonObject,collect:(range:JsonObject,checkpoint:JsonObject,save:(value:JsonObject)=>void)=>Promise<JsonObject>,save:(value:JsonObject)=>void):Promise<JsonObject>{
 if(grain==='total')return collect(dates,checkpoint,save);
 const periods=reportPeriods(dates,grain),definition=fingerprint({source,dates,grain});
 if(checkpoint.definition&&checkpoint.definition!==definition)throw new MirrorError('REPORT_DEFINITION_CHANGED','The saved report periods do not match the frozen report. Start a new run.');
 const state:JsonObject={definition,periods:checkpoint.periods??{}},results:JsonObject[]=[];let rowCount=0;
 for(let i=0;i<periods.length;i++){
  const range=periods[i]!,key=String(i),prior=state.periods[key]??{};let result=prior.result;
  if(!result)try{result=await collect(range,prior.native??{},native=>{state.periods[key]={native};save(state);});state.periods[key]={result};save(state);}
  catch(e){if(e instanceof MirrorError&&e.retryable)throw e;if(e instanceof MirrorError&&['STALE_JOB_LEASE','JOB_CANCELLED','MEMBERSHIP_REVOKED','ACCOUNT_ACCESS_REVOKED'].includes(e.code))throw e;result={rows:[],complete:false,date_range:range,error:reportSourceError(e,source),warnings:[]};state.periods[key]={result};save(state);}
  rowCount+=result.rows.length;if(rowCount>10000)throw new MirrorError('REPORT_ROW_LIMIT','The source exceeds 10,000 rows across its periods. Narrow the dates or accounts.');results.push({...result,date_range:range});
 }
 const successful=results.filter(r=>!r.error),first=successful[0];if(!first)throw new MirrorError('REPORT_PERIODS_FAILED','Every calendar period failed for this source.',{periods:results.map((r,i)=>({date_range:periods[i],error:r.error}))},502);
 const context=(r:JsonObject)=>{const {rows,metadata,...data}=r;return data;};
 const errors=results.filter(r=>r.error),contexts=results.map(context);
 const quality={...first.quality,period_count:results.length,failed_period_count:errors.length,sampled:results.some(r=>r.quality?.sampled),thresholded:results.some(r=>r.quality?.thresholded),data_loss:results.some(r=>r.quality?.data_loss),invalid_sampling:results.some(r=>r.quality?.invalid_sampling),empty_reasons:[...new Set(results.flatMap(r=>r.quality?.empty_reasons??[]))],restricted_metrics:[...new Set(results.flatMap(r=>r.quality?.restricted_metrics??[]))],measurement_complete:results.every(r=>r.quality?.measurement_complete===true),pages:results.flatMap(r=>r.quality?.pages??[])};
 return {...context(first),quality,date_range:dates,complete:results.every(r=>r.complete),periods:contexts,period_errors:errors.map(context),warnings:[...new Set(results.flatMap(r=>r.warnings??[])),...(errors.length?[errors.length+' calendar period(s) failed. Their dates and errors are retained; totals and recommendations have incomplete coverage.']:[])],lineage:results.flatMap(r=>r.lineage??[]),query_fingerprint:fingerprint(results.map(r=>r.query_fingerprint??null)),rows:results.flatMap((r,i)=>r.rows.map((row:JsonObject)=>({...row,report_period:periods[i],period_context:context(r)})))};
}
