import {listenForFetch} from '../dist/tests/http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportWorker} from '../dist/src/worker.js';
import {createReportExecutor} from '../dist/src/report-executor.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {AccountSecurity} from '../dist/server/account-security.js';
import {SocialSignIn} from '../dist/server/social-signin.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {sha256} from '../dist/src/security.js';
const master=Buffer.alloc(32,93).toString('base64'),origin='https://amcp.test';
function fixture(){const store=new Store(':memory:',master),web=new WebStore(store,{origin,masterKey:master,adminPassword:'synthetic-admin-password',authEnv:{AMCP_SIGNIN_GOOGLE_CLIENT_ID:'synthetic',AMCP_SIGNIN_GOOGLE_CLIENT_SECRET:'synthetic',AMCP_SIGNIN_APPLE_CLIENT_ID:'synthetic',AMCP_SIGNIN_APPLE_CLIENT_SECRET:'synthetic',AMCP_SIGNIN_FACEBOOK_CLIENT_ID:'synthetic',AMCP_SIGNIN_FACEBOOK_CLIENT_SECRET:'synthetic'}}),accounts=new UserAccounts(web),security=new AccountSecurity(accounts);const req=s=>({headers:{origin,...(s?{cookie:web.cookie(s.id),'x-amcp-csrf':s.csrf}:{})},socket:{remoteAddress:'127.0.0.1'}});return {store,web,accounts,security,req};}

for(const provider of ['google','apple','facebook'])test(provider+' pending social registration commits once and can be approved',async()=>{
 const f=fixture();try{
  const social=new SocialSignIn(f.accounts);social.identity=async()=>({subject:'new-person',email:'new-person@example.test',name:'New Person'});
  const attempt=async()=>{const started=social.start(f.req(),provider,{}),req=f.req();req.headers.cookie=started.cookie.split(';')[0];return social.finish(req,provider,{state:new URL(started.url).searchParams.get('state'),code:'synthetic'});};
  for(let i=0;i<2;i++)await assert.rejects(attempt,e=>e.code==='ACCOUNT_PENDING_APPROVAL');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM amcp_users').get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM amcp_identities').get().n,1);
  const user=f.store.db.prepare('SELECT * FROM amcp_users').get();assert.equal(user.approved,0);
  const owner=f.web.signIn('synthetic-admin-password','synthetic-ip');f.security.setAccess(f.req(owner),{user_id:user.id,grant:true});
  assert.ok((await attempt()).session);
 }finally{f.store.close();}
});

test('disabled account invalidates a persisted actor and regrant does not revive its old authority',()=>{
 const f=fixture();try{const user=f.accounts.newUser('Member','member@example.test',null,true),session=f.accounts.session(user),actor=f.web.session(f.req(session)).actor,binding=f.store.bindJobActor(actor,'scheduled-report'),owner=f.web.signIn('synthetic-admin-password','synthetic-ip');
  f.security.setAccess(f.req(owner),{user_id:user.id,grant:false});assert.equal(f.web.session(f.req(session)),undefined);
  assert.throws(()=>f.store.restoreJobActor(user.tenant_id,'scheduled-report',binding),e=>e.code==='ACCOUNT_ACCESS_REVOKED');
  f.security.setAccess(f.req(owner),{user_id:user.id,grant:true});assert.throws(()=>f.store.restoreJobActor(user.tenant_id,'scheduled-report',binding),e=>e.code==='ACCOUNT_ACCESS_REVOKED');
  const fresh=f.accounts.session(f.accounts.user(user.id));assert.doesNotThrow(()=>f.store.bindJobActor(f.web.session(f.req(fresh)).actor,'new-job'));
 }finally{f.store.close();}
});

for(const role of ['viewer','operator','admin'])test(role+' connector deletion uses administrator policy',async()=>{
 const f=fixture();let server;try{
  const app=createHttpApp(new MirrorService(new Registry(),f.store),f.store,{website:{origin,masterKey:master,adminPassword:'synthetic-admin-password',authEnv:{}}}),user=f.accounts.newUser('Member',role+'@example.test',null,true);
  f.store.db.prepare('INSERT INTO workspace_memberships VALUES(?,?,?,1,?)').run(f.web.tenantId,user.id,role,Date.now());const session=f.accounts.session(user,f.web.tenantId),id='administrator-connector',token=f.store.createKey({tenantId:f.web.tenantId,userId:'connector/'+id,role:'operator'});
  f.store.putDocument(f.web.tenantId,'website_mcp_token',id,{hash:sha256(token),name:'Owner connector',role:'operator',revoked:false});
  server=await listenForFetch(app);
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/connector-tokens/'+id,{method:'DELETE',headers:{Origin:origin,Cookie:f.web.cookie(session.id),'x-amcp-csrf':session.csrf}});
  assert.equal(response.status,role==='admin'?200:403);if(role==='admin')assert.throws(()=>f.store.authenticate(token));else assert.doesNotThrow(()=>f.store.authenticate(token));
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}f.store.close();}
});

