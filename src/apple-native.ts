import type {Action,CompiledRequest,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {appleEntityKind,assertAppleEntityWrite} from './apple-entity-writes.js';

// AMCP extensions derived from Apple's own Platform API SDK, not captured AMCP actions.
// https://github.com/apple/apple-ads-platform-api-node/blob/main/src/api/apple-ads-api.ts
// Native request/response model definitions live in the same repository's src/model directory.
export const appleOrigin='https://api.ads.apple.com';
const gateway='apple_ads_native_action';
const evidence='INDEPENDENT_APPLE_V1_EXTENSION';
const entities=[['campaign','campaigns'],['adgroup','adgroups'],['ad','ads'],['creative','creatives'],['keyword','keywords'],['negative_keyword','negative-keywords'],['shared_budget','shared-budgets']] as const;
function route(name:string,method:string,path:string,kind:string):Action {
 const action='apple_ads_v1_'+name;
 return {gateway,name:action,canonical_name:action,aliases:[],method,path:appleOrigin+'/v1/'+path,read_only:kind!=='write',destructive:method==='DELETE',required:[],path_parameters:path.includes('{id}')?['id']:[],evidence,raw:{name:action,method,path:'/v1/'+path,read_only:kind!=='write',kind,source:'https://github.com/apple/apple-ads-platform-api-node',native_fields:[]}};
}
export const appleActions:Action[]=[
 ...entities.flatMap(([singular,plural])=>[route(plural.replaceAll('-','_')+'_query','POST',plural+'/query','query'),route(singular+'_get','GET',plural+'/{id}','get')]),
 route('ad_account_get','GET','ad-accounts/{id}','get'),
 ...['campaigns','adgroups','ads','keywords','searchterms'].map(entity=>route('reports_apps_'+entity,'POST','reports/apps/'+entity+'/query','report')),
 ...entities.flatMap(([singular,plural])=>[route(singular+'_create','POST',plural,'write'),route(singular+'_update','PUT',plural+'/{id}','write'),route(singular+'_delete','DELETE',plural+'/{id}','write')])
];
const actions=new Map(appleActions.map(action=>[action.name,action]));
const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
function invalid(message:string):never{throw new MirrorError('INVALID_APPLE_REQUEST',message);}
function keys(value:JsonObject,allowed:string[],label:string){for(const key of Object.keys(value))if(!allowed.includes(key))invalid('Unsupported '+label+' field: '+key+'. Use Apple Platform API v1 request fields.');}
function numericId(value:unknown,label:string){if((typeof value!=='number'&&typeof value!=='string')||!/^\d+$/.test(String(value))||typeof value==='number'&&!Number.isSafeInteger(value))invalid(label+' must be a positive decimal identifier; use strings for large IDs.');if(/^0+$/.test(String(value)))invalid(label+' must be positive.');}
const queryOperators=['IS_NOT_NULL','EQUALS','STARTS_WITH','IN','NOT_CONTAINS_ANY','NOT_EQUALS','LESS_THAN_OR_EQUAL_TO','BETWEEN','NOT_IN','LESS_THAN','GREATER_THAN_OR_EQUAL_TO','CONTAINS_ALL','NOT_CONTAINS_ALL','LIKE','IS_NULL','GREATER_THAN','ENDS_WITH','CONTAINS_ANY','NOT_LIKE'];
const reportOperators=['EQUALS','GREATER_THAN','LESS_THAN','IN','LIKE','STARTS_WITH','CONTAINS','ENDS_WITH','CONTAINS_ANY','CONTAINS_ALL','BETWEEN','GREATER_THAN_OR_EQUAL_TO','LESS_THAN_OR_EQUAL_TO','NOT_EQUALS'];
function queryBody(body:JsonObject,report:boolean){
 keys(body,report?['pagination','sorting','filters','fields','groupBy','timeRange','options']:['pagination','sorting','filters'],'query');
 if(body.pagination!==undefined&&!object(body.pagination))invalid('pagination must be an object.');
 const pagination=body.pagination??{};keys(pagination,report?['offset','pageSize']:['offset','pageSize','fetchTotalCount'],'pagination');
 const offset=pagination.offset??0,pageSize=pagination.pageSize??100;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>5000)invalid('pagination requires offset >= 0 and pageSize between 1 and 5000.');
 if(pagination.fetchTotalCount!==undefined&&typeof pagination.fetchTotalCount!=='boolean')invalid('fetchTotalCount must be boolean.');
 body.pagination={...pagination,offset,pageSize,...(!report&&pagination.fetchTotalCount===undefined?{fetchTotalCount:true}:{})};
 for(const name of ['filters','sorting'])if(body[name]!==undefined&&body[name]!==null){
  if(!Array.isArray(body[name])||body[name].length>100)invalid(name+' must be an array with at most 100 entries.');
  for(const item of body[name]){
   if(!object(item)||typeof item.field!=='string'||!item.field.trim()||item.field.length>256)invalid(name+' entries require a field name.');
   keys(item,name==='sorting'?['field','order']:['field','operator','value',...(!report?['ignoreCase']:[])],name);
   if(name==='sorting'&&!['ASC','DESC'].includes(item.order))invalid('sorting.order must be ASC or DESC.');
   if(name==='filters'&&!(report?reportOperators:queryOperators).includes(item.operator))invalid('Unsupported filter operator.');
   if(item.ignoreCase!==undefined&&typeof item.ignoreCase!=='boolean')invalid('ignoreCase must be boolean.');
  }
 }
}
function reportBody(plan:CompiledRequest,body:JsonObject){
 queryBody(body,true);
 const time=body.timeRange;if(!object(time))invalid('Reports require an explicit timeRange with start and end dates.');
 keys(time,['start','end','timeZone','granularity'],'timeRange');
 for(const key of ['start','end'])if(typeof time[key]!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(time[key])||!Number.isFinite(Date.parse(time[key]))||new Date(time[key]).toISOString().slice(0,10)!==time[key])invalid('timeRange.'+key+' must be a real YYYY-MM-DD date.');
 if(time.start>time.end)invalid('timeRange.start cannot follow end.');
 if(time.timeZone!==undefined&&!['UTC','ORTZ'].includes(time.timeZone))invalid('timeZone must be UTC or ORTZ.');
 if(time.granularity!==undefined&&!['HOURLY','DAILY','WEEKLY','MONTHLY'].includes(time.granularity))invalid('Unsupported report granularity.');
 const entity=plan.path.split('/').at(-2),hourly=time.granularity==='HOURLY';
 if(entity==='searchterms'&&time.timeZone==='UTC')invalid('Search term reports require ORTZ.');
 if(hourly&&['searchterms','ads'].includes(entity!))invalid('HOURLY granularity is unavailable for ads and search terms.');
 if(body.fields!==undefined&&(!Array.isArray(body.fields)||body.fields.some((v:unknown)=>typeof v!=='string'||!v)))invalid('fields must be an array of native metric names.');
 if(body.groupBy!==undefined){
  const excluded=hourly||['keywords','searchterms'].includes(entity!)?['ageRange','gender','countryCode','adminArea','locality']:entity==='ads'?['deviceClass']:[];
  if(!Array.isArray(body.groupBy)||body.groupBy.some((v:unknown)=>!['deviceClass','ageRange','gender','countryCode','adminArea','locality','storefront','countryOrRegion'].includes(String(v))||excluded.includes(String(v))))invalid('Unsupported groupBy for this report entity or granularity.');
 }
 if(body.options!==undefined){if(!object(body.options))invalid('options must be an object.');keys(body.options,['includeRows'],'options');if(body.options.includeRows!==undefined&&(!Array.isArray(body.options.includeRows)||body.options.includeRows.some((v:unknown)=>!['GRAND_TOTAL','EMPTY_METRICS'].includes(String(v)))||entity==='searchterms'&&body.options.includeRows.length>0))invalid('Unsupported includeRows option for this report.');}
}
/** Final validation happens after generic alias merging so hidden scope changes cannot slip through. */
export function validateApplePlan(plan:CompiledRequest):CompiledRequest {
 if(plan.gateway!==gateway||!actions.has(plan.action))return plan;
 numericId(plan.accountId,'account_id');
 for(const segment of plan.path.split('/'))if(!/^[a-z-]+$/.test(segment)&&segment&&segment!=='v1')numericId(segment,'resource ID');
 if(plan.path.startsWith('/v1/ad-accounts/')&&plan.path.split('/').at(-1)!==plan.accountId)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','The ad account resource must match account_id.',{},403);
 const query={...plan.query};const body=plan.body===undefined?undefined:structuredClone(plan.body);
 for(const bag of [query,object(body)?body:{}])for(const key of ['account_id','ad_account_id','org_id'])delete bag[key];
 if(Object.keys(query).length)invalid('These Apple v1 routes do not accept URL query parameters. Put native query selectors in payload.');
 const kind=actions.get(plan.action)!.raw.kind;
 if(kind==='query'||kind==='report'){
  if(!object(body))invalid('Query and report payloads must be objects.');
  if(kind==='report')reportBody(plan,body);else queryBody(body,false);
 }else if(kind==='write'&&appleEntityKind(plan)){
  assertAppleEntityWrite({...plan,query,body});
 }else if(kind==='write'&&plan.method!=='DELETE'){
  if(!object(body)||!Object.keys(body).length)invalid('Campaign writes require a nonempty native payload.');
  const create=plan.method==='POST';
  keys(body,['name','startTime','endTime','status','dailyBudget','sharedBudgets','targeting','bidStrategy','invoiceDetail','regulationResponses',...(create?['adAccountId','billingEvent','promotedObjectType','promotedObjectId']:[])],'campaign');
  if(create){for(const key of ['adAccountId','name','billingEvent','promotedObjectType','promotedObjectId','dailyBudget','targeting'])if(body[key]===undefined)invalid('Campaign creation requires '+key+'.');numericId(body.adAccountId,'adAccountId');if(String(body.adAccountId)!==plan.accountId)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','Campaign adAccountId must match account_id.',{},403);}
 }
 return {...plan,query,...(body===undefined?{}:{body}),headers:{...plan.headers,'X-AP-Context':'adAccountId='+plan.accountId+';'},warnings:[...plan.warnings,'Independent Apple Platform API v1 extension; native vendor rules still apply.']};
}
export function validateAppleResponse(plan:CompiledRequest,value:unknown){
 if(plan.gateway!==gateway||!actions.has(plan.action)||!plan.readOnly)return;
 const fail=()=>{throw new MirrorError('UPSTREAM_RESPONSE_INVALID','Apple v1 response does not contain the expected result envelope.',{},502);};
 if(!object(value)||value.result===undefined||value.result===null)fail();
 const data=value as JsonObject,kind=actions.get(plan.action)!.raw.kind;
 if(kind==='query'&&!Array.isArray(data.result)||kind==='report'&&(!object(data.result)||!Array.isArray(data.result.rows))||kind==='get'&&(!object(data.result)||data.result.id===undefined))fail();
 const rows=kind==='query'?data.result:kind==='get'?[data.result]:[];
 for(const row of rows){if(!object(row)||row.id===undefined)fail();if(row.adAccountId!==undefined&&String(row.adAccountId)!==plan.accountId)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','Apple returned a resource for another ad account.',{},502);}
 if(kind==='get'&&String(data.result.id)!==plan.path.split('/').at(-1))fail();
}
