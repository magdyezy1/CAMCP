import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {WebStore} from '../server/web-store.js';
import {PlatformOAuth,platform} from '../server/platform-oauth.js';
import {createWebsite} from '../server/website.js';
import type {Connection} from '../src/types.js';

const master=Buffer.alloc(32,91).toString('base64'),origin='https://amcp.shop';
const blocked:typeof fetch=async()=>{throw Error('Unexpected vendor egress');};
const env:NodeJS.ProcessEnv={AMCP_META_CLIENT_ID:'synthetic-meta-client',AMCP_META_CLIENT_SECRET:'synthetic-secret',AMCP_LINKEDIN_CLIENT_ID:'synthetic-linkedin-client',AMCP_LINKEDIN_CLIENT_SECRET:'synthetic-secret'};
function fixture(){const store=new Store(':memory:',master),web=new WebStore(store,{origin,masterKey:master,adminPassword:'synthetic-scope-test-password'});return {store,web,session:web.signIn('synthetic-scope-test-password','test')};}

test('new Meta and LinkedIn authorizations request write scopes only when enabled and Settings exposes them',async()=>{
 const f=fixture();try{
  const reader=new PlatformOAuth(f.web,env,blocked),writer=new PlatformOAuth(f.web,env,blocked,true);
  for(const [id,scope]of [['meta','ads_management'],['linkedin','rw_ads']] as const){
   const readConfig=reader.publicConfig().find(p=>p.id===id)!,writeConfig=writer.publicConfig().find(p=>p.id===id)!;assert.equal(readConfig.scopes.includes(scope),false);assert.equal(writeConfig.scopes.includes(scope),true);assert.equal(platform(id).scopes.includes(scope),false);
   const start=await writer.start(f.session,id),url=new URL(start.url);assert.ok(url.searchParams.get('scope')!.split(/[ ,]+/).includes(scope));const state=f.web.consumeOAuth(f.session,id,url.searchParams.get('state')!);assert.deepEqual(state.requestedScopes,writeConfig.scopes);
  }
  const website=createWebsite(f.store,{origin,masterKey:master},true);assert.ok(website.oauth.publicConfig().find(p=>p.id==='meta')!.scopes.includes('ads_management'));assert.ok(website.oauth.publicConfig().find(p=>p.id==='linkedin')!.scopes.includes('rw_ads'));
 }finally{f.store.close();}
});

test('provider scope overrides take precedence over write defaults, including an explicit empty override',async()=>{
 const f=fixture();try{
  const adapter=new PlatformOAuth(f.web,{...env,AMCP_META_SCOPES:'ads_read, pages_show_list',AMCP_LINKEDIN_SCOPES:''},blocked,true);
  assert.deepEqual(adapter.config(platform('meta')).scopes,['ads_read','pages_show_list']);assert.deepEqual(adapter.config(platform('linkedin')).scopes,[]);
  const start=await adapter.start(f.session,'meta'),url=new URL(start.url);assert.equal(url.searchParams.get('scope'),'ads_read,pages_show_list');
 }finally{f.store.close();}
});

test('configuration changes do not upgrade existing connections or pending authorizations and provider-declared scopes win',async()=>{
 const f=fixture();try{
  const c:Connection={id:'existing-read-login',tenantId:'local',gateway:'meta_native_action',accounts:['111'],label:'Existing read login',enabled:true,scopes:['ads_read']};f.store.putConnection(f.session.actor,c,{accessToken:'synthetic-existing'});
  const reader=new PlatformOAuth(f.web,env,blocked),start=await reader.start(f.session,'meta'),url=new URL(start.url),pending=f.web.consumeOAuth(f.session,'meta',url.searchParams.get('state')!);
  // The fake exchange exercises metadata processing only; no provider endpoint is contacted.
  const fake:typeof fetch=async()=>new Response(JSON.stringify({access_token:'synthetic-new'}),{headers:{'Content-Type':'application/json'}});
  const writer=new PlatformOAuth(f.web,env,fake,true);assert.equal((await writer.exchange('meta',pending,{code:'synthetic-code'})).scopes.includes('ads_management'),false);
  const legacy={...pending};delete legacy.requestedScopes;assert.equal((await writer.exchange('meta',legacy,{code:'synthetic-code'})).scopes.includes('ads_management'),false);
  const newStart=await writer.start(f.session,'meta'),newUrl=new URL(newStart.url),newPending=f.web.consumeOAuth(f.session,'meta',newUrl.searchParams.get('state')!);assert.equal((await writer.exchange('meta',newPending,{code:'synthetic-code'})).scopes.includes('ads_management'),true);
  const narrowed=new PlatformOAuth(f.web,env,async()=>new Response(JSON.stringify({access_token:'synthetic-limited',scope:'ads_read'}),{headers:{'Content-Type':'application/json'}}),true);assert.deepEqual((await narrowed.exchange('meta',newPending,{code:'synthetic-code'})).scopes,['ads_read']);
  assert.deepEqual(f.store.listConnections('local')[0]!.scopes,['ads_read']);assert.deepEqual(f.store.listConnections('local')[0]!.writeAccounts??[],[]);
 }finally{f.store.close();}
});

