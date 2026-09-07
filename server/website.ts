import express,{type Request,type Response,type NextFunction} from 'express';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebStore,type WebsiteOptions} from './web-store.js';
import {PlatformOAuth,platform,platforms,selectionKind} from './platform-oauth.js';
import {AssetDiscovery,type AssetGroup} from './asset-discovery.js';
import {Store} from '../src/store.js';
import {MirrorError} from '../src/errors.js';
import {sha256,redact} from '../src/security.js';
import type {Connection,JsonObject} from '../src/types.js';
import {McpOAuth} from './mcp-oauth.js';
import {mcpAuthRouter} from '@modelcontextprotocol/sdk/server/auth/router.js';

export function createWebsite(store:Store,options:WebsiteOptions,allowWrites=false){
 const web=new WebStore(store,options),oauth=new PlatformOAuth(web,process.env,options.fetcher,allowWrites),discovery=new AssetDiscovery(store,options.fetcher),router=express.Router();
 router.use((_req,res,next)=>{res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');next();});
 const mcpOAuth=new McpOAuth(web,allowWrites);
 router.use(['/token','/revoke'],express.urlencoded({extended:false,limit:'16kb'}),async(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');if(req.method!=='POST'){next();return;}
  try{web.consumeMcpAttempt(req);}catch{res.status(429).setHeader('Retry-After','900').json({error:'too_many_requests'});return;}
  try{await mcpOAuth.authenticateClient(req.body,req.headers.authorization);next();}catch{res.status(400).json({error:'invalid_client',error_description:'Invalid client credentials or authentication method.'});}
 });
 router.use(mcpAuthRouter({provider:mcpOAuth,issuerUrl:new URL(web.origin),resourceServerUrl:mcpOAuth.resource,scopesSupported:allowWrites?['mcp:read','mcp:write']:['mcp:read'],resourceName:'AMCP',serviceDocumentationUrl:new URL(web.origin+'/connectors')}));
 const handler=(fn:(req:Request,res:Response)=>unknown)=>async(req:Request,res:Response,next:NextFunction)=>{try{await fn(req,res);}catch(e){next(e);}};
 const connection=(tenant:string,id:string)=>{const c=store.listConnections(tenant).find(c=>c.id===id);if(!c)throw new MirrorError('CONNECTION_NOT_FOUND','The connection was not found in this workspace.',{},404);return c;};
 const readDocument=(tenant:string,kind:string,id:string,fallback:JsonObject={})=>{try{return store.document(tenant,kind,id);}catch(e){if(e instanceof MirrorError&&e.code==='NOT_FOUND')return fallback;throw e;}};
 const savedAssets=(tenant:string,c:Connection)=>{const kind=selectionKind(c.gateway);return readDocument(tenant,'website_assets',c.id,{groups:[{kind,complete:false,assets:c.accounts.map(id=>({id,kind,name:id,source:'configured_binding'}))}],selected:c.accounts.map(id=>kind+':'+id),lastSync:null});};
 const publicConnection=(tenant:string,c:Connection)=>{
  const assets=savedAssets(tenant,c),meta=readDocument(tenant,'website_connection',c.id);
  return {id:c.id,name:c.label,enabled:c.enabled,isDefault:c.isDefault===true,accounts:c.accounts,writeAccounts:(c.writeAccounts??[]).filter(id=>c.accounts.includes(id)),expiresAt:meta.expiresAt??null,lastSync:assets.lastSync??null,error:assets.error??null,selected:assets.selected??[],groups:assets.groups??[],status:assets.error?'attention':c.enabled?'connected':'selection_required'};
 };
 const sync=async(tenant:string,c:Connection,kinds?:string[])=>{
  const result=await discovery.sync(c,kinds);
  // A sync may overlap selection, default changes, or disconnect. Never restore its old grants.
  c=connection(tenant,c.id);const previous=savedAssets(tenant,c),groups:AssetGroup[]=[...(previous.groups??[])];
  for(const group of result.groups){const old=groups.findIndex(g=>g.kind===group.kind);const replacement=!group.complete&&old>=0?{...group,assets:groups[old]!.assets}:group;if(old>=0)groups[old]=replacement;else groups.push(replacement);}
  const failed=result.groups.filter(g=>!g.complete),prefix=selectionKind(c.gateway)+':';let selection=(previous.selected??c.accounts.map(id=>prefix+id)) as string[];
  const accountsGroup=result.groups.find(g=>g.kind===selectionKind(c.gateway)&&g.complete);
  if(accountsGroup){const visible=new Set(accountsGroup.assets.map(a=>a.id));selection=selection.filter(k=>!k.startsWith(prefix)||visible.has(k.slice(prefix.length)));const accounts=c.accounts.filter(id=>visible.has(id));if(accounts.length!==c.accounts.length){c={...c,accounts,writeAccounts:(c.writeAccounts??[]).filter(id=>accounts.includes(id)),enabled:c.enabled&&accounts.length>0};store.putConnection({tenantId:tenant,userId:'workspace-admin',role:'admin'},c,store.credentials(tenant,c.id));}}
  store.putDocument(tenant,'website_assets',c.id,{groups,selected:selection,lastSync:Date.now(),error:failed.length?failed.map(g=>g.error).join(' '):null});
  if(result.label){c={...c,label:result.label};store.db.prepare('UPDATE connections SET data=? WHERE tenant_id=? AND id=?').run(JSON.stringify(c),tenant,c.id);}
  store.appendAudit(tenant,randomUUID(),{event:'website_asset_sync',connection_id:c.id,kinds:result.groups.map(g=>g.kind),complete:failed.length===0,vendor_writes:0});
  return publicConnection(tenant,c);
 };
 router.get('/api/session',handler((req,res)=>{const session=web.session(req);res.json({authenticated:!!session,configured:web.configured,csrf:session?.csrf??null,name:session?'Workspace administrator':null,origin:web.origin,readOnly:!allowWrites,writesEnabled:allowWrites});}));
 router.post('/api/session',express.json({limit:'4kb'}),handler((req,res)=>{web.requireOrigin(req);if(typeof req.body?.password!=='string')throw new MirrorError('INVALID_LOGIN','Enter your workspace password.',{},400);const old=web.session(req),session=web.signIn(req.body.password,web.clientAddress(req));if(old)web.signOut(old.id);res.setHeader('Set-Cookie',web.cookie(session.id));res.json({authenticated:true,csrf:session.csrf,name:'Workspace administrator'});}));
 router.delete('/api/session',handler((req,res)=>{const session=web.requireMutation(req);web.signOut(session.id);res.setHeader('Set-Cookie',web.cookie('',0));res.json({success:true});}));
 router.get('/api/mcp/consent',handler((req,res)=>{const s=web.requireSession(req);if(typeof req.query.request!=='string')throw new MirrorError('INVALID_CONSENT','Start authorization from your MCP client.');res.json(mcpOAuth.consent(req.query.request,s));}));
 router.post('/api/mcp/consent',express.json({limit:'4kb'}),handler((req,res)=>{const s=web.requireMutation(req);if(typeof req.body?.request!=='string'||typeof req.body?.approved!=='boolean')throw new MirrorError('INVALID_CONSENT','Invalid authorization decision.');const consent=mcpOAuth.consent(req.body.request,s),url=mcpOAuth.decide(req.body.request,s,req.body.approved);store.appendAudit(s.actor.tenantId,randomUUID(),{event:req.body.approved?'mcp_oauth_approved':'mcp_oauth_denied',scope:consent.scope,role:consent.role});res.json({url});}));
 router.get('/api/mcp/authorizations',handler((req,res)=>{web.requireSession(req);res.json({clients:mcpOAuth.authorizations()});}));
 router.delete('/api/mcp/authorizations/:id',handler((req,res)=>{const s=web.requireMutation(req);mcpOAuth.revokeClient(String(req.params.id));store.appendAudit(s.actor.tenantId,randomUUID(),{event:'mcp_oauth_revoked',client_id:String(req.params.id)});res.json({success:true});}));
 router.get('/api/platforms',handler((req,res)=>{const session=web.session(req),connections=session?store.listConnections(session.actor.tenantId):[];
  res.json({platforms:oauth.publicConfig().map(p=>({...p,connections:connections.filter(c=>c.gateway===p.gateway).map(c=>publicConnection(session!.actor.tenantId,c))})),authenticated:!!session});
 }));
 router.post('/api/auth/:platform/start',express.json({limit:'4kb'}),handler(async(req,res)=>{
  const session=web.requireMutation(req),id=String(req.params.platform),p=platform(id);
  if(!p.authType){res.json(await oauth.start(session,id));return;}
  const result=await oauth.connectService(id),connectionId=randomUUID(),attemptId=randomUUID(),tenant=session.actor.tenantId;
  // Browser sessions may be revoked while the token service is responding.
  web.requireMutation(req);
  const c:Connection={id:connectionId,tenantId:tenant,gateway:p.gateway,accounts:[],label:result.label,enabled:false,scopes:result.scopes,isDefault:!store.listConnections(tenant).some(c=>c.gateway===p.gateway&&c.isDefault)};
  store.putConnection(session.actor,c,result.credentials);store.putDocument(tenant,'website_connection',connectionId,{platform:id,expiresAt:result.credentials.expiresAt??null,createdAt:Date.now()});
  store.appendAudit(tenant,attemptId,{event:'website_api_connected',platform:id,connection_id:connectionId,vendor_writes:0});
  let error:string|null=null;try{error=(await sync(tenant,c)).error;}catch(e){error=e instanceof MirrorError?e.message:'Asset sync could not be completed. Retry from the connection manager.';}
  store.putDocument(tenant,'oauth_progress',attemptId,{platform:id,state:error?'sync_attention':'complete',authorization:true,exchange:true,sync:!error,connectionId,createdAt:Date.now(),message:error??'Connection secured. Choose the assets AMCP can use.'});
  res.json({url:'/oauth/result?attempt='+encodeURIComponent(attemptId),attemptId});
 }));
 const callback=handler(async(req,res)=>{
  const session=web.requireSession(req),id=String(req.params.platform),query:Record<string,string>={};platform(id);
  for(const [k,v]of Object.entries(req.query)){if(typeof v!=='string'||v.length>8192)throw new MirrorError('OAUTH_CALLBACK_INVALID','The provider returned invalid callback parameters.',{},400);query[k]=v;}
  if(!query.state)throw new MirrorError('OAUTH_STATE_INVALID','The callback is missing its security state.',{},400);
  const pending=web.consumeOAuth(session,id,query.state),attemptId=String(pending.attemptId),tenant=session.actor.tenantId,p=platform(id);
  const progress=(data:JsonObject)=>store.putDocument(tenant,'oauth_progress',attemptId,{platform:id,createdAt:Date.now(),...data});
  let securedConnectionId:string|undefined;
  try{
   progress({state:'exchange',authorization:true,exchange:false,sync:false});
   const result=await oauth.exchange(id,pending,query),connectionId=randomUUID();
   // A completed token exchange must not restore access after the initiating session ended.
   web.requireSession(req);
   const c:Connection={id:connectionId,tenantId:tenant,gateway:p.gateway,accounts:[],label:result.label,enabled:false,scopes:result.scopes,isDefault:!store.listConnections(tenant).some(c=>c.gateway===p.gateway&&c.isDefault)};
   store.putConnection(session.actor,c,result.credentials);securedConnectionId=connectionId;store.putDocument(tenant,'website_connection',connectionId,{platform:id,expiresAt:result.credentials.expiresAt??null,providerId:result.providerId??null,createdAt:Date.now()});
   store.appendAudit(tenant,attemptId,{event:'website_oauth_connected',platform:id,connection_id:connectionId});progress({state:'sync',authorization:true,exchange:true,sync:false,connectionId});
   const synced=await sync(tenant,c);progress({state:synced.error?'sync_attention':'complete',authorization:true,exchange:true,sync:!synced.error,connectionId,message:synced.error??'Connection secured. Choose the assets AMCP can use.'});
  }catch(e){progress({state:securedConnectionId?'sync_attention':'failed',authorization:!query.error&&!query.denied,exchange:!!securedConnectionId,sync:false,connectionId:securedConnectionId,message:e instanceof MirrorError?e.message:'The connection could not be completed. Start again from AMCP.'});}
  res.redirect(303,'/oauth/result?attempt='+encodeURIComponent(attemptId));
 });
 router.get('/api/auth/:platform/callback',callback);router.get('/api/:platform/callback',callback);
 router.get('/api/oauth/progress/:id',handler((req,res)=>{const session=web.requireSession(req);res.json(store.document(session.actor.tenantId,'oauth_progress',String(req.params.id)));}));
 router.get('/api/connections/:id',handler((req,res)=>{const s=web.requireSession(req);res.json(publicConnection(s.actor.tenantId,connection(s.actor.tenantId,String(req.params.id))));}));
 router.post('/api/connections/:id/sync',express.json({limit:'8kb'}),handler(async(req,res)=>{
  const s=web.requireMutation(req),c=connection(s.actor.tenantId,String(req.params.id));const kinds=req.body?.kinds;
  if(kinds!==undefined&&(!Array.isArray(kinds)||kinds.length>8||kinds.some((k:unknown)=>typeof k!=='string')))throw new MirrorError('INVALID_ARGUMENT','Select valid asset types.');res.json(await sync(s.actor.tenantId,c,kinds));
 }));
 router.patch('/api/connections/:id/assets',express.json({limit:'256kb'}),handler((req,res)=>{
  const s=web.requireMutation(req),tenant=s.actor.tenantId,c=connection(tenant,String(req.params.id)),assets=savedAssets(tenant,c),selected=req.body?.selected;
  if(!Array.isArray(selected)||selected.length>10000||selected.some(k=>typeof k!=='string')||new Set(selected).size!==selected.length)throw new MirrorError('INVALID_ASSET_SELECTION','Select valid, unique assets.');
  const known=new Set((assets.groups??[]).flatMap((g:AssetGroup)=>g.assets.map(a=>g.kind+':'+a.id)));
  if(selected.some(k=>!known.has(k)))throw new MirrorError('UNKNOWN_ASSET','Sync assets before selecting them.',{},409);
  const prefix=selectionKind(c.gateway)+':';
  if(selected.some(k=>!k.startsWith(prefix)))throw new MirrorError('INVALID_ASSET_SELECTION','Select the platform’s primary accounts, properties or sites for MCP access. Other tabs show related inventory.');
  const accounts=selected.map(k=>k.slice(prefix.length));
  store.transaction(()=>{store.putConnection(s.actor,{...c,accounts,writeAccounts:(c.writeAccounts??[]).filter(id=>accounts.includes(id)),enabled:accounts.length>0},store.credentials(tenant,c.id));store.db.prepare('INSERT INTO documents(tenant_id,kind,id,data) VALUES(?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,revision=documents.revision+1').run(tenant,'website_assets',c.id,JSON.stringify({...assets,selected}));});
  store.appendAudit(tenant,randomUUID(),{event:'website_asset_selection',connection_id:c.id,selected_accounts:accounts,selected_assets:selected.length,vendor_writes:0});res.json(publicConnection(tenant,connection(tenant,c.id)));
 }));
 router.patch('/api/connections/:id/write-access',express.json({limit:'256kb'}),handler((req,res)=>{
  const s=web.requireMutation(req),tenant=s.actor.tenantId,c=connection(tenant,String(req.params.id)),accounts=req.body?.accounts;
  if(s.actor.role!=='admin')throw new MirrorError('FORBIDDEN','Only the workspace administrator can change write access.',{},403);
  if(!Array.isArray(accounts)||accounts.length>10000||accounts.some(id=>typeof id!=='string')||new Set(accounts).size!==accounts.length)throw new MirrorError('INVALID_WRITE_ACCOUNTS','Select valid, unique resources for write access.');
  if(accounts.length&&(!allowWrites||!c.enabled))throw new MirrorError('WRITES_DISABLED','Enable deployment write support and select resources before granting write access.',{},403);
  if(accounts.some(id=>!c.accounts.includes(id)))throw new MirrorError('WRITE_ACCOUNT_NOT_SELECTED','Write access is limited to this login’s selected resources.',{},403);
  if(accounts.length&&req.body?.confirmed!==true)throw new MirrorError('WRITE_ACCESS_CONFIRMATION_REQUIRED','Explicitly confirm that operator connectors may change these resources.',{},400);
  store.putConnection(s.actor,{...c,writeAccounts:accounts},store.credentials(tenant,c.id));
  store.appendAudit(tenant,randomUUID(),{event:'website_write_access_changed',connection_id:c.id,write_accounts:accounts,previous_write_accounts:c.writeAccounts??[],vendor_writes:0});res.json(publicConnection(tenant,connection(tenant,c.id)));
 }));
 router.post('/api/connections/:id/default',handler((req,res)=>{
  const s=web.requireMutation(req),tenant=s.actor.tenantId,c=connection(tenant,String(req.params.id));
  store.transaction(()=>{for(const existing of store.listConnections(tenant).filter(x=>x.gateway===c.gateway))store.db.prepare('UPDATE connections SET data=? WHERE tenant_id=? AND id=?').run(JSON.stringify({...existing,isDefault:existing.id===c.id}),tenant,existing.id);});
  store.appendAudit(tenant,randomUUID(),{event:'website_default_connection',connection_id:c.id});res.json({success:true});
 }));
 router.delete('/api/connections/:id',handler((req,res)=>{
  const s=web.requireMutation(req),tenant=s.actor.tenantId,c=connection(tenant,String(req.params.id));
  store.transaction(()=>{store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(tenant,c.id);store.db.prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?').run(tenant,c.id);store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND id=? AND kind IN ('website_assets','website_connection')").run(tenant,c.id);});
  store.appendAudit(tenant,randomUUID(),{event:'website_local_disconnect',connection_id:c.id,vendor_writes:0});res.json({success:true});
 }));
 router.get('/api/connector-tokens',handler((req,res)=>{const s=web.requireSession(req);res.json({tokens:store.documents(s.actor.tenantId,'website_mcp_token').map(({hash,...v})=>v),url:web.origin+'/mcp'});}));
 router.post('/api/connector-tokens',express.json({limit:'4kb'}),handler((req,res)=>{
  const s=web.requireMutation(req),name=String(req.body?.name??'MCP connector').trim();if(!name||name.length>80)throw new MirrorError('INVALID_ARGUMENT','Use a connector name of 1 to 80 characters.');
  const role=req.body?.role??'reader';if(role!=='reader'&&role!=='operator')throw new MirrorError('INVALID_ROLE','Choose reader or operator access.');
  if(s.actor.role!=='admin')throw new MirrorError('FORBIDDEN','Only the workspace administrator can create connector tokens.',{},403);
  if(role==='operator'&&!allowWrites)throw new MirrorError('WRITES_DISABLED','Advertising writes are disabled in this deployment.',{},403);
  if(role==='operator'&&req.body?.confirmed!==true)throw new MirrorError('WRITE_ACCESS_CONFIRMATION_REQUIRED','Explicitly confirm this connector’s operator access.',{},400);
  const id=randomUUID(),token=store.createKey({...s.actor,userId:'connector/'+id,role},30*86400000),expiresAt=Date.now()+30*86400000;
  store.putDocument(s.actor.tenantId,'website_mcp_token',id,{name,role,hash:sha256(token),createdAt:Date.now(),expiresAt,revoked:false});store.appendAudit(s.actor.tenantId,id,{event:'website_mcp_token_created',name,role});res.json({id,token,role,expiresAt});
 }));
 router.delete('/api/connector-tokens/:id',handler((req,res)=>{
  const s=web.requireMutation(req),record=store.document(s.actor.tenantId,'website_mcp_token',String(req.params.id));
  store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(s.actor.tenantId,record.hash);store.putDocument(s.actor.tenantId,'website_mcp_token',record.id,{...record,revoked:true});store.appendAudit(s.actor.tenantId,randomUUID(),{event:'website_mcp_token_revoked',token_id:record.id});res.json({success:true});
 }));
 router.get('/api/activity',handler((req,res)=>{const s=web.requireSession(req);res.json({events:store.audit(s.actor.tenantId,100).map((r:any)=>({id:r.seq,at:r.created_at,event:redact(JSON.parse(r.event))})).reverse()});}));
 const directory=path.resolve(options.staticDirectory??'web');router.use('/assets',express.static(directory,{dotfiles:'deny',index:false,fallthrough:false,maxAge:0}));
 for(const route of ['/','/connectors','/activity','/settings','/login','/oauth/result','/oauth/consent','/privacy','/terms','/data-deletion'])router.get(route,(_req,res)=>res.sendFile('index.html',{root:directory}));
 return {router,web,oauth,discovery,mcpOAuth};
}
