import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Kind='account'|'campaign'|'adset';
type Send=(p:CompiledRequest)=>Promise<TransportResult>;
const kinds:Record<string,Kind>={meta_ad_account_id_insights_report_create:'account',meta_campaign_id_insights_report_create:'campaign',meta_ad_set_id_insights_report_create:'adset'};
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v);
const account=(p:CompiledRequest)=>String(p.accountId??'').replace(/^act_/,'');
function fail(message:string,code='META_REPORT_INVALID'):never{throw new MirrorError(code,message,{},code==='META_REPORT_STATE_UNVERIFIED'?502:400);}
function stateFail(message:string):never{return fail(message,'META_REPORT_STATE_UNVERIFIED');}
const only=(o:JsonObject,fields:string[])=>{if(Object.keys(o).some(k=>!fields.includes(k)))fail('Unsupported report input. Inspect the exact asynchronous report contract.');};
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const metrics=['impressions','clicks','spend','reach','frequency','cpc','cpm','ctr','actions','action_values','cost_per_action_type','conversions','conversion_values','cost_per_conversion','purchase_roas','website_purchase_roas','outbound_clicks','unique_outbound_clicks','inline_link_clicks','inline_link_click_ctr'];
const actionMetrics=new Set(['actions','action_values','cost_per_action_type','conversions','conversion_values','cost_per_conversion','purchase_roas','website_purchase_roas','outbound_clicks','unique_outbound_clicks']);
const identities=['account_id','account_name','account_currency','date_start','date_stop','campaign_id','campaign_name','adset_id','adset_name','ad_id','ad_name'];
const definitionFields=['fields','level','time_range','time_increment','action_report_time','use_account_attribution_setting','use_unified_attribution_setting'];
export const metaReportFieldContract={metrics,identities,definition:definitionFields};
const statusFields=['id','account_id','async_status','async_percent_completion','date_start','date_stop','error_code','error_message',...definitionFields];
const pending=['Job Not Started','Job Started','Job Running'];
const terminal=['Job Failed','Job Skipped'];
const key=(c:Connection,a:string,job:string)=>c.id+'/'+a+'/'+job;
function document(store:Store,tenant:string,kind:string,name:string){try{return store.document(tenant,kind,name);}catch{return undefined;}}
export function metaReportKind(p:CompiledRequest):Kind|undefined{
 const kind=kinds[p.action];if(!kind||p.gateway!=='meta_native_action'||p.method!=='POST'||p.specialTransport||p.origin&&p.origin!=='https://graph.facebook.com')return;
 return (kind==='account'?/^\/v25\.0\/act_[1-9][0-9]*\/insights$/:/^\/v25\.0\/[1-9][0-9]*\/insights$/).test(p.path)?kind:undefined;
}
/** Graph field selectors normally use CSV. Async Insights instead takes a
 * native list parameter; normalize before review freezes and hashes the body. */
