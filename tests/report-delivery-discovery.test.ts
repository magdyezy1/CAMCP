import {listenForFetch} from './http-listener.js';
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
import {GoogleSheetsExports,sheetsGateway,spreadsheetIdFromUrl} from '../src/google-sheets.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {platforms} from '../server/platform-oauth.js';
import type {Actor,Connection,JsonObject,CompiledRequest} from '../src/types.js';

const key=Buffer.alloc(32,38).toString('base64'),actor:Actor={tenantId:'local',userId:'owner',role:'admin'};
const google:Connection={id:'google-test',tenantId:'local',gateway:'google_ads_native_action',accounts:[],enabled:false,label:'Google login',scopes:[]};
const sheet:Connection={id:'sheets-test',tenantId:'local',gateway:sheetsGateway,accounts:[],enabled:false,label:'Sheets login',scopes:['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/spreadsheets']};
const credentials={accessToken:'synthetic',developerToken:'synthetic',loginCustomerId:'999'};
const json=(d:unknown,status=200)=>Response.json(d,{status});
function rootRow(id:string,manager=false){return {id,descriptiveName:manager?'Manager '+id:'Account '+id,currencyCode:'EGP',timeZone:'Africa/Cairo',status:'ENABLED',manager};}
const child=(id:string,status:string,root='300')=>({customerClient:{...rootRow(id),clientCustomer:'customers/'+id,resourceName:'customers/'+root+'/customerClients/'+id,status,level:'1'}});
function googleFixture(){const calls:JsonObject[]=[];const fetcher:typeof fetch=async(url,init)=>{
 const u=new URL(String(url)),headers=new Headers(init?.headers),body=init?.body?JSON.parse(String(init.body)):{};calls.push({path:u.pathname,headers,body});
 if(u.pathname.endsWith(':listAccessibleCustomers')){assert.equal(headers.get('login-customer-id'),null);return json({resourceNames:['customers/300','customers/400']});}
 assert.equal(init?.method,'POST');assert.ok(u.pathname.endsWith('/googleAds:search'));const root=u.pathname.split('/')[3]!;assert.equal(headers.get('login-customer-id'),root);
 if(body.query.includes('FROM customer_client')){assert.ok(!/WHERE .*status|WHERE .*hidden|level\s*[<=]/i.test(body.query));return body.pageToken?json({results:[child('302','CANCELED'),child('303','SUSPENDED')]}):json({results:[child('301','CANCELED'),{customerClient:{...rootRow('300',true),level:'0'}}],nextPageToken:'page-two'});}
 return json({results:[{customer:rootRow(root,root==='300')}]});
 };return {fetcher,calls};}

