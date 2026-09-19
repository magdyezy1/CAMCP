import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService,strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {readOnlyPolicy} from '../src/preflight.js';
import {MirrorError,providerHttpErrorCode} from '../src/errors.js';
import {scopeKey} from '../src/security.js';
import {reportSourceError} from '../src/report-errors.js';
import {createHttpApp} from '../server/http-app.js';
import {googleAdsScope,googleAuthorizationInfo,googleAuthorizationRevision,reauthorizeGoogleConnection} from '../server/google-reauthorization.js';
import type {Actor,Connection,Credentials,JsonObject} from '../src/types.js';

const key=Buffer.alloc(32,37).toString('base64'),origin='https://amcp.shop',password='synthetic-reauthorization-password';
const clientId='100-test.apps.googleusercontent.com';
const actor:Actor={tenantId:'local',userId:'owner',role:'admin'};
const connection:Connection={id:'saved-google',tenantId:'local',gateway:'google_ads_native_action',label:'Saved Google login',accounts:['100'],writeAccounts:['100'],defaultWriteAccess:true,enabled:true,isDefault:true,scopes:[googleAdsScope]};
const credentials:Credentials={clientId,clientSecret:'synthetic-client-secret',accessToken:'old-access-token',refreshToken:'old-refresh-token',expiresAt:Date.now()+3600000};
const fresh:Credentials={...credentials,accessToken:'fresh-access-token',refreshToken:'fresh-refresh-token'};
const failure={error:{code:403,status:'PERMISSION_DENIED',message:'The caller does not have permission',details:[{'@type':'type.googleapis.com/google.ads.googleads.v23.errors.GoogleAdsFailure',requestId:'synthetic-google-request',errors:[{errorCode:{authorizationError:'AUTHORIZATION_ERROR'},message:'Authorization of the client failed.'}]}]}};
function fixture(){const store=new Store(':memory:',key);store.putConnection(actor,{...connection},credentials);store.putDocument('local','overview_report','report',{config:{sources:[{connection_id:connection.id,account_id:'100'}]}});store.putDocument('local','overview_schedule','schedule',{connection_id:connection.id});return store;}
const available=(id='100'):typeof fetch=>async(url,init)=>{
 const u=new URL(String(url));assert.equal(u.origin,'https://googleads.googleapis.com');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fresh-access-token');
 if(u.pathname.endsWith(':listAccessibleCustomers'))return Response.json({resourceNames:['customers/'+id]});
 assert.equal(init?.method,'POST');assert.match(String(init?.body),/FROM customer"/);
 return Response.json({results:[{customer:{id,descriptiveName:'Synthetic account',manager:false,status:'ENABLED',currencyCode:'USD',timeZone:'UTC'}}]});
};
const renew=(store:Store,fetcher:typeof fetch=available(),extra:Partial<Parameters<typeof reauthorizeGoogleConnection>[0]>={})=>reauthorizeGoogleConnection({store,actor,connectionId:connection.id,credentials:fresh,scopes:[googleAdsScope],revision:null,allowWrites:true,assertActive:()=>{},fetcher,...extra});

test('Google generic authorization failures and blank 403s are not mislabeled as missing scopes',()=>{
 assert.equal(providerHttpErrorCode(403,failure),'PROVIDER_ACCESS_DENIED');assert.equal(providerHttpErrorCode(403,{}),'PROVIDER_ACCESS_DENIED');
 assert.equal(providerHttpErrorCode(403,{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}}),'INSUFFICIENT_SCOPE');
 assert.equal(providerHttpErrorCode(403,{},'Bearer error="insufficient_scope"'),'INSUFFICIENT_SCOPE');
 const error=reportSourceError(new MirrorError('INSUFFICIENT_SCOPE','Platform returned HTTP 403',{upstream:failure},403),{platform:'google',account_id:'100'});
 assert.equal(error.code,'PROVIDER_ACCESS_DENIED');assert.equal(error.provider.code,'AUTHORIZATION_ERROR');assert.equal(error.provider.request_id,'synthetic-google-request');assert.match(error.next_action,/Sync alone/);assert.match(error.next_action,/Explorer Access supports/);
 assert.equal(reportSourceError(new MirrorError('INSUFFICIENT_SCOPE','A required scope is missing.',{},403),{platform:'google'}).code,'INSUFFICIENT_SCOPE');
 assert.equal(reportSourceError(new MirrorError('INSUFFICIENT_SCOPE','Denied.',{upstream:{error:{status:'PERMISSION_DENIED'}},scope_denial:true},403),{platform:'google'}).code,'INSUFFICIENT_SCOPE');
});

