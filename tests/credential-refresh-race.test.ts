import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {CredentialProvider} from '../src/auth.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,Credentials} from '../src/types.js';
import {requestAppleAccessToken} from '../src/apple-auth.js';
import {scopeKey} from '../src/security.js';

const owner={tenantId:'refresh-race',userId:'owner',role:'admin' as const},key=Buffer.alloc(32,71).toString('base64');
const gateways=['google_sheets_native_action','google_drive_native_action','google_ads_native_action','dv360_native_action','ga4_native_action','gtm_native_action','google_business_native_action','google_search_console_native_action','snapchat_native_action','linkedin_native_action','amazon_native_action','microsoft_ads_native_action','reddit_native_action','apple_ads_native_action'];
const initial=():Credentials=>({accessToken:'old-access',refreshToken:'old-refresh',clientId:'old-client',clientSecret:'synthetic-secret',expiresAt:1,redirectUri:'https://amcp.invalid/oauth/callback/snapchat'});
const replacement=():Credentials=>({accessToken:'replacement-access',refreshToken:'replacement-refresh',clientId:'new-client',clientSecret:'new-synthetic-secret',expiresAt:Date.now()+3600000});
function fixture(gateway='ga4_native_action',file=':memory:'){
 const store=new Store(file,key),c:Connection={id:'synthetic-connection',tenantId:owner.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic old login',scopes:[],userAgent:'AMCP test fixture'};store.putConnection(owner,c,initial());
 let finish!:(r:Response)=>void,started!:()=>void,calls=0;const ready=new Promise<void>(r=>started=r),fetcher:typeof fetch=async(_u,init)=>{calls++;assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');started();return new Promise<Response>(r=>finish=r);};
 const provider=new CredentialProvider(store,fetcher),response=()=>Response.json({access_token:'refreshed-old-access',refresh_token:'rotated-old-refresh',expires_in:3600,token_type:'Bearer'});
 return {store,c,ready,provider,fetcher,response,finish:(r=response())=>finish(r),calls:()=>calls};
}
for(const gateway of gateways)test(gateway+' refresh cannot overwrite a concurrent replacement login',async()=>{
 const f=fixture(gateway);try{const result=f.provider.get(f.c);await f.ready;const next=replacement();f.store.putConnection(owner,{...f.c,label:'Replacement login'},next);f.finish();await assert.rejects(result,(e:any)=>e.code==='CONNECTION_CHANGED');assert.deepEqual(f.store.credentials(owner.tenantId,f.c.id),next);assert.equal(f.calls(),1);}finally{f.store.close();}
});
test('disconnect during refresh cannot recreate credentials or return an orphan access token',async()=>{
 const f=fixture();try{const result=f.provider.get(f.c);await f.ready;f.store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId,f.c.id);f.finish();await assert.rejects(result,(e:any)=>['CONNECTION_REQUIRED','CONNECTION_CHANGED'].includes(e.code));assert.equal(f.store.listConnections(owner.tenantId).length,0);}finally{f.store.close();}
});
test('metadata and account-grant updates preserve a valid rotated credential without restoring grants',async()=>{
 const f=fixture();try{const result=f.provider.get(f.c);await f.ready;f.store.putConnection(owner,{...f.c,label:'Renamed',accounts:['999'],writeAccounts:[]},initial());f.finish();const token=await result;assert.equal(token.accessToken,'refreshed-old-access');assert.equal(f.store.credentials(owner.tenantId,f.c.id).refreshToken,'rotated-old-refresh');const c=f.store.listConnections(owner.tenantId)[0]!;assert.deepEqual(c.accounts,['999']);assert.deepEqual(c.writeAccounts,[]);assert.equal(c.label,'Renamed');}finally{f.store.close();}
});
test('changing a gateway during refresh cannot transplant another provider token',async()=>{
 const f=fixture();try{const result=f.provider.get(f.c);await f.ready;f.store.putConnection(owner,{...f.c,gateway:'linkedin_native_action'},initial());f.finish();await assert.rejects(result,(e:any)=>e.code==='CONNECTION_CHANGED');assert.equal(f.store.credentials(owner.tenantId,f.c.id).accessToken,'old-access');}finally{f.store.close();}
});
test('same connection ID across tenants has independent refresh state and replacements',async()=>{
 const f=fixture();try{const other={...owner,tenantId:'other-tenant'},c={...f.c,tenantId:other.tenantId};f.store.putConnection(other,c,replacement());const saved=f.store.credentials(other.tenantId,c.id),result=f.provider.get(f.c);await f.ready;f.finish();assert.equal((await result).accessToken,'refreshed-old-access');assert.deepEqual(f.store.credentials(other.tenantId,c.id),saved);}finally{f.store.close();}
});
test('two SQLite workers converge on one rotated refresh and preserve it across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-refresh-race-')),path=join(dir,'test.sqlite'),f=fixture('ga4_native_action',path),s2=new Store(path,key);try{const a=f.provider.get(f.c);await f.ready;const b=new CredentialProvider(s2,f.fetcher).get(f.c);f.finish();const results=await Promise.all([a,b]);assert.equal(f.calls(),1);assert.equal(results[0]!.refreshToken,'rotated-old-refresh');assert.equal(results[1]!.refreshToken,'rotated-old-refresh');const s3=new Store(path,key);try{assert.equal((await new CredentialProvider(s3,async()=>{throw Error('Unexpected refresh');}).get(f.c)).accessToken,'refreshed-old-access');}finally{s3.close();}}finally{f.store.close();s2.close();removeTestDirectory(dir,'amcp-refresh-race-');}
});
test('malformed or contradictory successful token bodies never replace the encrypted credentials',async()=>{
 const bodies=[{access_token:'',expires_in:3600},{access_token:' ',expires_in:3600},{access_token:'token\r\nInjected: header',expires_in:3600},{access_token:'token',error:'invalid_grant',expires_in:3600},{access_token:'token',token_type:'MAC',expires_in:3600},{access_token:'token',refresh_token:'',expires_in:3600},{access_token:'token',expires_in:0},{access_token:'token',expires_in:'0x100'},{access_token:'token',expires_in:1e300}];
 for(const body of bodies){const f=fixture();try{const result=f.provider.get(f.c);await f.ready;f.finish(Response.json(body));await assert.rejects(result,(e:any)=>e.code==='TOKEN_REFRESH_FAILED',JSON.stringify(body));assert.deepEqual(f.store.credentials(owner.tenantId,f.c.id),initial());}finally{f.store.close();}}
});
test('oversized and invalid UTF-8 token responses fail without retaining provider text',async()=>{
 for(const body of [JSON.stringify({access_token:'token',expires_in:3600,padding:'x'.repeat(1024*1024)}),new Uint8Array([0xff,0xfe])]){const f=fixture();try{const result=f.provider.get(f.c);await f.ready;f.finish(new Response(body,{headers:{'content-type':'application/json'}}));await assert.rejects(result,(e:any)=>e.code==='TOKEN_REFRESH_FAILED'&&!JSON.stringify(e).includes('padding'));assert.equal(f.store.credentials(owner.tenantId,f.c.id).accessToken,'old-access');}finally{f.store.close();}}
});

