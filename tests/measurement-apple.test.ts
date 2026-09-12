import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService,strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {CredentialProvider} from '../src/auth.js';
import {appleClientSecret,requestAppleAccessToken} from '../src/apple-auth.js';
import {WebStore} from '../server/web-store.js';
import {PlatformOAuth,platform} from '../server/platform-oauth.js';
import {AssetDiscovery} from '../server/asset-discovery.js';
import {createHttpApp} from '../server/http-app.js';
import {appleActions,validateAppleResponse} from '../src/apple-native.js';
import {Compiler} from '../src/compiler.js';
import {paginate} from '../src/pagination.js';
import type {Connection,Credentials,JsonObject} from '../src/types.js';

const master=Buffer.alloc(32,85).toString('base64'),origin='https://amcp.shop',password='synthetic-measurement-password';
const owner={tenantId:'local',userId:'test',role:'admin' as const},reader={...owner,role:'reader' as const};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function connection(gateway:string,accounts:string[]):Connection{return {id:randomUUID(),tenantId:'local',gateway,accounts,label:'Synthetic provider',enabled:accounts.length>0,scopes:[]};}
function fixture(){const store=new Store(':memory:',master),web=new WebStore(store,{origin,masterKey:master,adminPassword:password});return {store,web,session:web.signIn(password,'test')};}

test('Google measurement authorization uses separate callbacks, minimal scopes, PKCE and refresh credentials',async()=>{
 const f=fixture();try{
  const calls:{url:URL;body:URLSearchParams}[]=[],env={AMCP_GOOGLE_CLIENT_ID:'synthetic-shared-client',AMCP_GOOGLE_CLIENT_SECRET:'synthetic-shared-secret'};
  const adapter=new PlatformOAuth(f.web,env,async(url,init)=>{calls.push({url:new URL(String(url)),body:new URLSearchParams(String(init?.body))});return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});});
  for(const id of ['ga4','gtm','gsc']){
   const start=await adapter.start(f.session,id),url=new URL(start.url),state=f.web.consumeOAuth(f.session,id,url.searchParams.get('state')!);
   assert.equal(url.searchParams.get('client_id'),env.AMCP_GOOGLE_CLIENT_ID);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('redirect_uri'),origin+'/api/auth/'+id+'/callback');assert.ok(url.searchParams.get('scope')!.endsWith('.readonly'));
   const result=await adapter.exchange(id,state,{code:'synthetic-code'});assert.equal(result.credentials.refreshToken,'synthetic-refresh');assert.equal(result.credentials.developerToken,undefined);
   assert.equal(calls.at(-1)!.body.get('code_verifier'),state.verifier);assert.equal(calls.at(-1)!.url.href,'https://oauth2.googleapis.com/token');
   const c=connection(platform(id).gateway,['123']);f.store.putConnection(owner,c,{...result.credentials,expiresAt:Date.now()-1});
   const refresh=new CredentialProvider(f.store,async(url,init)=>{assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'),'synthetic-refresh');return json({access_token:'synthetic-renewed',refresh_token:'synthetic-rotated',expires_in:3600});});
   assert.equal((await refresh.get(c)).refreshToken,'synthetic-rotated');assert.equal(f.store.credentials('local',c.id).accessToken,'synthetic-renewed');
  }
  const partial=new PlatformOAuth(f.web,{...env,AMCP_GA4_CLIENT_ID:'dedicated-without-secret'});assert.equal(partial.config(platform('ga4')).configured,false);
 }finally{f.store.close();}
});