export function metaReportPlan(p:CompiledRequest):CompiledRequest{
 if(metaReportKind(p)&&object(p.body)&&typeof p.body.fields==='string')return {...p,body:{...p.body,fields:p.body.fields.split(',')}};
 return p;
}
export function assertMetaReportScope(c:Connection){if(!c.scopes.some(s=>s==='ads_read'||s==='ads_management'))fail('Asynchronous Meta reports require ads_read or ads_management on the selected connection.','INSUFFICIENT_SCOPE');}
export function assertMetaReport(p:CompiledRequest){
 const kind=metaReportKind(p);if(!kind)return;const b=p.body;if(!id(account(p))||!object(b)||Object.keys(p.query).length||Object.keys(p.headers).length)fail('Use one selected account and a native JSON body, without query/header overrides.');only(b,definitionFields);
 const levels=kind==='account'?['account','campaign','adset','ad']:kind==='campaign'?['campaign','adset','ad']:['adset','ad'];if(!levels.includes(b.level))fail('Select a report grain within the requested account/campaign/ad set.');
 if(!Array.isArray(b.fields)||!b.fields.length||b.fields.length>40||new Set(b.fields).size!==b.fields.length||b.fields.some((f:unknown)=>typeof f!=='string'||![...metrics,...identities].includes(f)))fail('Choose distinct supported native metric and identity fields.');
 const required=['account_id','date_start','date_stop',...(b.level!=='account'?['campaign_id']:[]),...(['adset','ad'].includes(b.level)?['adset_id']:[]),...(b.level==='ad'?['ad_id']:[])];if(required.some(f=>!b.fields.includes(f)))fail('Include account/date fields and every parent/entity ID for the selected grain.');
 const descendants=b.level==='account'?['campaign','adset','ad']:b.level==='campaign'?['adset','ad']:b.level==='adset'?['ad']:[];if(b.fields.some((f:string)=>descendants.some(k=>f===k+'_id'||f===k+'_name')))fail('Do not request descendant identities below the selected report grain.');
 if(!object(b.time_range)||Object.keys(b.time_range).length!==2||!date(b.time_range.since)||!date(b.time_range.until)||b.time_range.since>b.time_range.until||(Date.parse(b.time_range.until)-Date.parse(b.time_range.since))/86400000>=366)fail('Supply explicit inclusive since/until dates spanning at most 366 days.');
 if(b.time_increment!==undefined&&b.time_increment!=='all_days'&&b.time_increment!=='monthly'&&!(typeof b.time_increment==='string'&&/^[1-9][0-9]?$/.test(b.time_increment)&&Number(b.time_increment)<=90))fail('time_increment is the native string all_days, monthly or 1–90.');
 if(b.action_report_time!==undefined&&!['impression','conversion','mixed'].includes(b.action_report_time))fail('Choose a native action_report_time.');
 for(const f of ['use_account_attribution_setting','use_unified_attribution_setting'])if(b[f]!==undefined&&typeof b[f]!=='boolean')fail('Attribution flags must be explicit booleans.');
 if(b.use_account_attribution_setting&&b.use_unified_attribution_setting)fail('Choose one attribution setting source.');
}
function read(p:CompiledRequest,path:string,query:JsonObject):CompiledRequest{return {...p,action:'AMCP_META_REPORT_READ',path,query,body:undefined,method:'GET',headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,scopeContext:undefined};}
function response(r:TransportResult):JsonObject{if(r.status!==200||!object(r.data)||r.data.error!==undefined||r.data.errors!==undefined||r.data.warnings!==undefined||Buffer.byteLength(JSON.stringify(r.data))>4*1024*1024)stateFail('Meta returned failed, partial, oversized or unrecognized report state.');return r.data;}
export function metaReportSnapshots(p:CompiledRequest){const result=[read(p,'/v25.0/act_'+account(p),{fields:'id,account_status,currency,timezone_name'})];if(metaReportKind(p)!=='account')result.push(read(p,p.path.slice(0,-9),{fields:metaReportKind(p)==='adset'?'id,account_id,campaign{id,account_id}':'id,account_id'}));return result;}
export async function readMetaReportState(p:CompiledRequest,send:Send){
 const a=response(await send(read(p,'/v25.0/act_'+account(p),{fields:'id,account_status,currency,timezone_name'})));
 if(String(a.id).replace(/^act_/,'')!==account(p)||!Number.isSafeInteger(a.account_status)||typeof a.currency!=='string'||!/^[A-Z]{3}$/.test(a.currency)||typeof a.timezone_name!=='string'||!a.timezone_name)stateFail('The selected account, currency and timezone were not established.');
 try{new Intl.DateTimeFormat('en',{timeZone:a.timezone_name});}catch{stateFail('The account timezone is not recognized.');}
 const state:JsonObject={account:{id:account(p),account_status:a.account_status,currency:a.currency,timezone_name:a.timezone_name}};
 if(metaReportKind(p)!=='account'){
  const parent=p.path.split('/')[2]!,d=response(await send(read(p,'/v25.0/'+parent,{fields:metaReportKind(p)==='adset'?'id,account_id,campaign{id,account_id}':'id,account_id'})));
  if(d.id!==parent||d.account_id!==account(p))stateFail('The report target is outside the selected account.');state.target={id:d.id,account_id:d.account_id};
  if(metaReportKind(p)==='adset'){if(!object(d.campaign)||!id(d.campaign.id)||d.campaign.account_id!==account(p))stateFail('The ad-set campaign was not verified.');state.target.campaign_id=d.campaign.id;}
 }return [state];
}
export function metaReportOutcome(p:CompiledRequest,r:TransportResult){return r.status===200&&object(r.data)&&Object.keys(r.data).length===1&&id(r.data.report_run_id);}
function retained(store:Store,c:Connection,a:string,job:string){const doc=document(store,c.tenantId,'meta_report_run',key(c,a,job));return doc&&doc.connection_id===c.id&&doc.account_id===a&&doc.expires_at>Date.now()?doc:undefined;}
/** An accepted receipt authorizes only minimal status/definition verification.
 * Data access follows an independent account and definition check, not its ID. */
