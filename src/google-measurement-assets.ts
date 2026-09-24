import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

export interface MeasurementAsset {id:string;kind:'properties'|'sites';name:string;parentId?:string;currency?:string;timezone?:string;status?:string;source:'vendor'}
type Reader=(request:CompiledRequest)=>Promise<unknown>;
export const measurementScopes:Record<string,string[]>={
 ga4_native_action:['https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/analytics.edit'],
 google_search_console_native_action:['https://www.googleapis.com/auth/webmasters.readonly','https://www.googleapis.com/auth/webmasters']
};
function invalid(message:string):never{throw new MirrorError('ASSET_RESPONSE_INVALID',message,{},502);}
function object(value:unknown):JsonObject{if(!value||typeof value!=='object'||Array.isArray(value))invalid('Google returned an invalid discovery object.');const data=value as JsonObject;if(data.error!==undefined)invalid('Google discovery returned an error envelope.');return data;}
function rows(value:unknown,key:string):{data:JsonObject;items:JsonObject[]}{
 const data=object(value);if(data[key]===undefined&&Object.keys(data).some(k=>k!=='nextPageToken'))invalid('Google discovery returned no recognized collection.');
 const items=data[key]??[];if(!Array.isArray(items))invalid('Google returned an invalid discovery collection.');return {data,items:items.map(object)};
}
function name(value:unknown,fallback:string):string{if(value===undefined)return fallback;if(typeof value!=='string'||!value||value.length>1000)invalid('Google returned an invalid discovery name.');return value;}
function bound(count:number){if(count>10000)throw new MirrorError('ASSET_SYNC_LIMIT','Discovery exceeds 10000 assets. Existing metadata was retained; use a narrower provider identity.',{},409);}
function siteId(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>2048||/[\s\x00-\x1f]/.test(value))invalid('Search Console returned an invalid site identifier.');
 if(value.startsWith('sc-domain:')){if(!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(value.slice(10)))invalid('Search Console returned an invalid Domain property.');}
 else {let url:URL;try{url=new URL(value);}catch{invalid('Search Console returned an invalid URL-prefix property.');}if(!['https:','http:'].includes(url!.protocol)||url!.username||url!.password||url!.hash)invalid('Search Console returned an unsafe URL-prefix property.');}
 return value;
}
/** Discovery does not confer AMCP selection, write authority or proof of reportability. */
export async function collectMeasurementAssets(gateway:string,read:Reader,options:{maxPages?:number;includeDetails?:boolean;deadline?:number}={}){
 if(!measurementScopes[gateway])throw new MirrorError('PLATFORM_NOT_FOUND','This discovery contract supports GA4 and Search Console only.');
 const assets:MeasurementAsset[]=[],seen=new Set<string>(),tokens=new Set<string>(),accounts=new Set<string>();let requests=0,excludedUnverified=0;
 const maxPages=options.maxPages??25;if(!Number.isInteger(maxPages)||maxPages<1||maxPages>50)throw new MirrorError('INVALID_ARGUMENT','max_pages must be between 1 and 50.');
 const get=async(origin:string,path:string,query:JsonObject={})=>{if(++requests>250)throw new MirrorError('ASSET_SYNC_LIMIT','This discovery requires more than 250 requests. Retry without property details or with a narrower login.',{},409);if(options.deadline!==undefined&&performance.now()>=options.deadline)throw new MirrorError('ASSET_SYNC_LIMIT','Discovery exceeded its time limit. Existing metadata was retained.',{},409);return read({gateway,action:'AMCP_MEASUREMENT_ASSET_SYNC',origin,path,query,method:'GET',headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'INDEPENDENT_GOOGLE_MEASUREMENT_DISCOVERY',warnings:[],...(options.deadline!==undefined?{measurementSyncDeadline:options.deadline}:{})});};
 if(gateway==='google_search_console_native_action'){
  const {data,items}=rows(await get('https://www.googleapis.com','/webmasters/v3/sites'),'siteEntry');
  if(data.nextPageToken||data.pagination||data.paging)invalid('Search Console returned unexpected discovery pagination.');bound(items.length);
  for(const row of items){const id=siteId(row.siteUrl);if(seen.has(id))invalid('Search Console returned a duplicate site.');seen.add(id);if(!['siteOwner','siteFullUser','siteRestrictedUser','siteUnverifiedUser'].includes(row.permissionLevel))invalid('Search Console returned an unknown permission level.');if(row.permissionLevel==='siteUnverifiedUser'){excludedUnverified++;continue;}assets.push({id,kind:'sites',name:id,status:row.permissionLevel,source:'vendor'});}
 }else{
  let token:string|undefined;
  for(let page=0;page<maxPages;page++){
   const {data,items}=rows(await get('https://analyticsadmin.googleapis.com','/v1beta/accountSummaries',{pageSize:200,...(token?{pageToken:token}:{})}),'accountSummaries');
   for(const account of items){if(typeof account.account!=='string'||!/^accounts\/\d+$/.test(account.account))invalid('GA4 returned an invalid account summary.');accounts.add(account.account);bound(accounts.size);
    if(account.propertySummaries!==undefined&&!Array.isArray(account.propertySummaries))invalid('GA4 returned invalid property summaries.');
    for(const raw of account.propertySummaries??[]){const row=object(raw);if(typeof row.property!=='string'||!/^properties\/\d+$/.test(row.property)||seen.has(row.property))invalid('GA4 returned an invalid or repeated property identifier.');seen.add(row.property);bound(seen.size);assets.push({id:row.property.slice(11),kind:'properties',name:name(row.displayName,row.property),parentId:account.account,source:'vendor'});}
   }
   if(data.nextPageToken===undefined||data.nextPageToken===''){token=undefined;break;}
   if(typeof data.nextPageToken!=='string'||data.nextPageToken.length>4096||tokens.has(data.nextPageToken))invalid('GA4 returned an invalid or repeated page token.');token=data.nextPageToken;tokens.add(token!);
   if(page===maxPages-1)throw new MirrorError('ASSET_SYNC_LIMIT','GA4 discovery reached max_pages before completing. Existing metadata was retained; increase max_pages or narrow the login.',{max_pages:maxPages},409);
  }
  if(options.includeDetails)for(const asset of assets){const data=object(await get('https://analyticsadmin.googleapis.com','/v1beta/properties/'+asset.id));if(data.name!=='properties/'+asset.id||data.account!==undefined&&data.account!==asset.parentId||typeof data.parent==='string'&&data.parent.startsWith('accounts/')&&data.parent!==asset.parentId)invalid('GA4 property details did not confirm the discovered property and account.');if(data.currencyCode!==undefined&&(typeof data.currencyCode!=='string'||! /^[A-Z]{3}$/.test(data.currencyCode)))invalid('GA4 returned invalid currency metadata.');if(typeof data.timeZone!=='string'||!data.timeZone)invalid('GA4 property details omitted the reporting timezone.');try{new Intl.DateTimeFormat('en',{timeZone:data.timeZone});}catch{invalid('GA4 returned an unknown reporting timezone.');}asset.name=name(data.displayName,asset.name);asset.timezone=data.timeZone;if(data.currencyCode!==undefined)asset.currency=data.currencyCode;}
 }
 return {assets,complete:true as const,requests,excluded_unverified:excludedUnverified,details_included:gateway==='ga4_native_action'&&options.includeDetails===true};
}
