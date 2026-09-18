import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {CredentialProvider} from '../src/auth.js';
import {WebStore} from '../server/web-store.js';
import {PlatformOAuth,platform} from '../server/platform-oauth.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {createHttpApp} from '../server/http-app.js';
import {compileMicrosoft,microsoftGateway as gateway,microsoftScope,microsoftActions,assertMicrosoftWrite,microsoftSnapshots,validateMicrosoftResponse} from '../src/microsoft-native.js';
import type {Connection,JsonObject} from '../src/types.js';
const admin={tenantId:'t',userId:'u',role:'admin' as const},operator={...admin,role:'operator' as const};
const key=Buffer.alloc(32,56).toString('base64');
const connection:Connection={id:'ms',tenantId:'t',label:'Synthetic Microsoft',gateway,accounts:['123'],writeAccounts:['123'],accountCustomers:{'123':'456'},scopes:[microsoftScope],enabled:true};
const policy={allowWrites:true,maxBudgetChange:0,requireBeforeState:true};

test('Microsoft v13 catalog compiles exact native contracts, IDs and cross-account report scope',()=>{
 const registry=new Registry();assert.equal(microsoftActions.length,24);
 assert.ok(registry.listTools({mode:'strict',flags:{}}).some(t=>t.name===gateway));
 for(const input of [{action:'GetCampaignsByAccountId',account_id:'123',payload:{AccountId:'999'}},{action:'GetCampaignsByAccountId',account_id:'123',payload:{CustomerId:'999'}},{action:'GetCampaignsByAccountId',account_id:123},{action:'GetCampaignsByIds',account_id:'123',payload:{CampaignIds:['1','1']}}])assert.throws(()=>compileMicrosoft(input));
 const p=compileMicrosoft({action:'GetCampaignsByAccountId',account_id:'123'});assert.equal(p.method,'POST');assert.equal(p.path,'/CampaignManagement/v13/Campaigns/QueryByAccountId');assert.deepEqual(p.body,{AccountId:'123'});assert.equal(p.readOnly,true);
 assert.equal(registry.help({gateway,operation:'AddCampaigns'},{mode:'strict',flags:{}}).raw.payload_fields.includes('Campaigns'),true);
 assert.throws(()=>registry.help({gateway,operation:'Unknown'},{mode:'strict',flags:{}}),/Unknown Microsoft/);
 assert.throws(()=>compileMicrosoft({action:'SubmitGenerateReport',account_id:'123',payload:{ReportRequest:{Type:'CampaignPerformanceReportRequest',Scope:{AccountIds:['999']}}}}),/Scope/);
});

test('Microsoft Search write qualification checks exact parent campaigns and rejects unsupported types or invalid budgets',()=>{
 for(const row of [{CampaignType:'PerformanceMax',DailyBudget:20},{DailyBudget:0},{DailyBudget:-1},{BudgetId:123}]){
  const plan=compileMicrosoft({action:'AddCampaigns',account_id:'123',payload:{Campaigns:[{Name:'Example',Status:'Paused',...row}]}});
  assert.throws(()=>assertMicrosoftWrite(plan));
 }
 const plan=compileMicrosoft({action:'AddKeywords',account_id:'123',campaign_id:'100',payload:{AdGroupId:'200',Keywords:[{Text:'example',MatchType:'Exact',Status:'Paused'}]}});
 const reads=microsoftSnapshots(plan),campaign=reads.find(r=>r.action==='GetCampaignsByIds')!;
 assert.deepEqual(campaign.body,{AccountId:'123',CampaignIds:['100'],CampaignType:'Search'});
 assert.throws(()=>validateMicrosoftResponse(campaign,{status:200,headers:{},data:{Campaigns:[{Id:'100',CampaignType:'Shopping'}]}},true),/Only Search/);
 assert.throws(()=>validateMicrosoftResponse(campaign,{status:200,headers:{},data:{Campaigns:[null]}},true),/every exact/);
});

