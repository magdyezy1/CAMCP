import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {readOnlyPolicy} from '../src/preflight.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import {platforms} from '../server/platform-oauth.js';
import type {Actor,Connection,JsonObject} from '../src/types.js';

const master=Buffer.alloc(32,92).toString('base64'),origin='https://amcp.shop';
const password='synthetic-owner-password',testPassword='synthetic-reviewer-password';
const accountId='111',owner:Actor={tenantId:'local',userId:'workspace-admin',role:'admin'};
type Headers=Record<string,string>;

async function site(kind:'shared'|'named'='shared',allowWrites=false){
 const store=new Store(':memory:',master),authEnv:NodeJS.ProcessEnv={AMCP_MICROSOFT_DEVELOPER_TOKEN:'synthetic-developer-token'};
 for(const p of platforms){authEnv['AMCP_'+p.env+'_CLIENT_ID']='synthetic-'+p.id+'-client';authEnv['AMCP_'+p.env+'_CLIENT_SECRET']='synthetic-'+p.id+'-secret';}
 const calls:string[]=[],control={failDiscovery:false,beforeExchange:undefined as (()=>void)|undefined};
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push((init?.method??'GET')+' '+url.origin+url.pathname);
  if(url.origin==='https://api.x.com'&&url.pathname==='/oauth/request_token')return new Response('oauth_callback_confirmed=true&oauth_token=synthetic-request&oauth_token_secret=synthetic-request-secret');
  if(url.origin==='https://graph.facebook.com'){
   assert.equal(init?.method??'GET','GET','the connection flow must not mutate advertising resources');
   if(url.pathname==='/v25.0/oauth/access_token'){control.beforeExchange?.();return Response.json({access_token:'synthetic-meta-access',expires_in:3600});}
   if(url.pathname==='/v25.0/me/adaccounts')return control.failDiscovery?Response.json({error:{message:'Synthetic discovery unavailable',code:2}},{status:503}):Response.json({data:[{id:'act_'+accountId,account_id:accountId,name:'Reviewer ad account',currency:'USD',timezone_name:'UTC'}]});
   if(url.pathname==='/v25.0/me')return Response.json({id:'reviewer-provider-user',name:'Reviewer platform login'});
  }
  if(url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token')return Response.json({access_token:'synthetic-google-access',refresh_token:'synthetic-google-refresh',expires_in:3600});
  if(url.origin==='https://googleads.googleapis.com'){
   if(url.pathname.endsWith(':listAccessibleCustomers'))return Response.json({resourceNames:['customers/'+accountId]});
   assert.match(String(init?.body),/FROM customer"/);
   return Response.json({results:[{customer:{id:accountId,descriptiveName:'Reviewer Google account',manager:false,status:'ENABLED',currencyCode:'USD',timeZone:'UTC'}}]});
  }
  throw Error('Unexpected synthetic provider route: '+url.origin+url.pathname);
 };
 const options={origin,masterKey:master,adminPassword:password,testPassword,authEnv,fetcher};
 const web=new WebStore(store,options),accounts=new UserAccounts(web);
 const service=new MirrorService(new Registry(),store,undefined,undefined,{...readOnlyPolicy,allowWrites});
 const listener=createHttpApp(service,store,{website:options}).listen(0,'127.0.0.1');
 await new Promise<void>(r=>listener.once('listening',r));
 const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 const request=async(path:string,method='GET',body?:unknown,headers:Headers={})=>{
  const r=await fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const bytes=await r.arrayBuffer();return new Response([204,205,304].includes(r.status)?null:bytes,{status:r.status,headers:r.headers});
 };
 const sessionHeaders=(s:ReturnType<WebStore['createSession']>)=>({Cookie:web.cookie(s.id).split(';')[0]!,'X-AMCP-CSRF':s.csrf});
 const sharedLogin=async()=>{
  const r=await request('/api/session/test','POST',{password:testPassword});assert.equal(r.status,200);
  return {Cookie:r.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':(await r.json()).csrf} as Headers;
 };
 const user=kind==='named'?store.transaction(()=>accounts.newUser('Invited reviewer','reviewer@example.test',null,true,true)):undefined;
 const headers=kind==='shared'?await sharedLogin():sessionHeaders(accounts.session(user!));
 const profile=await (await request('/api/account','GET',undefined,headers)).json();assert.equal(profile.testAccount,true);
 const actor:Actor={tenantId:profile.workspaceId,userId:user?.id??'workspace-test',role:'admin',testAccount:true};
 const ownerHeaders=sessionHeaders(web.createSession(owner));
 const start=async(platform='meta',route='/api/auth/'+platform+'/start')=>{
  const r=await request(route,'POST',{},headers);assert.equal(r.status,200,await r.clone().text());return await r.json() as {url:string;attemptId:string};
 };
 const complete=async(attempt:{url:string;attemptId:string},platform='meta',alias=false)=>{
  const state=new URL(attempt.url).searchParams.get('state')!;
  const path=(alias?'/api/'+platform+'/callback':'/api/auth/'+platform+'/callback')+'?'+new URLSearchParams({state,code:'synthetic-code'});
  const r=await request(path,'GET',undefined,headers);assert.equal(r.status,303,await r.clone().text());
  assert.equal(r.headers.get('location'),'/oauth/result?attempt='+attempt.attemptId);
  const progress=await request('/api/oauth/progress/'+attempt.attemptId,'GET',undefined,headers);assert.equal(progress.status,200);
  return await progress.json() as JsonObject;
 };
 const seed=(target:Actor,id:string,gateway='meta_native_action')=>{
  const c:Connection={id,tenantId:target.tenantId,gateway,accounts:[accountId],enabled:true,label:'Scoped login',isDefault:true,writeAccounts:[],scopes:gateway==='google_ads_native_action'?['https://www.googleapis.com/auth/adwords']:['ads_read']};
  store.putConnection(target,c,{accessToken:'synthetic-seeded-token',refreshToken:'synthetic-seeded-refresh',expiresAt:Date.now()+3600000});return c;
 };
 return {store,web,actor,headers,ownerHeaders,sharedLogin,request,start,complete,seed,calls,control,close:async()=>{const closed=new Promise<void>(r=>listener.close(()=>r()));listener.closeAllConnections();await closed;store.close();}};
}

for(const kind of ['shared','named'] as const)test(kind+' test accounts can complete and manage isolated platform connections',async()=>{
 const s=await site(kind);try{
  const firstAttempt=await s.start(),first=await s.complete(firstAttempt);assert.equal(first.state,'complete');
  const id=first.connectionId as string,route='/api/connections/'+id;
  const details=await (await s.request(route,'GET',undefined,s.headers)).json();
  assert.equal(details.name,'Reviewer platform login');assert.equal(details.status,'selection_required');
  assert.deepEqual(details.accounts,[]);assert.equal(details.groups[0].complete,true);assert.equal(details.groups[0].assets[0].id,accountId);
  assert.doesNotMatch(JSON.stringify(details),/synthetic-meta-access|clientSecret|refreshToken/);
  assert.equal((await s.request(route+'/assets','PATCH',{selected:['ad_accounts:unknown']},s.headers)).status,409);
  const selected=await s.request(route+'/assets','PATCH',{selected:['ad_accounts:'+accountId]},s.headers);
  assert.equal(selected.status,200);assert.equal((await selected.json()).status,'connected');
  assert.equal((await s.request(route+'/sync','POST',{},s.headers)).status,200);
  // A duplicate connection ID and account ID in the owner workspace cannot redirect a mutation.
  s.seed(owner,id);s.seed(owner,'owner-only');
  s.store.putDocument(owner.tenantId,'oauth_progress','owner-progress',{state:'complete',connectionId:'owner-only'});
  const ownerBefore=JSON.stringify(s.store.listConnections(owner.tenantId));
  const second=await s.complete(await s.start(),'meta',true);assert.equal(second.state,'complete');assert.notEqual(second.connectionId,id);
  const secondRoute='/api/connections/'+second.connectionId;
  assert.equal((await s.request(secondRoute+'/default','POST',{},s.headers)).status,200);
  assert.equal(s.store.listConnections(s.actor.tenantId).find(c=>c.id===second.connectionId)?.isDefault,true);
  assert.equal(s.store.listConnections(s.actor.tenantId).find(c=>c.id===id)?.isDefault,false);
  const forbidden:[string,string][]=[['GET',''],['DELETE',''],['POST','/sync'],['POST','/reauthorize'],['POST','/default'],['PATCH','/assets'],['PATCH','/write-access']];
  const before=s.calls.length;
  for(const [method,suffix] of forbidden){
   const r=await s.request('/api/connections/owner-only'+suffix,method,method==='GET'?undefined:{},s.headers);
   assert.equal(r.status,404,method+' '+suffix);assert.equal((await r.json()).error.code,'CONNECTION_NOT_FOUND');
  }
  assert.equal(s.calls.length,before,'cross-workspace requests must not reach any provider');
  assert.equal((await s.request('/api/oauth/progress/owner-progress','GET',undefined,s.headers)).status,404);
  assert.equal((await s.request('/api/oauth/progress/'+firstAttempt.attemptId,'GET',undefined,s.ownerHeaders)).status,404);
  const listed=await (await s.request('/api/platforms','GET',undefined,s.headers)).json();
  assert.deepEqual(listed.platforms.find((p:JsonObject)=>p.id==='meta').connections.map((c:JsonObject)=>c.id).sort(),[id,second.connectionId].sort());
  assert.equal((await s.request(route,'DELETE',undefined,s.headers)).status,200);
  assert.equal((await s.request(route,'GET',undefined,s.headers)).status,404);
  assert.equal((await s.request(secondRoute,'DELETE',undefined,s.headers)).status,200);
  assert.deepEqual(s.store.listConnections(s.actor.tenantId),[]);
  assert.equal(JSON.stringify(s.store.listConnections(owner.tenantId)),ownerBefore,'owner connections survive test selection/default/disconnect');
 }finally{await s.close();}
});

test('test accounts can start every browser OAuth platform, while server-owned Apple credentials stay restricted',async()=>{
 const s=await site();try{
  for(const p of platforms.filter(p=>!p.authType)){
   const started=await s.start(p.id);assert.equal(new URL(started.url).origin,new URL(p.authorize).origin,p.id);
   const progress=await s.request('/api/oauth/progress/'+started.attemptId,'GET',undefined,s.headers);
   assert.equal(progress.status,200);assert.equal((await progress.json()).state,'authorization');
   const callback=await s.request('/api/auth/'+p.id+'/callback?state=invalid&code=synthetic','GET',undefined,s.headers);
   assert.equal(callback.status,400);assert.equal((await callback.json()).error.code,'OAUTH_STATE_INVALID',p.id);
  }
  const count=s.calls.length,apple=await s.request('/api/auth/apple/start','POST',{},s.headers);
  assert.equal(apple.status,403);assert.equal((await apple.json()).error.code,'SERVICE_CONNECTION_RESTRICTED');assert.equal(s.calls.length,count);
 }finally{await s.close();}
});

test('test connection authorization still requires origin, CSRF, the initiating session and single-use state',async()=>{
 const s=await site();try{
  const invalidHeaders:Headers[]=[{},{Cookie:s.headers.Cookie!},{...s.headers,Origin:'https://other.example'}];
  for(const headers of invalidHeaders){
   const r=await s.request('/api/auth/meta/start','POST',{},headers);assert.ok([401,403].includes(r.status));
  }
  for(const path of ['/API/auth/meta/start','/api/AUTH/meta/start'])assert.equal((await s.request(path,'POST',{},s.headers)).status,404);
  assert.equal(s.calls.length,0);assert.equal((s.store.db.prepare('SELECT count(*) AS n FROM amcp_oauth_states').get() as JsonObject).n,0);
  const attempt=await s.start(),state=new URL(attempt.url).searchParams.get('state')!;
  const callback='/api/auth/meta/callback?'+new URLSearchParams({state,code:'synthetic-code'});
  for(const headers of [s.ownerHeaders,await s.sharedLogin()]){
   const r=await s.request(callback,'GET',undefined,headers);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'OAUTH_STATE_INVALID');
  }
  assert.equal(s.calls.length,0,'a different session cannot consume or exchange the code');
  const result=await s.complete(attempt);assert.equal(result.state,'complete');
  const count=s.calls.length,replayed=await s.request(callback,'GET',undefined,s.headers);
  assert.equal(replayed.status,400);assert.equal((await replayed.json()).error.code,'OAUTH_STATE_INVALID');assert.equal(s.calls.length,count);
  for(const [method,suffix] of [['POST','/sync'],['POST','/default'],['POST','/reauthorize'],['PATCH','/assets'],['PATCH','/write-access'],['DELETE','']]){
   const r=await s.request('/api/connections/'+result.connectionId+suffix,method,{}, {Cookie:s.headers.Cookie!});
   assert.equal(r.status,403);assert.equal((await r.json()).error.code,'CSRF_INVALID');
  }
 }finally{await s.close();}
});

test('test accounts can reauthorize Google in place and preserve selected accounts and report references',async()=>{
 const s=await site();try{
  const c=s.seed(s.actor,'reviewer-google','google_ads_native_action');
  const report={config:{sources:[{connection_id:c.id,account_id:accountId}]}};
  s.store.putDocument(s.actor.tenantId,'overview_report','saved-report',report);
  const storedReport=s.store.document(s.actor.tenantId,'overview_report','saved-report');
  const attempt=await s.start('google','/api/connections/'+c.id+'/reauthorize');
  assert.equal(new URL(attempt.url).searchParams.get('prompt'),'consent select_account');
  const result=await s.complete(attempt,'google');assert.equal(result.state,'complete');assert.equal(result.connectionId,c.id);
  assert.deepEqual(s.store.listConnections(s.actor.tenantId).map(c=>({id:c.id,accounts:c.accounts})),[{id:c.id,accounts:[accountId]}]);
  assert.deepEqual(s.store.document(s.actor.tenantId,'overview_report','saved-report'),storedReport);
 }finally{await s.close();}
});

for(const allowWrites of [false,true])test('test connection grants retain deployment controls with writes '+allowWrites,async()=>{
 const s=await site('shared',allowWrites);try{
  const progress=await s.complete(await s.start()),route='/api/connections/'+progress.connectionId;
  assert.equal((await s.request(route+'/assets','PATCH',{selected:['ad_accounts:'+accountId],write_access:false},s.headers)).status,200);
  const grant=await s.request(route+'/write-access','PATCH',{accounts:[accountId],confirmed:true},s.headers);
  assert.equal(grant.status,allowWrites?200:403);
  if(allowWrites){
   assert.deepEqual((await grant.json()).writeAccounts,[accountId]);
   assert.equal((await s.request(route+'/write-access','PATCH',{accounts:[accountId]},s.headers)).status,400);
   assert.equal((await s.request(route+'/write-access','PATCH',{accounts:['other'],confirmed:true},s.headers)).status,403);
  }else{
   assert.equal((await grant.json()).error.code,'WRITES_DISABLED');
   assert.equal((await s.request(route+'/assets','PATCH',{selected:['ad_accounts:'+accountId],write_access:true},s.headers)).status,403);
  }
  const revoked=await s.request(route+'/write-access','PATCH',{accounts:[]},s.headers);assert.equal(revoked.status,200);assert.deepEqual((await revoked.json()).writeAccounts,[]);
  for(const path of ['/api/workspace/write','/api/workspace/campaign','/api/workspace/media','/api/connector-tokens','/api/mcp/consent']){
   const r=await s.request(path,'POST',{},s.headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'TEST_ACCOUNT_SCOPE');
  }
 }finally{await s.close();}
});

test('a test account can see discovery failure and recover with sync without losing the connection',async()=>{
 const s=await site();try{
  s.control.failDiscovery=true;const progress=await s.complete(await s.start());
  assert.equal(progress.state,'sync_attention');assert.equal(progress.exchange,true);assert.equal(progress.sync,false);
  assert.equal(s.store.listConnections(s.actor.tenantId).length,1);
  s.control.failDiscovery=false;
  const response=await s.request('/api/connections/'+progress.connectionId+'/sync','POST',{},s.headers);assert.equal(response.status,200);
  const recovered=await response.json();assert.equal(recovered.error,null);assert.equal(recovered.groups[0].complete,true);assert.equal(recovered.groups[0].assets[0].id,accountId);
 }finally{await s.close();}
});

test('a revoked test session cannot create a connection after token exchange',async()=>{
 const s=await site();try{
  const attempt=await s.start();s.control.beforeExchange=()=>s.web.signOut(s.headers.Cookie!.split('=')[1]!);
  const state=new URL(attempt.url).searchParams.get('state')!;
  assert.equal((await s.request('/api/auth/meta/callback?'+new URLSearchParams({state,code:'synthetic'}),'GET',undefined,s.headers)).status,303);
  assert.deepEqual(s.store.listConnections(s.actor.tenantId),[]);
  assert.equal((await s.request('/api/oauth/progress/'+attempt.attemptId,'GET',undefined,s.headers)).status,401);
  assert.ok(s.calls.every(call=>call.endsWith('/oauth/access_token')),'revocation must stop discovery');
 }finally{await s.close();}
});

test('named test workspace viewers cannot initiate or manage connections',async()=>{
 const s=await site('named');try{
  s.seed(s.actor,'reviewer-meta');
  s.store.db.prepare("UPDATE workspace_memberships SET role='viewer' WHERE tenant_id=? AND user_id=?").run(s.actor.tenantId,s.actor.userId);
  for(const [method,path] of [['POST','/api/auth/meta/start'],['POST','/api/connections/reviewer-meta/sync'],['PATCH','/api/connections/reviewer-meta/assets'],['DELETE','/api/connections/reviewer-meta']]){
   const r=await s.request(path!,method,{},s.headers);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'FORBIDDEN');
  }
  assert.equal(s.calls.length,0);assert.equal(s.store.listConnections(s.actor.tenantId).length,1);
 }finally{await s.close();}
});