test('GA4, Google tag containers, Search Console sites and Apple ACL discovery preserve resource grants',async()=>{
 const f=fixture();try{
  const paths:string[]=[],fake:typeof fetch=async(input)=>{
   const url=new URL(String(input));paths.push(url.pathname+url.search);
   if(url.pathname==='/v1beta/accountSummaries')return json(url.searchParams.has('pageToken')?{accountSummaries:[{account:'accounts/8',propertySummaries:[{property:'properties/124',displayName:'Second property'}]}]}:{accountSummaries:[{account:'accounts/8',propertySummaries:[{property:'properties/123',displayName:'Primary'}]}],nextPageToken:'page2'});
   if(url.pathname==='/v1beta/properties/123/dataStreams')return json({dataStreams:[{name:'properties/123/dataStreams/9',displayName:'Web'}]});
   if(url.pathname==='/tagmanager/v2/accounts'){assert.equal(url.searchParams.get('includeGoogleTags'),'true');return json({account:[{accountId:'44',name:'Tags'}]});}
   if(url.pathname==='/tagmanager/v2/accounts/44/containers')return json({container:[{accountId:'44',containerId:'5',name:'Google tag',usageContext:['gtag']}]});
   if(url.pathname==='/webmasters/v3/sites')return json({siteEntry:[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'},{siteUrl:'https://unverified.invalid/',permissionLevel:'siteUnverifiedUser'}]});
   if(url.pathname.endsWith('/sitemaps'))return json({sitemap:[{path:'https://example.com/sitemap.xml'}]});
   if(url.pathname==='/v1/acls'){assert.equal(url.origin,'https://api.ads.apple.com');return json({result:{acls:[{adAccount:{id:'77',name:'App ads',orgId:'8'},roles:['API_ACCOUNT_READ_ONLY']}]}});}
   throw Error('Unexpected discovery URL '+url.pathname);
  };
  const discovery=new AssetDiscovery(f.store,fake);
  for(const [id,accounts,kind,expected,related]of [
   ['ga4',['123'],'properties',['123','124'],'data_streams'],['gtm',['44'],'tag_accounts',['44'],'containers'],['gsc',['sc-domain:example.com'],'sites',['sc-domain:example.com'],'sitemaps'],['apple',['77'],'ad_accounts',['77'],undefined]
  ] as const){
   const c=connection(platform(id).gateway,[...accounts]);f.store.putConnection(owner,c,{accessToken:'synthetic'});
   const result=await discovery.sync(c);assert.equal(result.groups[0]!.kind,kind);assert.equal(result.groups[0]!.complete,true,result.groups[0]!.error);assert.deepEqual(result.groups[0]!.assets.map(a=>a.id),[...expected]);
   if(related){const result=await discovery.sync(c,[related]);assert.equal(result.groups[0]!.complete,true,result.groups[0]!.error);assert.equal(result.groups[0]!.assets[0]!.parentId,accounts[0]);}
  }
  assert.ok(paths.some(p=>p.includes('pageToken=page2')));
  const c=connection(platform('gtm').gateway,['44']);f.store.putConnection(owner,c,{accessToken:'synthetic'});
  const invalid=new AssetDiscovery(f.store,async()=>json({container:[{accountId:'999',containerId:'5'}]}));const result=await invalid.sync(c,['containers']);assert.equal(result.groups[0]!.complete,false);assert.deepEqual(result.groups[0]!.assets,[]);
 }finally{f.store.close();}
});

test('Google measurement gateways execute scoped native reads and reject a different selected resource',async()=>{
 const f=fixture();try{
  const calls:string[]=[],transport=new NativeTransport(async(input,init)=>{const url=new URL(String(input));calls.push(url.pathname);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic');
   if(url.pathname.endsWith(':runReport'))return json({dimensionHeaders:[],metricHeaders:[{name:'sessions',type:'TYPE_INTEGER'}],rows:[{metricValues:[{value:'12'}]}],rowCount:1});
   if(url.pathname.endsWith('/containers'))return json({container:[{accountId:'44',containerId:'5',name:'Google tag'}]});
   if(url.pathname.endsWith('/searchAnalytics/query'))return json({rows:[{keys:['query'],clicks:5,impressions:20,ctr:0.25,position:2}],responseAggregationType:'byProperty'});
   throw Error('Unexpected request');
  }),service=new MirrorService(new Registry(),f.store,transport);
  const cases=[
   {id:'ga4',account:'123',operation:'ga4_run_report',args:{property:'123',request:{dateRanges:[{startDate:'2026-09-01',endDate:'2026-09-02'}],metrics:[{name:'sessions'}]}}},
   {id:'gtm',account:'44',operation:'gtm_ops',args:{action:'LIST_CONTAINERS',account_id:'44'}},
   {id:'gsc',account:'sc-domain:example.com',operation:'gsc_analytics_ops',args:{action:'QUERY_SEARCH_ANALYTICS',site_url:'sc-domain:example.com',payload:{startDate:'2026-09-01',endDate:'2026-09-02'}}}
  ];
  for(const c of cases){const gateway=platform(c.id).gateway,conn=connection(gateway,[c.account]);f.store.putConnection(owner,conn,{accessToken:'synthetic'});const result=await service.call(gateway,{operation:c.operation,arguments:c.args},reader);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.dry_run,false);}
  const denied=await service.call('ga4_native_action',{operation:'ga4_run_report',arguments:{...cases[0]!.args,property:'999'}},reader);assert.equal(denied.success,false);assert.equal(calls.length,3);
 }finally{f.store.close();}
});

test('Apple Ads signs ES256 client secrets and automatically renews access credentials without browser OAuth',async()=>{
 const f=fixture(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const credentials:Credentials={clientId:'synthetic.apple.client',appleTeamId:'synthetic-team',appleKeyId:'synthetic-key',applePrivateKey:privateKey};
 try{
  const jwt=appleClientSecret(credentials,1000),parts=jwt.split('.'),header=JSON.parse(Buffer.from(parts[0]!,'base64url').toString()),body=JSON.parse(Buffer.from(parts[1]!,'base64url').toString());
  assert.equal(header.alg,'ES256');assert.equal(header.kid,'synthetic-key');assert.equal(body.aud,'https://appleid.apple.com');assert.equal(body.sub,credentials.clientId);assert.equal(body.iss,credentials.appleTeamId);assert.equal(body.exp,1300);assert.ok(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2]!,'base64url')));
  let count=0;const fake:typeof fetch=async(url,init)=>{count++;assert.equal(String(url),'https://appleid.apple.com/auth/oauth2/token');const params=new URLSearchParams(String(init?.body));assert.equal(params.get('grant_type'),'client_credentials');assert.equal(params.get('scope'),'searchadsorg');assert.equal(params.get('client_secret')!.split('.').length,3);return json({access_token:'synthetic-apple-'+count,token_type:'Bearer',expires_in:3600});};
  const initial=await requestAppleAccessToken(credentials,fake),c=connection('apple_ads_native_action',['77']);f.store.putConnection(owner,c,{...initial,expiresAt:Date.now()-1});
  const provider=new CredentialProvider(f.store,fake),results=await Promise.all([provider.get(c),provider.get(c)]);assert.equal(count,2);assert.equal(results[0]!.accessToken,'synthetic-apple-2');assert.equal(results[1]!.accessToken,'synthetic-apple-2');assert.equal(f.store.credentials('local',c.id).applePrivateKey,privateKey);
  const raw=(f.store.db.prepare('SELECT secret FROM connections WHERE id=?').get(c.id) as {secret:string}).secret;assert.ok(!raw.includes(privateKey));
  assert.throws(()=>appleClientSecret({...credentials,applePrivateKey:'not-pem'}),/P-256/);
  await assert.rejects(requestAppleAccessToken(credentials,async()=>json({access_token:'invalid',expires_in:0})),/lifetime/);
 }finally{f.store.close();}
});