test('Microsoft scope, account grant and operator checks prevent egress',async()=>{
 const store=new Store(':memory:',key);let requests=0;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async()=>{requests++;throw Error('Unexpected request');}),undefined,policy);
 const args={action:'prepare',gateway,arguments:{action:'AddCampaigns',account_id:'123',payload:{Campaigns:[{Name:'Example',Status:'Paused',DailyBudget:10}]}}};
 try{
  store.putConnection(admin,{...connection,writeAccounts:[]},{accessToken:'synthetic',developerToken:'synthetic'});
  assert.equal((await service.call('amcp_write',args,operator)).error.code,'WRITE_ACCOUNT_FORBIDDEN');
  store.putConnection(admin,{...connection,scopes:[]},{accessToken:'synthetic',developerToken:'synthetic'});
  assert.equal((await service.call('amcp_write',args,operator)).error.code,'INSUFFICIENT_SCOPE');
  store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic'});
  assert.equal((await service.call('amcp_write',args,{...operator,role:'reader'})).success,false);
  assert.equal((await service.call(gateway,{action:'GetAccount',account_id:'999'},operator)).success,false);
  store.putConnection(admin,{...connection,accountCustomers:{}},{accessToken:'synthetic',developerToken:'synthetic'});
  assert.equal((await service.call(gateway,{action:'GetAccount',account_id:'123'},operator)).error.code,'MICROSOFT_CUSTOMER_REQUIRED');
  assert.equal(requests,0);
 }finally{store.close();}
});

test('Microsoft report submission does not retry job creation on a lost response',async()=>{
 const plan=compileMicrosoft({action:'SubmitGenerateReport',account_id:'123',payload:{ReportRequest:{Type:'AccountPerformanceReportRequest',Scope:{AccountIds:['123']},Columns:['Clicks'],Aggregation:'Summary',Time:{PredefinedTime:'Yesterday'}}}});let calls=0;
 const transport=new NativeTransport(async()=>{calls++;throw Error('Synthetic lost response');},async()=>{});
 await assert.rejects(()=>transport.request(plan,connection,{accessToken:'synthetic',developerToken:'synthetic'}));assert.equal(calls,1);
 assert.throws(()=>validateMicrosoftResponse(plan,{status:200,headers:{},data:{}}),e=>e instanceof Error&&'code' in e&&e.code==='UPSTREAM_RESPONSE_INVALID');
});

test('Microsoft OAuth uses S256, separate developer token and durable refresh rotation',async()=>{
 const store=new Store(':memory:',key),web=new WebStore(store,{origin:'https://amcp.shop',masterKey:key,adminPassword:'synthetic-microsoft-password'}),session=web.signIn('synthetic-microsoft-password','test');
 try{
  const env={AMCP_MICROSOFT_CLIENT_ID:'synthetic-client',AMCP_MICROSOFT_CLIENT_SECRET:'synthetic-secret',AMCP_MICROSOFT_DEVELOPER_TOKEN:'synthetic-developer'};
  const auth=new PlatformOAuth(web,env,async(url,init)=>{assert.equal(String(url),platform('microsoft').token);const b=new URLSearchParams(String(init?.body));assert.ok(b.get('code_verifier'));assert.equal(b.get('redirect_uri'),'https://amcp.shop/api/auth/microsoft/callback');assert.equal(b.get('scope'),microsoftScope+' offline_access');return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});},true);
  const start=await auth.start(session,'microsoft'),url=new URL(start.url);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),microsoftScope+' offline_access');
  const pending=web.consumeOAuth(session,'microsoft',url.searchParams.get('state')!),result=await auth.exchange('microsoft',pending,{code:'synthetic-code'});assert.equal(result.credentials.developerToken,'synthetic-developer');assert.ok(result.scopes.includes(microsoftScope));
  store.putConnection(admin,connection,{...result.credentials,expiresAt:Date.now()-1});let refreshed=0;
  const provider=new CredentialProvider(store,async(url,init)=>{refreshed++;assert.equal(String(url),platform('microsoft').token);assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'synthetic-refresh');return Response.json({access_token:'synthetic-new',refresh_token:'synthetic-rotated',expires_in:3600});});
  await Promise.all([provider.get(connection),provider.get(connection)]);assert.equal(refreshed,1);assert.equal(store.credentials('t','ms').refreshToken,'synthetic-rotated');
  assert.equal(new PlatformOAuth(web,{...env,AMCP_MICROSOFT_DEVELOPER_TOKEN:''}).config(platform('microsoft')).configured,false);
 }finally{store.close();}
});

