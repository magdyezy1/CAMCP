import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,Script} from 'node:vm';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {createHttpApp} from '../server/http-app.js';
import {assetSyncDiagnostic} from '../src/report-errors.js';
import {MirrorError} from '../src/errors.js';
import type {Actor,Connection,JsonObject,CompiledRequest} from '../src/types.js';

const key=Buffer.alloc(32,48).toString('base64');
const actor:Actor={tenantId:'local',userId:'owner',role:'admin'};
const connection:Connection={id:'google-sync',tenantId:'local',gateway:'google_ads_native_action',accounts:['300'],enabled:true,label:'Synthetic Google',scopes:['https://www.googleapis.com/auth/adwords'],writeAccounts:[]};
const credentials={accessToken:'synthetic-secret-token',loginCustomerId:'999'};
const failure=(reason:string,message='Access denied')=>({error:{code:403,status:'PERMISSION_DENIED',message:'The caller does not have permission',details:[{'@type':'type.googleapis.com/google.ads.googleads.v23.errors.GoogleAdsFailure',requestId:'synthetic-body-trace',errors:[{errorCode:{authorizationError:reason},message,trigger:{stringValue:'private-trigger'},access_token:'private-access-token'}]}]},refresh_token:'private-refresh-token'});
const denied=(reason:string)=>Response.json(failure(reason,'Access denied access_token=private-inline-token'),{status:403,headers:{'request-id':'synthetic-header-trace'}});
function fixture(){
 const calls:JsonObject[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,headers=new Headers(init?.headers);
  calls.push({path,headers,method:init?.method,body:init?.body});
  if(path==='/v23/customers:listAccessibleCustomers')return Response.json({resourceNames:['customers/300','customers/400','customers/500']});
  return denied('AUTHORIZATION_ERROR');
 };
 return {calls,fetcher};
}

test('Google sync succeeds from the account list without the detail calls that previously produced 403s',async()=>{
 const store=new Store(':memory:',key),f=fixture();
 try{
  store.putConnection(actor,connection,credentials);
  const group=(await new AssetDiscovery(store,f.fetcher).sync(connection)).groups[0]!;
  assert.equal(group.complete,true);assert.deepEqual(group.assets.map(a=>a.id),['300','400','500']);assert.equal(group.diagnostics,undefined);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.method,'GET');assert.equal(f.calls[0]!.body,undefined);assert.equal(f.calls[0]!.headers.get('login-customer-id'),'999');
  assert.deepEqual(store.listConnections('local')[0]!.accounts,['300']);assert.deepEqual(store.listConnections('local')[0]!.writeAccounts,[]);
 }finally{store.close();}
});

test('Google account-list failures retain their provider reason and request path without retrying 403s',async()=>{
 for(const reason of ['SERVICE_DISABLED','AUTHORIZATION_ERROR']){
  const store=new Store(':memory:',key);let calls=0;
  try{
   store.putConnection(actor,connection,credentials);
   const group=(await new AssetDiscovery(store,async()=>{calls++;return denied(reason);}).sync(connection)).groups[0]!;
   assert.equal(group.complete,false);assert.equal(group.assets.length,0);assert.equal(calls,1);
   const d=group.diagnostics![0]!;assert.equal(d.provider.code,reason);assert.equal(d.provider.request_id,'synthetic-header-trace');
   assert.equal(d.http_status,403);assert.equal(d.request.stage,'account_list');assert.equal(d.request.method,'GET');assert.equal(d.request.path,'/v23/customers:listAccessibleCustomers');assert.equal(d.login_customer_id,'999');
   assert.ok(!JSON.stringify(group).includes('private-'));assert.ok(!JSON.stringify(group).includes(credentials.accessToken));
  }finally{store.close();}
 }
});

test('expired credentials are reported as an incomplete sync without discarding account grants or making vendor requests',async()=>{
 const store=new Store(':memory:',key);let calls=0;
 try{
  store.putConnection(actor,connection,{...credentials,expiresAt:Date.now()-1000});
  const group=(await new AssetDiscovery(store,async()=>{calls++;throw Error('Unexpected vendor request');}).sync(connection)).groups[0]!;
  assert.equal(group.complete,false);assert.equal(group.diagnostics![0]!.code,'REAUTHORIZATION_REQUIRED');
  assert.match(group.diagnostics![0]!.next_action,/Reconnect/);assert.equal(calls,0);
  assert.deepEqual(store.listConnections('local')[0]!.accounts,['300']);
 }finally{store.close();}
});