test('reauthorization verifies account reads, keeps the connection ID and grants, and preserves saved report/schedule references',async()=>{
 const store=fixture();try{
  const report=store.document('local','overview_report','report'),schedule=store.document('local','overview_schedule','schedule');
  const next=await renew(store);assert.equal(store.listConnections('local').length,1);assert.equal(next.id,connection.id);assert.equal(next.isDefault,true);
  assert.deepEqual(next.accounts,['100']);assert.deepEqual(next.writeAccounts,['100']);assert.deepEqual(next.accountLoginCustomers,{'100':'100'});
  assert.equal(store.credentials('local',next.id).refreshToken,fresh.refreshToken);assert.ok(googleAuthorizationRevision(store,'local',next.id));
  assert.deepEqual(store.document('local','overview_report','report'),report);assert.deepEqual(store.document('local','overview_schedule','schedule'),schedule);
  assert.deepEqual(store.document('local','website_assets',next.id).selected,['ad_accounts:100']);
  const publicInfo=googleAuthorizationInfo(store,next,clientId);assert.equal(publicInfo.matchesCurrentClient,true);assert.equal(publicInfo.adsScopeRecorded,true);assert.equal(publicInfo.clientId,clientId);
  assert.equal(googleAuthorizationInfo(store,next,'200-different.apps.googleusercontent.com').matchesCurrentClient,false);assert.ok(!JSON.stringify(publicInfo).includes('token'));assert.ok(!JSON.stringify(publicInfo).includes(credentials.clientSecret!));
 }finally{store.close();}
});

test('fresh Google denial preserves old credentials and exposes provider request IDs without retrying or changing grants',async()=>{
 const store=fixture();let calls=0;try{
  await assert.rejects(()=>renew(store,async(url)=>{calls++;return String(url).endsWith(':listAccessibleCustomers')?Response.json({resourceNames:['customers/100']}):Response.json(failure,{status:403});}),(e:MirrorError)=>{
   assert.equal(e.code,'REAUTHORIZATION_ACCESS_FAILED');const d=(e.details.diagnostics as JsonObject[])[0]!;assert.equal(d.provider.request_id,'synthetic-google-request');assert.equal(d.code,'PROVIDER_ACCESS_DENIED');return true;
  });
  assert.equal(calls,2);assert.deepEqual(store.credentials('local',connection.id),credentials);assert.deepEqual(store.listConnections('local')[0]!.accounts,['100']);assert.equal(googleAuthorizationRevision(store,'local',connection.id),null);
 }finally{store.close();}
});

test('a different Google login cannot silently replace a connection with inaccessible selected accounts',async()=>{
 const store=fixture();try{await assert.rejects(()=>renew(store,available('200')),(e:MirrorError)=>e.code==='REAUTHORIZATION_ACCOUNT_MISMATCH');assert.deepEqual(store.credentials('local',connection.id),credentials);assert.deepEqual(store.listConnections('local')[0]!.accounts,['100']);}finally{store.close();}
});

test('Google account-list rejection during reauthorization retains stage and provider trace',async()=>{
 const store=fixture();try{await assert.rejects(()=>renew(store,async()=>Response.json(failure,{status:403})),(e:MirrorError)=>{const d=(e.details.diagnostics as JsonObject[])[0]!;assert.equal(d.request.stage,'account_list');assert.equal(d.provider.request_id,'synthetic-google-request');return e.code==='REAUTHORIZATION_ACCESS_FAILED';});assert.deepEqual(store.credentials('local',connection.id),credentials);}finally{store.close();}
});

