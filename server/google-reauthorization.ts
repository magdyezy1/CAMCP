import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import {scopeKey} from '../src/security.js';
import {assetSyncDiagnostic} from '../src/report-errors.js';
import type {Actor,Connection,Credentials,JsonObject} from '../src/types.js';
import {googleAccountDiscovery} from './google-account-discovery.js';
import type {AssetGroup} from './asset-discovery.js';

export const googleAdsScope='https://www.googleapis.com/auth/adwords';
export function googleAuthorizationRevision(store:Store,tenant:string,id:string):string|null{
 try{return store.document(tenant,'website_connection',id).authorizationRevision??null;}
 catch(e){if(e instanceof MirrorError&&e.code==='NOT_FOUND')return null;throw e;}
}
export function googleAuthorizationInfo(store:Store,c:Connection,configuredClientId:string|undefined):JsonObject{
 const saved=store.credentials(c.tenantId,c.id).clientId;
 // OAuth client IDs are public identifiers. No token, secret or raw credential object leaves this helper.
 const clientId=typeof saved==='string'&&/^[A-Za-z0-9.-]{1,250}\.apps\.googleusercontent\.com$/.test(saved)?saved:null;
 return {clientId,matchesCurrentClient:saved&&configuredClientId?saved===configuredClientId:null,adsScopeRecorded:c.scopes.includes(googleAdsScope),reauthorizeAvailable:!!configuredClientId};
}

/** Replace authorization only after fresh, read-only discovery verifies every retained account. */
export async function reauthorizeGoogleConnection(input:{store:Store;actor:Actor;connectionId:string;revision:string|null;credentials:Credentials;scopes:string[];allowWrites:boolean;assertActive:()=>void;fetcher?:typeof fetch}):Promise<Connection>{
 const {store,actor,connectionId,revision,credentials,scopes,assertActive}=input;
 const current=()=>{
  assertActive();
  if(actor.role!=='admin')throw new MirrorError('FORBIDDEN','A workspace administrator is required.',{},403);
  const c=store.listConnections(actor.tenantId).find(c=>c.id===connectionId);
  if(!c||c.gateway!=='google_ads_native_action')throw new MirrorError('CONNECTION_NOT_FOUND','This Google connection was removed. Start again from Connections.',{},404);
  if(googleAuthorizationRevision(store,actor.tenantId,c.id)!==revision)throw new MirrorError('CONNECTION_CHANGED','This connection was already reauthorized. Start again from Connections.',{},409);
  return c;
 };
 const c=current();
 if(!scopes.includes(googleAdsScope))throw new MirrorError('INSUFFICIENT_SCOPE','Google Ads permission was not granted. Reauthorize and approve Google Ads access. Your existing connection was kept.',{},403);
 if(!credentials.refreshToken)throw new MirrorError('REAUTHORIZATION_REQUIRED','Google did not return offline access. Reauthorize and approve consent again. Your existing connection was kept.',{},401);
 const transport=new NativeTransport(input.fetcher);if(!input.fetcher||input.fetcher===fetch)transport.coordination=store;
 let group:AssetGroup;
 try{group=await googleAccountDiscovery(transport,c,credentials);}catch(e){throw new MirrorError('REAUTHORIZATION_ACCESS_FAILED','Fresh Google authorization could not read the account list. Your existing connection was kept.',{diagnostics:[assetSyncDiagnostic(e,'google',c.id,'ad_accounts')]},e instanceof MirrorError?e.status:502,e instanceof MirrorError&&e.retryable);}
 if(!group.complete)throw new MirrorError('REAUTHORIZATION_ACCESS_FAILED','Fresh Google authorization still could not read all account details. Your existing connection was kept.',{diagnostics:group.diagnostics??[]},403);
 const visible=new Map(group.assets.map(a=>[a.id,a]));
 // Use the same lock as token refresh, preventing a refresh started earlier from overwriting these credentials.
 const lock='refresh:'+scopeKey(actor.tenantId,connectionId),owner=randomUUID();
 if(!store.acquireLock(lock,owner,45000))throw new MirrorError('REFRESH_IN_PROGRESS','This connection is refreshing. Start reauthorization again shortly; the existing connection was kept.',{},409,true);
 try{return store.transaction(()=>{
  const latest=current(),missing=latest.accounts.filter(id=>!visible.has(id));
  if(missing.length)throw new MirrorError('REAUTHORIZATION_ACCOUNT_MISMATCH','The selected Google login cannot access every account selected on this connection. Choose the original Google login, or add a separate login. Your existing connection was kept.',{account_ids:missing},403);
  const next:Connection={...latest,scopes,accountLoginCustomers:Object.fromEntries(latest.accounts.map(id=>[id,visible.get(id)!.loginCustomerId!])),writeAccounts:input.allowWrites?latest.writeAccounts:[],defaultWriteAccess:input.allowWrites&&latest.defaultWriteAccess===true};
  let meta:JsonObject={};try{meta=store.document(actor.tenantId,'website_connection',connectionId);}catch(e){if(!(e instanceof MirrorError&&e.code==='NOT_FOUND'))throw e;}
  store.putConnection(actor,next,credentials);
  store.putDocument(actor.tenantId,'website_connection',connectionId,{...meta,platform:'google',expiresAt:credentials.expiresAt??null,createdAt:meta.createdAt??Date.now(),reauthorizedAt:Date.now(),authorizationRevision:randomUUID()});
  store.putDocument(actor.tenantId,'website_assets',connectionId,{groups:[{...group,checkedAt:Date.now()}],selected:next.accounts.map(id=>'ad_accounts:'+id),lastSync:Date.now(),error:null});
  store.appendAudit(actor.tenantId,randomUUID(),{event:'website_oauth_reauthorized',platform:'google',connection_id:connectionId,vendor_writes:0});
  return next;
 });}finally{store.releaseLock(lock,owner);}
}