export function authorizeMetaReportRead(p:CompiledRequest,c:Connection,store:Store,a:string):boolean{
 if(p.gateway!=='meta_native_action')return false;const match=/^\/v25\.0\/([1-9][0-9]*)(\/insights)?$/.exec(p.path);if(!match)return false;const job=match[1]!,saved=retained(store,c,a,job),reviewId=p.scopeContext?.metaReportReviewId;
 if(!saved&&!reviewId)return false;
 if(p.method!=='GET'||!p.readOnly||p.body!==undefined||p.specialTransport||p.origin&&p.origin!=='https://graph.facebook.com')fail('A report binding only authorizes exact status or result reads.','RESOURCE_SCOPE_REQUIRED');assertMetaReportScope(c);
 if(Object.keys(p.headers).length)fail('Report reads do not accept header overrides.');let binding=saved;
 if(reviewId){const review=document(store,c.tenantId,'write_review',reviewId),claim=store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(c.tenantId,reviewId)as JsonObject|undefined;let result:JsonObject|undefined;try{result=claim?.result?JSON.parse(claim.result):undefined;}catch{}
  if(match[2]||!review||review.connection_id!==c.id||account(review.plan)!==a||!metaReportKind(review.plan)||claim?.state!=='complete'||result?.success!==true||result.data?.report_run_id!==job)fail('The original successful report review must authorize this status read.','RESOURCE_SCOPE_REQUIRED');
  binding={review_id:reviewId,connection_id:c.id,account_id:a,job_id:job,definition:review.plan.body,target_kind:metaReportKind(review.plan),target_id:review.plan.path.split('/')[2],currency:review.state[0].account.currency,timezone:review.state[0].account.timezone_name,target_campaign_id:review.state[0].target?.campaign_id};
 }
 if(!binding)fail('Verify this report through its original review first.','RESOURCE_SCOPE_REQUIRED');
 if(match[2]){if(binding.status!=='complete')fail('This report has not completed verified processing.',binding.status==='failed'?'META_REPORT_GENERATION_FAILED':'META_REPORT_PENDING');only(p.query,['limit','after']);if(p.query.limit!==undefined&&(!Number.isSafeInteger(p.query.limit)||p.query.limit<1||p.query.limit>1000))fail('Use a result page limit from 1 to 1000.');if(p.query.after!==undefined&&(typeof p.query.after!=='string'||!p.query.after||p.query.after.length>4096))fail('Use the returned bounded result cursor.');}
 else {only(p.query,['fields']);if(p.query.fields!==undefined&&p.query.fields!==statusFields.join(','))fail('Use the fixed report-status and definition fields.');p.query.fields=statusFields.join(',');}
 p.metaReportRead={...binding,kind:match[2]?'rows':'status'};return true;
}
function decoded(v:unknown){if(typeof v==='string'&&/^[\[{]/.test(v)){try{return JSON.parse(v);}catch{return v;}}return v;}
function sameDefinition(expected:JsonObject,actual:JsonObject){return Object.entries(expected).every(([k,v])=>{const found=decoded(actual[k]);return k==='fields'?Array.isArray(found)&&stable([...v].sort())===stable([...found].sort()):typeof v==='boolean'&&v===false?found===false:stable(v)===stable(found);});}
export function metaReportReadResult(p:CompiledRequest,r:TransportResult):JsonObject|undefined{
 const spec=p.metaReportRead;if(!spec)return;const d=response(r);
 if(spec.kind==='status'){
  if(d.id!==spec.job_id||d.account_id!==spec.account_id||typeof d.async_status!=='string'||![...pending,...terminal,'Job Completed'].includes(d.async_status)||!Number.isSafeInteger(d.async_percent_completion)||d.async_percent_completion<0||d.async_percent_completion>100)stateFail('The report status or account identity is unknown.');
  const complete=d.async_status==='Job Completed';if(complete&&(d.async_percent_completion!==100||d.error_code||!sameDefinition(spec.definition,d)||d.date_start!==spec.definition.time_range.since||d.date_stop!==spec.definition.time_range.until))stateFail('The completed job does not match the reviewed report definition and dates.');
  return Object.fromEntries(statusFields.filter(k=>d[k]!==undefined).map(k=>[k,d[k]]));
 }
 if(!Array.isArray(d.data)||Object.keys(d).some(k=>!['data','paging','summary'].includes(k))||d.summary!==undefined||d.data.length>Number(p.query.limit??1000)||d.paging!==undefined&&(!object(d.paging)||Object.keys(d.paging).some(k=>!['cursors','previous','next'].includes(k))||d.paging.cursors!==undefined&&(!object(d.paging.cursors)||Object.keys(d.paging.cursors).some(k=>!['before','after'].includes(k))||Object.values(d.paging.cursors).some(v=>typeof v!=='string'||!v||v.length>4096))||d.paging.next!==undefined&&(typeof d.paging.next!=='string'||!d.paging.next)))stateFail('The completed report returned an incomplete or unknown row envelope.');
 for(const v of d.data){
  if(!object(v)||['error','errors','warnings'].some(k=>v[k]!==undefined))stateFail('A report row contains a provider error or warning.');
  for(const field of metrics){const value=v[field];if(value===undefined||value===null)continue;
   if(actionMetrics.has(field)){if(!Array.isArray(value)||value.some(item=>!object(item)||typeof item.action_type!=='string'||!item.action_type||!numeric(item.value)||['error','errors','warnings'].some(k=>item[k]!==undefined)))stateFail('An action metric has an unknown native shape.');}
   else if(!numeric(value))stateFail('A metric is not a native numeric string.');
  }
 }
 const rows=d.data.map((v:unknown)=>{if(!object(v)||v.account_id!==spec.account_id||!date(v.date_start)||!date(v.date_stop)||v.date_start>v.date_stop||v.date_start<spec.definition.time_range.since||v.date_stop>spec.definition.time_range.until)stateFail('A report row has the wrong account or date range.');for(const k of ['campaign_id','adset_id','ad_id'])if(spec.definition.fields.includes(k)&&!id(v[k]))stateFail('The report grain identity is incomplete.');if(spec.target_kind==='campaign'&&v.campaign_id!==spec.target_id||spec.target_kind==='adset'&&(v.adset_id!==spec.target_id||v.campaign_id!==spec.target_campaign_id))stateFail('A report row is outside its reviewed campaign/ad set.');if(v.account_currency!==undefined&&v.account_currency!==spec.currency)stateFail('Report currency disagrees with the reviewed account.');return Object.fromEntries(spec.definition.fields.filter((k:string)=>v[k]!==undefined).map((k:string)=>[k,v[k]]));});
 let after:string|undefined;if(d.paging?.next){after=d.paging.cursors?.after;if(typeof after!=='string'||!after||after.length>4096||!rows.length)stateFail('Report pagination is incomplete.');let url:URL;try{url=new URL(d.paging.next);}catch{stateFail('Report pagination URL is malformed.');}if(url.origin!=='https://graph.facebook.com'||url.pathname!==p.path||url.username||url.password||url.hash||url.searchParams.get('after')!==after)stateFail('Report pagination changed scope.');}
 return {data:rows,...(after?{paging:{cursors:{after},next:'https://graph.facebook.com'+p.path+'?after='+encodeURIComponent(after)}}:{})};
}
export function observeMetaReportRead(p:CompiledRequest,c:Connection,store:Store,data:JsonObject){const s=p.metaReportRead;if(!s||s.kind!=='status')return;const status=data.async_status==='Job Completed'?'complete':terminal.includes(data.async_status)?'failed':'pending',old=retained(store,c,s.account_id,s.job_id);if(old&&old.review_id!==s.review_id)stateFail('This provider report ID is already bound to another review.');const {kind,...binding}=s;store.putDocument(c.tenantId,'meta_report_run',key(c,s.account_id,s.job_id),{...binding,status,verified_at:Date.now(),expires_at:Date.now()+7*86400000});}
export async function verifyMetaReport(p:CompiledRequest,result:JsonObject,reviewId:string,send:Send){
 const job=result.data.report_run_id,plan=read(p,'/v25.0/'+job,{fields:statusFields.join(',')});plan.scopeContext={metaReportReviewId:reviewId};const d=metaReportReadResult(plan,await send(plan))!;
 const status=d.async_status==='Job Completed'?'verified':terminal.includes(d.async_status)?'failed':'pending';return {status,checks:[{resource_id:job,status,verification_scope:'provider_report_completion_and_exact_definition',provider_status:d.async_status,percent_complete:d.async_percent_completion,...(status==='failed'?{code:'META_REPORT_GENERATION_FAILED',provider_error_code:d.error_code??null}:{}),report_rows_downloaded:false}],resources:status==='verified'?[{report_run_id:job,account_id:account(p),read_result:{tool:'meta_native_action',arguments:{action:'meta_report_run_insights_get',account_id:account(p),params:{ad_id:job},query:{limit:1000},aggregate_pages:true,dry_run:false}},meaning:'The report job and definition are verified. Result retrieval separately verifies rows and completeness; no sums or zero fills are inferred.'}]:[]};
}
export async function runMetaReportRead(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<unknown>,aggregate:boolean,maxPages=25){
 const s=p.metaReportRead;if(!s||s.kind!=='rows')return {data:await fetch(p),pages:1,truncated:false};if(!Number.isInteger(maxPages)||maxPages<1||maxPages>25)fail('Meta report retrieval supports 1–25 bounded pages per call.');
 const rows:JsonObject[]=[],seen=new Set<string>(),identitiesSeen=new Set<string>();let plan=structuredClone(p),after:string|undefined,bytes=0,pages=0;const started=performance.now();
 do{if(performance.now()-started>60000)stateFail('Report retrieval exceeded its monotonic deadline.');const d=await fetch(plan)as JsonObject;bytes+=Buffer.byteLength(JSON.stringify(d));if(bytes>8*1024*1024||performance.now()-started>60000)stateFail('Report retrieval exceeded its byte/time bound.');pages++;
  for(const row of d.data){const identity=stable(['account_id','campaign_id','adset_id','ad_id','date_start','date_stop'].map(k=>row[k]));if(identitiesSeen.has(identity))stateFail('The report returned a duplicate grain/date row.');identitiesSeen.add(identity);rows.push(row);}if(rows.length>25000)stateFail('Split reports exceeding 25000 rows.');after=d.paging?.cursors?.after;if(after){if(after===plan.query.after||seen.has(after))stateFail('Report pagination repeated a cursor.');seen.add(after);plan={...plan,query:{...plan.query,after}};}
 }while(after&&aggregate&&pages<maxPages);
 return {data:{data:rows,...(after?{paging:{cursors:{after}}}:{}),report:{report_run_id:s.job_id,account_id:s.account_id,currency:s.currency,timezone:s.timezone,definition:s.definition,complete:!after&&!p.query.after,retrieved_from_start:!p.query.after,remaining_pages_complete:!after,rows:rows.length,pages,units:'native provider values; missing metrics remain unavailable; no totals or cross-attribution aggregation',...(after?{next_call:{tool:'meta_native_action',arguments:{action:'meta_report_run_insights_get',account_id:s.account_id,connection_id:s.connection_id,params:{ad_id:s.job_id},query:{limit:p.query.limit??1000,after},aggregate_pages:aggregate,dry_run:false}}}:{})}},pages,truncated:!!after};
}
export const metaReportImpact={provider:'meta',scope:'asynchronous_insights_job',may_affect_serving:false,effect:'Creates a provider reporting job with a frozen native definition. It does not change campaigns, budgets or ads. Quota and provider processing apply.',verification:'Requires matching account, dates and requested definition plus completed processing. Report rows and pagination are checked separately when retrieving results.',recovery:'Preserve the original review/idempotency key. Poll or retrieve the accepted job; never resubmit a lost creation response automatically.'};