test('Meta initial code is exchanged for the provider-reported long-lived token; TikTok advertiser tokens never use consumer refresh',async()=>{
 const f=fixture();try{
  const calls:URL[]=[],adapter=new PlatformOAuth(f.web,{AMCP_META_CLIENT_ID:'synthetic-client',AMCP_META_CLIENT_SECRET:'synthetic-secret'},async(input)=>{
   const url=new URL(String(input));calls.push(url);
   return url.searchParams.get('grant_type')==='fb_exchange_token'?json({access_token:'synthetic-long',expires_in:5184000}):json({access_token:'synthetic-short',expires_in:3600,scope:'ads_read'});
  });
  const start=await adapter.start(f.session,'meta'),stored=f.web.consumeOAuth(f.session,'meta',new URL(start.url).searchParams.get('state')!),before=Date.now(),result=await adapter.exchange('meta',stored,{code:'synthetic-code'});
  assert.equal(calls.length,2);assert.equal(calls[1]!.searchParams.get('fb_exchange_token'),'synthetic-short');assert.equal(result.credentials.accessToken,'synthetic-long');assert.ok(result.credentials.expiresAt!>=before+5184000000);assert.deepEqual(result.scopes,['ads_read']);
  const invalid=new PlatformOAuth(f.web,{AMCP_META_CLIENT_ID:'synthetic',AMCP_META_CLIENT_SECRET:'synthetic'},async()=>json({access_token:'synthetic'}));await assert.rejects(invalid.exchange('meta',stored,{code:'synthetic'}),/lifetime/);
  const c=connection('tiktok_native_action',['123']);f.store.putConnection(owner,c,{accessToken:'long-term-synthetic'});let requests=0;const provider=new CredentialProvider(f.store,async()=>{requests++;throw Error('Consumer refresh must not be used');});assert.equal((await provider.get(c)).accessToken,'long-term-synthetic');
  f.store.replaceCredentials('local',c.id,{accessToken:'expired',expiresAt:Date.now()-1,refreshToken:'unsupported-token',clientId:'synthetic',clientSecret:'synthetic'});await assert.rejects(provider.get(c),/reauthorization/);assert.equal(requests,0);
 }finally{f.store.close();}
});

