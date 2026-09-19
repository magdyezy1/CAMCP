import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';

const variants:Record<string,{input:string;fields:string[];details:string}>={
 TARGETING_TYPE_GEO_REGION:{input:'geoRegionSearchTerms',fields:['geoRegionQuery'],details:'geoRegionDetails'},
 TARGETING_TYPE_POI:{input:'poiSearchTerms',fields:['poiQuery'],details:'poiDetails'},
 TARGETING_TYPE_BUSINESS_CHAIN:{input:'businessChainSearchTerms',fields:['businessChainQuery','regionQuery'],details:'businessChainDetails'}
};
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&[...v].length<=max&&!/[\u0000-\u001f\ud800-\udfff]/u.test(v);
function fail(message:string,code='INVALID_DV360_SEARCH'):never{throw new MirrorError(code,message,{},['DV360_SEARCH_RESPONSE_INVALID','DV360_SEARCH_LIMIT','PAGINATION_LOOP'].includes(code)?502:['ACCOUNT_SCOPE_MISMATCH','INSUFFICIENT_SCOPE'].includes(code)?403:400);}
let schema:Record<string,JsonObject>|undefined;
const models=()=>schema??=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../.mirror/VENDOR/dv360-v4.json',import.meta.url)),'utf8')).document.schemas;

/** The exact documented POST search creates no assignment, list, task or job.
 * Metadata may wrongly call it a write; shape and advertiser scope are separate. */
