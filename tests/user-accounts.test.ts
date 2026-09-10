import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {SignJWT,exportJWK} from 'jose';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts,hashUserPassword} from '../server/user-accounts.js';
import {McpOAuth} from '../server/mcp-oauth.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
const master=Buffer.alloc(32,65).toString('base64'),password='synthetic-member-password',origin='https://amcp.shop';
const key=generateKeyPairSync('rsa',{modulusLength:2048}),json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
async function fixture(extra:NodeJS.ProcessEnv={}){
 const store=new Store(':memory:',master),env:NodeJS.ProcessEnv={AMCP_EMAIL_API_KEY:'synthetic-mail-secret',AMCP_EMAIL_FROM:'AMCP <accounts@example.test>',AMCP_SIGNIN_GOOGLE_CLIENT_ID:'google-client',AMCP_SIGNIN_GOOGLE_CLIENT_SECRET:'google-secret',AMCP_SIGNIN_APPLE_CLIENT_ID:'apple-client',AMCP_SIGNIN_APPLE_CLIENT_SECRET:'synthetic-apple-secret',AMCP_SIGNIN_FACEBOOK_CLIENT_ID:'facebook-client',AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET:'facebook-secret',...extra};
 const web=new WebStore(store,{origin,masterKey:master,adminPassword:password,authEnv:env}),accounts=new UserAccounts(web),calls:{url:string;init:RequestInit}[]=[],emails:JsonObject[]=[],state={nonce:'',subject:'person-1',email:'member@example.test',invalid:''};
 const jwk={...await exportJWK(key.publicKey),alg:'RS256',kid:'test-key',use:'sig'};
 const fetcher:typeof fetch=async(url,init={})=>{const u=new URL(String(url));calls.push({url:u.href,init});if(u.href==='https://api.resend.com/emails'){emails.push(JSON.parse(String(init.body)));return json({id:'email-test'});}
  if(u.pathname.endsWith('/certs')||u.pathname.endsWith('/keys'))return json({keys:[jwk]});
  if(u.hostname==='graph.facebook.com'){if(u.pathname.endsWith('/access_token'))return json({access_token:'facebook-access-only'});return json({id:'123456',name:'Facebook member',email:'do-not-trust@example.test'});}
  if(u.hostname==='oauth2.googleapis.com'||u.hostname==='appleid.apple.com'){
   const apple=u.hostname==='appleid.apple.com',claims:JsonObject={nonce:state.invalid==='nonce'?'wrong':state.nonce,email:state.email,email_verified:true};if(state.invalid==='azp')claims.azp='another-client';
   const token=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(state.invalid==='issuer'?'https://attacker.invalid':apple?'https://appleid.apple.com':'https://accounts.google.com').setAudience(state.invalid==='audience'?'another-client':apple?'apple-client':'google-client').setSubject(state.subject).setIssuedAt().setExpirationTime(state.invalid==='expired'?Math.floor(Date.now()/1000)-60:'5m').sign(key.privateKey);
   return json({access_token:'social-access-only',id_token:state.invalid==='signature'?token.slice(0,-8)+'invalidx':token});
  }throw Error('Unexpected provider egress '+u.origin);
 };
 const service=new MirrorService(new Registry(),store),listener=createHttpApp(service,store,{website:{origin,masterKey:master,adminPassword:password,authEnv:env,fetcher}}).listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 const request=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined}),bytes=await r.arrayBuffer();return new Response(bytes,{status:r.status,headers:r.headers});};
 const create=async(email='member@example.test')=>store.transaction(()=>accounts.newUser('Test member',email,null));
 const credentials=(s:ReturnType<WebStore['createSession']>)=>({Cookie:web.cookie(s.id),'X-AMCP-CSRF':s.csrf});
 const signup=async(email='member@example.test')=>{assert.equal((await request('/api/account/register','POST',{name:'Test member',email})).status,200);const link=/https:\/\/\S+/.exec(emails.at(-1)!.text)![0]!,params=new URLSearchParams(new URL(link).hash.slice(1));return {token:params.get('token'),kind:'register',password};};
 const login=async(email='member@example.test')=>{const r=await request('/api/account/login','POST',{email,password});assert.equal(r.status,200);return {Cookie:r.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':(await r.json()).csrf};};
 const begin=async(provider:string,headers:Record<string,string>={},link=false)=>{const r=await request('/api/signin/'+provider+'/start','POST',{link},headers);assert.equal(r.status,200);const url=new URL((await r.json()).url);state.nonce=url.searchParams.get('nonce')??'';return {url,flow:r.headers.get('set-cookie')!.split(';')[0]!,state:url.searchParams.get('state')!};};
 const callback=async(provider:string,start:{flow:string;state:string},extra:Record<string,string>={})=>{
  if(provider==='apple'){const r=await fetch(base+'/api/signin/apple/callback',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:start.flow,Origin:'https://appleid.apple.com',...extra},body:new URLSearchParams({state:start.state,code:'synthetic-code'})}),bytes=await r.arrayBuffer();return new Response(bytes,{status:r.status,headers:r.headers});}
  return request('/api/signin/'+provider+'/callback?'+new URLSearchParams({state:start.state,code:'synthetic-code'}),'GET',undefined,{Cookie:start.flow,...extra});
 };
 return {store,web,accounts,env,state,calls,emails,request,create,credentials,signup,login,begin,callback,close:async()=>{const p=new Promise<void>(r=>listener.close(()=>r()));listener.closeAllConnections();await p;store.close();}};
}
test('email registration verifies ownership before choosing a password; isolated member sign-in is persistent and CSRF protected',async()=>{
 const f=await fixture();try{
  const link=await f.signup();assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n,0);
  const records=JSON.stringify(f.store.db.prepare('SELECT * FROM amcp_account_challenges').all());assert.ok(!records.includes(link.token!)&&!records.includes('member@example.test'));
  assert.equal((await f.request('/api/account/verify-email','POST',link)).status,200);assert.equal((await f.request('/api/account/verify-email','POST',link)).status,400);
  const headers=await f.login(),s=await (await f.request('/api/session','GET',undefined,headers)).json();assert.equal(s.name,'Test member');assert.equal(s.administrator,false);assert.equal(s.email,'member@example.test');assert.match(headers.Cookie,/__Host-amcp_session=/);
  assert.deepEqual((await (await f.request('/api/platforms','GET',undefined,headers)).json()).platforms.flatMap((p:JsonObject)=>p.connections),[]);
  const user=f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject;assert.notEqual(user.tenant_id,'local');assert.equal(user.password_hash.includes(password),false);
  assert.equal((await f.request('/api/account/profile','POST',{name:'New name',workspaceName:'My workspace'},{Cookie:headers.Cookie})).status,403);
  assert.equal((await f.request('/api/account/profile','POST',{name:'New name',workspaceName:'My workspace'},headers)).status,200);
  assert.equal((await (await f.request('/api/session','GET',undefined,headers)).json()).workspaceName,'My workspace');
  assert.equal((await f.request('/api/account/options')).headers.get('cache-control'),'no-store');
  assert.equal((await f.request('/api/account/login','POST',{email:user.email,password:'wrong'})).status,401);
 }finally{await f.close();}
});
test('reset links are single-use, expire, and revoke only their owner browser sessions and MCP credentials',async()=>{
 const f=await fixture();try{
  await f.request('/api/account/verify-email','POST',await f.signup());const headers=await f.login();const user=f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject,other=await f.create('other@example.test');
  const key1=f.store.createKey({tenantId:user.tenant_id,userId:'connector/one',role:'reader'},3600000),key2=f.store.createKey({tenantId:other.tenant_id,userId:'connector/two',role:'reader'},3600000);
  assert.equal((await f.request('/api/account/forgot-password','POST',{email:user.email})).status,200);const url=new URL(/https:\/\/\S+/.exec(f.emails.at(-1)!.text)![0]!),token=new URLSearchParams(url.hash.slice(1)).get('token');
  const input={kind:'reset',token,password:'a-new-long-password'};assert.equal((await f.request('/api/account/verify-email','POST',input)).status,200);
  assert.equal((await (await f.request('/api/session','GET',undefined,headers)).json()).authenticated,false);assert.throws(()=>f.store.authenticate(key1));assert.ok(f.store.authenticate(key2));assert.equal((await f.request('/api/account/verify-email','POST',input)).status,400);
  const expired=f.accounts.challenge('reset',{userId:user.id,version:2},-1);assert.throws(()=>f.accounts.readChallenge(expired,'reset'),/expired/);
 }finally{await f.close();}
});
test('Google, Apple form_post and Facebook sign-in bind a one-use state to the initiating browser and create private workspaces',async()=>{
 for(const provider of ['google','apple','facebook']){const f=await fixture();try{
  const start=await f.begin(provider);assert.equal(start.url.searchParams.get('redirect_uri'),origin+'/api/signin/'+provider+'/callback');if(provider==='google'){assert.equal(start.url.searchParams.get('code_challenge_method'),'S256');assert.equal(start.url.searchParams.get('code_challenge')?.length,43);}if(provider==='apple')assert.equal(start.url.searchParams.get('response_mode'),'form_post');
  const wrong=await f.callback(provider,start,{Cookie:'__Host-amcp_login_flow=wrong'});assert.match(wrong.headers.get('location')!,/SIGNIN_STATE_INVALID/);
  const r=await f.callback(provider,start);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/auth/complete');assert.match(r.headers.get('set-cookie')!,/HttpOnly; SameSite=Lax/);
  const user=f.store.db.prepare('SELECT * FROM amcp_users').get() as JsonObject;assert.notEqual(user.tenant_id,'local');assert.equal(user.email,provider==='facebook'?null:f.state.email);
  const data=JSON.stringify(f.store.db.prepare('SELECT * FROM amcp_identities').all());assert.ok(!data.includes('social-access-only')&&!data.includes('facebook-access-only'));
  assert.match((await f.callback(provider,start)).headers.get('location')!,/SIGNIN_FAILED/);
  const tokenCall=f.calls.find(c=>c.url.includes('/token')||c.url.includes('/access_token'))!;assert.equal(tokenCall.init.redirect,'error');assert.ok(new URLSearchParams(String(tokenCall.init.body)).get('client_secret'));
 }finally{await f.close();}}
});
test('signed identity validation rejects bad nonce, audience, issuer, expiry, authorized party and signature',async()=>{
 for(const invalid of ['nonce','audience','issuer','expired','azp','signature']){const f=await fixture();try{f.state.invalid=invalid;const r=await f.callback('google',await f.begin('google'));assert.match(r.headers.get('location')!,/SIGNIN_FAILED/);assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n,0);}finally{await f.close();}}
});
test('matching email never silently links identities; authenticated linking works and cannot remove the last sign-in method',async()=>{
 const f=await fixture();try{
  await f.request('/api/account/verify-email','POST',await f.signup());const existing=await f.callback('google',await f.begin('google'));assert.match(existing.headers.get('location')!,/ACCOUNT_EXISTS/);
  const headers=await f.login(),start=await f.begin('google',headers,true),r=await f.callback('google',start);assert.equal(r.headers.get('location'),'/account?linked=true');assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get() as JsonObject).n,1);
  const social=await f.callback('facebook',await f.begin('facebook')),cookie=social.headers.getSetCookie().find(c=>c.startsWith('__Host-amcp_session='))!.split(';')[0]!;
  const s=await (await f.request('/api/session','GET',undefined,{Cookie:cookie})).json();assert.equal((await f.request('/api/account/identities/facebook','DELETE',undefined,{Cookie:cookie,'X-AMCP-CSRF':s.csrf})).status,400);
 }finally{await f.close();}
});
test('member account sessions and server-owned credentials do not cross workspace boundaries',async()=>{
 const f=await fixture();try{
  const a=await f.create('a@example.test'),b=await f.create('b@example.test'),sa=f.accounts.session(a),sb=f.accounts.session(b),headers=f.credentials(sa),other=f.credentials(sb);
  const listed=await (await f.request('/api/account/sessions','GET',undefined,headers)).json(),foreign=await (await f.request('/api/account/sessions','GET',undefined,other)).json();assert.equal(listed.sessions.length,1);
  assert.equal((await f.request('/api/account/sessions/'+foreign.sessions[0].id,'DELETE',undefined,headers)).status,404);assert.equal((await f.request('/api/account/sessions/'+listed.sessions[0].id,'DELETE',undefined,headers)).status,200);
  assert.equal((await (await f.request('/api/session','GET',undefined,other)).json()).authenticated,true);
  const apple=await f.request('/api/auth/apple/start','POST',{},other);assert.equal(apple.status,403);assert.equal((await apple.json()).error.code,'SERVICE_CONNECTION_RESTRICTED');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test('MCP consent and refresh bind grants to the signed-in member workspace; tenant revocation cannot revoke another member',async()=>{
 const f=await fixture();try{
  const oauth=new McpOAuth(f.web,true),client=await oauth.clientsStore.registerClient({redirect_uris:['https://claude.ai/api/mcp/auth_callback'],token_endpoint_auth_method:'none'}),a=await f.create('a@example.test'),b=await f.create('b@example.test');
  const issue=async(user:JsonObject)=>{let redirect='';const verifier=randomBytes(32).toString('base64url');await oauth.authorize(client,{redirectUri:client.redirect_uris[0]!,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),scopes:['mcp:read'],resource:new URL(origin+'/mcp')},{redirect:(_n:number,u:string)=>redirect=u} as any);const request=new URL(redirect).searchParams.get('request')!,url=oauth.decide(request,f.accounts.session(user),true);return oauth.exchangeAuthorizationCode(client,new URL(url).searchParams.get('code')!,verifier,client.redirect_uris[0],new URL(origin+'/mcp'));};
  const first=await issue(a),second=await issue(b);assert.equal(f.store.authenticate(first.access_token).tenantId,a.tenant_id);assert.equal(f.store.authenticate(second.access_token).tenantId,b.tenant_id);assert.equal(oauth.authorizations('local').length,0);assert.equal(oauth.authorizations(a.tenant_id).length,1);
  oauth.revokeClient(client.client_id,a.tenant_id);assert.throws(()=>f.store.authenticate(first.access_token));assert.ok(f.store.authenticate(second.access_token));const next=await oauth.exchangeRefreshToken(client,second.refresh_token!);assert.equal(f.store.authenticate(next.access_token).tenantId,b.tenant_id);
 }finally{await f.close();}
});
test('account recovery and social signup fail closed without configured delivery or open registration',async()=>{
 const f=await fixture({AMCP_EMAIL_API_KEY:'',AMCP_ALLOW_SIGNUP:'false'});try{
  const options=await (await f.request('/api/account/options')).json();assert.equal(options.emailEnabled,false);assert.equal(options.signupEnabled,false);assert.ok(!JSON.stringify(options).includes('secret'));
  assert.equal((await f.request('/api/account/register','POST',{name:'Name',email:'test@example.test'})).status,403);assert.equal((await f.request('/api/account/forgot-password','POST',{email:'test@example.test'})).status,503);
  assert.match((await f.callback('google',await f.begin('google'))).headers.get('location')!,/SIGNUP_DISABLED/);assert.equal(f.emails.length,0);await assert.rejects(()=>hashUserPassword('short'),/15 and 128/);
 }finally{await f.close();}
});
test('closing registration invalidates outstanding signup links and signing out cancels a started member social flow',async()=>{
 const f=await fixture();try{
  const link=await f.signup();f.env.AMCP_ALLOW_SIGNUP='false';assert.equal((await f.request('/api/account/verify-email','POST',link)).status,403);f.env.AMCP_ALLOW_SIGNUP='true';
  await f.request('/api/account/verify-email','POST',link);const headers=await f.login(),start=await f.begin('google',headers,true);
  const logout=await f.request('/api/session','DELETE',undefined,headers);assert.equal(logout.status,200);assert.ok(logout.headers.getSetCookie().some(c=>c.includes('amcp_login_flow=;')&&c.includes('Max-Age=0')));
  assert.match((await f.callback('google',start)).headers.get('location')!,/SIGNIN_FAILED/);assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM amcp_identities').get() as JsonObject).n,0);
 }finally{await f.close();}
});
test('new public pages and branding assets serve with CSP, while account data requires a session',async()=>{
 const f=await fixture();try{
  for(const path of ['/','/connections','/account','/login','/signup','/verify-email','/reset-password','/forgot-password','/auth/complete','/assets/identity.js','/assets/identity.css','/assets/mark.svg']){const r=await f.request(path);assert.equal(r.status,200,path);assert.match(r.headers.get('content-security-policy')!,/script-src 'self'/);}
  for(const path of ['/api/account','/api/account/sessions'])assert.equal((await f.request(path)).status,401);
  assert.equal((await f.request('/api/account/register','POST',{name:'Test',email:'test@example.test'},{Origin:'https://attacker.invalid'})).status,403);
 }finally{await f.close();}
});