test('a stale gateway object cannot read or refresh credentials for a newly selected provider',async()=>{
 for(const value of [initial(),replacement()]){const f=fixture();try{f.store.putConnection(owner,{...f.c,gateway:'linkedin_native_action'},value);await assert.rejects(f.provider.get(f.c),{code:'CONNECTION_CHANGED'});assert.equal(f.calls(),0);}finally{f.store.close();}}
});

test('rotation fencing compares the refresh grant even when the access token is unchanged',async()=>{
 const f=fixture();try{const result=f.provider.get(f.c);await f.ready;const current={...initial(),refreshToken:'another-refresh-grant'};f.store.replaceCredentials(owner.tenantId,f.c.id,current);f.finish();await assert.rejects(result,{code:'CONNECTION_CHANGED'});assert.deepEqual(f.store.credentials(owner.tenantId,f.c.id),current);}finally{f.store.close();}
});

test('connection replacement and removal of previous ownership commit atomically',()=>{
 const f=fixture();try{f.store.rememberResource(f.c,'123','campaigns/old');f.store.db.exec("CREATE TRIGGER refuse_ownership_cleanup BEFORE DELETE ON resource_ownership BEGIN SELECT RAISE(ABORT,'Synthetic cleanup failure'); END");assert.throws(()=>f.store.putConnection(owner,{...f.c,label:'Replacement login'},replacement()),/Synthetic cleanup failure/);assert.deepEqual(f.store.credentials(owner.tenantId,f.c.id),initial());assert.equal(f.store.listConnections(owner.tenantId)[0]!.label,'Synthetic old login');assert.equal(f.store.ownsResource(f.c,'123','campaigns/old'),true);}finally{f.store.close();}
});