test('website onboarding persists selectable properties/sites and Apple accounts while enforcing CSRF and explicit grants',async()=>{
 const envKeys=['AMCP_GA4_CLIENT_ID','AMCP_GA4_CLIENT_SECRET','AMCP_GTM_CLIENT_ID','AMCP_GTM_CLIENT_SECRET','AMCP_GSC_CLIENT_ID','AMCP_GSC_CLIENT_SECRET','AMCP_APPLE_CLIENT_ID','AMCP_APPLE_CLIENT_SECRET'],previous=envKeys.map(key=>process.env[key]);
 envKeys.forEach(key=>process.env[key]='synthetic');const store=new Store(':memory:',master),service=new MirrorService(new Registry(),store);
 let holdToken=false,releaseToken:()=>void=()=>{},notifyToken:()=>void=()=>{};
 const tokenStarted=new Promise<void>(r=>notifyToken=r),tokenReleased=new Promise<void>(r=>releaseToken=r);
 const fake:typeof fetch=async(input)=>{const url=new URL(String(input));if(url.hostname==='oauth2.googleapis.com'||url.hostname==='appleid.apple.com'){if(holdToken){notifyToken();await tokenReleased;}return json({access_token:'synthetic',refresh_token:'synthetic',expires_in:3600});}if(url.pathname.endsWith('accountSummaries'))return json({accountSummaries:[{account:'accounts/8',propertySummaries:[{property:'properties/123',displayName:'GA4'}]}]});if(url.pathname==='/tagmanager/v2/accounts')return json({account:[{accountId:'44',name:'Google tags'}]});if(url.pathname==='/webmasters/v3/sites')return json({siteEntry:[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}]});if(url.pathname==='/v1/acls')return json({result:{acls:[{adAccount:{id:'77',name:'Apple'},roles:['API_ACCOUNT_READ_ONLY']}]}});throw Error('Unexpected URL');};
 const listener=createHttpApp(service,store,{website:{origin,masterKey:master,adminPassword:password,fetcher:fake}}).listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+(listener.address() as {port:number}).port;
 const request=async(url:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{const r=await fetch(base+url,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers});};
 try{
  const login=await request('/api/session','POST',{password}),headers={Cookie:login.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':(await login.json()).csrf as string};
  const config=await (await request('/api/platforms')).json();assert.equal(config.platforms.length,15);assert.equal(config.platforms.find((p:JsonObject)=>p.id==='apple').callback,null);assert.ok(!JSON.stringify(config).includes('synthetic'));
  for(const [id,selection]of [['ga4','properties:123'],['gtm','tag_accounts:44'],['gsc','sites:sc-domain:example.com'],['apple','ad_accounts:77']]){
   assert.equal((await request('/api/auth/'+id+'/start','POST',{})).status,401);const start=await request('/api/auth/'+id+'/start','POST',{},headers);assert.equal(start.status,200);const started=await start.json();
   if(id!=='apple'){const state=new URL(started.url).searchParams.get('state');assert.equal((await request('/api/auth/'+id+'/callback?code=synthetic&state='+state,'GET',undefined,headers)).status,303);}
   const c=store.listConnections('local').find(c=>c.gateway===platform(id!).gateway)!;assert.ok(c);assert.deepEqual(c.accounts,[]);assert.equal(c.enabled,false);
   assert.equal((await request('/api/connections/'+c.id+'/assets','PATCH',{selected:[selection]},{Cookie:headers.Cookie})).status,403);
   const saved=await request('/api/connections/'+c.id+'/assets','PATCH',{selected:[selection]},headers);assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).enabled,true);
   assert.equal((await request('/api/connections/'+c.id+'/assets','PATCH',{selected:['unknown:999']},headers)).status,409);
  }
  const before=store.listConnections('local').length,attempt=await (await request('/api/auth/ga4/start','POST',{},headers)).json();holdToken=true;
  const callback=request('/api/auth/ga4/callback?code=synthetic&state='+new URL(attempt.url).searchParams.get('state'),'GET',undefined,headers);
  await tokenStarted;try{assert.equal((await request('/api/session','DELETE',undefined,headers)).status,200);}finally{releaseToken();}
  assert.equal((await callback).status,303);assert.equal(store.listConnections('local').length,before);assert.equal(store.document('local','oauth_progress',attempt.attemptId).state,'failed');
 }finally{const closing=new Promise<void>(r=>listener.close(()=>r()));listener.closeAllConnections();await closing;store.close();envKeys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
});