test('reauthorization respects concurrent grant revocation and never adds newly discovered accounts',async()=>{
 const store=fixture();let changed=false;try{
  const next=await renew(store,async(url,init)=>{if(!changed){changed=true;store.putConnection(actor,{...connection,accounts:[],writeAccounts:[],enabled:false},credentials);}return available()(url,init);});
  assert.deepEqual(next.accounts,[]);assert.deepEqual(next.writeAccounts,[]);assert.equal(next.enabled,false);assert.deepEqual(store.document('local','website_assets',connection.id).selected,[]);
 }finally{store.close();}
});

test('disconnect, session revocation and concurrent reauthorization cannot be undone by a delayed completion',async()=>{
 for(const mode of ['disconnect','session','revision'] as const){
  const store=fixture();let active=true,changed=false;try{
   const fetcher:typeof fetch=async(url,init)=>{if(!changed){changed=true;if(mode==='disconnect')store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run('local',connection.id);else if(mode==='session')active=false;else store.putDocument('local','website_connection',connection.id,{authorizationRevision:'newer-authorization'});}return available()(url,init);};
   await assert.rejects(()=>renew(store,fetcher,{assertActive:()=>{if(!active)throw new MirrorError('SIGN_IN_REQUIRED','Session ended.',{},401);}}),(e:MirrorError)=>e.code===({disconnect:'CONNECTION_NOT_FOUND',session:'SIGN_IN_REQUIRED',revision:'CONNECTION_CHANGED'}[mode]));
   if(mode==='disconnect')assert.equal(store.listConnections('local').length,0);else assert.deepEqual(store.credentials('local',connection.id),credentials);
  }finally{store.close();}
 }
});

test('reauthorization requires reporting scope and offline access, and coordinates with active token refresh',async()=>{
 const store=fixture();try{
  for(const extra of [{scopes:['openid']},{credentials:{...fresh,refreshToken:undefined}}]){let calls=0;await assert.rejects(()=>renew(store,async()=>{calls++;throw Error('No egress expected');},extra));assert.equal(calls,0);}
  const lock='refresh:'+scopeKey('local',connection.id);assert.equal(store.acquireLock(lock,'another-refresh',45000),true);
  await assert.rejects(()=>renew(store),(e:MirrorError)=>e.code==='REFRESH_IN_PROGRESS');assert.deepEqual(store.credentials('local',connection.id),credentials);
 }finally{store.close();}
});

async function website(denyFresh=false){
 const store=fixture(),env={AMCP_GOOGLE_CLIENT_ID:clientId,AMCP_GOOGLE_CLIENT_SECRET:credentials.clientSecret},calls:JsonObject[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const u=new URL(String(url));calls.push({url:String(url),method:init?.method,body:init?.body,authorization:new Headers(init?.headers).get('Authorization')});
  if(u.href==='https://oauth2.googleapis.com/token'){assert.equal(new URLSearchParams(String(init?.body)).get('client_id'),clientId);return Response.json({access_token:fresh.accessToken,refresh_token:fresh.refreshToken,expires_in:3600,scope:googleAdsScope});}
  if(u.pathname.endsWith(':listAccessibleCustomers'))return Response.json({resourceNames:['customers/100']});
  if(denyFresh||new Headers(init?.headers).get('Authorization')==='Bearer old-access-token')return Response.json(failure,{status:403});
  return available()(url,init);
 };
 const service=new MirrorService(new Registry(),store,undefined,strictOptions,{...readOnlyPolicy,allowWrites:true}),app=createHttpApp(service,store,{website:{origin,masterKey:key,adminPassword:password,fetcher,authEnv:env}}),server=await listenForFetch(app);
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const request=async(url:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+url,{method,redirect:'manual',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),bytes=await r.arrayBuffer();return new Response(bytes,{status:r.status,headers:r.headers});};
 const login=await request('/api/session','POST',{password}),cookie=login.headers.get('set-cookie')!.split(';')[0]!,csrf=(await login.json()).csrf,headers={Cookie:cookie,'X-AMCP-CSRF':csrf};
 const start=async()=>{const r=await request('/api/connections/'+connection.id+'/reauthorize','POST',undefined,headers);assert.equal(r.status,200);return await r.json() as JsonObject;};
 const callback=(state:string,code='synthetic-authorization-code',other=headers)=>request('/api/auth/google/callback?'+new URLSearchParams({state,code}),'GET',undefined,other);
 return {store,request,headers,calls,start,callback,env,close:async()=>{const end=new Promise<void>(r=>server.close(()=>r()));server.closeAllConnections();await end;store.close();}};
}

