import {randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
import {WebStore,type WebSession} from './web-store.js';

const opaque=()=>randomBytes(32).toString('base64url');
let passwordWork=0;
async function derive(password:string,salt:string):Promise<Buffer>{
 if(passwordWork>=4)throw new MirrorError('AUTH_BUSY','Sign-in is busy. Please try again shortly.',{},429);
 passwordWork++;try{return await new Promise((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(e,b)=>e?reject(e):resolve(b)));}finally{passwordWork--;}
}
export async function hashUserPassword(password:unknown){
 if(typeof password!=='string'||password.length<12||password.length>128)throw new MirrorError('PASSWORD_LENGTH','Use a password between 12 and 128 characters.');
 const salt=randomBytes(16).toString('hex');return 'scrypt-v2$'+salt+'$'+(await derive(password,salt)).toString('hex');
}
async function verifyPassword(password:unknown,hash?:string|null){
 if(typeof password!=='string'||password.length>128)return false;
 const [,salt,value]=(hash??'scrypt-v2$00000000000000000000000000000000$'+'0'.repeat(64)).split('$');
 if(!/^[a-f0-9]{32}$/.test(salt??'')||!/^[a-f0-9]{64}$/.test(value??''))return false;
 return timingSafeEqual(await derive(password,salt!),Buffer.from(value!,'hex'))&&!!hash;
}
export function accountEmail(value:unknown):string{
 if(typeof value!=='string'||value.length>254||!/^([^\s@<>]+)@([^\s@<>]+\.[^\s@<>]+)$/.test(value.trim()))throw new MirrorError('INVALID_EMAIL','Enter a valid email address.');
 return value.trim().toLowerCase();
}
export function accountName(value:unknown):string{
 if(typeof value!=='string'||value.trim().length<1||value.trim().length>80||/[\x00-\x1f\x7f]/.test(value))throw new MirrorError('INVALID_NAME','Use a name between 1 and 80 characters.');return value.trim();
}
export class UserAccounts {
 readonly env:NodeJS.ProcessEnv;readonly fetcher:typeof fetch;
 constructor(readonly web:WebStore){this.env=web.options.authEnv??process.env;this.fetcher=web.options.fetcher??fetch;}
 get emailConfigured(){return !!(this.env.AMCP_EMAIL_API_KEY&&this.env.AMCP_EMAIL_FROM&&this.web.options.masterKey);}
 get signupEnabled(){return this.env.AMCP_ALLOW_SIGNUP!=='false'&&!!this.web.options.masterKey;}
 limit(req:Request,action:string,identity='',max=8){
  const now=Date.now(),db=this.web.store.db,keys=[sha256('user-auth:'+action+':'+this.web.clientAddress(req))];if(identity)keys.push(sha256('user-auth-identity:'+action+':'+identity));
  this.web.store.transaction(()=>{db.prepare('DELETE FROM amcp_login_limits WHERE until_at<=?').run(now);for(const key of keys){const row=db.prepare('SELECT attempts FROM amcp_login_limits WHERE key=?').get(key) as JsonObject|undefined;if(row&&row.attempts>=max)throw new MirrorError('LOGIN_RATE_LIMIT','Too many attempts. Please try again in 15 minutes.',{},429);}for(const key of keys)db.prepare('INSERT INTO amcp_login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key,now+900000);});
 }
 user(id:string):JsonObject{const user=this.web.store.db.prepare('SELECT * FROM amcp_users WHERE id=? AND disabled=0').get(id) as JsonObject|undefined;if(!user)throw new MirrorError('ACCOUNT_UNAVAILABLE','This account is unavailable.',{},401);return user;}
 profile(session:WebSession){
  if(session.actor.userId==='workspace-admin')return {id:'workspace-admin',name:'Workspace administrator',email:null,hasPassword:true,identities:[],administrator:true,workspaceName:'AMCP workspace'};
  const u=this.user(session.actor.userId),identities=this.web.store.db.prepare('SELECT provider,created_at FROM amcp_identities WHERE user_id=?').all(u.id);
  let workspaceName=u.name+"’s workspace";try{workspaceName=this.web.store.document(u.tenant_id,'account_settings','workspace').name;}catch{}
  return {id:u.id,name:u.name,email:u.email,hasPassword:!!u.password_hash,identities,administrator:false,workspaceName};
 }
 newUser(name:string,email:string|null,passwordHash:string|null):JsonObject{
  const id=randomUUID(),tenant='user-'+randomUUID(),now=Date.now();this.web.store.ensureTenant(tenant);
  this.web.store.db.prepare('INSERT INTO amcp_users(id,email,name,tenant_id,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,email,name,tenant,passwordHash,now);
  this.web.store.putDocument(tenant,'account_settings','workspace',{name:name+"’s workspace"});this.web.store.appendAudit(tenant,randomUUID(),{event:'account_created',user_id:id});return this.user(id);
 }
 session(user:JsonObject){return this.web.createSession({userId:user.id,tenantId:user.tenant_id,role:'admin'});}
 async login(req:Request,input:JsonObject){
  const email=accountEmail(input.email);this.limit(req,'login',email,10);
  const user=this.web.store.db.prepare('SELECT * FROM amcp_users WHERE email=? AND disabled=0').get(email) as JsonObject|undefined;
  if(!await verifyPassword(input.password,user?.password_hash))throw new MirrorError('INVALID_LOGIN','Email or password is incorrect.',{},401);
  // The password may have changed while the asynchronous KDF was running.
  const current=this.user(user!.id);if(current.version!==user!.version)throw new MirrorError('INVALID_LOGIN','Please sign in again.',{},401);
  this.web.store.appendAudit(current.tenant_id,randomUUID(),{event:'account_sign_in',method:'password'});return this.session(current);
 }
 challenge(kind:string,data:JsonObject,ttl=1800000){
  const token=opaque(),hash=sha256(token),db=this.web.store.db;db.prepare('DELETE FROM amcp_account_challenges WHERE expires_at<=?').run(Date.now());
  const total=(db.prepare('SELECT count(*) AS n FROM amcp_account_challenges').get() as JsonObject).n;if(total>=10000)throw new MirrorError('AUTH_BUSY','Please try again later.',{},429);
  db.prepare('INSERT INTO amcp_account_challenges VALUES(?,?,?,?)').run(hash,kind,this.web.sealAccount(hash,data),Date.now()+ttl);return token;
 }
 readChallenge(token:unknown,kind:string,consume=false):JsonObject{
  if(typeof token!=='string'||!/^[\w-]{43}$/.test(token))throw new MirrorError('LINK_EXPIRED','This link expired or was already used. Request a new one.');
  const hash=sha256(token),row=this.web.store.db.prepare('SELECT secret FROM amcp_account_challenges WHERE hash=? AND kind=? AND expires_at>?').get(hash,kind,Date.now()) as JsonObject|undefined;
  if(!row)throw new MirrorError('LINK_EXPIRED','This link expired or was already used. Request a new one.');
  if(consume)this.web.store.db.prepare('DELETE FROM amcp_account_challenges WHERE hash=?').run(hash);return this.web.openAccount(hash,row.secret);
 }
 async sendEmail(email:string,kind:string,token:string){
  if(!this.emailConfigured)throw new MirrorError('EMAIL_SETUP_REQUIRED','Email sign-in is not available yet. Use a configured social account or contact the administrator.',{},503);
  const route=kind==='register'?'verify-email':kind==='reset'?'reset-password':'verify-email',link=this.web.origin+'/'+route+'#token='+encodeURIComponent(token)+'&kind='+kind;
  const title=kind==='register'?'Create your AMCP account':kind==='reset'?'Reset your AMCP password':'Verify your AMCP email';
  try{const r=await this.fetcher('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+this.env.AMCP_EMAIL_API_KEY,'Content-Type':'application/json','Idempotency-Key':'amcp-'+sha256(token)},body:JSON.stringify({from:this.env.AMCP_EMAIL_FROM,to:[email],subject:title,text:title+'\n\n'+link+'\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.'})});if(!r.ok)throw Error('delivery');await r.body?.cancel();}catch{this.web.store.db.prepare('DELETE FROM amcp_account_challenges WHERE hash=?').run(sha256(token));throw new MirrorError('EMAIL_DELIVERY_FAILED','We could not send the email. Please try again later.',{},503);}
 }
 async register(req:Request,input:JsonObject){
  if(!this.signupEnabled)throw new MirrorError('SIGNUP_DISABLED','New account registration is currently closed.',{},403);
  if(!this.emailConfigured)throw new MirrorError('EMAIL_SETUP_REQUIRED','Email registration is not available yet. Choose an available social sign-in.',{},503);
  const email=accountEmail(input.email),name=accountName(input.name);this.limit(req,'email',email,5);
  if(!this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(email))await this.sendEmail(email,'register',this.challenge('register',{email,name}));
  return {message:'If this email can be registered, an account setup link is on its way. Already a member? Sign in instead.'};
 }
 async requestReset(req:Request,input:JsonObject){
  if(!this.emailConfigured)throw new MirrorError('EMAIL_SETUP_REQUIRED','Email recovery is not configured. Use your linked social account.',{},503);
  const email=accountEmail(input.email);this.limit(req,'email',email,5);const user=this.web.store.db.prepare('SELECT * FROM amcp_users WHERE email=? AND disabled=0').get(email) as JsonObject|undefined;
  if(user)await this.sendEmail(email,'reset',this.challenge('reset',{userId:user.id,version:user.version}));return {message:'If an account uses this email, a password reset link is on its way.'};
 }
 revokeAccess(user:JsonObject){
  const db=this.web.store.db;db.prepare("DELETE FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=?").run(user.id);
  db.prepare('UPDATE api_keys SET revoked=1 WHERE tenant_id=?').run(user.tenant_id);db.prepare('UPDATE amcp_mcp_grants SET used=1 WHERE tenant_id=?').run(user.tenant_id);
 }
 async finishEmail(req:Request,input:JsonObject){
  this.limit(req,'verify','',15);const kind=input.kind;if(!['register','reset','email'].includes(kind))throw new MirrorError('LINK_EXPIRED','Use the complete link from your email.');
  if(kind==='register'&&!this.signupEnabled)throw new MirrorError('SIGNUP_DISABLED','New account registration is currently closed.',{},403);
  const data=this.readChallenge(input.token,kind);const hash=kind==='email'?null:await hashUserPassword(input.password);
  this.web.store.transaction(()=>{
   this.readChallenge(input.token,kind,true);
   if(kind==='register'){
    if(this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(data.email))throw new MirrorError('ACCOUNT_EXISTS','An account already uses this email. Sign in or reset your password.');
    this.newUser(data.name,data.email,hash);
   }else{
    const user=this.user(data.userId);if(user.version!==data.version)throw new MirrorError('LINK_EXPIRED','Your account changed. Request a fresh link.');
    if(kind==='email'){
     if(this.web.store.db.prepare('SELECT id FROM amcp_users WHERE email=? AND id<>?').get(data.email,user.id))throw new MirrorError('ACCOUNT_EXISTS','This email is already used by another account.');
     this.web.store.db.prepare('UPDATE amcp_users SET email=?,version=version+1 WHERE id=?').run(data.email,user.id);
    }else this.web.store.db.prepare('UPDATE amcp_users SET password_hash=?,version=version+1 WHERE id=?').run(hash,user.id);
    this.revokeAccess(user);this.web.store.appendAudit(user.tenant_id,randomUUID(),{event:kind==='email'?'account_email_verified':'account_password_reset'});
   }
  });return {message:kind==='register'?'Your account is ready. Sign in to open your workspace.':'Account updated. Sign in again; previous sessions and MCP access have been revoked.'};
 }
 async requestEmail(req:Request,input:JsonObject){
  const s=this.web.requireMutation(req),u=this.user(s.actor.userId),email=accountEmail(input.email);this.limit(req,'email',email,5);this.fresh(s);
  await this.sendEmail(email,'email',this.challenge('email',{email,userId:u.id,version:u.version}));return {message:'Check your inbox to verify this email. Confirmation signs out existing sessions and revokes old MCP access.'};
 }
 fresh(s:WebSession){const data=this.web.store.db.prepare('SELECT actor FROM amcp_web_sessions WHERE hash=?').get(sha256(s.id)) as JsonObject|undefined;if(!data||Number(JSON.parse(data.actor).signedInAt??s.expiresAt-8*3600000)<Date.now()-900000)throw new MirrorError('REAUTH_REQUIRED','Sign out and sign in again before changing account security.',{},403);}
 update(req:Request,input:JsonObject){const s=this.web.requireMutation(req),u=this.user(s.actor.userId),name=accountName(input.name),workspace=accountName(input.workspaceName);this.web.store.transaction(()=>{this.web.store.db.prepare('UPDATE amcp_users SET name=? WHERE id=?').run(name,u.id);this.web.store.putDocument(u.tenant_id,'account_settings','workspace',{name:workspace});});return this.profile(s);}
 async changePassword(req:Request,input:JsonObject){
  const s=this.web.requireMutation(req),u=this.user(s.actor.userId);this.limit(req,'password',u.id,8);this.fresh(s);
  if(u.password_hash&&!await verifyPassword(input.currentPassword,u.password_hash))throw new MirrorError('INVALID_LOGIN','Your current password is incorrect.',{},401);
  if(!u.email)throw new MirrorError('EMAIL_REQUIRED','Verify an email address before adding a password.');
  const hash=await hashUserPassword(input.password);this.web.requireMutation(req);
  return this.web.store.transaction(()=>{if(this.user(u.id).version!==u.version)throw new MirrorError('ACCOUNT_CHANGED','Sign in again before retrying.');this.web.store.db.prepare('UPDATE amcp_users SET password_hash=?,version=version+1 WHERE id=?').run(hash,u.id);this.revokeAccess(u);return this.session(this.user(u.id));});
 }
 unlink(req:Request,provider:string){const s=this.web.requireMutation(req),u=this.user(s.actor.userId);this.fresh(s);this.web.store.transaction(()=>{const count=(this.web.store.db.prepare('SELECT count(*) AS n FROM amcp_identities WHERE user_id=?').get(u.id) as JsonObject).n;if(!u.password_hash&&count<=1)throw new MirrorError('LAST_SIGN_IN_METHOD','Add another sign-in method before removing this one.');this.web.store.db.prepare('DELETE FROM amcp_identities WHERE user_id=? AND provider=?').run(u.id,provider);this.web.store.appendAudit(u.tenant_id,randomUUID(),{event:'account_identity_removed',provider});});}
}
