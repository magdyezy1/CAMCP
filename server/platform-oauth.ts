import {createHmac,createHash,randomBytes,randomUUID} from 'node:crypto';
import {MirrorError} from '../src/errors.js';
import type {Credentials,JsonObject} from '../src/types.js';
import {WebStore,type WebSession} from './web-store.js';
import {requestAppleAccessToken} from '../src/apple-auth.js';
import {gtmWriteScopes} from '../src/measurement-writes.js';
import {microsoftGateway,microsoftScope} from '../src/microsoft-native.js';

export interface PlatformDefinition {id:string;name:string;kind:string;description:string;logo:string;gateway:string;env:string;authorize:string;token:string;scopes:string[];pkce?:boolean;assetKinds:string[];selectionKind?:string;authType?:'client_credentials';reviewedWrites?:boolean}
export const platforms:PlatformDefinition[]=[
 {id:'microsoft',name:'Microsoft Advertising',kind:'Bing & Microsoft Ads',description:'Connect Microsoft advertising accounts, search campaigns and reports.',logo:'M',gateway:microsoftGateway,env:'MICROSOFT',authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',scopes:[microsoftScope,'offline_access'],pkce:true,assetKinds:['ad_accounts'],reviewedWrites:true},
 {id:'google',name:'Google Ads',kind:'Search & display',description:'Connect your Google advertising accounts.',logo:'G',gateway:'google_ads_native_action',env:'GOOGLE',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/adwords','openid','profile'],pkce:true,assetKinds:['ad_accounts']},
 {id:'meta',name:'Meta',kind:'Facebook & Instagram',description:'Bring your ad accounts, pages and Instagram together.',logo:'∞',gateway:'meta_native_action',env:'META',authorize:'https://www.facebook.com/v25.0/dialog/oauth',token:'https://graph.facebook.com/v25.0/oauth/access_token',scopes:['ads_read','pages_show_list','pages_read_engagement','business_management'],assetKinds:['ad_accounts','pages','instagram','catalogs','pixels','mobile_apps','custom_conversions']},
 {id:'tiktok',name:'TikTok',kind:'TikTok for Business',description:'Connect advertisers and discover your business assets.',logo:'♪',gateway:'tiktok_native_action',env:'TIKTOK',authorize:'https://ads.tiktok.com/marketing_api/auth',token:'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/',scopes:[],assetKinds:['ad_accounts','pixels','identities']},
 {id:'snapchat',name:'Snapchat',kind:'Snap Ads',description:'Connect organizations, ad accounts and tracking assets.',logo:'S',gateway:'snapchat_native_action',env:'SNAPCHAT',authorize:'https://accounts.snapchat.com/login/oauth2/authorize',token:'https://accounts.snapchat.com/login/oauth2/access_token',scopes:['snapchat-marketing-api'],assetKinds:['ad_accounts','profiles','pixels','mobile_apps','catalogs']},
 {id:'linkedin',name:'LinkedIn',kind:'LinkedIn Marketing',description:'Connect your professional advertising accounts.',logo:'in',gateway:'linkedin_native_action',env:'LINKEDIN',authorize:'https://www.linkedin.com/oauth/v2/authorization',token:'https://www.linkedin.com/oauth/v2/accessToken',scopes:['r_ads','r_ads_reporting'],assetKinds:['ad_accounts']},
 {id:'x',name:'X (Twitter)',kind:'X Ads',description:'Connect ad accounts, promoted profiles and tracking tags.',logo:'𝕏',gateway:'x_ads_native_action',env:'X',authorize:'https://api.x.com/oauth/authorize',token:'https://api.x.com/oauth/access_token',scopes:[],assetKinds:['ad_accounts','profiles','pixels','mobile_apps']},
 {id:'ga4',name:'Google Analytics 4',kind:'Analytics & measurement',description:'Connect GA4 properties, reports and data streams.',logo:'A',gateway:'ga4_native_action',env:'GA4',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/analytics.readonly'],pkce:true,assetKinds:['properties','data_streams'],selectionKind:'properties',reviewedWrites:true},
 {id:'gtm',name:'Google Tag Manager',kind:'Google tag & containers',description:'Connect Tag Manager accounts and Google tag containers.',logo:'◇',gateway:'gtm_native_action',env:'GTM',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/tagmanager.readonly'],pkce:true,assetKinds:['tag_accounts','containers'],selectionKind:'tag_accounts',reviewedWrites:true},
 {id:'gsc',name:'Google Search Console',kind:'Organic search',description:'Connect verified sites, search performance and sitemaps.',logo:'⌕',gateway:'google_search_console_native_action',env:'GSC',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scopes:['https://www.googleapis.com/auth/webmasters.readonly'],pkce:true,assetKinds:['sites','sitemaps'],selectionKind:'sites',reviewedWrites:true},
 {id:'apple',name:'Apple Ads',kind:'App Store advertising',description:'Connect Apple Ads accounts using your API credentials.',logo:'●',gateway:'apple_ads_native_action',env:'APPLE',authorize:'',token:'https://appleid.apple.com/auth/oauth2/token',scopes:['searchadsorg'],assetKinds:['ad_accounts'],authType:'client_credentials',reviewedWrites:true}
];
export function platform(id:string){const p=platforms.find(p=>p.id===id);if(!p)throw new MirrorError('PLATFORM_NOT_FOUND','Unknown advertising platform.',{},404);return p;}
export function selectionKind(gateway:string){return platforms.find(p=>p.gateway===gateway)?.selectionKind??'ad_accounts';}
const pct=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function signOAuth1(method:string,url:URL,consumerKey:string,consumerSecret:string,token='',tokenSecret='',extra:Record<string,string>={},nonce=randomBytes(20).toString('hex'),timestamp=String(Math.floor(Date.now()/1000))):string{
 const params:Record<string,string>={oauth_consumer_key:consumerKey,oauth_nonce:nonce,oauth_signature_method:'HMAC-SHA1',oauth_timestamp:timestamp,oauth_version:'1.0',...(token?{oauth_token:token}:{}),...extra};
 const sorted=[...url.searchParams.entries(),...Object.entries(params)].map(([k,v])=>[pct(k),pct(v)] as [string,string]).sort(([a,b],[c,d])=>a<c?-1:a>c?1:b<d?-1:b>d?1:0).map(([k,v])=>k+'='+v).join('&');
 const base=method.toUpperCase()+'&'+pct(url.origin+url.pathname)+'&'+pct(sorted),signature=createHmac('sha1',pct(consumerSecret)+'&'+pct(tokenSecret)).update(base).digest('base64');
 return 'OAuth '+Object.entries({...params,oauth_signature:signature}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>pct(k)+'="'+pct(v)+'"').join(', ');
}
export class PlatformOAuth {
 constructor(readonly web:WebStore,private env:NodeJS.ProcessEnv=process.env,private fetcher:typeof fetch=fetch,readonly allowWrites=false){}
 config(p:PlatformDefinition){
  const sharedGoogle=['ga4','gtm','gsc'].includes(p.id)&&!this.env['AMCP_'+p.env+'_CLIENT_ID']&&!this.env['AMCP_'+p.env+'_CLIENT_SECRET'];
  const clientId=this.env['AMCP_'+(sharedGoogle?'GOOGLE':p.env)+'_CLIENT_ID'],clientSecret=this.env['AMCP_'+(sharedGoogle?'GOOGLE':p.env)+'_CLIENT_SECRET'];
  const writeScope=this.allowWrites?(p.id==='meta'?'ads_management':p.id==='linkedin'?'rw_ads':undefined):undefined;
  const defaults=[...p.scopes,...(writeScope?[writeScope]:[]),...(this.allowWrites&&p.id==='gtm'?gtmWriteScopes:[]),...(this.allowWrites&&p.id==='gsc'?['https://www.googleapis.com/auth/webmasters']:[])];
  const appleKey=!!(this.env.AMCP_APPLE_TEAM_ID&&this.env.AMCP_APPLE_KEY_ID&&this.env.AMCP_APPLE_PRIVATE_KEY);
  return {clientId,clientSecret,configured:!!(clientId&&(clientSecret||p.id==='apple'&&appleKey)&&(p.id!=='microsoft'||this.env.AMCP_MICROSOFT_DEVELOPER_TOKEN)),redirectUri:this.web.origin+'/api/auth/'+p.id+'/callback',scopes:p.id==='apple'?p.scopes:(this.env['AMCP_'+p.env+'_SCOPES']?.split(/[ ,]+/).filter(Boolean))??defaults};
 }
 publicConfig(){return platforms.map(p=>{const c=this.config(p);return {...p,selectionKind:p.selectionKind??'ad_accounts',authorize:undefined,token:undefined,configured:c.configured,callback:p.authType?null:c.redirectUri,scopes:c.scopes};});}
 async connectService(id:string):Promise<{credentials:Credentials;label:string;scopes:string[]}>{
  const p=platform(id),c=this.config(p);if(p.id!=='apple')throw new MirrorError('OAUTH_FLOW_REQUIRED','Use browser authorization for this platform.');
  if(!c.configured)throw new MirrorError('PROVIDER_SETUP_REQUIRED','Configure Apple Ads API credentials in Railway before connecting.',{},409);
  const credentials=await requestAppleAccessToken({clientId:c.clientId,clientSecret:c.clientSecret,appleTeamId:this.env.AMCP_APPLE_TEAM_ID,appleKeyId:this.env.AMCP_APPLE_KEY_ID,applePrivateKey:this.env.AMCP_APPLE_PRIVATE_KEY},this.fetcher);
  return {credentials,label:'Apple Ads API login',scopes:[...p.scopes]};
 }
 async readResponse(response:Response,format:'json'|'form'='json'):Promise<JsonObject>{
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024*1024){await reader.cancel();throw new MirrorError('OAUTH_RESPONSE_INVALID','The provider response was too large.',{},502);}chunks.push(part.value);}}finally{reader.releaseLock();}
  if(!response.ok)throw new MirrorError('OAUTH_EXCHANGE_FAILED','The provider rejected authorization. Check app credentials and callback settings, then reconnect.',{http_status:response.status},502);
  try{const text=Buffer.concat(chunks).toString('utf8'),data=format==='form'?Object.fromEntries(new URLSearchParams(text)):JSON.parse(text);if(!data||typeof data!=='object'||Array.isArray(data)||data.error)throw Error();return data;}catch{throw new MirrorError('OAUTH_RESPONSE_INVALID','The provider returned an invalid authorization response.',{},502);}
 }
 async start(session:WebSession,id:string):Promise<{url:string;attemptId:string}>{
  const p=platform(id),c=this.config(p);if(!c.configured)throw new MirrorError('PROVIDER_SETUP_REQUIRED','Add the '+p.name+' app credentials in Railway before connecting.',{callback:c.redirectUri},409);
  if(p.authType)throw new MirrorError('SERVICE_CONNECTION_REQUIRED','This platform uses server-side API credentials, without a browser OAuth callback.');
  const state=randomBytes(32).toString('base64url'),attemptId=randomUUID(),verifier=randomBytes(48).toString('base64url');
  let data:JsonObject={attemptId,redirectUri:c.redirectUri,verifier,requestedScopes:[...c.scopes],requestedWriteAccess:this.allowWrites},url=new URL(p.authorize);
  if(id==='x'){
   const requestedAccessType=this.allowWrites?'write':'read';
   const requestUrl=new URL('https://api.x.com/oauth/request_token');requestUrl.searchParams.set('x_auth_access_type',requestedAccessType);
   const callback=c.redirectUri+'?state='+state;
   const auth=signOAuth1('POST',requestUrl,c.clientId!,c.clientSecret!,'','',{oauth_callback:callback});
   const result=await this.readResponse(await this.fetcher(requestUrl,{method:'POST',headers:{Authorization:auth},redirect:'error',signal:AbortSignal.timeout(15000)}),'form');
   if(result.oauth_callback_confirmed!=='true'||typeof result.oauth_token!=='string'||typeof result.oauth_token_secret!=='string')throw new MirrorError('OAUTH_RESPONSE_INVALID','X did not confirm the callback.',{},502);
   data={...data,requestedAccessType,requestToken:result.oauth_token,requestSecret:result.oauth_token_secret};url.searchParams.set('oauth_token',result.oauth_token);
  }else{
   const redirectParameter=id==='tiktok'?(this.env.AMCP_TIKTOK_REDIRECT_PARAMETER??'redirect_uri'):'redirect_uri';if(!['redirect_uri','redirect_url'].includes(redirectParameter))throw new MirrorError('CONFIG_ERROR','TikTok redirect parameter must match the developer portal URL.');
   url.searchParams.set(id==='tiktok'?'app_id':'client_id',c.clientId!);url.searchParams.set(redirectParameter,c.redirectUri);url.searchParams.set('state',state);
   if(id!=='tiktok')url.searchParams.set('response_type','code');if(c.scopes.length)url.searchParams.set('scope',c.scopes.join(id==='meta'?',':' '));
   if(p.pkce){url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
   if(p.token==='https://oauth2.googleapis.com/token'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
   if(id==='meta'&&this.env.AMCP_META_CONFIG_ID){url.searchParams.set('config_id',this.env.AMCP_META_CONFIG_ID);url.searchParams.set('override_default_response_type','true');}
  }
  this.web.beginOAuth(session,id,data,state);this.web.store.putDocument(session.actor.tenantId,'oauth_progress',attemptId,{platform:id,state:'authorization',createdAt:Date.now(),authorization:false,exchange:false,sync:false});
  return {url:url.href,attemptId};
 }
 async exchange(id:string,stored:JsonObject,query:Record<string,string>):Promise<{credentials:Credentials;label:string;scopes:string[];providerId?:string}>{
  const p=platform(id),c=this.config(p);if(!c.configured)throw new MirrorError('PROVIDER_SETUP_REQUIRED','Provider credentials are unavailable.',{},503);
  if(p.authType)throw new MirrorError('SERVICE_CONNECTION_REQUIRED','Apple Ads does not use an authorization-code callback.');
  if(query.error||query.denied)throw new MirrorError('OAUTH_CANCELLED','Authorization was cancelled. Your existing connections were not changed.',{},400);
  let result:JsonObject;
  if(id==='x'){
   if(query.oauth_token!==stored.requestToken||!query.oauth_verifier)throw new MirrorError('OAUTH_TOKEN_MISMATCH','X returned a mismatched authorization token.',{},400);
   // X binds access to the original request token. Never replace that token or
   // request a new access type during exchange when deployment settings change.
   const url=new URL(p.token),authorization=signOAuth1('POST',url,c.clientId!,c.clientSecret!,stored.requestToken,stored.requestSecret,{oauth_verifier:query.oauth_verifier});
   result=await this.readResponse(await this.fetcher(url,{method:'POST',headers:{Authorization:authorization},redirect:'error',signal:AbortSignal.timeout(15000)}),'form');
   if(typeof result.oauth_token!=='string'||typeof result.oauth_token_secret!=='string')throw new MirrorError('OAUTH_RESPONSE_INVALID','X did not return usable user credentials.',{},502);
   return {credentials:{consumerKey:c.clientId,consumerSecret:c.clientSecret,accessToken:result.oauth_token,tokenSecret:result.oauth_token_secret},label:result.screen_name?'@'+result.screen_name:'X login',scopes:[],providerId:result.user_id};
  }
  const code=query[id==='tiktok'?'auth_code':'code'];if(!code||code.length>8192)throw new MirrorError('OAUTH_CODE_REQUIRED','The provider did not return an authorization code.',{},400);
  const body=new URLSearchParams({client_id:c.clientId!,client_secret:c.clientSecret!,grant_type:'authorization_code',code,redirect_uri:stored.redirectUri});if(p.pkce)body.set('code_verifier',stored.verifier);
  if(id==='microsoft')body.set('scope',microsoftScope+' offline_access');
  const tokenUrl=new URL(p.token);if(id==='meta'){body.delete('grant_type');tokenUrl.search=body.toString();}
  result=await this.readResponse(await this.fetcher(tokenUrl,{method:id==='meta'?'GET':'POST',body:id==='meta'?undefined:id==='tiktok'?JSON.stringify({app_id:c.clientId,secret:c.clientSecret,auth_code:code}):body,headers:id==='tiktok'?{'Content-Type':'application/json'}:{},redirect:'error',signal:AbortSignal.timeout(15000)}));
  if(id==='tiktok'){if(result.code!==0||!result.data)throw new MirrorError('OAUTH_EXCHANGE_FAILED','TikTok rejected the authorization code.',{},502);result=result.data;}
  if(id==='meta'&&this.env.AMCP_META_LONG_LIVED_TOKEN!=='false'){
   if(typeof result.access_token!=='string'||!result.access_token)throw new MirrorError('OAUTH_RESPONSE_INVALID','Meta did not return a usable short-lived token.',{},502);
   const exchangeUrl=new URL(p.token);exchangeUrl.search=new URLSearchParams({grant_type:'fb_exchange_token',client_id:c.clientId!,client_secret:c.clientSecret!,fb_exchange_token:result.access_token}).toString();
   const extended=await this.readResponse(await this.fetcher(exchangeUrl,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)}));
   // Trust only the provider's actual lifetime; never invent a 60-day expiration.
   if(typeof extended.access_token!=='string'||!extended.access_token||!Number.isFinite(Number(extended.expires_in))||Number(extended.expires_in)<=0)throw new MirrorError('OAUTH_RESPONSE_INVALID','Meta did not return a valid long-lived token and lifetime.',{},502);
   result={...result,...extended};
  }
  if(typeof result.access_token!=='string'||!result.access_token||result.refresh_token!==undefined&&typeof result.refresh_token!=='string')throw new MirrorError('OAUTH_RESPONSE_INVALID','The provider did not return a usable access token.',{},502);
  const expires=result.expires_in===undefined?undefined:Number(result.expires_in);if(expires!==undefined&&(!Number.isFinite(expires)||expires<=0))throw new MirrorError('OAUTH_RESPONSE_INVALID','The provider returned an invalid token lifetime.',{},502);
  const credentials:Credentials={accessToken:result.access_token,refreshToken:result.refresh_token,clientId:c.clientId,clientSecret:c.clientSecret,redirectUri:stored.redirectUri,...(expires?{expiresAt:Date.now()+expires*1000}:{}),...(id==='google'?{developerToken:this.env.AMCP_GOOGLE_DEVELOPER_TOKEN,loginCustomerId:this.env.AMCP_GOOGLE_LOGIN_CUSTOMER_ID}:{})};
  if(id==='microsoft'){credentials.developerToken=this.env.AMCP_MICROSOFT_DEVELOPER_TOKEN;if(!credentials.refreshToken||!expires)throw new MirrorError('OAUTH_RESPONSE_INVALID','Microsoft authorization must return offline access and a valid lifetime. Reconnect with offline_access.',{},502);}
  // Bind fallback scope metadata to the authorization that produced this code.
  // An in-flight or legacy read authorization must never inherit a later write configuration.
  const requestedScopes=Array.isArray(stored.requestedScopes)&&stored.requestedScopes.every((scope:unknown)=>typeof scope==='string')?stored.requestedScopes:[...p.scopes];
  return {credentials,label:p.name+' login',scopes:typeof result.scope==='string'?result.scope.split(/[ ,]+/).filter(Boolean):requestedScopes};
 }
}
