import {MirrorError} from './errors.js';
import {metricNumber} from './report-metrics.js';
import type {JsonObject} from './types.js';

/** X requires a separate request for every placement and MOBILE_CONVERSION group. */
export async function xCampaignReport(inventory:JsonObject[],start:number,end:number,extra:string[],read:(query:JsonObject)=>Promise<JsonObject>):Promise<{rows:JsonObject[];complete:boolean;warnings:string[]}>{
 const placements=['ALL_ON_TWITTER','PUBLISHER_NETWORK','SPOTLIGHT','TREND'],groups=[...new Set(['ENGAGEMENT','BILLING',...extra])];
 if(groups.some(g=>!['ENGAGEMENT','BILLING','VIDEO','WEB_CONVERSION','MOBILE_CONVERSION'].includes(g)))throw new MirrorError('INVALID_REPORT_SOURCE','Choose a supported X metric group.');
 const groupSets=[groups.filter(g=>g!=='MOBILE_CONVERSION'),...(groups.includes('MOBILE_CONVERSION')?[['MOBILE_CONVERSION']]:[])];
 if(Math.ceil(inventory.length/20)*Math.ceil((end-start)/(7*86400000))*placements.length*groupSets.length>100)throw new MirrorError('REPORT_RANGE_LIMIT','Split the X date range or account to stay within 100 analytics requests.');
 const rows=new Map<string,JsonObject>(),warnings=new Set<string>();let complete=true,successful=0;
 for(let t=start;t<end;t+=7*86400000)for(let at=0;at<inventory.length;at+=20)for(const placement of placements)for(const group of groupSets){
  const stop=Math.min(end,t+7*86400000),batch=inventory.slice(at,at+20),expected=new Set(batch.map(c=>String(c.id)));
  let response:JsonObject;
  try{response=await read({entity:'CAMPAIGN',entity_ids:[...expected].join(','),start_time:new Date(t).toISOString(),end_time:new Date(stop).toISOString(),granularity:'HOUR',metric_groups:group.join(','),placement});successful++;}
  catch(e){if(e instanceof MirrorError&&(e.retryable||![400,404,422].includes(e.status)))throw e;complete=false;warnings.add('The provider could not report '+placement+' / '+group.join(',')+'. Budget guidance is withheld for incomplete coverage.');continue;}
  if(!Array.isArray(response.data))throw new MirrorError('REPORT_SHAPE_CHANGED','X analytics did not return a campaign collection.');
  const seen=new Set<string>();
  for(const r of response.data){
   if(!expected.has(r.id)||seen.has(r.id)||!Array.isArray(r.id_data))throw new MirrorError('REPORT_SCOPE_MISMATCH','X returned an unexpected or duplicated campaign.');seen.add(r.id);
   const old=rows.get(r.id)??{id:r.id,name:inventory.find(c=>c.id===r.id)?.name,objective:inventory.find(c=>c.id===r.id)?.objective,native_metrics:{}};
   for(const segment of r.id_data){
    if(segment.segment!=null)throw new MirrorError('REPORT_SHAPE_CHANGED','Unexpected segmented X report.');
    const add=(values:JsonObject,prefix='',depth=0)=>{if(depth>5)throw new MirrorError('REPORT_SHAPE_CHANGED','X metric nesting is too deep.');for(const [k,v]of Object.entries(values)){const key=prefix?prefix+'_'+k:k;
     if(v&&typeof v==='object'&&!Array.isArray(v)){add(v,key,depth+1);continue;}
     if(!Array.isArray(v)||v.length!==(stop-t)/3600000)throw new MirrorError('REPORT_BUCKET_MISMATCH','X returned inconsistent hourly buckets.');
     let sum=0;for(const item of v){if(item===null)continue;const n=metricNumber(item);if(n===null)throw new MirrorError('REPORT_SHAPE_CHANGED','X returned a nonnumeric analytics value.');sum+=n;}old.native_metrics[key]=(old.native_metrics[key]??0)+sum;
    }};add(segment.metrics??{});
   }rows.set(r.id,old);
  }
  if(seen.size!==expected.size){complete=false;warnings.add('X omitted requested campaign IDs; the returned subset is retained.');}
 }
 if(inventory.length&&!successful)throw new MirrorError('PROVIDER_REPORT_FAILED','X rejected every requested analytics placement.');
 const n=(v:unknown,divisor=1)=>{const value=metricNumber(v);return value===null?null:value/divisor;};
 return {rows:[...rows.values()].map(r=>({...r,metrics:{spend:n(r.native_metrics.billed_charge_local_micro,1e6),impressions:n(r.native_metrics.impressions),clicks:n(r.native_metrics.clicks),engagements:n(r.native_metrics.engagements),video_views:n(r.native_metrics.video_total_views)}})),complete,warnings:[...warnings,'X null hourly values mean no reported activity and count as zero; absent metric columns remain unavailable.']};
}