test('Microsoft paginated discovery binds each advertiser to its own parent customer',async()=>{
 const store=new Store(':memory:',key);store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic-developer'});let searches=0;
 try{
  const discovery=new AssetDiscovery(store,async(url,init)=>{
   assert.equal(new URL(String(url)).origin,'https://clientcenter.api.bingads.microsoft.com');const h=new Headers(init?.headers);assert.equal(h.get('authorization'),'Bearer synthetic');assert.equal(h.get('developertoken'),'synthetic-developer');
   const body=JSON.parse(String(init?.body));
   if(String(url).endsWith('/User/Query')){assert.equal(body.UserId,null);return Response.json({User:{Id:'789'}});}
   assert.deepEqual(body.Predicates,[{Field:'UserId',Operator:'Equals',Value:'789'}]);assert.equal(body.PageInfo.Index,searches++);
   return Response.json({Accounts:body.PageInfo.Index===0?Array.from({length:100},(_,i)=>({Id:String(i+1000),ParentCustomerId:i%2?'456':'457',Name:'Synthetic',CurrencyCode:'EUR',TimeZone:'Paris'})):[{Id:'2000',ParentCustomerId:'458',Name:'Last'}]});
  });
  const result=await discovery.sync(connection);assert.equal(result.groups[0]!.complete,true,result.groups[0]!.error);assert.equal(result.groups[0]!.assets.length,101);assert.equal(result.groups[0]!.assets.at(-1)!.parentId,'458');assert.equal(searches,2);
 }finally{store.close();}
});

test('Microsoft reviewed hierarchy creates campaign → ad group → RSA → keyword with no list calls',async()=>{
 const store=new Store(':memory:',key);store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic-developer'});let writes=0,reads=0;
 const sent:JsonObject[]=[],service=new MirrorService(new Registry(),store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body)),headers=new Headers(init?.headers);assert.equal(headers.get('CustomerAccountId'),'123');assert.equal(headers.get('CustomerId'),'456');
  const reply=(data:JsonObject)=>Response.json({...data,TrackingId:String(++reads),futureEnvelopeTelemetry:{cost:reads}});
  if(path.endsWith('/Account/Query'))return reply({Account:{Id:'123',ParentCustomerId:'456',CurrencyCode:'USD'}});
  if(path.endsWith('/Campaigns/QueryByIds'))return reply({Campaigns:[{Id:'100',Name:'Campaign',Status:'Paused',DailyBudget:50}]});
  if(path.endsWith('/AdGroups/QueryByIds')){assert.equal(body.CampaignId,'100');return reply({AdGroups:[{Id:'200',Name:'Ad group',Status:'Paused'}]});}
  writes++;sent.push(body);const kind=path.split('/').at(-1)!,ids:Record<string,string>={Campaigns:'100',AdGroups:'200',Ads:'300',Keywords:'400'};
  return Response.json({[kind.slice(0,-1)+'Ids']:[ids[kind]],PartialErrors:null});
 }),undefined,policy);
 async function create(action:string,payload:JsonObject,campaign_id?:string){const p=await service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload,...(campaign_id?{campaign_id}:{})}},operator);assert.equal(p.success,true,JSON.stringify(p));assert.equal(typeof p.data.state_hash,'string');const r=await service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},operator);assert.equal(r.success,true,JSON.stringify(r));return r;}
 try{
  await create('AddCampaigns',{Campaigns:[{Name:'Campaign',CampaignType:'Search',DailyBudget:50,BudgetType:'DailyBudgetStandard',Status:'Paused'}]});
  await create('AddAdGroups',{CampaignId:'100',AdGroups:[{Name:'Ad group',Status:'Paused',CpcBid:{Amount:1.25}}]});
  await create('AddAds',{AdGroupId:'200',Ads:[{Type:'ResponsiveSearch',Status:'Paused',FinalUrls:['https://example.com'],Headlines:[{Asset:{Type:'TextAsset',Text:'First headline'}},{Asset:{Type:'TextAsset',Text:'Second headline'}},{Asset:{Type:'TextAsset',Text:'Third headline'}}],Descriptions:[{Asset:{Type:'TextAsset',Text:'First description'}},{Asset:{Type:'TextAsset',Text:'Second description'}}]}]},'100');
  await create('AddKeywords',{AdGroupId:'200',Keywords:[{Text:'example',MatchType:'Exact',Status:'Paused',Bid:{Amount:1.25}}]},'100');
  assert.equal(writes,4);assert.equal(sent[0]!.Campaigns[0].DailyBudget,50);assert.equal(sent[2]!.CampaignId,undefined);assert.equal(store.verifyAudit(),true);
 }finally{store.close();}
});

