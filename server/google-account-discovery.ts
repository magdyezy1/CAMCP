import {MirrorError} from '../src/errors.js';
import type {CompiledRequest,Connection,Credentials,JsonObject} from '../src/types.js';
import type {NativeTransport} from '../src/transport.js';
import type {AssetGroup,WorkspaceAsset} from './asset-discovery.js';

/** Discover every status beneath each directly accessible root, without granting account access. */
export async function googleAccountDiscovery(transport:NativeTransport,connection:Connection,credentials:Credentials):Promise<AssetGroup>{
 const plan=(path:string,body?:JsonObject):CompiledRequest=>({gateway:connection.gateway,action:'AMCP_GOOGLE_DISCOVERY',path,query:{},method:body?'POST':'GET',body,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'INDEPENDENT_ACCOUNT_DISCOVERY',warnings:[]});
 const result=await transport.request(plan('/v23/customers:listAccessibleCustomers'),connection,{...credentials,loginCustomerId:undefined});
 const names=(result.data as JsonObject).resourceNames;
 if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!/^customers\/\d+$/.test(n)))throw new MirrorError('ASSET_RESPONSE_INVALID','Google did not return a customer list.',{},502);
 const roots=[...new Set<string>(names.map(n=>n.split('/')[1]))].sort();
 if(roots.length>100)throw new MirrorError('ASSET_SYNC_LIMIT','This login has more than 100 directly accessible Google accounts. Narrow the login.',{},409);
 const assets=new Map<string,WorkspaceAsset>(roots.map(id=>[id,{id,kind:'ad_accounts',name:'Google Ads '+id,loginCustomerId:id,source:'vendor'}]));
 const failures:string[]=[];
 const search=async(root:string,query:string)=>{
  const rows:JsonObject[]=[],seen=new Set<string>();let token:string|undefined;
  for(let page=0;page<25;page++){
   const response=await transport.request(plan('/v23/customers/'+root+'/googleAds:search',{query,...(token?{pageToken:token}:{})}),connection,{...credentials,loginCustomerId:root});
   const data=response.data as JsonObject,items=data.results??[];
   if(!Array.isArray(items)||items.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw new MirrorError('ASSET_RESPONSE_INVALID','Google returned an invalid account hierarchy.',{},502);
   rows.push(...items);if(rows.length>10000)throw new MirrorError('ASSET_SYNC_LIMIT','Google account discovery exceeded 10,000 accounts.',{},409);
   if(!data.nextPageToken)return rows;
   if(typeof data.nextPageToken!=='string'||seen.has(data.nextPageToken))throw new MirrorError('PAGINATION_LOOP','Google repeated an account page token.',{},502);
   token=data.nextPageToken;seen.add(token);
  }
  throw new MirrorError('ASSET_SYNC_LIMIT','Google account discovery reached its page limit.',{},409);
 };
 const account=(row:JsonObject,root:string,client=false):WorkspaceAsset=>{
  const id=String(row?.id??'');if(!/^\d+$/.test(id)||typeof row?.id==='number'&&!Number.isSafeInteger(row.id)||client&&row.clientCustomer!==undefined&&row.clientCustomer!=='customers/'+id)throw new MirrorError('ASSET_ID_INVALID','Google returned an invalid customer identifier.',{},502);
  return {id,kind:'ad_accounts',name:row.descriptiveName||'Google Ads '+id,currency:row.currencyCode,timezone:row.timeZone,status:row.status,manager:row.manager===true,hidden:row.hidden===true,testAccount:row.testAccount===true,loginCustomerId:root,...(id!==root?{parentId:root}:{}),source:'vendor'};
 };
 for(const root of roots)try{
  const self=(await search(root,'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager, customer.test_account FROM customer'))[0]?.customer;
  if(!self||String(self.id)!==root)throw new MirrorError('ASSET_RESPONSE_INVALID','Google did not return the requested account details.',{},502);
  assets.set(root,account(self,root));
  if(!self.manager)continue;
  // customer_client includes all descendant levels. No status or hidden filter excludes historical accounts.
  const rows=await search(root,'SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status, customer_client.manager, customer_client.hidden, customer_client.test_account, customer_client.level FROM customer_client');
  for(const row of rows){const asset=account(row.customerClient,root,true);if(!assets.has(asset.id)||assets.get(asset.id)!.status===undefined)assets.set(asset.id,asset);}
  if(assets.size>10000)throw new MirrorError('ASSET_SYNC_LIMIT','Google account discovery exceeded 10,000 accounts.',{},409);
 }catch(e){failures.push(root+': '+(e instanceof MirrorError?e.message:'Account discovery failed.'));}
 return {kind:'ad_accounts',assets:[...assets.values()],complete:failures.length===0,...(failures.length?{error:'Some Google account details could not be synced. '+failures.join(' ')}:{})};
}
