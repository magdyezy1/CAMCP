import {randomBytes,randomUUID,createHash} from 'node:crypto';
import type {Response} from 'express';
import type {OAuthServerProvider,AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {OAuthClientInformationFull,OAuthTokens,OAuthTokenRevocationRequest} from '@modelcontextprotocol/sdk/shared/auth.js';
import {InvalidClientMetadataError,InvalidGrantError,InvalidScopeError,InvalidTargetError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {WebStore,type WebSession} from './web-store.js';
import {sha256,safeEqual} from '../src/security.js';
import type {JsonObject} from '../src/types.js';

const opaque=()=>randomBytes(32).toString('base64url');
const scope='mcp:read';
/** AMCP issues its own reader credentials. Platform tokens never leave the server. */
export class McpOAuth implements OAuthServerProvider {
 readonly resource:URL;
 constructor(readonly web:WebStore){this.resource=new URL(web.origin+'/mcp');}
 get clientsStore(){return {
  getClient:async(id:string)=>{const row=this.web.store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(id) as {data:string}|undefined;return row?JSON.parse(row.data) as OAuthClientInformationFull:undefined;},
  registerClient:async(input:Omit<OAuthClientInformationFull,'client_id'|'client_id_issued_at'>)=>{
   if(input.token_endpoint_auth_method!=='none')throw new InvalidClientMetadataError('Use a public client with PKCE and token_endpoint_auth_method none.');
   if(!input.redirect_uris.length||input.redirect_uris.length>10||input.redirect_uris.some(uri=>{try{const u=new URL(uri);return !!(u.username||u.password||u.hash)||u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));}catch{return true;}}))throw new InvalidClientMetadataError('Register exact HTTPS or loopback HTTP redirect URIs.');
   this.validateScopes(input.scope?.split(' '));
   const count=this.web.store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get() as {n:number};if(count.n>=1000)throw new InvalidClientMetadataError('Client registration limit reached. Contact the workspace administrator.');
   const client:OAuthClientInformationFull={client_id:randomUUID(),client_id_issued_at:Math.floor(Date.now()/1000),client_name:String(input.client_name??'MCP client').slice(0,120),redirect_uris:input.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope};
   this.web.store.db.prepare('INSERT INTO amcp_mcp_clients VALUES(?,?)').run(client.client_id,JSON.stringify(client));return client;
  }
 };}
 private validateScopes(scopes?:string[]){if(scopes?.some(s=>s!==scope))throw new InvalidScopeError('AMCP supports mcp:read only.');}
 private validateResource(resource?:URL){if(resource&&resource.href!==this.resource.href)throw new InvalidTargetError('The resource must be the AMCP MCP endpoint.');}
 private put(token:string,kind:string,client:string,data:JsonObject,ttl:number){this.web.store.db.prepare('INSERT INTO amcp_mcp_grants VALUES(?,?,?,?,?,?,0)').run(sha256(token),kind,client,this.web.tenantId,JSON.stringify(data),Date.now()+ttl);}
 private get(token:string,kind:string,client?:string,allowUsed=false):JsonObject{
  const row=this.web.store.db.prepare('SELECT * FROM amcp_mcp_grants WHERE hash=? AND kind=? AND tenant_id=?').get(sha256(token),kind,this.web.tenantId) as JsonObject|undefined;
  if(!row||client&&row.client_id!==client||row.expires_at<=Date.now()||row.used&&!allowUsed)throw new InvalidGrantError('This authorization has expired or was already used.');
  return {...row,data:JSON.parse(row.data)};
 }
 async authorize(client:OAuthClientInformationFull,params:AuthorizationParams,res:Response){
  this.validateScopes(params.scopes);this.validateResource(params.resource);
  if(!client.redirect_uris.includes(params.redirectUri)||!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))throw new InvalidGrantError('An exact redirect URI and S256 PKCE challenge are required.');
  this.web.store.db.prepare("DELETE FROM amcp_mcp_grants WHERE kind IN ('request','code') AND expires_at<?").run(Date.now());
  const request=opaque();this.put(request,'request',client.client_id,{redirectUri:params.redirectUri,challenge:params.codeChallenge,state:params.state,resource:this.resource.href,clientName:client.client_name??'MCP client'},600000);
  res.redirect(303,this.web.origin+'/oauth/consent?request='+encodeURIComponent(request));
 }
 consent(request:string,session:WebSession){if(session.actor.tenantId!==this.web.tenantId)throw new InvalidGrantError('Workspace mismatch.');const row=this.get(request,'request');return {name:row.data.clientName,redirectUri:row.data.redirectUri,scope};}
 decide(request:string,session:WebSession,approved:boolean){
  this.consent(request,session);
  return this.web.store.transaction(()=>{const row=this.get(request,'request');this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);
   const url=new URL(row.data.redirectUri);if(row.data.state!==undefined)url.searchParams.set('state',row.data.state);
   if(approved){const code=opaque();this.put(code,'code',row.client_id,row.data,300000);url.searchParams.set('code',code);}else url.searchParams.set('error','access_denied');return url.href;
  });
 }
 async challengeForAuthorizationCode(client:OAuthClientInformationFull,code:string){return this.get(code,'code',client.client_id).data.challenge as string;}
 private issue(client:string,data:JsonObject):OAuthTokens{
  const family=data.family??randomUUID(),access=this.web.store.createKey({tenantId:this.web.tenantId,userId:'oauth/'+client,role:'reader'},3600000),refresh=opaque();
  this.put(access,'access',client,{family,scope},3600000);this.put(refresh,'refresh',client,{family,scope},30*86400000);
  return {access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope};
 }
 async exchangeAuthorizationCode(client:OAuthClientInformationFull,code:string,verifier?:string,redirectUri?:string,resource?:URL){
  this.validateResource(resource);
  return this.web.store.transaction(()=>{const row=this.get(code,'code',client.client_id);
   // The SDK validates PKCE before this method and omits verifier afterwards.
   if(redirectUri!==row.data.redirectUri||verifier!==undefined&&(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)||!safeEqual(createHash('sha256').update(verifier).digest('base64url'),row.data.challenge)))throw new InvalidGrantError('The redirect URI or PKCE verifier does not match.');
   this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);return this.issue(client.client_id,row.data);
  });
 }
 private revokeFamily(family:string){
  const rows=this.web.store.db.prepare("SELECT hash,kind,data FROM amcp_mcp_grants WHERE tenant_id=? AND kind IN ('access','refresh')").all(this.web.tenantId) as JsonObject[];
  for(const row of rows)if(JSON.parse(row.data).family===family){this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);if(row.kind==='access')this.web.store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(this.web.tenantId,row.hash);}
 }
 async exchangeRefreshToken(client:OAuthClientInformationFull,token:string,scopes?:string[],resource?:URL){
  this.validateScopes(scopes);this.validateResource(resource);
  const result=this.web.store.transaction(()=>{const row=this.get(token,'refresh',client.client_id,true);if(row.used){this.revokeFamily(row.data.family);return undefined;}this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);return this.issue(client.client_id,row.data);});
  if(!result)throw new InvalidGrantError('Refresh token replay detected. Authorize the client again.');return result;
 }
 async verifyAccessToken(token:string){this.web.store.authenticate(token);const row=this.get(token,'access');return {token,clientId:row.client_id,scopes:[scope],expiresAt:Math.floor(row.expires_at/1000),resource:this.resource};}
 async revokeToken(client:OAuthClientInformationFull,request:OAuthTokenRevocationRequest){
  const row=this.web.store.db.prepare('SELECT data FROM amcp_mcp_grants WHERE hash=? AND client_id=? AND tenant_id=?').get(sha256(request.token),client.client_id,this.web.tenantId) as {data:string}|undefined;
  if(row){const data=JSON.parse(row.data);if(data.family)this.web.store.transaction(()=>this.revokeFamily(data.family));}
 }
 authorizations(){
  const rows=this.web.store.db.prepare("SELECT g.client_id,MAX(g.expires_at) AS expires_at,c.data FROM amcp_mcp_grants g JOIN amcp_mcp_clients c ON c.id=g.client_id WHERE g.tenant_id=? AND g.kind='refresh' AND g.used=0 AND g.expires_at>? GROUP BY g.client_id").all(this.web.tenantId,Date.now()) as JsonObject[];
  return rows.map(row=>({id:row.client_id,name:JSON.parse(row.data).client_name,expiresAt:row.expires_at}));
 }
 revokeClient(id:string){this.web.store.transaction(()=>{
  const rows=this.web.store.db.prepare('SELECT hash,kind FROM amcp_mcp_grants WHERE client_id=? AND tenant_id=?').all(id,this.web.tenantId) as JsonObject[];
  for(const row of rows){this.web.store.db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE hash=?').run(row.hash);if(row.kind==='access')this.web.store.db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=? AND hash=?').run(this.web.tenantId,row.hash);}
 });}
}