test('Google project access works without a legacy developer token while OAuth and Microsoft developer-token checks remain enforced',async()=>{
 const calls:Headers[]=[];
 const transport=new NativeTransport(async(_url,init)=>{calls.push(new Headers(init?.headers));return Response.json({results:[]});});
 const plan:CompiledRequest={gateway:connection.gateway,action:'report',accountId:'300',path:'/v23/customers/300/googleAds:search',method:'POST',query:{},body:{query:'SELECT customer.id FROM customer'},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'TEST',warnings:[]};
 await transport.request(plan,connection,credentials);assert.equal(calls[0]!.get('developer-token'),null);assert.equal(calls[0]!.get('Authorization'),'Bearer '+credentials.accessToken);
 await transport.request(plan,connection,{...credentials,developerToken:'synthetic-legacy-token'});assert.equal(calls[1]!.get('developer-token'),'synthetic-legacy-token');
 await assert.rejects(()=>transport.request(plan,connection,{}),(e:MirrorError)=>e.code==='CREDENTIALS_REQUIRED');
 await assert.rejects(()=>transport.request({...plan,gateway:'microsoft_ads_native_action',origin:'https://campaign.api.bingads.microsoft.com',path:'/CampaignManagement/v13/Campaigns/Query'},{...connection,gateway:'microsoft_ads_native_action'},credentials),(e:MirrorError)=>e.code==='DEVELOPER_TOKEN_REQUIRED');
 assert.equal(calls.length,2);
});

test('Google diagnostics distinguish project approval, ambiguous v23 authorization and inactive accounts',()=>{
 const diagnostic=(reason:string)=>assetSyncDiagnostic(new MirrorError('INSUFFICIENT_SCOPE','Platform returned HTTP 403',{upstream:failure(reason)},403),'google',connection.id,'ad_accounts','400');
 assert.match(diagnostic('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION').next_action,/project that owns AMCP/);
 assert.match(diagnostic('ACTION_NOT_PERMITTED').next_action,/does not prove that a higher tier/);
 assert.match(diagnostic('CUSTOMER_NOT_ENABLED').next_action,/does not reactivate/);
 assert.match(diagnostic('USER_PERMISSION_DENIED').next_action,/Google identity/);
});

test('Connections and Activity expose safe Google sync diagnostics behind authentication and preserve prior selection',async()=>{
 const store=new Store(':memory:',key),origin='https://amcp.shop';
 store.putConnection(actor,connection,credentials);
 const service=new MirrorService(new Registry(),store),app=createHttpApp(service,store,{website:{origin,masterKey:key,adminPassword:'synthetic-sync-password',fetcher:async()=>denied('USER_PERMISSION_DENIED')}}),server=app.listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  assert.equal((await fetch(base+'/api/activity')).status,401);
  const login=await fetch(base+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-sync-password'})});
  const data=await login.json() as JsonObject,headers={Origin:origin,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':data.csrf};
  const response=await fetch(base+'/api/connections/'+connection.id+'/sync',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);
  const result=await response.json() as JsonObject;assert.equal(result.status,'attention');assert.deepEqual(result.accounts,['300']);assert.equal(result.groups[0].diagnostics.length,1);
  const activity=await (await fetch(base+'/api/activity',{headers})).json() as JsonObject;
  const event=activity.events.find((e:JsonObject)=>e.event.event==='website_asset_sync');
  assert.equal(event.event.complete,false);assert.equal(event.event.error.code,'ASSET_SYNC_INCOMPLETE');
  assert.equal(event.diagnostics[0].provider.code,'USER_PERMISSION_DENIED');assert.equal(event.diagnostics.length,1);
  assert.equal(event.event.vendor_writes,0);assert.ok(!JSON.stringify({result,activity}).includes('private-'));assert.ok(!JSON.stringify({result,activity}).includes(credentials.accessToken));
  const anonymous=await (await fetch(base+'/api/platforms')).json() as JsonObject;assert.ok(anonymous.platforms.every((p:JsonObject)=>!p.connections.length));
 }finally{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});store.close();}
});

test('the connection manager displays provider-specific failures and escapes untrusted provider messages',()=>{
 const esc=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
 const context=createContext({esc});new Script(readFileSync('web/reporting-overview.js','utf8')).runInContext(context);
 const app=readFileSync('web/app.js','utf8'),start=app.indexOf('function renderAssetSyncDiagnostics('),end=app.indexOf('\n}',start)+2;
 new Script(app.slice(start,end)).runInContext(context);
 context.group={diagnostics:[{account_id:'400',code:'INSUFFICIENT_SCOPE',provider:{code:'USER_PERMISSION_DENIED',message:'<img src=x onerror=alert(1)>'},request:{stage:'manager_hierarchy',method:'POST',path:'/v23/customers/400/googleAds:search'},next_action:'Check the connected Google identity'}]};
 const html=new Script('renderAssetSyncDiagnostics(group)').runInContext(context) as string;
 assert.match(html,/400 · USER_PERMISSION_DENIED/);assert.match(html,/Manager account hierarchy/);assert.match(html,/Check the connected Google identity/);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img'));
});