test('Apple native reads, reports, pagination, projection and scope validation work through MirrorService',async()=>{
 const f=fixture();try{
  const c=connection('apple_ads_native_action',['77']);f.store.putConnection(owner,c,{accessToken:'synthetic-apple'});let requests=0;
  const service=new MirrorService(new Registry(),f.store,new NativeTransport(async(input,init)=>{
   requests++;const url=new URL(String(input));assert.equal(url.origin,'https://api.ads.apple.com');assert.equal(new Headers(init?.headers).get('X-AP-Context'),'adAccountId=77;');
   if(url.pathname==='/v1/campaigns/query'){const body=JSON.parse(String(init?.body));assert.equal(init?.method,'POST');const offset=body.pagination.offset;return json({result:[{id:String(100+offset),adAccountId:'77',name:'Campaign'}],pagination:{offset,pageSize:1,totalCount:2}});}
   if(url.pathname==='/v1/reports/apps/campaigns/query'){const body=JSON.parse(String(init?.body));return json({result:{rows:[{metadata:{campaignId:'100'},total:{impressions:3}}]},pagination:{offset:body.pagination.offset,pageSize:1,totalCount:1}});}
   if(url.pathname==='/v1/campaigns/100')return json({result:{id:'100',adAccountId:'77',name:'Campaign'}});
   throw Error('Unexpected route');
  }));
  const result=await service.call(c.gateway,{action:'apple_ads_v1_campaigns_query',account_id:'77',payload:{pagination:{pageSize:1}},aggregate_pages:true,result_fields:['id','name']},reader);
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.pages,2);assert.deepEqual(result.data.data.result,[{id:'100',name:'Campaign'},{id:'101',name:'Campaign'}]);assert.equal(result.data.dry_run,false);
  const report=await service.call(c.gateway,{action:'apple_ads_v1_reports_apps_campaigns',account_id:'77',payload:{timeRange:{start:'2026-09-01',end:'2026-09-02',granularity:'DAILY'}}},reader);assert.equal(report.success,true,JSON.stringify(report));assert.equal(report.data.data.result.rows[0].total.impressions,3);
  const get=await service.call(c.gateway,{action:'apple_ads_v1_campaign_get',account_id:'77',path_params:{id:'100'}},reader);assert.equal(get.success,true,JSON.stringify(get));
  const before=requests;
  for(const input of [{action:'apple_ads_v1_campaigns_query',account_id:'999'},{action:'apple_ads_v1_campaigns_query',account_id:'77',payload:{pagination:{pageSize:0}}},{action:'apple_ads_v1_campaign_get',account_id:'77',path_params:{id:'../x'}},{action:'apple_ads_v1_ad_account_get',account_id:'77',path_params:{id:'88'}},{action:'apple_ads_v1_reports_apps_campaigns',account_id:'77',payload:{timeRange:{start:'2026-02-30',end:'2026-03-01'}}}])assert.equal((await service.call(c.gateway,input,reader)).success,false);
  assert.equal(requests,before);
  const preview=await service.call(c.gateway,{action:'apple_ads_v1_campaign_delete',account_id:'77',path_params:{id:'100'}},reader);assert.equal(preview.success,true);assert.equal(preview.data.dry_run,true);assert.equal(requests,before);
  const help=service.registry.help({gateway:c.gateway},strictOptions);assert.ok(help.amcp_actions.some((a:JsonObject)=>a.action==='apple_ads_v1_campaigns_query'));
 }finally{f.store.close();}
});