test('Microsoft budget changes invalidate review and partial mutation results are retained without retry',async()=>{
 const store=new Store(':memory:',key);store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic-developer'});let budget=10,writes=0;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async(url)=>{
  const path=new URL(String(url)).pathname;if(path.endsWith('/Account/Query'))return Response.json({Account:{Id:'123'}});
  if(path.includes('/QueryByIds'))return Response.json({Campaigns:[{Id:'100',DailyBudget:budget,Status:'Paused'}]});
  writes++;return Response.json({PartialErrors:[{Index:0,Code:1,Message:'Synthetic failure'}]});
 }),undefined,policy);
 const prepare=()=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:'UpdateCampaigns',account_id:'123',payload:{Campaigns:[{Id:'100',DailyBudget:30}]}}},operator);
 try{
  const p=await prepare();assert.equal(p.success,true,JSON.stringify(p));budget=20;
  const e={action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true};const stale=await service.call('amcp_write',e,operator);assert.equal(stale.error.code,'STATE_CHANGED');assert.ok(JSON.stringify(stale.error.details).includes('DailyBudget'));assert.equal(writes,0);
  const next=await prepare(),execute={...e,review_id:next.data.review_id,idempotency_key:next.data.idempotency_key};assert.equal((await service.call('amcp_write',execute,operator)).success,false);assert.equal((await service.call('amcp_write',execute,operator)).success,false);assert.equal(writes,1);
 }finally{store.close();}
});

test('Microsoft report submission and polling stay bound to original connection and selected account',async()=>{
 const store=new Store(':memory:',key);store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic-developer'});let calls=0;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async(url)=>{calls++;return Response.json(String(url).endsWith('/Submit')?{ReportRequestId:'report-1'}:{ReportRequestStatus:{Status:'Success',ReportDownloadUrl:'https://reports.example.invalid/synthetic.zip'}});}),undefined,policy);
 const args={action:'SubmitGenerateReport',account_id:'123',payload:{ReportRequest:{Type:'CampaignPerformanceReportRequest',Scope:{AccountIds:['123']},Columns:['CampaignId','Clicks','Spend'],Aggregation:'Summary',Format:'Csv',Time:{PredefinedTime:'Yesterday'}}}};
 try{
  assert.equal((await service.call(gateway,{...args,dry_run:true},operator)).success,true);assert.equal(calls,0);
  assert.equal((await service.call(gateway,{action:'PollGenerateReport',account_id:'123',payload:{ReportRequestId:'report-1'}},operator)).error.code,'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await service.call(gateway,args,operator)).success,true);assert.equal((await service.call(gateway,{action:'PollGenerateReport',account_id:'123',payload:{ReportRequestId:'report-1'}},operator)).success,true);
  store.putConnection(admin,{...connection,id:'other'},{accessToken:'synthetic',developerToken:'synthetic-developer'});
  assert.equal((await service.call(gateway,{action:'PollGenerateReport',connection_id:'other',account_id:'123',payload:{ReportRequestId:'report-1'}},operator)).error.code,'RESOURCE_SCOPE_REQUIRED');assert.equal(calls,2);
 }finally{store.close();}
});

test('website Microsoft OAuth account selection persists customer mapping and default reviewed write grants',async()=>{
 const keys=['AMCP_MICROSOFT_CLIENT_ID','AMCP_MICROSOFT_CLIENT_SECRET','AMCP_MICROSOFT_DEVELOPER_TOKEN'],previous=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]='synthetic');
 const store=new Store(':memory:',key),origin='https://amcp.shop',password='synthetic-ms-website-password';
 const fake:typeof fetch=async url=>{const path=new URL(String(url)).pathname;return Response.json(path.endsWith('/token')?{access_token:'synthetic',refresh_token:'synthetic-refresh',expires_in:3600}:path.endsWith('/User/Query')?{User:{Id:'789'}}:{Accounts:[{Id:'123',ParentCustomerId:'456',Name:'Synthetic',CurrencyCode:'USD'}]});};
 const listener=createHttpApp(new MirrorService(new Registry(),store,undefined,undefined,policy),store,{website:{origin,masterKey:key,adminPassword:password,fetcher:fake}}).listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 const request=(url:string,method='GET',body?:unknown,headers:Record<string,string>={})=>fetch(base+url,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const login=await request('/api/session','POST',{password}),session=await login.json(),headers={Cookie:login.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':session.csrf};
  const started=await (await request('/api/auth/microsoft/start','POST',{},headers)).json(),state=new URL(started.url).searchParams.get('state');assert.ok(state);
  assert.equal((await request('/api/auth/microsoft/callback?state='+state+'&code=synthetic','GET',undefined,headers)).status,303);
  const c=store.listConnections('local')[0]!;assert.equal(c.enabled,false);assert.deepEqual(c.accounts,[]);
  assert.equal((await request('/api/connections/'+c.id+'/assets','PATCH',{selected:['ad_accounts:999']},headers)).status,409);
  assert.equal((await request('/api/connections/'+c.id+'/assets','PATCH',{selected:['ad_accounts:123']},headers)).status,200);
  let saved=store.listConnections('local')[0]!;assert.deepEqual(saved.accountCustomers,{'123':'456'});assert.deepEqual(saved.writeAccounts,['123']);
  const config=await (await request('/api/platforms')).json();assert.equal(JSON.stringify(config).includes('synthetic-refresh'),false);
  assert.equal((await request('/api/connections/'+c.id+'/assets','PATCH',{selected:[]},headers)).status,200);saved=store.listConnections('local')[0]!;assert.deepEqual(saved.accountCustomers,{});assert.deepEqual(saved.writeAccounts,[]);assert.equal(saved.enabled,false);
 }finally{await new Promise<void>(resolve=>listener.close(()=>resolve()));store.close();keys.forEach((k,i)=>previous[i]===undefined?delete process.env[k]:process.env[k]=previous[i]);}
});