for(const revoke of ['key','connection','selection'])test('native read withholds data after in-flight '+revoke+' revocation',async()=>{
 const store=new Store(':memory:',master);try{const admin={tenantId:'test',userId:'owner',role:'admin'},connection={id:'google',tenantId:'test',gateway:'google_ads_native_action',accounts:['123'],enabled:true,scopes:[],label:'Synthetic'},credentials={accessToken:'synthetic'};store.putConnection(admin,connection,credentials);
  const bearer=store.createKey({...admin,role:'reader'}),actor=store.authenticate(bearer);let release,started;const waiting=new Promise(r=>release=r),begun=new Promise(r=>started=r);
  const service=new MirrorService(new Registry(),store,new NativeTransport(async()=>{started();await waiting;return Response.json({results:[{campaign:{id:'789',name:'Confidential fixture'}}]});}));
  const pending=service.call('google_ads_native_action',{action:'google_ads_v23_google_ads_search',customer_id:'123',payload:{query:'SELECT campaign.id, campaign.name FROM campaign'},connection_id:'google'},actor);
  await begun;if(revoke==='key')store.revokeKey(bearer);else store.putConnection(admin,{...connection,enabled:false,...(revoke==='selection'?{accounts:[]}: {})},credentials);release();
  const result=await pending;assert.equal(result.success,false);assert.ok(!JSON.stringify(result).includes('Confidential fixture'));assert.equal(store.ownsResource(connection,'123','789'),false);
 }finally{store.close();}
});

test('legacy report creator revocation stops egress; explicit authorized resume succeeds once',async()=>{
 const store=new Store(':memory:',master);try{
  const admin={tenantId:'test',userId:'owner',role:'admin'};store.putConnection(admin,{id:'google',tenantId:'test',gateway:'google_ads_native_action',accounts:['123'],enabled:true,scopes:[],label:'Synthetic'},{accessToken:'synthetic'});
  const key=store.createKey({...admin,role:'operator'}),actor=store.authenticate(key);let requests=0;
  const service=new MirrorService(new Registry(),store,new NativeTransport(async()=>{requests++;return Response.json({results:[]});}));
  const call=(operation,args,who=actor)=>service.call('amcp_native_action',{operation,arguments:args},who);
  const binding=await call('bind_reporting_workbook',{spreadsheet_id:'synthetic-sheet',dry_run:false});assert.equal(binding.success,true);
  const query=await call('create_reporting_query',{workbook_binding_id:binding.data.workbook_binding_id,name:'Report',query_config:{gateway:'google_ads_native_action',arguments:{action:'google_ads_v23_google_ads_search',customer_id:'123',connection_id:'google',payload:{query:'SELECT campaign.id FROM campaign'}}},dry_run:false});assert.equal(query.success,true);
  const id=query.data.prepared_run_id;await call('execute_reporting_run',{run_id:id,dry_run:false});store.revokeKey(key);
  const worker=new ReportWorker(store,createReportExecutor(service));await worker.once();assert.equal(requests,0);assert.equal(store.job('test',id).error.code,'UNAUTHORIZED');
  const resumed=await call('execute_reporting_run',{run_id:id,dry_run:false},admin);assert.equal(resumed.success,true);await worker.once();assert.equal(requests,1);assert.equal(store.job('test',id).state,'complete');await worker.once();assert.equal(requests,1);
  assert.ok(!JSON.stringify(store.job('test',id)).includes('authority'));
 }finally{store.close();}
});

test('old ownerless persisted jobs stop before an executor is invoked',async()=>{
 const store=new Store(':memory:',master);try{let calls=0;const id=store.enqueue('test','report',{query_config:{}});await new ReportWorker(store,async()=>{calls++;}).once();assert.equal(calls,0);assert.equal(store.job('test',id).error.code,'JOB_REAUTHORIZATION_REQUIRED');}finally{store.close();}
});
