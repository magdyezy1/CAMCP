import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore,checkPassword,passwordHash} from '../server/web-store.js';
import {PlatformOAuth,platforms} from '../server/platform-oauth.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {sha256} from '../src/security.js';
import type {Connection} from '../src/types.js';
const master=Buffer.alloc(32,77).toString('base64'),password='synthetic-test-password-only',origin='https://amcp.shop';
const owner={tenantId:'local',userId:'tester',role:'admin' as const};
const c:Connection={id:'synthetic-meta',tenantId:'local',gateway:'meta_native_action',accounts:['111'],enabled:true,label:'Test login',scopes:['ads_read'],isDefault:true};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const blocked:typeof fetch=async()=>{throw Error('Unexpected vendor egress');};
async function site(fetcher:typeof fetch=blocked){
 const store=new Store(':memory:',master),service=new MirrorService(new Registry(),store),listener=await listenForFetch(createHttpApp(service,store,{website:{origin,masterKey:master,adminPassword:password,fetcher}}));
 const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 // Consume each network body before fixture teardown; leaving it unread can race
 // socket shutdown in Node's HTTP parser. Return a detached response to assertions.
 const request=async(url:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{
  const response=await fetch(base+url,{method,redirect:'manual',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),bytes=await response.arrayBuffer();
  return new Response([204,205,304].includes(response.status)?null:bytes,{status:response.status,headers:response.headers});
 };
 const login=await request('/api/session','POST',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0]!,csrf=(await login.json()).csrf,headers={Cookie:cookie,'X-AMCP-CSRF':csrf};
 return {store,request,headers,base,close:async()=>{const closed=new Promise<void>(r=>listener.close(()=>r()));listener.closeAllConnections();await closed;store.close();}};
}
test('website passwords, session cookies, origin, CSRF, expiry and encrypted single-use OAuth state',()=>{
 const store=new Store(':memory:',master),web=new WebStore(store,{origin,masterKey:master,adminPassword:password});
 try{
  assert.ok(checkPassword(password,passwordHash(password)));assert.equal(checkPassword('wrong',passwordHash(password)),false);
  const session=web.signIn(password,'127.0.0.1'),req={headers:{cookie:web.cookie(session.id),origin,'x-amcp-csrf':session.csrf}} as unknown as Request;
  assert.equal(web.requireMutation(req).actor.tenantId,'local');assert.match(web.cookie(session.id),/HttpOnly; SameSite=Lax.*Secure/);
  assert.throws(()=>web.requireMutation({headers:{...req.headers,'x-amcp-csrf':'wrong'}} as unknown as Request));
  assert.throws(()=>web.requireMutation({headers:{...req.headers,origin:'https://evil.invalid'}} as Request));
  const state=web.beginOAuth(session,'meta',{privateValue:'synthetic-state-secret'}),other=web.signIn(password,'127.0.0.2');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM amcp_oauth_states').all()).includes('synthetic-state-secret'));
  assert.throws(()=>web.consumeOAuth(other,'meta',state));assert.throws(()=>web.consumeOAuth(session,'google',state));
  assert.equal(web.consumeOAuth(session,'meta',state).privateValue,'synthetic-state-secret');assert.throws(()=>web.consumeOAuth(session,'meta',state));
  const expired=web.beginOAuth(session,'meta',{});store.db.prepare('UPDATE amcp_oauth_states SET expires_at=0').run();assert.throws(()=>web.consumeOAuth(session,'meta',expired));
  store.db.prepare('UPDATE amcp_web_sessions SET expires_at=0 WHERE hash=?').run(sha256(session.id));assert.equal(web.session(req),undefined);
 }finally{store.close();}
});
test('failed login attempts are bounded and missing setup fails closed',()=>{
 const store=new Store(':memory:');try{const web=new WebStore(store,{origin,adminPassword:password});for(let i=0;i<8;i++)assert.throws(()=>web.signIn('wrong','peer'),/incorrect/);assert.throws(()=>web.signIn(password,'peer'),/Too many/);assert.throws(()=>new WebStore(store,{origin}).signIn(password,'new'),/Configure/);}finally{store.close();}
});
test('website routes conceal connections, protect mutations, and issue revocable reader MCP tokens',async()=>{
 const s=await site();try{
  s.store.putConnection(owner,c,{accessToken:'synthetic-vendor-token'});
  for(const route of ['/','/connectors','/settings','/oauth/result','/privacy','/terms','/data-deletion','/assets/app.js','/assets/app.css'])assert.equal((await s.request(route)).status,200,route);
  assert.equal((await s.request('/api/connections/'+c.id)).status,401);assert.equal(JSON.stringify(await (await s.request('/api/platforms')).json()).includes(c.id),false);
  assert.equal((await s.request('/api/connector-tokens','POST',{}, {Cookie:s.headers.Cookie})).status,403);
  const tokenResult=await s.request('/api/connector-tokens','POST',{name:'Test MCP'},s.headers),token=await tokenResult.json();assert.equal(tokenResult.status,200);assert.equal(s.store.authenticate(token.token).role,'reader');
  const listing=await (await s.request('/api/connector-tokens','GET',undefined,s.headers)).json();assert.ok(!JSON.stringify(listing).includes(token.token));assert.ok(!JSON.stringify(listing).includes(sha256(token.token)));
  const mcp=await s.request('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization:'Bearer '+token.token,Accept:'application/json, text/event-stream'}); // Browser origins are deliberately denied at MCP.
  assert.equal(mcp.status,403);await mcp.arrayBuffer();
  const native=await fetch(s.base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token.token,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(native.status,200);assert.equal((await native.json()).result.tools.length,25);
  assert.equal((await s.request('/api/connector-tokens/'+token.id,'DELETE',undefined,s.headers)).status,200);assert.throws(()=>s.store.authenticate(token.token));
  const logout=await s.request('/api/session','DELETE',undefined,s.headers);assert.equal(logout.status,200);assert.equal((await s.request('/api/connector-tokens','GET',undefined,s.headers)).status,401);
 }finally{await s.close();}
});
test('asset selection is an atomic account grant; unknown assets and unrelated inventory cannot grant access',async()=>{
 const s=await site();try{s.store.putConnection(owner,c,{accessToken:'synthetic'});
  assert.equal((await s.request('/api/connections/'+c.id+'/assets','PATCH',{selected:['ad_accounts:999']},s.headers)).status,409);
  assert.equal((await s.request('/api/connections/'+c.id+'/assets','PATCH',{selected:[]},s.headers)).status,200);assert.equal(s.store.listConnections('local')[0]!.enabled,false);
  assert.equal((await s.request('/api/connections/'+c.id+'/assets','PATCH',{selected:['ad_accounts:111']},s.headers)).status,200);assert.equal(s.store.resolveConnection(owner,c.gateway).accounts[0],'111');
  s.store.putConnection(owner,{...c,id:'second',isDefault:false},{accessToken:'synthetic2'});assert.equal((await s.request('/api/connections/second/default','POST',{},s.headers)).status,200);assert.equal(s.store.resolveConnection(owner,c.gateway).id,'second');
  await s.request('/api/connections/second','DELETE',undefined,s.headers);assert.throws(()=>s.store.credentials('local','second'));
 }finally{await s.close();}
});
test('an in-flight sync cannot restore deselected accounts or resurrect disconnected credentials',async()=>{
 let unblock!:()=>void,started!:()=>void;let arrived=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>unblock=r);
 const fetcher:typeof fetch=async url=>{if(String(url).includes('/adaccounts')){started();await gate;return json({data:[{id:'act_111',name:'Test account'}]});}return json({id:'test-user',name:'Updated identity'});};
 const s=await site(fetcher);try{
  s.store.putConnection(owner,c,{accessToken:'synthetic'});const pending=s.request('/api/connections/'+c.id+'/sync','POST',{},s.headers);await arrived;
  await s.request('/api/connections/'+c.id+'/assets','PATCH',{selected:[]},s.headers);unblock();assert.equal((await pending).status,200);assert.deepEqual(s.store.listConnections('local')[0]!.accounts,[]);assert.equal(s.store.listConnections('local')[0]!.enabled,false);
  arrived=new Promise<void>(r=>started=r);gate=new Promise<void>(r=>unblock=r);const removed=s.request('/api/connections/'+c.id+'/sync','POST',{},s.headers);await arrived;await s.request('/api/connections/'+c.id,'DELETE',undefined,s.headers);unblock();assert.equal((await removed).status,404);assert.equal(s.store.listConnections('local').length,0);
 }finally{await s.close();}
});

for(const change of ['session','login'] as const)for(const retry of [true,false])test('website sync cannot persist assets after '+change+' changes '+(retry?'before retry':'during a successful read'),async()=>{
 let calls=0;const s=await site(async()=>{calls++;if(change==='session')s.store.db.exec('DELETE FROM amcp_web_sessions');else s.store.putConnection(owner,c,{accessToken:'replacement'});return new Response(JSON.stringify({data:[{id:'act_111',name:'Late provider result'}]}),{status:retry?503:200,headers:{'Content-Type':'application/json'}});});
 try{s.store.putConnection(owner,c,{accessToken:'synthetic'});const saved={groups:[{kind:'ad_accounts',complete:true,assets:[{id:'111',name:'Retained account',kind:'ad_accounts',source:'vendor'}]}],selected:['ad_accounts:111'],lastSync:123,error:null};s.store.putDocument('local','website_assets',c.id,saved);
  const before=s.store.document('local','website_assets',c.id),result=await s.request('/api/connections/'+c.id+'/sync','POST',{},s.headers);assert.equal(result.status,change==='session'?401:409);assert.equal((await result.json()).error.code,change==='session'?'SIGN_IN_REQUIRED':'CONNECTION_CHANGED');assert.equal(calls,1);assert.deepEqual(s.store.document('local','website_assets',c.id),before);assert.equal(s.store.listConnections('local')[0]!.label,c.label);
 }finally{await s.close();}
});
test('browser provider OAuth adapters preserve callback, state, PKCE and provider-specific token encoding',async()=>{
 const store=new Store(':memory:',master),web=new WebStore(store,{origin,masterKey:master,adminPassword:password}),session=web.signIn(password,'test'),env:NodeJS.ProcessEnv={};for(const p of platforms){env['AMCP_'+p.env+'_CLIENT_ID']='synthetic-client';env['AMCP_'+p.env+'_CLIENT_SECRET']='synthetic-secret';}
 env.AMCP_MICROSOFT_DEVELOPER_TOKEN='synthetic-developer';
 const calls:{url:URL;init:RequestInit}[]=[];
 const adapter=new PlatformOAuth(web,env,async(url,init)=>{const u=new URL(String(url));calls.push({url:u,init:init??{}});if(u.pathname.endsWith('/request_token'))return new Response('oauth_token=request-test&oauth_token_secret=request-secret&oauth_callback_confirmed=true');if(u.pathname.endsWith('/access_token')&&u.hostname==='api.x.com')return new Response('oauth_token=access-test&oauth_token_secret=access-secret&screen_name=synthetic');return json(u.hostname==='business-api.tiktok.com'?{code:0,data:{access_token:'synthetic-access'}}:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});});
 try{for(const p of platforms.filter(p=>!p.authType)){const start=await adapter.start(session,p.id),url=new URL(start.url);let state=url.searchParams.get('state');if(p.id==='x'){const header=String(calls.at(-1)!.init.headers&&new Headers(calls.at(-1)!.init.headers).get('authorization'));const callback=decodeURIComponent(/oauth_callback="([^"]+)"/.exec(header)![1]!);state=new URL(callback).searchParams.get('state');assert.ok(!header.includes('oauth_token='));}
   assert.ok(state);const stored=web.consumeOAuth(session,p.id,state!);assert.equal(stored.redirectUri,origin+'/api/auth/'+p.id+'/callback');if(p.id==='google')assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(stored.verifier).digest('base64url'));
   const result=await adapter.exchange(p.id,stored,p.id==='x'?{oauth_token:'request-test',oauth_verifier:'synthetic-verifier'}:p.id==='tiktok'?{auth_code:'synthetic-code'}:{code:'synthetic-code'});assert.ok(result.credentials.accessToken);const last=calls.at(-1)!;
   if(p.id==='meta'){const initial=calls.at(-2)!;assert.equal(initial.url.searchParams.get('redirect_uri'),stored.redirectUri);assert.equal(initial.url.searchParams.has('grant_type'),false);assert.equal(last.init.method,'GET');assert.equal(last.url.searchParams.get('grant_type'),'fb_exchange_token');}
   if(p.id==='snapchat')assert.equal(new URLSearchParams(String(last.init.body)).get('redirect_uri'),stored.redirectUri);
   if(p.id==='tiktok')assert.deepEqual(JSON.parse(String(last.init.body)),{app_id:'synthetic-client',secret:'synthetic-secret',auth_code:'synthetic-code'});
  }
  await assert.rejects(()=>adapter.exchange('x',{requestToken:'first',requestSecret:'secret'},{oauth_token:'different',oauth_verifier:'x'}),/mismatched/);
 }finally{store.close();}
});
test('LinkedIn offset pagination and unsafe Meta pagination fail or complete truthfully',async()=>{
 const store=new Store(':memory:',master);try{const connection={...c,gateway:'linkedin_native_action'},offsets:string[]=[];store.putConnection(owner,connection,{accessToken:'synthetic'});
  const discovery=new AssetDiscovery(store,async url=>{const start=new URL(String(url)).searchParams.get('start')!;offsets.push(start);return json({elements:[{account:'urn:li:sponsoredAccount:'+(start==='0'?'111':'222')}],paging:{start:Number(start),count:1,total:2,links:[]}});});
  const result=await discovery.sync(connection);assert.equal(result.groups[0]!.complete,true);assert.equal(result.groups[0]!.assets.length,2);assert.deepEqual(offsets,['0','1']);
  store.putConnection(owner,c,{accessToken:'synthetic'});let requests=0;const unsafe=new AssetDiscovery(store,async()=>{requests++;return json({data:[{id:'111'}],paging:{next:'https://evil.invalid/stolen?after=2'}});});const denied=await unsafe.sync(c);assert.equal(denied.groups[0]!.complete,false);assert.equal(requests,1);
 }finally{store.close();}
});
test('MCP OAuth discovery, registration, consent, PKCE, one-use codes, refresh rotation and replay revocation work over HTTP',async()=>{
 const s=await site();try{
  const missing=await fetch(s.base+'/mcp');assert.match(missing.headers.get('www-authenticate')!,/oauth-protected-resource\/mcp/);await missing.arrayBuffer();
  const metadata=await (await s.request('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(metadata.resource,origin+'/mcp');
  const register=await s.request('/register','POST',{client_name:'Synthetic MCP',redirect_uris:['http://127.0.0.1:8769/callback'],token_endpoint_auth_method:'none'});assert.equal(register.status,201);const client=await register.json();
  const verifier=randomBytes(48).toString('base64url'),params=new URLSearchParams({client_id:client.client_id,redirect_uri:client.redirect_uris[0],response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'mcp:read',state:'original-state',resource:origin+'/mcp'});
  const start=await s.request('/authorize?'+params);assert.equal(start.status,303);const consentUrl=new URL(start.headers.get('location')!),request=consentUrl.searchParams.get('request')!;
  assert.equal((await s.request('/api/mcp/consent?request='+request)).status,401);const preview=await (await s.request('/api/mcp/consent?request='+request,'GET',undefined,s.headers)).json();assert.equal(preview.name,'Synthetic MCP');
  const decision=await s.request('/api/mcp/consent','POST',{request,approved:true},s.headers);assert.equal(decision.status,200);const callback=new URL((await decision.json()).url);assert.equal(callback.searchParams.get('state'),'original-state');
  const token=(values:Record<string,string>)=>fetch(s.base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values)});
  const grant={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code:callback.searchParams.get('code')!,code_verifier:verifier,resource:origin+'/mcp'};
  assert.equal((await token({...grant,code_verifier:'x'.repeat(64)})).status,400);const exchanged=await token(grant);assert.equal(exchanged.status,200);const credentials=await exchanged.json();assert.equal(s.store.authenticate(credentials.access_token).role,'reader');
  const refresh={grant_type:'refresh_token',client_id:client.client_id,refresh_token:credentials.refresh_token,resource:origin+'/mcp'};const refreshed=await token(refresh);assert.equal(refreshed.status,200);const rotated=await refreshed.json();assert.notEqual(rotated.refresh_token,credentials.refresh_token);assert.equal((await token(refresh)).status,400);assert.throws(()=>s.store.authenticate(rotated.access_token));
  // The code stays single-use; replaying it mid-flow would revoke the tokens used above (tests/claude-oauth.test.ts).
  assert.equal((await token(grant)).status,400);
 }finally{await s.close();}
});