test('website Sync retains old authorization; Reauthorize uses consent, account choice, state and PKCE and updates the same connection',async()=>{
 const s=await website();try{
  const sync=await (await s.request('/api/connections/'+connection.id+'/sync','POST',{},s.headers)).json();assert.equal(sync.status,'attention');assert.equal(sync.authorization.matchesCurrentClient,true);assert.equal(s.calls.some(c=>c.url.includes('/token')),false);
  const started=await s.start(),url=new URL(started.url);assert.equal(url.searchParams.get('prompt'),'consent select_account');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
  const returned=await s.callback(url.searchParams.get('state')!);assert.equal(returned.status,303);
  const token=s.calls.find(c=>c.url.includes('/token'))!,verifier=new URLSearchParams(String(token.body)).get('code_verifier')!;assert.equal(createHash('sha256').update(verifier).digest('base64url'),url.searchParams.get('code_challenge'));
  const progress=await (await s.request('/api/oauth/progress/'+started.attemptId,'GET',undefined,s.headers)).json();assert.equal(progress.state,'complete');assert.equal(progress.connectionId,connection.id);
  assert.equal(s.store.listConnections('local').length,1);assert.deepEqual(s.store.listConnections('local')[0]!.writeAccounts,['100']);assert.equal(s.store.credentials('local',connection.id).accessToken,fresh.accessToken);
  assert.equal((await s.callback(url.searchParams.get('state')!)).status,400);
  const syncAgain=await (await s.request('/api/connections/'+connection.id+'/sync','POST',{},s.headers)).json();assert.equal(syncAgain.error,null);
  assert.ok(!JSON.stringify({sync,progress,syncAgain}).includes('access-token'));assert.ok(!JSON.stringify({sync,progress,syncAgain}).includes(credentials.clientSecret!));
 }finally{await s.close();}
});

test('reauthorization start requires session, CSRF, administrator and the current tenant; OAuth client changes are rejected',async()=>{
 const s=await website();try{
  const route='/api/connections/'+connection.id+'/reauthorize';assert.equal((await s.request(route,'POST')).status,401);assert.equal((await s.request(route,'POST',{}, {Cookie:s.headers.Cookie})).status,403);
  const row=s.store.db.prepare('SELECT hash,actor FROM amcp_web_sessions').get() as {hash:string;actor:string};
  s.store.db.prepare('UPDATE amcp_web_sessions SET actor=? WHERE hash=?').run(JSON.stringify({...JSON.parse(row.actor),role:'reader'}),row.hash);
  assert.equal((await s.request(route,'POST',{},s.headers)).status,403);s.store.db.prepare('UPDATE amcp_web_sessions SET actor=? WHERE hash=?').run(row.actor,row.hash);
  s.store.putConnection({tenantId:'other',userId:'owner',role:'admin'},{...connection,id:'other-google',tenantId:'other'},credentials);assert.equal((await s.request('/api/connections/other-google/reauthorize','POST',{},s.headers)).status,404);
  const started=await s.start();s.env.AMCP_GOOGLE_CLIENT_ID='200-changed.apps.googleusercontent.com';await s.callback(new URL(started.url).searchParams.get('state')!);
  const progress=await (await s.request('/api/oauth/progress/'+started.attemptId,'GET',undefined,s.headers)).json();assert.equal(progress.state,'failed');assert.match(progress.message,/client changed/);assert.equal(s.calls.length,0);assert.deepEqual(s.store.credentials('local',connection.id),credentials);
 }finally{await s.close();}
});

