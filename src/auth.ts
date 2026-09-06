import {Store} from './store.js';
import type {Connection,Credentials,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {scopeKey} from './security.js';
const refreshEndpoints:Record<string,string>={google_ads_native_action:'https://oauth2.googleapis.com/token',dv360_native_action:'https://oauth2.googleapis.com/token',ga4_native_action:'https://oauth2.googleapis.com/token',gtm_native_action:'https://oauth2.googleapis.com/token',google_business_native_action:'https://oauth2.googleapis.com/token',google_search_console_native_action:'https://oauth2.googleapis.com/token',snapchat_native_action:'https://accounts.snapchat.com/login/oauth2/access_token',linkedin_native_action:'https://www.linkedin.com/oauth/v2/accessToken',amazon_native_action:'https://api.amazon.com/auth/o2/token'};
export class CredentialProvider {
 private refreshes=new Map<string,Promise<Credentials>>();
 constructor(private store:Store,private fetcher:typeof fetch=fetch){}
 async get(connection:Connection):Promise<Credentials>{
  const c=this.store.credentials(connection.tenantId,connection.id);if(!c.expiresAt||c.expiresAt>Date.now()+120000)return c;
  const key=scopeKey(connection.tenantId,connection.id);const current=this.refreshes.get(key);if(current)return current;
  const work=this.refresh(connection,c);this.refreshes.set(key,work);try{return await work;}finally{this.refreshes.delete(key);}
 }
 private async refresh(connection:Connection,c:Credentials):Promise<Credentials>{
  const endpoint=connection.gateway==='reddit_native_action'?'https://www.reddit.com/api/v1/access_token':refreshEndpoints[connection.gateway];if(!endpoint||!c.refreshToken||!c.clientId||!c.clientSecret)throw new MirrorError('REAUTHORIZATION_REQUIRED','Credentials expired and this connection needs reauthorization.',{connection_id:connection.id},401);
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:c.refreshToken,client_id:c.clientId,client_secret:c.clientSecret});
  if(connection.gateway==='snapchat_native_action'){
   if(!c.redirectUri)throw new MirrorError('REAUTHORIZATION_REQUIRED','Reconnect Snapchat to record the registered callback required for refresh.',{connection_id:connection.id},401);
   body.set('redirect_uri',c.redirectUri);
  }
  const headers:Record<string,string>={};
  if(connection.gateway==='reddit_native_action'){
   if(!connection.userAgent||/[\r\n]/.test(connection.userAgent))throw new MirrorError('USER_AGENT_REQUIRED','Configure a descriptive Reddit application userAgent on the connection.');
   headers['User-Agent']=connection.userAgent;headers.Authorization='Basic '+Buffer.from(c.clientId+':'+c.clientSecret).toString('base64');body.delete('client_id');body.delete('client_secret');
  }
  let response:Response;
  try{response=await this.fetcher(endpoint,{method:'POST',body,headers,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new MirrorError('TOKEN_REFRESH_FAILED','Token refresh failed; platform requests were not attempted.',{connection_id:connection.id},503,true);}
  let data:JsonObject;try{data=await response.json() as JsonObject;if(!data||typeof data!=='object'||Array.isArray(data))throw Error();}catch{throw new MirrorError('TOKEN_REFRESH_FAILED','Token service returned an invalid JSON response.',{connection_id:connection.id,status:response.status},502);}
  if(!response.ok||typeof data.access_token!=='string'){
   this.store.appendAudit(connection.tenantId,'auth/'+connection.id,{event:'token_refresh_failed',connection_id:connection.id,status:response.status});
   throw new MirrorError('TOKEN_REFRESH_FAILED','Token refresh was rejected. Reauthorize the connection.',{connection_id:connection.id,status:response.status},401);
  }
  const lifetime=Number(data.expires_in??3600);
  if(!Number.isFinite(lifetime)||lifetime<=0||data.refresh_token!==undefined&&typeof data.refresh_token!=='string')throw new MirrorError('TOKEN_REFRESH_FAILED','Token service returned invalid expiry or refresh metadata.',{},502);
  const next={...c,accessToken:data.access_token,refreshToken:data.refresh_token??c.refreshToken,expiresAt:Date.now()+lifetime*1000};
  this.store.replaceCredentials(connection.tenantId,connection.id,next);return next;
 }
}