test('a late refresh cannot overwrite another worker after its lease expired',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-refresh-expiry-')),file=join(dir,'test.sqlite'),f=fixture('ga4_native_action',file),s2=new Store(file,key);
 try{const older=f.provider.get(f.c);await f.ready;const lock='refresh:'+scopeKey(owner.tenantId,f.c.id);s2.db.prepare('UPDATE service_locks SET expires_at=0 WHERE key=?').run(lock);
  const next=await new CredentialProvider(s2,async()=>Response.json({access_token:'second-worker',refresh_token:'second-rotation',expires_in:3600})).get(f.c);
  f.finish();await assert.rejects(older,{code:'CONNECTION_CHANGED'});assert.deepEqual(s2.credentials(owner.tenantId,f.c.id),next);
 }finally{f.store.close();s2.close();removeTestDirectory(dir,'amcp-refresh-expiry-');}
});

test('decimal expiry, opaque refresh tokens and missing optional token fields retain compatibility',async()=>{
 for(const body of [{access_token:'Az-._~+/9==',refresh_token:'opaque refresh grant',expires_in:'3600',token_type:'bEaReR'},{access_token:'next-access'}]){const f=fixture();try{const start=Date.now(),result=f.provider.get(f.c);await f.ready;f.finish(Response.json(body));const next=await result;assert.equal(next.accessToken,body.access_token);assert.equal(next.refreshToken,body.refresh_token??initial().refreshToken);assert.ok(next.expiresAt!>=start+3600000&&next.expiresAt!<=Date.now()+3600000);}finally{f.store.close();}}
});

test('Apple token responses share bounded parsing and reject invalid token or expiry metadata',async()=>{
 for(const body of [{access_token:' token',expires_in:3600},{access_token:'token',expires_in:'0x100'},{access_token:'token',expires_in:1e300},{access_token:'token',token_type:'MAC',expires_in:3600},{access_token:'token',error:'invalid_client',expires_in:3600}])await assert.rejects(requestAppleAccessToken(initial(),async()=>Response.json(body)),{code:'TOKEN_REFRESH_FAILED'});
 for(const body of [JSON.stringify({access_token:'token',expires_in:3600,padding:'x'.repeat(1024*1024)}),new Uint8Array([0xff,0xfe])])await assert.rejects(requestAppleAccessToken(initial(),async()=>new Response(body)),{code:'TOKEN_REFRESH_FAILED'});
});

test('an oversized token stream is cancelled and a provider error reveals no token data',async()=>{
 const f=fixture();let cancelled=false;try{const result=f.provider.get(f.c);await f.ready;f.finish(new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}})));await assert.rejects(result,{code:'TOKEN_REFRESH_FAILED'});assert.equal(cancelled,true);assert.equal(f.store.credentials(owner.tenantId,f.c.id).accessToken,'old-access');}finally{f.store.close();}
 const g=fixture();try{const result=g.provider.get(g.c);await g.ready;g.finish(Response.json({error:'invalid_grant',error_description:'private-refresh-grant',access_token:'private-access'},{status:400}));await assert.rejects(result,(e:any)=>e.code==='TOKEN_REFRESH_FAILED'&&!JSON.stringify(e).includes('private-'));assert.equal(JSON.stringify(g.store.audit(owner.tenantId)).includes('private-'),false);}finally{g.store.close();}
});
