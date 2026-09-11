import assert from 'node:assert/strict';

// Share the deployed HTTP contract with local integration tests so CI cannot
// silently retain expectations from an older application release.
export async function checkApplication({base, origin, password, writes, restart}) {
 const api=async(path,method='GET',body,headers={})=>{
  const response=await fetch(base+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Connection:'close',...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  // Drain even status-only responses before restarting the server.
  const text=await response.text();
  return {status:response.status,headers:response.headers,text:async()=>text,json:async()=>JSON.parse(text)};
 };
 const json=async(path,method='GET',body,headers={})=>{const response=await api(path,method,body,headers);assert.equal(response.status,200,path);return response.json();};
 const paths=['/','/connections','/connectors','/dashboard','/campaigns','/media','/reports','/reporting-overview','/profiles','/login','/signup','/forgot-password','/verify-email','/reset-password','/account','/assets/app.js','/assets/app.css','/assets/workspace.js','/assets/identity.js','/assets/identity.css','/assets/account-security.js','/assets/reporting-overview.js','/assets/reporting.css','/assets/owner-operations.js'];
 for(const path of paths)assert.equal((await api(path)).status,200,path);
 const privacy=await api('/privacy');assert.equal(privacy.status,200);assert.match(privacy.headers.get('content-type'),/^text\/html/);assert.match(await privacy.text(),/AES-256-GCM/);assert.equal(privacy.headers.get('location'),null);assert.equal(privacy.headers.get('set-cookie'),null);
 assert.equal((await api('/assets/privacy.css')).status,200);
 const page=await (await api('/reporting-overview')).text();
 assert.match(page,/href="\/reporting-overview" data-route="reporting-overview"/,'Reporting Overview navigation is present');
 assert.match(page,/src="\/assets\/reporting-overview\.js"/,'Reporting Overview script is loaded');
 assert.equal((await api('/api/workspace/overview','POST',{action:'bootstrap'},{Origin:origin})).status,401);
 assert.equal((await api('/api/reporting-overview/synthetic.csv')).status,401);

 const signin=await json('/api/account/options');
 assert.deepEqual(signin.providers,[],'Unconfigured social providers are hidden from signed-out visitors');
 assert.equal(signin.emailEnabled,false);
 assert.equal((await api('/api/account')).status,401);
 const login=await api('/api/session','POST',{password},{Origin:origin});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf,headers={Cookie:cookie,Origin:origin,'X-AMCP-CSRF':csrf};
 const administratorOptions=await json('/api/account/options','GET',undefined,headers);
 assert.deepEqual(administratorOptions.providers.map(p=>p.id),['google','apple','facebook']);
 assert.ok(administratorOptions.providers.every(p=>p.configured===false),'Administrators can inspect unconfigured sign-in providers');

 const configured=await json('/api/platforms','GET',undefined,headers);
 assert.deepEqual(configured.platforms.map(p=>p.id).sort(),['google','meta','tiktok','snapchat','linkedin','x','ga4','gtm','gsc','apple','microsoft','drive','sheets'].sort());
 for(const id of ['snapchat','microsoft','drive','sheets'])assert.equal(configured.platforms.find(p=>p.id===id).callback,origin+'/api/auth/'+id+'/callback');
 const drive=configured.platforms.find(p=>p.id==='drive');
 assert.equal(drive.reviewedWrites,false);
 assert.deepEqual(drive.scopes,['https://www.googleapis.com/auth/drive.readonly']);
 const sheets=configured.platforms.find(p=>p.id==='sheets');
 assert.equal(sheets.reviewedWrites,false);
 assert.deepEqual(sheets.scopes,['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/spreadsheets']);
 for(const id of ['ga4','gtm','gsc','apple'])assert.equal(configured.platforms.find(p=>p.id===id).reviewedWrites,true);
 assert.equal(configured.platforms.find(p=>p.id==='gtm').scopes.includes('https://www.googleapis.com/auth/tagmanager.publish'),writes);
 assert.equal(configured.platforms.find(p=>p.id==='gsc').scopes.includes('https://www.googleapis.com/auth/webmasters'),writes);

 const overview=await json('/api/workspace/overview','POST',{action:'bootstrap'},headers);
 assert.equal(overview.success,true,'Reporting Overview API is available');
 assert.deepEqual(overview.data.platforms.map(p=>p.id).sort(),['google','meta','tiktok','snapchat','linkedin','x','ga4','gsc','apple','microsoft','reddit'].sort());
 assert.ok(overview.data.metrics.spend);
 assert.deepEqual(overview.data.schedules,[]);
 assert.deepEqual(overview.data.destinations,[]);
 assert.equal((await api('/api/workspace/overview','POST',{action:'bootstrap'},{Cookie:cookie,Origin:origin})).status,403,'Reporting Overview retains CSRF protection');

 const metadata=await json('/.well-known/oauth-authorization-server');
 assert.deepEqual(metadata.token_endpoint_auth_methods_supported.sort(),['client_secret_post','none']);
 assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
 const token=await json('/api/connector-tokens','POST',{name:'Synthetic CI client',role:'reader'},headers);
 const mcpHeaders={Authorization:'Bearer '+token.token,Accept:'application/json, text/event-stream'};
 let requestId=0;
 const mcp=async(method,params)=>{const body=await json('/mcp','POST',{jsonrpc:'2.0',id:++requestId,method,...(params?{params}:{})},mcpHeaders);assert.ok(!body.error,method);return body.result;};
 const tools=await mcp('tools/list');
 assert.equal(tools.tools.length,writes?27:25);
 assert.ok(tools.tools.some(t=>t.name==='amcp_reporting_overview'));
 const guides=await mcp('resources/list');
 assert.equal(guides.resources.length,10);
 assert.ok(guides.resources.some(r=>r.uri==='amcp://guides/reporting-overview'));
 // Read every advertised guide from the runtime image, not just its build stage.
 for(const resource of guides.resources){
  const guide=await mcp('resources/read',{uri:resource.uri});
  assert.ok(guide.contents?.some(c=>typeof c.text==='string'&&c.text.length>500),resource.uri);
  if(resource.uri==='amcp://guides/reporting-overview')assert.ok(guide.contents[0].text.includes('Google Sheets'));
  if(resource.uri==='amcp://guides/microsoft-ads')assert.ok(guide.contents[0].text.includes('DailyBudget'));
 }
 const writer=await api('/api/connector-tokens','POST',{name:'Synthetic operator',role:'operator',confirmed:true},headers);
 assert.equal(writer.status,writes?200:403);
 if(writes){
  const w=await writer.json();
  const denied=await json('/mcp','POST',{jsonrpc:'2.0',id:++requestId,method:'tools/call',params:{name:'amcp_write',arguments:{action:'prepare',gateway:'meta_native_action',arguments:{action:'meta_campaign_create',account_id:'123',payload:{name:'Synthetic',status:'PAUSED'}}}}},{Authorization:'Bearer '+w.token,Accept:'application/json, text/event-stream'});
  assert.equal(denied.result.isError,true,'Enabling writes does not grant account access');
 }
 await restart();
 assert.equal((await json('/api/session','GET',undefined,headers)).authenticated,true);
 assert.equal((await api('/api/connector-tokens/'+token.id,'DELETE',undefined,headers)).status,200);
 assert.equal((await api('/mcp','GET',undefined,{Authorization:'Bearer '+token.token})).status,401);
}
