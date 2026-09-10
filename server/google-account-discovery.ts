import {MirrorError} from '../src/errors.js';
import type {CompiledRequest,Connection,Credentials,JsonObject} from '../src/types.js';
import type {NativeTransport} from '../src/transport.js';
import type {AssetGroup} from './asset-discovery.js';

/** Match the account-list discovery used before manager/cancelled-account enrichment. */
export async function googleAccountDiscovery(transport:NativeTransport,connection:Connection,credentials:Credentials):Promise<AssetGroup>{
 const plan:CompiledRequest={gateway:connection.gateway,action:'AMCP_ASSET_DISCOVERY',path:'/v23/customers:listAccessibleCustomers',query:{},method:'GET',headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'INDEPENDENT_ACCOUNT_DISCOVERY',warnings:[]};
 let result;
 try{result=await transport.request(plan,connection,credentials);}catch(e){
  if(e instanceof MirrorError)throw new MirrorError(e.code,e.message,{...e.details,report_request:{stage:'account_list',method:plan.method,path:plan.path}},e.status,e.retryable);
  throw e;
 }
 const names=(result.data as JsonObject).resourceNames;
 if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!/^customers\/\d+$/.test(n)))throw new MirrorError('ASSET_RESPONSE_INVALID','Google did not return a customer list.',{},502);
 return {kind:'ad_accounts',complete:true,assets:names.map((name:string)=>{const id=name.split('/')[1]!;return {id,kind:'ad_accounts',name:'Google Ads '+id,source:'vendor'};})};
}
