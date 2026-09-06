import {randomBytes,scryptSync,timingSafeEqual,randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {SecretBox,sha256,scopeKey} from '../src/security.js';
import {MirrorError} from '../src/errors.js';
import type {Actor,JsonObject} from '../src/types.js';

export interface WebSession {id:string;actor:Actor;csrf:string;expiresAt:number}
export interface WebsiteOptions {origin:string;masterKey?:string;adminPassword?:string;adminPasswordHash?:string;tenantId?:string;fetcher?:typeof fetch;staticDirectory?:string}
export function passwordHash(password:string,salt=randomBytes(16).toString('hex')):string{return 'scrypt$'+salt+'$'+scryptSync(password,salt,32).toString('hex');}
export function checkPassword(password:string,hash:string):boolean{
 const [algorithm,salt,value]=hash.split('$');if(algorithm!=='scrypt'||!salt||!/^[a-f0-9]{64}$/.test(value??'')||password.length>1024)return false;
 return timingSafeEqual(scryptSync(password,salt,32),Buffer.from(value!,'hex'));
}
export function cookieValue(req:Request,name:string):string|undefined{
 const entries=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 return entries.length===1?entries[0]!.slice(name.length+1):undefined;
}
export class WebStore {
 readonly tenantId:string;readonly origin:string;readonly secure:boolean;readonly cookieName:string;readonly administratorHash?:string;private box?:SecretBox;
 constructor(readonly store:Store,readonly options:WebsiteOptions){
  const origin=new URL(options.origin);if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw Error('AMCP origin must be HTTPS, except for loopback development.');
  this.origin=origin.origin;this.secure=origin.protocol==='https:';this.cookieName=this.secure?'__Host-amcp_session':'amcp_local_session';this.tenantId=options.tenantId??'local';
  if(options.masterKey)this.box=new SecretBox(options.masterKey);
  if(options.adminPasswordHash){if(!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(options.adminPasswordHash))throw Error('Invalid AMCP administrator password hash.');this.administratorHash=options.adminPasswordHash;}
  else if(options.adminPassword){if(options.adminPassword.length<16)throw Error('AMCP administrator password must contain at least 16 characters.');this.administratorHash=passwordHash(options.adminPassword);}
  store.transaction(()=>store.db.exec(`
   CREATE TABLE IF NOT EXISTS amcp_web_sessions(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_login_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,until_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_oauth_states(hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,platform TEXT NOT NULL,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_mcp_clients(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS amcp_mcp_grants(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,client_id TEXT NOT NULL,tenant_id TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
  `));
 }
 get configured(){return !!this.administratorHash;}
 signIn(password:string,address:string):WebSession{
  if(!this.administratorHash)throw new MirrorError('SETUP_REQUIRED','Configure the AMCP administrator password on the server before signing in.',{},503);
  const key=sha256(address),now=Date.now();this.store.db.prepare('DELETE FROM amcp_login_limits WHERE until_at<?').run(now);
  const row=this.store.db.prepare('SELECT attempts FROM amcp_login_limits WHERE key=?').get(key) as JsonObject|undefined;
  if(row&&row.attempts>=8)throw new MirrorError('LOGIN_RATE_LIMIT','Too many sign-in attempts. Try again in 15 minutes.',{},429);
  if(!checkPassword(password,this.administratorHash)){
   this.store.db.prepare('INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key,now+900000);
   throw new MirrorError('INVALID_LOGIN','The password is incorrect.',{},401);
  }
  this.store.db.prepare('DELETE FROM amcp_login_limits WHERE key=?').run(key);
  this.store.db.prepare('DELETE FROM amcp_web_sessions WHERE expires_at<?').run(now);
  const session:WebSession={id:randomBytes(32).toString('base64url'),csrf:randomBytes(32).toString('base64url'),actor:{tenantId:this.tenantId,userId:'workspace-admin',role:'admin'},expiresAt:now+8*3600000};
  this.store.ensureTenant(this.tenantId);this.store.db.prepare('INSERT INTO amcp_web_sessions VALUES(?,?,?,?)').run(sha256(session.id),JSON.stringify(session.actor),session.csrf,session.expiresAt);
  this.store.appendAudit(this.tenantId,randomUUID(),{event:'website_sign_in'});return session;
 }
 session(req:Request):WebSession|undefined{
  const id=cookieValue(req,this.cookieName);if(!id||!/^[\w-]{43}$/.test(id))return;
  const row=this.store.db.prepare('SELECT * FROM amcp_web_sessions WHERE hash=? AND expires_at>?').get(sha256(id),Date.now()) as JsonObject|undefined;
  return row?{id,actor:JSON.parse(row.actor),csrf:row.csrf,expiresAt:row.expires_at}:undefined;
 }
 requireSession(req:Request):WebSession{const session=this.session(req);if(!session)throw new MirrorError('SIGN_IN_REQUIRED','Sign in to your AMCP workspace.',{},401);return session;}
 requireOrigin(req:Request){if(req.headers.origin!==this.origin||req.headers['sec-fetch-site']==='cross-site')throw new MirrorError('FORBIDDEN_ORIGIN','This request must come from your AMCP website.',{},403);}
 requireMutation(req:Request):WebSession{this.requireOrigin(req);const session=this.requireSession(req),csrf=req.headers['x-amcp-csrf'];if(typeof csrf!=='string'||csrf!==session.csrf)throw new MirrorError('CSRF_INVALID','Refresh the page and try again.',{},403);return session;}
 signOut(id:string){this.store.db.prepare('DELETE FROM amcp_web_sessions WHERE hash=?').run(sha256(id));this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE session_hash=?').run(sha256(id));}
 cookie(id:string,maxAge=28800){return `${this.cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure?'; Secure':''}`;}
 beginOAuth(session:WebSession,platform:string,data:JsonObject,state=randomBytes(32).toString('base64url')):string{
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Configure credential encryption before connecting a platform.',{},503);
  const hash=sha256(state);this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE expires_at<?').run(Date.now());
  this.store.db.prepare('INSERT INTO amcp_oauth_states VALUES(?,?,?,?,?)').run(hash,sha256(session.id),platform,this.box.seal(data,scopeKey('website-oauth',hash)),Date.now()+600000);return state;
 }
 consumeOAuth(session:WebSession,platform:string,state:string):JsonObject{
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Credential encryption is unavailable.',{},503);
  return this.store.transaction(()=>{
   const hash=sha256(state),row=this.store.db.prepare('SELECT * FROM amcp_oauth_states WHERE hash=? AND session_hash=? AND platform=? AND expires_at>?').get(hash,sha256(session.id),platform,Date.now()) as JsonObject|undefined;
   if(!row)throw new MirrorError('OAUTH_STATE_INVALID','This connection link expired or was already used. Start again from AMCP.',{},400);
   this.store.db.prepare('DELETE FROM amcp_oauth_states WHERE hash=?').run(hash);return this.box!.open<JsonObject>(row.secret,scopeKey('website-oauth',hash));
  });
 }
}