test('X requests write authorization only when enabled and pending read tokens are exchanged without an upgrade',async()=>{
 const f=fixture();try{
  const xenv={...env,AMCP_X_CLIENT_ID:'synthetic-x-client',AMCP_X_CLIENT_SECRET:'synthetic-x-secret'},calls:{url:URL;authorization:string}[]=[],issued=new Map<string,string>();
  const fake:typeof fetch=async(input,init)=>{
   const url=new URL(String(input)),authorization=new Headers(init?.headers).get('authorization')??'';calls.push({url,authorization});
   if(url.pathname==='/oauth/request_token'){
    const access=url.searchParams.get('x_auth_access_type')!;assert.ok(access==='read'||access==='write');const request='synthetic-request-'+access;issued.set(request,access);
    return new Response('oauth_token='+request+'&oauth_token_secret=synthetic-request-secret&oauth_callback_confirmed=true');
   }
   assert.equal(url.pathname,'/oauth/access_token');assert.equal(url.searchParams.has('x_auth_access_type'),false);assert.equal(authorization.includes('x_auth_access_type'),false);
   const token=decodeURIComponent(/oauth_token="([^"]+)"/.exec(authorization)![1]!),access=issued.get(token);assert.ok(access,'Exchange must use the original provider request token.');
   return new Response('oauth_token=synthetic-access-'+access+'&oauth_token_secret=synthetic-access-secret');
  };
  const reader=new PlatformOAuth(f.web,xenv,fake),writer=new PlatformOAuth(f.web,xenv,fake,true);
  const readStart=await reader.start(f.session,'x'),readRequest=calls.at(-1)!;assert.equal(readRequest.url.searchParams.get('x_auth_access_type'),'read');
  const callback=decodeURIComponent(/oauth_callback="([^"]+)"/.exec(readRequest.authorization)![1]!),pending=f.web.consumeOAuth(f.session,'x',new URL(callback).searchParams.get('state')!);assert.equal(pending.requestedAccessType,'read');
  assert.equal(new URL(readStart.url).searchParams.get('oauth_token'),pending.requestToken);
  const readResult=await writer.exchange('x',pending,{oauth_token:pending.requestToken,oauth_verifier:'synthetic-verifier'});assert.equal(readResult.credentials.accessToken,'synthetic-access-read');assert.equal(pending.requestedAccessType,'read');assert.deepEqual(readResult.scopes,[]);
  const legacy={...pending};delete legacy.requestedAccessType;assert.equal((await writer.exchange('x',legacy,{oauth_token:legacy.requestToken,oauth_verifier:'synthetic-verifier'})).credentials.accessToken,'synthetic-access-read');
  await writer.start(f.session,'x');const writeRequest=calls.at(-1)!;assert.equal(writeRequest.url.searchParams.get('x_auth_access_type'),'write');
  const writeCallback=decodeURIComponent(/oauth_callback="([^"]+)"/.exec(writeRequest.authorization)![1]!),writePending=f.web.consumeOAuth(f.session,'x',new URL(writeCallback).searchParams.get('state')!);assert.equal(writePending.requestedAccessType,'write');
  assert.equal((await writer.exchange('x',writePending,{oauth_token:writePending.requestToken,oauth_verifier:'synthetic-verifier'})).credentials.accessToken,'synthetic-access-write');
 }finally{f.store.close();}
});
