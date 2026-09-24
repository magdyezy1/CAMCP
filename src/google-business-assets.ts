import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest,JsonObject} from './types.js';

export const businessScope='https://www.googleapis.com/auth/business.manage';
export interface BusinessAsset {id:string;resourceName:string;kind:'business_accounts'|'locations';name:string;source:'vendor';parentIds?:string[];type?:string;role?:string;storeCode?:string}
export interface BusinessDiscoveryOptions {includeLocations?:boolean;maxAccounts?:number;maxLocationsPerAccount?:number;readMask?:string;deadline?:number}
function invalid(message:string):never{throw new MirrorError('ASSET_RESPONSE_INVALID',message,{},502);}
function object(v:unknown):JsonObject{if(!v||typeof v!=='object'||Array.isArray(v))invalid('Business Profile returned an invalid discovery object.');const d=v as JsonObject;if(d.error!==undefined)invalid('Business Profile returned an error envelope.');return d;}
function string(v:unknown,description:string):string{if(typeof v!=='string'||!v||v.length>1000)invalid('Business Profile returned an invalid '+description+'.');return v;}
export function businessDiscoveryOptions(input:BusinessDiscoveryOptions={}){
 const includeLocations=input.includeLocations??true,maxAccounts=input.maxAccounts??50,maxLocationsPerAccount=input.maxLocationsPerAccount??100;
 if(typeof includeLocations!=='boolean'||!Number.isInteger(maxAccounts)||maxAccounts<1||maxAccounts>500||!Number.isInteger(maxLocationsPerAccount)||maxLocationsPerAccount<0||maxLocationsPerAccount>500||includeLocations&&maxLocationsPerAccount===0)throw new MirrorError('INVALID_ARGUMENT','Use 1–500 accounts and 1–500 locations per account, or include_locations:false to omit locations.');
 const fields=input.readMask===undefined?['name','title','storeCode']:typeof input.readMask==='string'?input.readMask.split(',').map(x=>x.trim()):[];
 if(!fields.length||new Set(fields).size!==fields.length||fields.some(x=>!['name','title','storeCode'].includes(x)))throw new MirrorError('INVALID_ARGUMENT','The discovery read_mask supports name, title and storeCode. Identity and title are always requested.');
 return {includeLocations,maxAccounts,maxLocationsPerAccount,readMask:[...new Set(['name','title',...fields])].join(','),deadline:input.deadline??performance.now()+60000};
}

/** Provider-visible metadata only. Neither account IDs nor parents create AMCP grants. */
export async function collectBusinessAssets(read:(plan:CompiledRequest)=>Promise<unknown>,input:BusinessDiscoveryOptions={}){
 const options=businessDiscoveryOptions(input),accounts:BusinessAsset[]=[],locations=new Map<string,BusinessAsset>();let requests=0,bytes=0,sharedLocations=0;
 const pages=async(origin:string,path:string,key:string,limit:number,pageSize:number,query:JsonObject={})=>{
  const result:JsonObject[]=[],ids=new Set<string>(),tokens=new Set<string>();let token:string|undefined;
  for(let page=0;page<50;page++){
   if(++requests>250||!Number.isFinite(options.deadline)||performance.now()>=options.deadline)throw new MirrorError('ASSET_SYNC_LIMIT','Business Profile discovery exceeded its request/time bound; prior metadata must be retained.',{},409);
   const raw=await read({gateway:'google_business_native_action',action:'AMCP_BUSINESS_ASSET_SYNC',origin,path,query:{...query,pageSize,...(token?{pageToken:token}:{})},method:'GET',headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'INDEPENDENT_BUSINESS_PROFILE_DISCOVERY',warnings:[],measurementSyncDeadline:options.deadline});
   bytes+=Buffer.byteLength(JSON.stringify(raw)??'');if(bytes>8*1024*1024||performance.now()>=options.deadline)throw new MirrorError('ASSET_SYNC_LIMIT','Business Profile discovery exceeded its byte/time bound.',{},409);
   const data=object(raw);if(data[key]===undefined&&Object.keys(data).some(k=>!['nextPageToken','totalSize'].includes(k)))invalid('Business Profile returned no recognized discovery collection.');
   if(data.paging!==undefined||data.pagination!==undefined||data.next_page_token!==undefined)invalid('Business Profile returned unsupported pagination.');
   const rows=data[key]===undefined?[]:data[key];if(!Array.isArray(rows))invalid('Business Profile returned an invalid '+key+' collection.');
   for(const value of rows){const row=object(value),id=string(row.name,'resource name');if(ids.has(id))invalid('Business Profile repeated a resource within one account collection.');ids.add(id);result.push(row);if(result.length>limit)throw new MirrorError('ASSET_SYNC_LIMIT','Business Profile discovery exceeded the requested '+key+' limit. Increase the bound; no partial collection was saved.',{limit},409);}
   if(data.nextPageToken===undefined||data.nextPageToken==='')return result;
   if(typeof data.nextPageToken!=='string'||data.nextPageToken.length>4096||tokens.has(data.nextPageToken))invalid('Business Profile returned an invalid or repeated page token.');token=data.nextPageToken;tokens.add(token!);
  }
  throw new MirrorError('ASSET_SYNC_LIMIT','Business Profile discovery exceeded its page bound.',{},409);
 };
 for(const row of await pages('https://mybusinessaccountmanagement.googleapis.com','/v1/accounts','accounts',options.maxAccounts,20)){
  if(!/^accounts\/[1-9][0-9]{0,39}$/.test(row.name))invalid('Business Profile returned an invalid account name.');
  if(row.type!==undefined&&!['PERSONAL','LOCATION_GROUP','USER_GROUP','ORGANIZATION'].includes(row.type))invalid('Business Profile returned an unknown account type.');
  accounts.push({id:row.name.slice(9),resourceName:row.name,kind:'business_accounts',name:row.accountName===undefined?row.name:string(row.accountName,'account display name'),source:'vendor',...(row.type===undefined?{}:{type:row.type}),...(row.role===undefined?{}:{role:string(row.role,'account role')})});
 }
 if(options.includeLocations)for(const account of accounts){
  for(const row of await pages('https://mybusinessbusinessinformation.googleapis.com','/v1/'+account.resourceName+'/locations','locations',options.maxLocationsPerAccount,100,{readMask:options.readMask})){
   if(!/^locations\/[1-9][0-9]{0,39}$/.test(row.name))invalid('Business Profile returned an invalid location name.');
   const location:BusinessAsset={id:row.name,resourceName:row.name,kind:'locations',name:string(row.title,'location title'),source:'vendor',...(row.storeCode===undefined||row.storeCode===''?{}:{storeCode:string(row.storeCode,'store code')})},previous=locations.get(row.name);
   if(previous){const {parentIds,...same}=previous;if(stable(same)!==stable(location))invalid('The same location changed between parent-account reads. Retry complete discovery.');previous.parentIds!.push(account.id);sharedLocations++;}
   else locations.set(row.name,{...location,parentIds:[account.id]});
   if(accounts.length+locations.size>10000)throw new MirrorError('ASSET_SYNC_LIMIT','Business Profile discovery exceeds 10000 assets.',{},409);
  }
 }
 return {accounts,locations:[...locations.values()],complete:true as const,locations_included:options.includeLocations,requests,source_bytes:bytes,shared_location_memberships:sharedLocations,effective_read_mask:options.readMask,meaning:'Complete requested native collections only; visibility does not establish AMCP grants, write authority or listing verification.'};
}