test('Apple route contracts reject malformed results and keep bounded pagination honest',async()=>{
 const compiler=new Compiler(new Registry());
 for(const action of appleActions.filter(a=>a.read_only)){
  const report=action.raw.kind==='report',get=action.raw.kind==='get';
  const plan=compiler.compile('apple_ads_native_action',{action:action.name,account_id:'77',...(get?{path_params:{id:action.name==='apple_ads_v1_ad_account_get'?'77':'100'}}:{}),...(report?{payload:{timeRange:{start:'2026-09-01',end:'2026-09-02'},options:{}}}:{})},strictOptions);
  assert.equal(plan.origin,'https://api.ads.apple.com');assert.equal(plan.accountId,'77');assert.ok(!plan.path.includes('{')&&!plan.path.includes('%7B'));
  for(const invalid of [{},null,{result:null}])assert.throws(()=>validateAppleResponse(plan,invalid),/expected result/);
  if(!report){assert.throws(()=>validateAppleResponse(plan,{result:get?{id:'100',adAccountId:'999'}:[{id:'100',adAccountId:'999'}]}),/another ad account/);}
 }
 const plan=compiler.compile('apple_ads_native_action',{action:'apple_ads_v1_campaigns_query',account_id:'77',payload:{pagination:{pageSize:1}}},strictOptions);
 const capped=await paginate(plan,async()=>({result:[{id:'1'}],pagination:{offset:0,pageSize:1,totalCount:2}}),1);assert.equal(capped.truncated,true);
 await assert.rejects(paginate(plan,async()=>({result:[],pagination:{offset:0,pageSize:1,totalCount:2}})),/empty page/);
 await assert.rejects(paginate(plan,async()=>({result:[{id:'1'}],pagination:{offset:9,pageSize:1,totalCount:2}})),/inconsistent/);
});
