import {createHmac,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,Credentials,JsonObject} from './types.js';
import {redact,scopeKey} from './security.js';
import type {Store} from './store.js';
import {microsoftGateway,microsoftOrigin,microsoftCustomerOrigin,microsoftReportOrigin,microsoftCustomer} from './microsoft-native.js';
export const vendorOrigins:Record<string,string>={google_sheets_native_action:'https://www.googleapis.com',google_drive_native_action:'https://www.googleapis.com',
 meta_native_action:'https://graph.facebook.com',tiktok_native_action:'https://business-api.tiktok.com',snapchat_native_action:'https://adsapi.snapchat.com',google_ads_native_action:'https://googleads.googleapis.com',linkedin_native_action:'https://api.linkedin.com',x_ads_native_action:'https://ads-api.x.com',dv360_native_action:'https://displayvideo.googleapis.com',amazon_native_action:'https://advertising-api.amazon.com',apple_ads_native_action:'https://api.searchads.apple.com',reddit_native_action:'https://ads-api.reddit.com',criteo_native_action:'https://api.criteo.com',ga4_native_action:'https://analyticsdata.googleapis.com',gtm_native_action:'https://tagmanager.googleapis.com',google_business_native_action:'https://mybusinessbusinessinformation.googleapis.com',google_search_console_native_action:'https://searchconsole.googleapis.com',adjust_native_action:'https://automate.adjust.com'
};
const additionalOrigins:Record<string,string[]>={amazon_native_action:['https://advertising-api-eu.amazon.com','https://advertising-api-fe.amazon.com'],apple_ads_native_action:['https://api.ads.apple.com'],ga4_native_action:['https://analyticsadmin.googleapis.com'],google_business_native_action:['https://mybusinessaccountmanagement.googleapis.com','https://mybusiness.googleapis.com','https://businessprofileperformance.googleapis.com','https://mybusinessverifications.googleapis.com','https://mybusinessnotifications.googleapis.com','https://mybusinesslodging.googleapis.com'],x_ads_native_action:['https://upload.twitter.com','https://api.x.com','https://upload.x.com'],google_search_console_native_action:['https://www.googleapis.com'],adjust_native_action:['https://api.adjust.com','https://dash.adjust.com']};
export function buildUrl(request:CompiledRequest,connection:Connection):URL{
 if(/[?#\r\n\\]/.test(request.path)||!request.path.startsWith('/')||request.path.startsWith('//'))throw new MirrorError('INVALID_PATH','Request paths cannot contain a query, fragment or authority. Supply query parameters separately.');
 const base=request.origin??connection.baseUrl??(request.gateway===microsoftGateway?microsoftOrigin:vendorOrigins[request.gateway]);
 if(!base)throw new MirrorError('CONNECTOR_CONFIGURATION_REQUIRED','Configure an approved upstream origin for this gateway.');
 const origin=new URL(base);
 const allowed=[vendorOrigins[request.gateway],...(additionalOrigins[request.gateway]??[]),...(request.gateway===microsoftGateway?[microsoftOrigin,microsoftCustomerOrigin,microsoftReportOrigin]:[]),...(request.gateway==='google_business_native_action'?['https://mybusinessplaceactions.googleapis.com']:[])];
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
export interface BinaryUpload {field:string;bytes:Buffer;filename:string;mime:string;format?:'related'}
export class NativeTransport {
 coordination?:Store;
 private circuits=new Map<string,{failures:number;until:number}>();private budgets=new Map<string,{tokens:number;at:number}>();
 readonly metrics={requests:0,retries:0,errors:0,totalLatencyMs:0};
 constructor(private fetcher:typeof fetch=fetch,private sleeper:(ms:number)=>Promise<unknown>=delay,private timeoutMs=30000,private maximumBytes=8*1024*1024){}
 async request(plan:CompiledRequest,connection:Connection,credentials:Credentials,upload?:BinaryUpload):Promise<TransportResult>{
  const key=scopeKey(connection.tenantId,connection.gateway);
  const circuit=this.circuits.get(key);if(circuit&&circuit.until>Date.now())throw new MirrorError('CIRCUIT_OPEN','Platform circuit is temporarily open.',{retry_after_ms:circuit.until-Date.now()},503,true);
  const budget=this.budgets.get(key)??{tokens:30,at:Date.now()};budget.tokens=Math.min(30,budget.tokens+(Date.now()-budget.at)/1000);budget.at=Date.now();
  if(budget.tokens<1)throw new MirrorError('TENANT_RATE_LIMIT','Per-tenant platform request budget exhausted.',{retry_after_ms:1000},429,true);budget.tokens--;this.budgets.set(key,budget);
  const url=buildUrl(plan,connection);const headers:Record<string,string>={Accept:'application/json',...plan.headers};
  if(plan.gateway==='reddit_native_action'){
   if(!connection.userAgent||/[\r\n]/.test(connection.userAgent))throw new MirrorError('USER_AGENT_REQUIRED','Configure a descriptive Reddit application userAgent on the connection.');headers['User-Agent']=connection.userAgent;
  }
  let body:BodyInit|undefined;let form:URLSearchParams|undefined;
  if(upload){
   if(plan.readOnly)throw new MirrorError('INVALID_UPLOAD','Binary uploads must be reviewed mutations.');
   if(upload.format==='related'){
    if(plan.gateway!=='dv360_native_action'||plan.method!=='POST'||!/^\/upload\/v4\/advertisers\/\d+\/assets$/.test(plan.path)||plan.query.uploadType!=='multipart')throw new MirrorError('INVALID_UPLOAD','Multipart-related is restricted to the DV360 advertiser asset contract.');
    const boundary='amcp_'+randomUUID();body=new Uint8Array(Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(plan.body)+'\r\n--'+boundary+'\r\nContent-Type: '+upload.mime+'\r\n\r\n'),upload.bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]));headers['Content-Type']='multipart/related; boundary='+boundary;
   }else{
   const multipart=new FormData();for(const [k,v]of Object.entries((plan.body??{}) as JsonObject))multipart.set(k,typeof v==='object'?JSON.stringify(v):String(v));
   multipart.set(upload.field,new Blob([new Uint8Array(upload.bytes)],{type:upload.mime}),upload.filename);body=multipart;
   for(const key of Object.keys(headers))if(key.toLowerCase()==='content-type')delete headers[key];
   }
  }else if(plan.body!==undefined){
   if(plan.gateway==='meta_native_action'||plan.gateway==='x_ads_native_action'&&!plan.path.includes('/batch/')){form=new URLSearchParams();for(const [k,v]of Object.entries(plan.body as JsonObject))form.set(k,typeof v==='object'?JSON.stringify(v):String(v));body=form.toString();headers['Content-Type']='application/x-www-form-urlencoded';}
   else {body=JSON.stringify(plan.gateway==='google_ads_native_action'?camelKeys(plan.body):plan.body);headers['Content-Type']=plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'?'application/json-patch+json':'application/json';}
  }
  if(credentials.accessToken){if(plan.gateway==='tiktok_native_action')headers['Access-Token']=credentials.accessToken;else headers.Authorization='Bearer '+credentials.accessToken;}
  if(plan.gateway==='google_ads_native_action'){
   if(!credentials.developerToken)throw new MirrorError('DEVELOPER_TOKEN_REQUIRED','Google Ads requires its own developer token.');headers['developer-token']=credentials.developerToken;
   if(credentials.loginCustomerId)headers['login-customer-id']=credentials.loginCustomerId.replaceAll('-','');
  }
  if(plan.gateway===microsoftGateway){
   if(!credentials.developerToken)throw new MirrorError('DEVELOPER_TOKEN_REQUIRED','Microsoft Advertising requires its own developer token.');headers.DeveloperToken=credentials.developerToken;
   if(plan.accountId){headers.CustomerAccountId=plan.accountId;headers.CustomerId=microsoftCustomer(connection,plan.accountId);}
   else if(plan.action!=='AMCP_MICROSOFT_DISCOVERY'||![microsoftCustomerOrigin+'/CustomerManagement/v13/User/Query',microsoftCustomerOrigin+'/CustomerManagement/v13/Accounts/Search'].includes(url.href))throw new MirrorError('ACCOUNT_REQUIRED','Microsoft requests require an explicit selected account.');
  }
  if(plan.gateway==='amazon_native_action'){if(!credentials.clientId)throw new MirrorError('CLIENT_ID_REQUIRED','Amazon Ads requires a client ID.');headers['Amazon-Advertising-API-ClientId']=credentials.clientId;if(plan.accountId)headers['Amazon-Advertising-API-Scope']=plan.accountId;}
  if(plan.gateway==='apple_ads_native_action'&&plan.accountId)headers['X-AP-Context']=(url.origin==='https://api.ads.apple.com'&&plan.path.startsWith('/v1/')?'adAccountId='+plan.accountId+';':'orgId='+plan.accountId);
  if(plan.gateway==='x_ads_native_action')headers.Authorization=oauth1(plan.method,url,credentials,form);
  if(credentials.apiKey&&!headers.Authorization)headers.Authorization='Bearer '+credentials.apiKey;
  if(!headers.Authorization&&!headers['Access-Token'])throw new MirrorError('CREDENTIALS_REQUIRED','An authenticated platform connection is required.',{},401);
  // Report submission creates a job even though it cannot mutate advertising configuration.
  const start=Date.now();const maxAttempts=plan.readOnly&&!(plan.gateway===microsoftGateway&&plan.action==='SubmitGenerateReport')?3:1;
  for(let attempt=0;attempt<maxAttempts;attempt++){
   this.coordination?.providerPermit(key);
   this.metrics.requests++;
   try{
    const response=await this.fetcher(url,{method:plan.method,headers,body,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
    if(response.status===429){const seconds=Number(response.headers.get('retry-after')??30);this.coordination?.providerCooldown(key,Number.isFinite(seconds)?seconds*1000:30000);}
    if([429,502,503,504].includes(response.status)&&attempt+1<maxAttempts){await response.body?.cancel();this.metrics.retries++;const retry=Number(response.headers.get('retry-after'));await this.sleeper(Math.min(5000,Math.max(200*2**attempt,Number.isFinite(retry)?retry*1000:0)));continue;}
    const documentedEmpty=response.status===200&&(plan.gateway==='google_search_console_native_action'&&['PUT','DELETE'].includes(plan.method)&&/^\/webmasters\/v3\/sites\//.test(plan.path)||plan.gateway==='gtm_native_action'&&plan.method==='DELETE'||plan.gateway==='linkedin_native_action'&&plan.method==='POST'&&plan.path==='/rest/videos'&&plan.query.action==='finalizeUpload'||plan.gateway==='google_ads_native_action'&&plan.method==='POST'&&/^\/resumable\/upload\/v23\/customers\/\d+\/youTubeVideoUploads:create$/.test(plan.path)&&response.headers.has('x-goog-upload-url'));
    const data=await this.readBody(response,plan.method==='HEAD'||!plan.readOnly&&(documentedEmpty||[204,205].includes(response.status)||plan.gateway==='linkedin_native_action'&&response.status===201&&response.headers.has('x-restli-id')));
    const errorDetails=()=>({upstream:redact(data),http_status:response.status,request_id:response.headers.get('request-id')??response.headers.get('x-request-id')??response.headers.get('x-fb-trace-id'),...(plan.gateway==='google_ads_native_action'?{login_customer_id:headers['login-customer-id']??null}:{})});
    if(!response.ok){const code=response.status===401?'AUTH_EXPIRED':response.status===403?'INSUFFICIENT_SCOPE':response.status===429?'PLATFORM_RATE_LIMIT':'UPSTREAM_ERROR';throw new MirrorError(code,'Platform returned HTTP '+response.status,errorDetails(),response.status,response.status===429||response.status>=500);}
    if(data&&typeof data==='object'){
     const d=data as JsonObject;
     if((plan.gateway==='tiktok_native_action'&&d.code!==undefined&&d.code!==0)||d.request_status==='ERROR'||d.error)throw new MirrorError('PLATFORM_ERROR','Platform reported an unsuccessful result.',errorDetails(),502,false);
    }
    this.circuits.delete(key);this.metrics.totalLatencyMs+=Date.now()-start;
    return {data,status:response.status,headers:Object.fromEntries(['request-id','x-request-id','x-fb-trace-id','x-restli-id','retry-after',...(plan.gateway==='google_ads_native_action'&&plan.path.startsWith('/resumable/upload/')?['x-goog-upload-url','x-goog-upload-chunk-granularity']:[])].map(k=>[k,response.headers.get(k)]).filter((p):p is [string,string]=>p[1]!==null))};
   }catch(error){
    const e=error instanceof MirrorError?error:new MirrorError(plan.readOnly?'UPSTREAM_UNAVAILABLE':'WRITE_OUTCOME_UNCERTAIN',plan.readOnly?'Platform request failed or timed out.':'The write response was lost. Do not retry with a new key; inspect platform state.',{},502,plan.readOnly);
    if(plan.readOnly&&e.retryable&&attempt+1<maxAttempts){this.metrics.retries++;await this.sleeper(200*2**attempt);continue;}
    this.metrics.errors++;const prior=this.circuits.get(key)?.failures??0;this.circuits.set(key,{failures:prior+1,until:prior>=4?Date.now()+30000:0});throw e;
   }
  }
  throw new MirrorError('UPSTREAM_UNAVAILABLE','Platform request failed.');
 }
 /** A Google-issued upload capability stays in memory and can only target Google's upload origin. */
 async uploadGoogleVideo(raw:string,bytes:Buffer,accessToken:string,options:{granularity?:number;beforeChunk?:()=>void;progress?:(bytes:number)=>void}={}):Promise<TransportResult>{
  let url:URL;try{url=new URL(raw);}catch{throw new MirrorError('UNAPPROVED_UPLOAD_URL','Google returned an invalid upload URL.');}
  if(url.origin!=='https://googleads.googleapis.com'||url.username||url.password||url.hash||!url.pathname.startsWith('/resumable/upload/'))throw new MirrorError('UNAPPROVED_UPLOAD_URL','Google upload URLs must stay on the Google Ads resumable upload endpoint.');
  if(!accessToken)throw new MirrorError('CREDENTIALS_REQUIRED','Google video upload needs an authenticated connection.');
  const unit=options.granularity??262144;
  if(!Number.isSafeInteger(unit)||unit<1||unit>16*1024*1024)throw new MirrorError('MEDIA_RESPONSE_INVALID','Google returned an unsupported upload chunk granularity.');
  const chunkSize=Math.max(unit,Math.floor(4*1024*1024/unit)*unit);let offset=0,recoveries=0;
  while(offset<bytes.length){
   options.beforeChunk?.();const end=Math.min(bytes.length,offset+chunkSize),final=end===bytes.length;
   let response:Response;
   try{response=await this.fetcher(url,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/octet-stream','X-Goog-Upload-Offset':String(offset),'X-Goog-Upload-Command':final?'upload, finalize':'upload'},body:new Uint8Array(bytes.subarray(offset,end))});
    if(!response.ok){await response.body?.cancel();throw new MirrorError('MEDIA_UPLOAD_FAILED','Google video transfer returned HTTP '+response.status);}
   }catch{
    // A finalization may have created the asset. Never resubmit it on a lost reply.
    if(final||recoveries++>=2)throw new MirrorError('WRITE_OUTCOME_UNCERTAIN','Google upload response was lost. Inspect the retained upload before any retry.',{bytes_confirmed:offset});
    options.beforeChunk?.();let queried:Response;
    try{queried=await this.fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{Authorization:'Bearer '+accessToken,'X-Goog-Upload-Command':'query'}});}catch{throw new MirrorError('WRITE_OUTCOME_UNCERTAIN','The Google upload offset could not be confirmed.');}
    const received=queried.headers.get('x-goog-upload-size-received');await queried.body?.cancel();const next=Number(received);
    if(!queried.ok||received===null||!Number.isSafeInteger(next)||next<offset||next>end||next%unit!==0)throw new MirrorError('WRITE_OUTCOME_UNCERTAIN','Google returned an inconsistent resumable upload offset.');
    offset=next;options.progress?.(offset);continue;
   }
   const data=await this.readBody(response,!final);offset=end;options.progress?.(offset);
   if(final)return {data,status:response.status,headers:{}};
  }
  throw new MirrorError('MEDIA_RESPONSE_INVALID','The upload contained no media bytes.');
 }
 /** Only signed upload URLs returned by LinkedIn's initializeUpload response. */
 async uploadLinkedIn(raw:string,bytes:Buffer,mime:string,accessToken?:string):Promise<string|undefined>{
  let url:URL;try{url=new URL(raw);}catch{throw new MirrorError('INVALID_UPLOAD_URL','LinkedIn returned an invalid upload URL.');}
  if(url.origin!=='https://www.linkedin.com'||url.username||url.password||url.hash||!url.pathname.startsWith('/dms-uploads/'))throw new MirrorError('UNAPPROVED_UPLOAD_URL','LinkedIn upload URL is outside the approved upload host/path.');
  if(mime.startsWith('image/')&&!accessToken)throw new MirrorError('CREDENTIALS_REQUIRED','LinkedIn image uploads require an access token.');
  const headers:Record<string,string>={'Content-Type':mime.startsWith('video/')?'application/octet-stream':mime,...(mime.startsWith('image/')?{Authorization:'Bearer '+accessToken}:{})};
  let response:Response;try{response=await this.fetcher(url,{method:'PUT',headers,body:new Uint8Array(bytes),redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});}catch{throw new MirrorError('WRITE_OUTCOME_UNCERTAIN','Upload response was lost. Inspect the allocated media before retrying.',{},502);}
  await response.body?.cancel();if(!response.ok)throw new MirrorError('MEDIA_UPLOAD_FAILED','LinkedIn binary upload returned HTTP '+response.status,{},502);
  return response.headers.get('etag')?.replace(/^"|"$/g,'');
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