test('reauthorization cannot be completed from another session, and cancelled consent retains the saved connection',async()=>{
 const s=await website();try{
  const started=await s.start(),state=new URL(started.url).searchParams.get('state')!,other=await s.request('/api/session','POST',{password});const otherHeaders={...s.headers,Cookie:other.headers.get('set-cookie')!.split(';')[0]!};await other.arrayBuffer();
  assert.equal((await s.callback(state,'synthetic-code',otherHeaders)).status,400);assert.equal(s.calls.length,0);
  assert.equal((await s.request('/api/auth/google/callback?'+new URLSearchParams({state,error:'access_denied'}),'GET',undefined,s.headers)).status,303);
  const progress=await (await s.request('/api/oauth/progress/'+started.attemptId,'GET',undefined,s.headers)).json();assert.equal(progress.state,'failed');assert.match(progress.message,/cancelled/);assert.equal(s.calls.length,0);assert.deepEqual(s.store.credentials('local',connection.id),credentials);
 }finally{await s.close();}
});

test('a fresh 403 remains visible with its request ID on the callback and never replaces old credentials',async()=>{
 const s=await website(true);try{const started=await s.start();await s.callback(new URL(started.url).searchParams.get('state')!);const progress=await (await s.request('/api/oauth/progress/'+started.attemptId,'GET',undefined,s.headers)).json();assert.equal(progress.state,'failed');assert.equal(progress.diagnostics[0].provider.code,'AUTHORIZATION_ERROR');assert.equal(progress.diagnostics[0].provider.request_id,'synthetic-google-request');assert.equal(progress.connectionId,connection.id);assert.deepEqual(s.store.credentials('local',connection.id),credentials);}finally{await s.close();}
});

test('Google UI explains Sync versus Reauthorize, escapes client IDs and reports sync failures instead of generic success',async()=>{
 const app=readFileSync('web/app.js','utf8'),esc=(v:unknown)=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),messages:string[]=[];
 const context=createContext({esc,date:()=> 'Synthetic date',currentConnection:'different-login',refresh:async()=>{},toast:(m:string)=>messages.push(m),api:async()=>({error:'denied',groups:[{diagnostics:[{provider:{code:'AUTHORIZATION_ERROR'}}]}]})});
 for(const name of ['renderConnectionSyncStatus','renderGoogleAuthorization','syncConnection']){let start=app.indexOf('function '+name+'(');if(name==='syncConnection')start-=6;const end=app.indexOf('\n}',start)+2;new Script(app.slice(start,end)).runInContext(context);}
 context.connection={authorization:{clientId:'<img onerror=attack>',matchesCurrentClient:false,adsScopeRecorded:false}};
 const html=new Script('renderGoogleAuthorization(connection)').runInContext(context);assert.match(html,/differs/);assert.match(html,/Sync reloads/);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));
 await new Script('syncConnection("clicked-login",["ad_accounts"])').runInContext(context);assert.equal(context.currentConnection,'clicked-login');assert.match(messages[0]!,/needs attention.*AUTHORIZATION_ERROR/);
  assert.match(app,/data-reauthorize/);
 context.failedSync={lastSync:1,error:'Denied',groups:[{diagnostics:[{provider:{code:'AUTHORIZATION_ERROR'}}]}]};
 const status=new Script('renderConnectionSyncStatus(failedSync)').runInContext(context);assert.match(status,/role="status"/);assert.match(status,/Sync needs attention.*AUTHORIZATION_ERROR/);assert.match(app,/renderConnectionSyncStatus\(c\)/);
});
