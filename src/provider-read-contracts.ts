import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest,Connection} from './types.js';

/** Exact documented reads whose resource names contain mutation-like words.
 * This only establishes HTTP semantics; credentials and object scope are separate. */
export const qualifiedTikTokReadPaths:Record<string,string[]>={
 '/v1.3/catalog/set/get/':['bc_id','catalog_id'],
 '/v1.3/catalog/set/product/get/':['bc_id','catalog_id'],
 '/v1.3/business/publish/status/':['business_id'],
 '/v1.3/business/publish/location/':['business_id'],
 '/v1.3/business/post/authorize/status/':['business_id'],
 '/v1.3/business/mention/hashtag/verify/list/':['business_id'],
 '/v1.3/tool/brand_safety/partner/authorize/status/':['advertiser_id'],
 '/v1.3/ctm/message_event_set/get/':['advertiser_id','messaging_app_type','messaging_app_account_id'],
 '/v1.3/gmv_max/exclusive_authorization/get/':['advertiser_id','store_id','store_authorized_bc_id'],
 '/v1.3/identity/music/authorization/':['advertiser_id','identity_type','identity_id']
};
export function qualifiedProviderRead(p:CompiledRequest):boolean{
 if(!p.readOnly||p.method!=='GET'||p.specialTransport||p.body!==undefined)return false;
 if(p.gateway==='meta_native_action')return (!p.origin||p.origin==='https://graph.facebook.com')&&/^\/v25\.0\/act_\d+\/value_rule_set$/.test(p.path);
 if(p.gateway==='tiktok_native_action')return (!p.origin||p.origin==='https://business-api.tiktok.com')&&Object.hasOwn(qualifiedTikTokReadPaths,p.path);
 if(p.gateway==='linkedin_native_action')return (!p.origin||p.origin==='https://api.linkedin.com')&&/^\/rest\/organizationalEntityCreateShareAuthorizations\/[^/]+$/.test(p.path);
 return false;
}
const denied=(message:string):never=>{throw new MirrorError('RESOURCE_SCOPE_REQUIRED',message,{},403);};
export function authorizeQualifiedProviderRead(p:CompiledRequest,c:Connection,account:string):boolean{
 if(!qualifiedProviderRead(p))return false;
 if(p.gateway==='meta_native_action')return false; // The fixed act_ID path binds this read.
 if(p.gateway==='tiktok_native_action'){
  const fields=qualifiedTikTokReadPaths[p.path]!;
  if(fields.some(k=>typeof p.query[k]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(p.query[k])))denied('Select the exact native business/catalog identifiers for this read.');
  if(fields[0]==='advertiser_id'){
   if(p.query.advertiser_id!==account)denied('The advertiser must match the selected account.');if(fields.length===1)return true;
  }
  const bound=c.resourceBindings?.some(b=>b.accountId===account&&b.pathPrefix===p.path.slice(0,-1)&&fields.every(k=>b.query?.[k]===p.query[k])&&Object.entries(b.query??{}).every(([k,v])=>stable(v)===stable(p.query[k])));
  if(!bound)denied('An administrator must bind this exact read path and its native business/catalog/store/identity/message-account identifiers to the selected account and connection. Advertiser access alone does not grant access to these additional resources.');return true;
 }
 const path=decodeURIComponent(p.path),key=path.split('/').at(-1)!,parts=key.split('&').map(s=>s.split('='));
 if(parts.length!==3||parts.some(p=>p.length!==2)||new Set(parts.map(p=>p[0])).size!==3)denied('Use the documented owner, loggedInMember and agent composite key.');
 const values=Object.fromEntries(parts);
 if(!/^urn:li:(?:company|organization):\d+$/.test(values.owner??'')||!/^urn:li:person:[A-Za-z0-9_-]+$/.test(values.loggedInMember??'')||values.agent!=='urn:li:sponsoredAccount:'+account)denied('The exact company/member permission check must identify the selected sponsored account.');
 if(!c.scopes.includes('rw_ads'))throw new MirrorError('INSUFFICIENT_SCOPE','LinkedIn share-authorization diagnostics require rw_ads; reading this status does not grant publishing permission.',{},403);
 if(!c.resourceBindings?.some(b=>b.accountId===account&&b.pathPrefix===path&&Object.keys(b.query??{}).length===0))denied('An administrator must bind this exact company/member/account permission-check tuple before it can be queried.');
 return true;
}