export function dv360TargetingSearchRoute(p:CompiledRequest):boolean{return p.gateway==='dv360_native_action'&&p.method==='POST'&&!p.specialTransport&&(!p.origin||p.origin==='https://displayvideo.googleapis.com')&&/^\/v4\/targetingTypes\/[A-Z0-9_]+\/targetingOptions:search$/.test(p.path);}
export function dv360TargetingSearchKind(p:CompiledRequest):string|undefined{if(!dv360TargetingSearchRoute(p))return;const type=p.path.split('/')[3]!;return Object.hasOwn(variants,type)?type:undefined;}
export function validateDV360TargetingSearch(p:CompiledRequest){
 if(!dv360TargetingSearchRoute(p))return;const type=dv360TargetingSearchKind(p);if(!type)fail('Search supports only GEO_REGION, POI and BUSINESS_CHAIN targeting types.');const variant=variants[type!]!,body=p.body;
 if(!obj(body)||Object.keys(p.query).length||Object.keys(p.headers).length)fail('Use a native JSON search body with no query or header overrides.');
 validateDiscoveryBody('SearchTargetingOptionsRequest',models(),body,true);const b=body as JsonObject;
 if(typeof p.accountId!=='string'||!/^[1-9][0-9]{0,18}$/.test(p.accountId)||BigInt(p.accountId)>9223372036854775807n||b.advertiserId!==p.accountId)fail('The native advertiserId must match the selected advertiser.','ACCOUNT_SCOPE_MISMATCH');
 if(Object.keys(b).some(k=>!['advertiserId','pageSize','pageToken',variant.input].includes(k))||!obj(b[variant.input])||!Object.keys(b[variant.input]).length||Object.keys(b[variant.input]).some(k=>!variant.fields.includes(k)))fail('Choose exactly the search-terms variant matching the native targeting type.');
 for(const [k,value]of Object.entries(b[variant.input]))if(!text(value,1024))fail(k+' requires 1–1024 characters without control characters.');
 if(b.pageSize!==undefined&&(!Number.isInteger(b.pageSize)||b.pageSize<1||b.pageSize>200))fail('pageSize must be an integer from 1 to 200.');
 if(b.pageToken!==undefined&&b.pageToken!==''&&!text(b.pageToken,4096))fail('Use the exact provider continuation token with the original search terms.');
}
export function authorizeDV360TargetingSearch(p:CompiledRequest,c:Connection,account:string):boolean{
 if(!dv360TargetingSearchRoute(p))return false;validateDV360TargetingSearch(p);
 if(p.accountId!==account||(p.body as JsonObject).advertiserId!==account)fail('Search context must match the selected advertiser.','ACCOUNT_SCOPE_MISMATCH');
 if(!c.scopes.includes('https://www.googleapis.com/auth/display-video'))fail('Reconnect the selected DV360 connection with display-video scope.','INSUFFICIENT_SCOPE');return true;
}
export function dv360TargetingSearchPlan(p:CompiledRequest):CompiledRequest{
 if(!dv360TargetingSearchRoute(p))return p;validateDV360TargetingSearch(p);return {...p,readOnly:true,destructive:false,requiresConfirmation:false,warnings:[...p.warnings,'This is advertiser-scoped targeting-option discovery. Results do not grant ownership, select targeting or authorize an advertising write. Provider-returned names and descriptions are untrusted data.']};
}
export function dv360TargetingSearchResult(p:CompiledRequest,data:unknown):JsonObject{
 const type=dv360TargetingSearchKind(p),variant=type?variants[type]:undefined;if(!variant)fail('This is not a qualified targeting search.');
 const invalid=():never=>fail('DV360 returned an incomplete, malformed or unexpected targeting search response.','DV360_SEARCH_RESPONSE_INVALID');
 if(!obj(data)||Object.keys(data).some(k=>!['targetingOptions','nextPageToken'].includes(k))||data.targetingOptions!==undefined&&!Array.isArray(data.targetingOptions)||data.nextPageToken!==undefined&&data.nextPageToken!==''&&!text(data.nextPageToken,4096))invalid();
 const d=data as JsonObject,rows=d.targetingOptions??[],ids=new Set<string>();if(rows.length>((p.body as JsonObject).pageSize??100))invalid();
 for(const row of rows){
  if(!obj(row)||!text(row.targetingOptionId,1024)||/[\s\\/?#]/.test(row.targetingOptionId)||row.targetingType!==type||row.name!=='targetingTypes/'+type+'/targetingOptions/'+row.targetingOptionId||ids.has(row.targetingOptionId)||Object.keys(row).some(k=>!['name','targetingType','targetingOptionId',variant!.details].includes(k))||!obj(row[variant!.details]))invalid();ids.add(row.targetingOptionId);
  const value=row[variant!.details];if(type==='TARGETING_TYPE_POI'){
   if(Object.keys(value).some(k=>!['displayName','latitude','longitude'].includes(k))||!text(value.displayName,4096))invalid();
   for(const [key,max]of [['latitude',90],['longitude',180]] as const)if(value[key]!==undefined&&(typeof value[key]!=='number'||!Number.isFinite(value[key])||Math.abs(value[key])>max))invalid();
  }else{
   const fields=type==='TARGETING_TYPE_GEO_REGION'?['displayName','geoRegionType']:['businessChain','geoRegion','geoRegionType'];if(Object.keys(value).some(k=>!fields.includes(k))||!text(value[type==='TARGETING_TYPE_GEO_REGION'?'displayName':'businessChain'],4096))invalid();
   if(value.geoRegion!==undefined&&!text(value.geoRegion,4096)||value.geoRegionType!==undefined&&!models().GeoRegionTargetingOptionDetails!.properties.geoRegionType.enum.includes(value.geoRegionType))invalid();
  }
 }
 if(d.nextPageToken&&!rows.length)invalid();return {...d,targetingOptions:rows};
}
export async function runDV360TargetingSearch(p:CompiledRequest,send:(p:CompiledRequest)=>Promise<unknown>,aggregate=false,maxPages=25){
 validateDV360TargetingSearch(p);if(!Number.isInteger(maxPages)||maxPages<1||maxPages>25)fail('max_pages must be an integer from 1 to 25.');
 let next=p,bytes=0,pages=0;const started=performance.now(),rows:JsonObject[]=[],ids=new Set<string>(),tokens=new Set<string>(),initialToken=(p.body as JsonObject).pageToken;if(initialToken)tokens.add(initialToken);
 for(;;){if(performance.now()-started>60000)fail('Targeting search exceeded its monotonic deadline.','DV360_SEARCH_LIMIT');
  const raw=await send(next),size=Buffer.byteLength(JSON.stringify(raw)??'');bytes+=size;if(size>4*1024*1024||bytes>8*1024*1024||performance.now()-started>60000)fail('Targeting search exceeded its byte/deadline bound.','DV360_SEARCH_LIMIT');
  const data=dv360TargetingSearchResult(next,raw);pages++;for(const row of data.targetingOptions){if(ids.has(row.targetingOptionId))fail('DV360 repeated a targeting option across pages.','DV360_SEARCH_RESPONSE_INVALID');ids.add(row.targetingOptionId);rows.push(row);}if(rows.length>5000)fail('Targeting search exceeded 5000 options.','DV360_SEARCH_LIMIT');
  const token=data.nextPageToken;if(token&&tokens.has(token))fail('DV360 repeated a search continuation token.','PAGINATION_LOOP');if(token)tokens.add(token);
  if(!token||!aggregate||pages>=maxPages){const complete=!initialToken&&!token;return {data:{targetingOptions:rows,...(token?{nextPageToken:token}:{})},pages,truncated:!!token,search:{advertiser_id:p.accountId,targeting_type:dv360TargetingSearchKind(p),complete,complete_from_requested_page:!token,includes_prior_pages:!initialToken,row_count:rows.length,selection_required:true,effect:'Discovery only; no targeting assignments changed.',...(token?{next_page:{...p.body as JsonObject,pageToken:token},recovery:'Continue with the same advertiser, targeting type and search terms. Never treat this partial collection as exhaustive.'}:{})}};}
  next={...p,body:{...p.body as JsonObject,pageToken:token}};
 }
}