test('write inspection reports contract support with no credential, state or provider access',async()=>{
 const store=new Store(':memory:'),service=new MirrorService(new Registry(),store,new NativeTransport(async()=>{throw Error('Unexpected egress');}),undefined,policy);
 try{
  const supported=await service.call('amcp_write',{action:'inspect',gateway,arguments:{action:'UpdateCampaigns',account_id:'123',payload:{Campaigns:[{Id:'100',DailyBudget:25}]}}},operator);assert.equal(supported.success,true);assert.equal(supported.data.review_contract_supported,true);assert.equal(supported.data.network_requests,0);assert.equal(supported.data.live_permissions_verified,false);
  const unsupported=await service.call('amcp_write',{action:'inspect',gateway:'meta_native_action',arguments:{action:'meta_business_id_business_users_create',account_id:'123',path_params:{business_id:'999'},payload:{name:'Example'}}},operator);assert.equal(unsupported.success,true,JSON.stringify(unsupported));assert.equal(unsupported.data.review_contract_supported,false);assert.equal(unsupported.data.network_requests,0);
  const before=store.documents('t','write_review');assert.equal(before.length,0);
 }finally{store.close();}
});

for(const kind of ['Campaigns','AdGroups','Ads','Keywords'])for(const verb of ['Update','Delete'])test('Microsoft '+verb+kind+' uses exact target snapshots and one native mutation',async()=>{
 const store=new Store(':memory:',key);store.putConnection(admin,connection,{accessToken:'synthetic',developerToken:'synthetic-developer'});let writes=0;
 const service=new MirrorService(new Registry(),store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname,b=JSON.parse(String(init?.body));
  if(path.endsWith('/Account/Query'))return Response.json({Account:{Id:'123'}});
  if(path.endsWith('/QueryByIds')){const entity=path.split('/').at(-2)!,ids=b[entity.slice(0,-1)+'Ids'];return Response.json({[entity]:ids.map((Id:string)=>({Id,Name:'Existing',Status:'Paused',...(entity==='Campaigns'?{DailyBudget:10}:{})}))});}
  writes++;assert.equal(init?.method,verb==='Update'?'PUT':'DELETE');assert.equal(path,'/CampaignManagement/v13/'+kind);assert.equal(new Headers(init?.headers).get('CustomerAccountId'),'123');return Response.json({PartialErrors:null});
 }),undefined,policy);
 try{
  const parent=kind==='Campaigns'?{AccountId:'123'}:kind==='AdGroups'?{CampaignId:'100'}:{AdGroupId:'200'},payload={...parent,...(verb==='Update'?{[kind]:[{Id:'300',Status:'Paused'}]}:{[kind.slice(0,-1)+'Ids']:['300']})};
  const p=await service.call('amcp_write',{action:'prepare',gateway,arguments:{action:verb+kind,account_id:'123',campaign_id:'100',payload}},operator);assert.equal(p.success,true,JSON.stringify(p));
  const e=await service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},operator);assert.equal(e.success,true,JSON.stringify(e));assert.equal(writes,1);
 }finally{store.close();}
});