test('Google discovery includes cancelled and suspended descendants, names and routing across manager pages',async()=>{
 const store=new Store(':memory:',key),f=googleFixture();try{store.putConnection(actor,google,credentials);const result=await new AssetDiscovery(store,f.fetcher).sync(google),g=result.groups[0]!;assert.equal(g.complete,true);assert.deepEqual(g.assets.map(a=>a.id).sort(),['300','301','302','303','400']);assert.equal(g.assets.find(a=>a.id==='302')!.status,'CANCELED');assert.equal(g.assets.find(a=>a.id==='302')!.loginCustomerId,'300');assert.equal(g.assets.find(a=>a.id==='302')!.currency,'EGP');assert.equal(f.calls.filter(c=>c.body.pageToken).length,1);assert.deepEqual(store.listConnections('local')[0]!.accounts,[]);}finally{store.close();}
});
test('Google partial discovery retains accessible roots and successful hierarchies when a different root fails',async()=>{
 const store=new Store(':memory:',key),f=googleFixture();try{store.putConnection(actor,google,credentials);const discovery=new AssetDiscovery(store,async(url,init)=>String(url).includes('/customers/400/')?json({error:{message:'Permission denied'}},403):f.fetcher(url,init));const g=(await discovery.sync(google)).groups[0]!;assert.equal(g.complete,false);assert.match(g.error!,/400/);assert.ok(g.assets.some(a=>a.id==='302'&&a.status==='CANCELED'));assert.ok(g.assets.some(a=>a.id==='400'));}finally{store.close();}
});
test('Google hierarchy repeated pagination is a visible incomplete sync, not a complete truncated list',async()=>{
 const store=new Store(':memory:',key);try{store.putConnection(actor,google,credentials);const discovery=new AssetDiscovery(store,async(url,init)=>String(url).endsWith(':listAccessibleCustomers')?json({resourceNames:['customers/300']}):String(init?.body).includes('FROM customer_client')?json({results:[child('301','CANCELED')],nextPageToken:'repeat'}):json({results:[{customer:rootRow('300',true)}]}));const g=(await discovery.sync(google)).groups[0]!;assert.equal(g.complete,false);assert.match(g.error!,/page token/);}finally{store.close();}
});
test('website selection saves a cancelled Google account with its verified manager and transport uses that manager',async()=>{
 const store=new Store(':memory:',key),f=googleFixture(),service=new MirrorService(new Registry(),store),origin='https://amcp.shop',app=createHttpApp(service,store,{website:{origin,masterKey:key,adminPassword:'synthetic-test-password',fetcher:f.fetcher}}),server=await listenForFetch(app);
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  store.putConnection(actor,google,credentials);const login=await fetch(base+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-test-password'})});const data=await login.json() as JsonObject,headers={Origin:origin,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie')!.split(';')[0]!,'X-AMCP-CSRF':data.csrf};
  const sync=await fetch(base+'/api/connections/google-test/sync',{method:'POST',headers,body:'{}'});assert.equal(sync.status,200);await sync.json();
  const select=await fetch(base+'/api/connections/google-test/assets',{method:'PATCH',headers,body:JSON.stringify({selected:['ad_accounts:302']})});assert.equal(select.status,200);await select.json();
  const c=store.resolveConnection(actor,google.gateway,'302','google-test');assert.deepEqual(c.accountLoginCustomers,{'302':'300'});
  let sent:string|null=null;const transport=new NativeTransport(async(_u,init)=>{sent=new Headers(init?.headers).get('login-customer-id');return json({results:[]});});const plan:CompiledRequest={gateway:c.gateway,action:'report',accountId:'302',path:'/v23/customers/302/googleAds:search',method:'POST',query:{},body:{query:'SELECT campaign.id FROM campaign'},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'TEST',warnings:[]};await transport.request(plan,c,credentials);assert.equal(sent,'300');
  assert.throws(()=>store.putConnection(actor,{...c,accountLoginCustomers:{'123':'300'}},credentials),/selected accounts/);
 }finally{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});store.close();}
});
test('CSV download and API URLs bypass page routing; ordinary navigation and modifier keys retain browser behavior',()=>{
 const source=readFileSync('web/app.js','utf8'),start=source.indexOf('function clientNavigation('),end=source.indexOf('\n}',start)+2;
 const context=createContext({});new Script(source.slice(start,end)).runInContext(context);const run=(href:string,extra:JsonObject={},attrs:JsonObject={})=>{context.event={button:0,...extra};context.el={tagName:'A',getAttribute:(name:string)=>name==='href'?href:attrs[name]??null,hasAttribute:(name:string)=>Object.hasOwn(attrs,name)};return new Script('clientNavigation(event,el)').runInContext(context);};
 assert.equal(run('/api/reporting-overview/report.csv'),false);assert.equal(run('/reporting-overview',{}, {download:''}),false);assert.equal(run('/connections'),true);assert.equal(run('/connections',{ctrlKey:true}),false);assert.equal(run('/connections',{defaultPrevented:true}),false);assert.equal(run('//external.invalid/path'),false);assert.equal(run('/connections',{button:1}),false);
 assert.match(readFileSync('web/reporting-overview.js','utf8'),/\.csv" download="AMCP-campaign-report.csv"/);
});
test('pasted Sheets URLs validate the Google host and parse IDs without following arbitrary URLs or gid tabs',()=>{
 for(const url of ['https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0','https://docs.google.com/spreadsheets/u/1/d/sheet123/edit?usp=sharing'])assert.equal(spreadsheetIdFromUrl(url),'sheet123');
 for(const url of ['http://docs.google.com/spreadsheets/d/sheet123/edit','https://docs.google.com.evil.invalid/spreadsheets/d/sheet123/edit','https://user@docs.google.com/spreadsheets/d/sheet123','https://docs.google.com/spreadsheets/d/e/published/pubhtml','https://127.0.0.1/sheet123','sheet123'])assert.throws(()=>spreadsheetIdFromUrl(url),{code:'INVALID_SPREADSHEET_URL'});
 assert.ok(platforms.find(p=>p.id==='sheets')!.scopes.includes('https://www.googleapis.com/auth/spreadsheets'));
});
test('an administrator binds a pasted Sheet after an authenticated read, with stable retries and independent report tabs',async()=>{
 const store=new Store(':memory:',key),calls:JsonObject[]=[];try{store.putConnection(actor,sheet,{accessToken:'synthetic'});const exports=new GoogleSheetsExports(store,async(url,init)=>{calls.push({url:String(url),method:init?.method});assert.equal(new URL(String(url)).hostname,'sheets.googleapis.com');assert.equal(init?.method,'GET');return json({spreadsheetId:'sheet123',properties:{title:'Client reporting'}});});
  const input={connection_id:sheet.id,spreadsheet_url:'https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0',tab_name:'Google account A',idempotency_key:'destination-a',confirmed:true};const a=await exports.bind(actor,input),retry=await exports.bind(actor,input),b=await exports.bind(actor,{...input,tab_name:'Meta account B',idempotency_key:'destination-b'});assert.equal(a.id,retry.id);assert.notEqual(a.sheet_id,b.sheet_id);assert.notEqual(a.tab_name,b.tab_name);assert.equal(store.documents('local','sheets_destination').length,2);assert.deepEqual(store.resolveConnection(actor,sheetsGateway,'sheet123',sheet.id).accounts,['sheet123']);assert.ok(store.document('local','website_assets',sheet.id).selected.includes('spreadsheets:sheet123'));assert.equal(calls.length,3);await assert.rejects(()=>exports.bind(actor,{...input,tab_name:'Changed'}),{code:'IDEMPOTENCY_CONFLICT'});
 }finally{store.close();}
});
test('Sheets URL binding denies unselected files for operators and preserves grants on Google permission failures',async()=>{
 const store=new Store(':memory:',key);try{store.putConnection(actor,{...sheet,enabled:true,accounts:['oldsheet']},{accessToken:'synthetic'});let calls=0;const exports=new GoogleSheetsExports(store,async()=>{calls++;return json({error:{message:'Denied'}},403);}),input={connection_id:sheet.id,spreadsheet_url:'https://docs.google.com/spreadsheets/d/newSheet/edit',confirmed:true};await assert.rejects(()=>exports.bind({...actor,role:'operator'},input),{code:'SPREADSHEET_SCOPE_REQUIRED'});assert.equal(calls,0);await assert.rejects(()=>exports.bind(actor,input),{code:'SHEETS_PERMISSION_DENIED'});assert.deepEqual(store.listConnections('local')[0]!.accounts,['oldsheet']);assert.equal(store.documents('local','sheets_destination').length,0);
  store.putConnection(actor,{...sheet,scopes:['https://www.googleapis.com/auth/drive.file']},{accessToken:'synthetic'});await assert.rejects(()=>exports.bind(actor,input),{code:'SHEETS_RECONNECT_REQUIRED'});assert.deepEqual(store.listConnections('local')[0]!.accounts,[]);
 }finally{store.close();}
});
test('concurrent destination retries cannot replace an existing binding with a different tab',async()=>{
 const store=new Store(':memory:',key);try{store.putConnection(actor,{...sheet,enabled:true,accounts:['sheet123']},{accessToken:'synthetic'});let release!:()=>void,started!:()=>void;const arrived=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);let calls=0;const exports=new GoogleSheetsExports(store,async()=>{if(++calls===1){started();await gate;}return json({spreadsheetId:'sheet123',properties:{title:'Portfolio'}});});const input={connection_id:sheet.id,spreadsheet_id:'sheet123',tab_name:'Original tab',idempotency_key:'same-request-key',confirmed:true};const pending=exports.bind(actor,input);const rejected=assert.rejects(pending,{code:'IDEMPOTENCY_CONFLICT'});await arrived;const winner=await exports.bind(actor,{...input,tab_name:'Other tab'});release();await rejected;assert.equal(store.document('local','sheets_destination',winner.id).requested_tab_name,'Other tab');assert.equal(store.documents('local','sheets_destination').length,1);}finally{store.close();}
});
test('a selected Sheet revoked during binding is not regranted by the in-flight request',async()=>{
 const store=new Store(':memory:',key);try{store.putConnection(actor,{...sheet,enabled:true,accounts:['sheet123','other123']},{accessToken:'synthetic'});const exports=new GoogleSheetsExports(store,async()=>{store.putConnection(actor,{...sheet,enabled:true,accounts:['other123']},{accessToken:'synthetic'});return json({spreadsheetId:'sheet123',properties:{title:'Report'}});});await assert.rejects(()=>exports.bind(actor,{connection_id:sheet.id,spreadsheet_url:'https://docs.google.com/spreadsheets/d/sheet123/edit',confirmed:true}),{code:'SPREADSHEET_SCOPE_REQUIRED'});assert.deepEqual(store.listConnections('local')[0]!.accounts,['other123']);assert.equal(store.documents('local','sheets_destination').length,0);}finally{store.close();}
});
test('sync preserves a URL-selected spreadsheet that drive.file listing cannot enumerate',async()=>{
 const store=new Store(':memory:',key);try{const c={...sheet,accounts:['sheet123'],enabled:true};store.putConnection(actor,c,{accessToken:'synthetic'});const result=await new AssetDiscovery(store,async url=>new URL(String(url)).hostname==='sheets.googleapis.com'?json({spreadsheetId:'sheet123',properties:{title:'Pasted destination'}}):json({files:[]})).sync(c);assert.equal(result.groups[0]!.complete,true);assert.equal(result.groups[0]!.assets[0]!.name,'Pasted destination');}finally{store.close();}
});
test('multiple scheduled account reports save independent views, run once and write only to their own tabs',async()=>{
 const store=new Store(':memory:',key),writes:JsonObject[]=[],metadata:JsonObject={sheets:[]};
 try{
  store.putConnection(actor,{...sheet,enabled:true,accounts:['sheet123']},{accessToken:'synthetic'});store.putConnection(actor,{id:'meta',tenantId:'local',gateway:'meta_native_action',accounts:['100','200'],enabled:true,label:'Meta',scopes:['ads_read']},{accessToken:'synthetic'});
  const fetcher:typeof fetch=async(url,init)=>{const u=new URL(String(url));if(u.hostname==='sheets.googleapis.com'){if(init?.method==='POST'){const body=JSON.parse(String(init.body));writes.push(body);const add=body.requests.find((r:JsonObject)=>r.addSheet),mark=body.requests.find((r:JsonObject)=>r.createDeveloperMetadata);if(add)metadata.sheets.push({properties:add.addSheet.properties,developerMetadata:[mark.createDeveloperMetadata.developerMetadata]});return json({spreadsheetId:'sheet123',replies:body.requests.map(()=>({}))});}return json(u.searchParams.get('fields')?.startsWith('spreadsheetId')?{spreadsheetId:'sheet123',properties:{title:'Portfolio'}}:metadata);}if(u.pathname.endsWith('/insights'))return json({data:[{campaign_id:u.pathname.includes('100')?'101':'201',campaign_name:'Test campaign',objective:'OUTCOME_SALES',spend:'10',clicks:'5'}]});return json({currency:'USD',timezone_name:'UTC'});};
  const service=new MirrorService(new Registry(),store,new NativeTransport(fetcher,async()=>{})),overview=new ReportingOverview(service,fetcher),worker=new ReportWorker(store,async()=>({}),(t,k,i)=>overview.work(t,k,i));
  const makeConfig=(id:string)=>({name:'Report '+id,sources:[{platform:'meta',account_id:id,connection_id:'meta'}],date_range:{preset:'last_complete_days',days:7,timezone:'UTC'},metrics:['spend','clicks'],custom_metrics:[]});
  const scheduled:JsonObject[]=[],destinations:JsonObject[]=[];
  for(const id of ['100','200']){const d=await overview.handle({action:'bind_destination',connection_id:sheet.id,spreadsheet_id:'sheet123',tab_name:'Account '+id,confirmed:true},actor);destinations.push(d);const input={action:'schedule',config:makeConfig(id),schedule:{schedule_kind:'daily',timezone:'UTC',schedule_config:{hour:8},destination_id:d.id},idempotency_key:'schedule-'+id,confirmed:true};const s=await overview.handle(input,actor);assert.equal((await overview.handle(input,actor)).id,s.id);scheduled.push(s);}
  assert.equal(store.documents('local','overview_view').length,2);assert.deepEqual(store.documents('local','overview_view').map(v=>v.config.sources[0].account_id).sort(),['100','200']);
  for(const item of scheduled){const s=store.document('local','overview_schedule',item.id);store.putDocument('local','overview_schedule',item.id,{...s,next_run_at:Date.now()-1000});}
  overview.tick();overview.tick();assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='report_overview'").get()!.n,2);await worker.once();await worker.once();assert.equal(writes.length,2);
  assert.deepEqual(store.db.prepare("SELECT state FROM jobs WHERE kind='report_overview'").all().map(j=>j.state),['complete','complete']);
  assert.ok(store.documents('local','overview_report').every(r=>r.export?.state==='complete'));
  assert.equal(store.documents('local','sheets_delivery').filter(d=>d.state==='complete').length,2);
  const updates=writes.map(w=>w.requests.find((r:JsonObject)=>r.updateCells).updateCells);assert.notEqual(updates[0].range.sheetId,updates[1].range.sheetId);assert.deepEqual(updates.map(u=>u.rows[1].values[1].userEnteredValue.stringValue).sort(),['100','200']);
  await assert.rejects(()=>overview.handle({action:'schedule',config:makeConfig('200'),schedule:{schedule_kind:'daily',timezone:'UTC',destination_id:destinations[0]!.id},confirmed:true},actor),{code:'DESTINATION_IN_USE'});
 }finally{store.close();}
});
