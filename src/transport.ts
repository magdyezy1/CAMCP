import {createHmac,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,Credentials,JsonObject} from './types.js';
import {redact,scopeKey} from './security.js';
export const vendorOrigins:Record<string,string>={
 meta_native_action:'https://graph.facebook.com',tiktok_native_action:'https://business-api.tiktok.com',snapchat_native_action:'https://adsapi.snapchat.com',google_ads_native_action:'https://googleads.googleapis.com',linkedin_native_action:'https://api.linkedin.com',x_ads_native_action:'https://ads-api.x.com',dv360_native_action:'https://displayvideo.googleapis.com',amazon_native_action:'https://advertising-api.amazon.com',apple_ads_native_action:'https://api.searchads.apple.com',reddit_native_action:'https://ads-api.reddit.com',criteo_native_action:'https://api.criteo.com',ga4_native_action:'https://analyticsdata.googleapis.com',gtm_native_action:'https://tagmanager.googleapis.com',google_business_native_action:'https://mybusinessbusinessinformation.googleapis.com',google_search_console_native_action:'https://searchconsole.googleapis.com',adjust_native_action:'https://automate.adjust.com'
};
const additionalOrigins:Record<string,string[]>={amazon_native_action:['https://advertising-api-eu.amazon.com','https://advertising-api-fe.amazon.com'],apple_ads_native_action:['https://api.ads.apple.com'],ga4_native_action:['https://analyticsadmin.googleapis.com'],google_business_native_action:['https://mybusinessaccountmanagement.googleapis.com','https://mybusiness.googleapis.com','https://businessprofileperformance.googleapis.com','https://mybusinessverifications.googleapis.com','https://mybusinessnotifications.googleapis.com','https://mybusinesslodging.googleapis.com'],x_ads_native_action:['https://upload.twitter.com','https://api.x.com','https://upload.x.com'],google_search_console_native_action:['https://www.googleapis.com'],adjust_native_action:['https://api.adjust.com','https://dash.adjust.com']};
export function buildUrl(request:CompiledRequest,connection:Connection):URL{
 if(/[?#\r\n\\]/.test(request.path)||!request.path.startsWith('/')||request.path.startsWith('//'))throw new MirrorError('INVALID_PATH','Request paths cannot contain a query, fragment or authority. Supply query parameters separately.');
 const base=request.origin??connection.baseUrl??vendorOrigins[request.gateway];
 if(!base)throw new MirrorError('CONNECTOR_CONFIGURATION_REQUIRED','Configure an approved upstream origin for this gateway.');
 const origin=new URL(base);
 const allowed=[vendorOrigins[request.gateway],...(additionalOrigins[request.gateway]??[]),...(request.gateway==='google_business_native_action'?['https://mybusinessplaceactions.googleapis.com']:[])];
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!allowed.includes(origin.origin))throw new MirrorError('UNAPPROVED_UPSTREAM','Upstream origin is not allowed for this gateway.',{},403);
 let path=request.path;if(request.gateway==='tiktok_native_action'&&!path.startsWith('/open_api/'))path='/open_api'+path;
 const url=new URL(path,origin);if(url.origin!==origin.origin)throw new MirrorError('UNAPPROVED_UPSTREAM','Request escaped the platform origin.',{},403);
 for(const [key,value]of Object.entries(request.query)){if(value===undefined||value===null)continue;if(Array.isArray(value)&&request.queryArrayEncoding==='repeat'){for(const item of value)url.searchParams.append(key,String(item));}else url.searchParams.set(key,typeof value==='object'?JSON.stringify(value):String(value));}
 return url;
}
const pct=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function oauth1(method:string,url:URL,credentials:Credentials,bodyParams?:URLSearchParams,nonce:string=randomUUID(),timestamp:string=Math.floor(Date.now()/1000).toString()):string{
 if(!credentials.consumerKey||!credentials.consumerSecret||!credentials.accessToken||!credentials.tokenSecret)throw new MirrorError('OAUTH1_CREDENTIALS_REQUIRED','X Ads requires consumer and user OAuth 1.0a credentials.');
 const oauth:Record<string,string>={oauth_consumer_key:credentials.consumerKey,oauth_token:credentials.accessToken,oauth_nonce:nonce,oauth_timestamp:timestamp,oauth_signature_method:'HMAC-SHA1',oauth_version:'1.0'};
 const entries=[...url.searchParams.entries(),...(bodyParams?.entries()??[]),...Object.entries(oauth)].map(([k,v])=>[pct(k),pct(v)] as [string,string]).sort(([a,b],[c,d])=>a<c?-1:a>c?1:b<d?-1:b>d?1:0);
 const params=entries.map(([k,v])=>k+'='+v).join('&');const baseUrl=url.origin+url.pathname;
 const signature=createHmac('sha1',pct(credentials.consumerSecret)+'&'+pct(credentials.tokenSecret)).update(method.toUpperCase()+'&'+pct(baseUrl)+'&'+pct(params)).digest('base64');
 return 'OAuth '+Object.entries({...oauth,oauth_signature:signature}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>pct(k)+'="'+pct(v)+'"').join(', ');
}
function camelKeys(value:unknown):unknown{
 if(Array.isArray(value))return value.map(camelKeys);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),/^(?:update_mask|updateMask|read_mask|readMask)$/.test(k)&&typeof v==='string'?v.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()):camelKeys(v)]));
 return value;
}
export interface TransportResult {data:unknown;status:number;headers:Record<string,string>}
export class NativeTransport {
 private circuits=new Map<string,{failures:number;until:number}>();private budgets=new Map<string,{tokens:number;at:number}>();
 readonly metrics={requests:0,retries:0,errors:0,totalLatencyMs:0};
 constructor(private fetcher:typeof fetch=fetch,private sleeper:(ms:number)=>Promise<unknown>=delay,private timeoutMs=30000,private maximumBytes=8*1024*1024){}
 async request(plan:CompiledRequest,connection:Connection,credentials:Credentials):Promise<TransportResult>{
  const key=scopeKey(connection.tenantId,connection.gateway);
  const circuit=this.circuits.get(key);if(circuit&&circuit.until>Date.now())throw new MirrorError('CIRCUIT_OPEN','Platform circuit is temporarily open.',{retry_after_ms:circuit.until-Date.now()},503,true);
  const budget=this.budgets.get(key)??{tokens:30,at:Date.now()};budget.tokens=Math.min(30,budget.tokens+(Date.now()-budget.at)/1000);budget.at=Date.now();
  if(budget.tokens<1)throw new MirrorError('TENANT_RATE_LIMIT','Per-tenant platform request budget exhausted.',{retry_after_ms:1000},429,true);budget.tokens--;this.budgets.set(key,budget);
  const url=buildUrl(plan,connection);const headers:Record<string,string>={Accept:'application/json',...plan.headers};
  if(plan.gateway==='reddit_native_action'){
   if(!connection.userAgent||/[\r\n]/.test(connection.userAgent))throw new MirrorError('USER_AGENT_REQUIRED','Configure a descriptive Reddit application userAgent on the connection.');headers['User-Agent']=connection.userAgent;
  }
  let body:BodyInit|undefined;let form:URLSearchParams|undefined;
  if(plan.body!==undefined){
   if(plan.gateway==='meta_native_action'||plan.gateway==='x_ads_native_action'&&!plan.path.includes('/batch/')){form=new URLSearchParams();for(const [k,v]of Object.entries(plan.body as JsonObject))form.set(k,typeof v==='object'?JSON.stringify(v):String(v));body=form.toString();headers['Content-Type']='application/x-www-form-urlencoded';}
   else {body=JSON.stringify(plan.gateway==='google_ads_native_action'?camelKeys(plan.body):plan.body);headers['Content-Type']=plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'?'application/json-patch+json':'application/json';}
  }
  if(credentials.accessToken){if(plan.gateway==='tiktok_native_action')headers['Access-Token']=credentials.accessToken;else headers.Authorization='Bearer '+credentials.accessToken;}
  if(plan.gateway==='google_ads_native_action'){
   if(!credentials.developerToken)throw new MirrorError('DEVELOPER_TOKEN_REQUIRED','Google Ads requires its own developer token.');headers['developer-token']=credentials.developerToken;
   if(credentials.loginCustomerId)headers['login-customer-id']=credentials.loginCustomerId.replaceAll('-','');
  }
  if(plan.gateway==='amazon_native_action'){if(!credentials.clientId)throw new MirrorError('CLIENT_ID_REQUIRED','Amazon Ads requires a client ID.');headers['Amazon-Advertising-API-ClientId']=credentials.clientId;if(plan.accountId)headers['Amazon-Advertising-API-Scope']=plan.accountId;}
  if(plan.gateway==='apple_ads_native_action'&&plan.accountId)headers['X-AP-Context']=(url.origin==='https://api.ads.apple.com'&&plan.path.startsWith('/v1/')?'adAccountId='+plan.accountId+';':'orgId='+plan.accountId);
  if(plan.gateway==='x_ads_native_action')headers.Authorization=oauth1(plan.method,url,credentials,form);
  if(credentials.apiKey&&!headers.Authorization)headers.Authorization='Bearer '+credentials.apiKey;
  if(!headers.Authorization&&!headers['Access-Token'])throw new MirrorError('CREDENTIALS_REQUIRED','An authenticated platform connection is required.',{},401);
  const start=Date.now();const maxAttempts=plan.readOnly?3:1;
  for(let attempt=0;attempt<maxAttempts;attempt++){
   this.metrics.requests++;
   try{
    const response=await this.fetcher(url,{method:plan.method,headers,body,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
    if([429,502,503,504].includes(response.status)&&attempt+1<maxAttempts){await response.body?.cancel();this.metrics.retries++;const retry=Number(response.headers.get('retry-after'));await this.sleeper(Math.min(5000,Math.max(200*2**attempt,Number.isFinite(retry)?retry*1000:0)));continue;}
    const documentedEmpty=response.status===200&&(plan.gateway==='google_search_console_native_action'&&['PUT','DELETE'].includes(plan.method)&&/^\/webmasters\/v3\/sites\//.test(plan.path)||plan.gateway==='gtm_native_action'&&plan.method==='DELETE');
    const data=await this.readBody(response,plan.method==='HEAD'||!plan.readOnly&&(documentedEmpty||[204,205].includes(response.status)||plan.gateway==='linkedin_native_action'&&response.status===201&&response.headers.has('x-restli-id')));
    if(!response.ok){const code=response.status===401?'AUTH_EXPIRED':response.status===403?'INSUFFICIENT_SCOPE':response.status===429?'PLATFORM_RATE_LIMIT':'UPSTREAM_ERROR';throw new MirrorError(code,'Platform returned HTTP '+response.status,{upstream:redact(data)},response.status,response.status===429||response.status>=500);}
    if(data&&typeof data==='object'){
     const d=data as JsonObject;
     if((plan.gateway==='tiktok_native_action'&&d.code!==undefined&&d.code!==0)||d.request_status==='ERROR'||d.error)throw new MirrorError('PLATFORM_ERROR','Platform reported an unsuccessful result.',{upstream:redact(d)},502,false);
    }
    this.circuits.delete(key);this.metrics.totalLatencyMs+=Date.now()-start;
    return {data,status:response.status,headers:Object.fromEntries(['request-id','x-request-id','x-fb-trace-id','x-restli-id','retry-after'].map(k=>[k,response.headers.get(k)]).filter((p):p is [string,string]=>p[1]!==null))};
   }catch(error){
    const e=error instanceof MirrorError?error:new MirrorError(plan.readOnly?'UPSTREAM_UNAVAILABLE':'WRITE_OUTCOME_UNCERTAIN',plan.readOnly?'Platform request failed or timed out.':'The write response was lost. Do not retry with a new key; inspect platform state.',{},502,plan.readOnly);
    if(plan.readOnly&&e.retryable&&attempt+1<maxAttempts){this.metrics.retries++;await this.sleeper(200*2**attempt);continue;}
    this.metrics.errors++;const prior=this.circuits.get(key)?.failures??0;this.circuits.set(key,{failures:prior+1,until:prior>=4?Date.now()+30000:0});throw e;
   }
  }
  throw new MirrorError('UPSTREAM_UNAVAILABLE','Platform request failed.');
 }
 private async readBody(response:Response,allowEmpty:boolean):Promise<unknown>{
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>this.maximumBytes){await reader.cancel();throw new MirrorError('RESPONSE_TOO_LARGE','Platform response exceeds the configured size limit. Use smaller pages.');}chunks.push(value);}}finally{reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8');
  if(!text.trim()&&(!response.ok||allowEmpty))return null;
  let data:unknown;try{data=JSON.parse(text);}catch{
   if(!response.ok)return {content_type:response.headers.get('content-type'),body:text};
   throw new MirrorError('UPSTREAM_RESPONSE_INVALID','Platform returned an empty or malformed JSON response.',{status:response.status},502);
  }
  if(response.ok&&(data===null||typeof data!=='object'))throw new MirrorError('UPSTREAM_RESPONSE_INVALID','Platform JSON response must contain an object or array.',{status:response.status},502);
  return data;
 }
}
