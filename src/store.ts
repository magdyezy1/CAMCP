import {MAX_MEDIA_BYTES} from './drive-media.js';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {SecretBox,sha256,stable,redact,scopeKey} from './security.js';
import type {Actor,Connection,Credentials,JsonObject} from './types.js';
export class Store {
 readonly db:DatabaseSync;private box?:SecretBox;
 private actorChecks=new WeakMap<Actor,()=>void>();
 private authenticatedActors=new WeakMap<Actor,string>();
 private transactionDepth=0;
 constructor(filename:string,masterKey?:string){
  if(masterKey)this.box=new SecretBox(masterKey);
  if(filename!==':memory:')fs.mkdirSync(path.dirname(filename),{recursive:true});
  this.db=new DatabaseSync(filename);
  try{
  this.db.exec('PRAGMA busy_timeout=5000;');
  // SQLite may skip its busy handler when concurrent journal-mode changes would
  // deadlock. Retry only this idempotent bootstrap step, before any application work.
  const journalDeadline=Date.now()+5000,pause=new Int32Array(new SharedArrayBuffer(4));
  for(;;){try{this.db.exec('PRAGMA journal_mode=WAL;');break;}catch(e){
   const code=(e as {errcode?:number}).errcode;
   if(code===undefined||![5,6].includes(code&255)||Date.now()>=journalDeadline)throw e;
   Atomics.wait(pause,0,0,Math.min(25,journalDeadline-Date.now()));
  }}
  this.db.exec('PRAGMA foreign_keys=ON;');
  // Serialize bootstrap and migration together so two starting processes cannot
  // both observe an old schema and attempt the same ALTER TABLE.
  this.transaction(()=>{this.db.exec(`
   CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
   CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS workspace_memberships(tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','viewer')),active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,user_id));
   CREATE TABLE IF NOT EXISTS credential_owners(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS service_locks(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS provider_cooldowns(key TEXT PRIMARY KEY,until_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS api_keys(hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL,role TEXT NOT NULL,expires_at INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS connections(id TEXT NOT NULL,tenant_id TEXT NOT NULL REFERENCES tenants(id),data TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
   CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,request_id TEXT NOT NULL,event TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
   CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append only'); END;
   CREATE TABLE IF NOT EXISTS idempotency(tenant_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,key));
   CREATE TABLE IF NOT EXISTS documents(tenant_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant_id,kind,id));
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,available_at);
   CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant_id,seq);
   CREATE TABLE IF NOT EXISTS resource_ownership(tenant_id TEXT NOT NULL,connection_id TEXT NOT NULL,account_id TEXT NOT NULL,resource TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,connection_id,account_id,resource));
   CREATE TABLE IF NOT EXISTS media_chunks(tenant_id TEXT NOT NULL,id TEXT NOT NULL,chunk_index INTEGER NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(tenant_id,id,chunk_index));
   CREATE TABLE IF NOT EXISTS media_staging(tenant_id TEXT NOT NULL,id TEXT NOT NULL,secret TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,id));
  `);
  const version=this.db.prepare('SELECT version FROM schema_version').get() as {version:number};
  if(version.version===1)this.db.exec('ALTER TABLE jobs ADD COLUMN lease_token TEXT; UPDATE schema_version SET version=2;');
  else if(version.version!==2)throw new MirrorError('SCHEMA_VERSION_MISMATCH','Database migration required.',{},500);
  });
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
 reserveMedia(tenant:string,id:string,expiresAt:number){
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Media staging requires the configured master key.');
  this.transaction(()=>{
   this.db.prepare('DELETE FROM media_chunks WHERE EXISTS(SELECT 1 FROM media_staging s WHERE s.tenant_id=media_chunks.tenant_id AND s.id=media_chunks.id AND s.expires_at<=?)').run(Date.now());
   this.db.prepare('DELETE FROM media_staging WHERE expires_at<=?').run(Date.now());
   const local=this.db.prepare('SELECT count(*) AS n FROM media_staging WHERE tenant_id=?').get(tenant) as {n:number};
   const total=this.db.prepare('SELECT count(*) AS n FROM media_staging').get() as {n:number};
   if(local.n>=2||total.n>=8)throw new MirrorError('MEDIA_STAGING_FULL','Finish or cancel existing media reviews, or wait five minutes for them to expire.',{},429);
   this.db.prepare('INSERT INTO media_staging VALUES(?,?,NULL,?)').run(tenant,id,expiresAt);
  });
 }
 stageMedia(tenant:string,id:string,bytes:Buffer){
  if(!this.box||bytes.length>MAX_MEDIA_BYTES)throw new MirrorError('MEDIA_STAGING_INVALID','Media exceeds the configured encrypted staging limit.');
  this.transaction(()=>{const row=this.db.prepare('SELECT expires_at FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?').get(tenant,id,Date.now());if(!row)throw new MirrorError('REVIEW_EXPIRED','Media preparation expired.');this.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=?').run(tenant,id);const size=4*1024*1024;let chunks=0;for(let offset=0;offset<bytes.length;offset+=size){const secret=this.box!.seal({bytes:bytes.subarray(offset,offset+size).toString('base64')},scopeKey(tenant,'media-chunk',id,String(chunks)));this.db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)').run(tenant,id,chunks++,secret);}this.db.prepare('UPDATE media_staging SET secret=? WHERE tenant_id=? AND id=?').run(this.box!.seal({chunks,size:bytes.length,sha256:sha256(bytes)},scopeKey(tenant,'media',id)),tenant,id);});
 }
 stagedMedia(tenant:string,id:string):Buffer{
  const row=this.db.prepare('SELECT secret FROM media_staging WHERE tenant_id=? AND id=? AND expires_at>?').get(tenant,id,Date.now()) as {secret:string}|undefined;
  if(!this.box||!row?.secret)throw new MirrorError('REVIEW_EXPIRED','The staged media expired or was removed.');const manifest=this.box.open<JsonObject>(row.secret,scopeKey(tenant,'media',id));if(manifest.bytes)return Buffer.from(manifest.bytes,'base64');const chunks=this.db.prepare('SELECT chunk_index,secret FROM media_chunks WHERE tenant_id=? AND id=? ORDER BY chunk_index').all(tenant,id) as JsonObject[];if(chunks.length!==manifest.chunks||manifest.size>MAX_MEDIA_BYTES)throw new MirrorError('MEDIA_STAGING_INVALID','Encrypted media chunks are incomplete.');const bytes=Buffer.concat(chunks.map((c,i)=>{if(c.chunk_index!==i)throw new MirrorError('MEDIA_STAGING_INVALID','Encrypted media chunk order is invalid.');return Buffer.from(this.box!.open<{bytes:string}>(c.secret,scopeKey(tenant,'media-chunk',id,String(i))).bytes,'base64');}));if(bytes.length!==manifest.size||sha256(bytes)!==manifest.sha256)throw new MirrorError('MEDIA_STAGING_INVALID','Staged media integrity check failed.');return bytes;
 }
 removeStagedMedia(tenant:string,id:string){this.transaction(()=>{this.db.prepare('DELETE FROM media_chunks WHERE tenant_id=? AND id=?').run(tenant,id);this.db.prepare('DELETE FROM media_staging WHERE tenant_id=? AND id=?').run(tenant,id);});}
 transaction<T>(fn:()=>T):T{
  if(fn.constructor.name==='AsyncFunction')throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED','SQLite transactions require synchronous callbacks.');
  const depth=this.transactionDepth,name='amcp_sp_'+depth;
  this.db.exec(depth===0?'BEGIN IMMEDIATE':'SAVEPOINT '+name);this.transactionDepth++;
  try{
   const result=fn();
   if(result&&typeof (result as {then?:unknown}).then==='function')throw new MirrorError('ASYNC_TRANSACTION_UNSUPPORTED','SQLite transactions require synchronous callbacks.');
   this.db.exec(depth===0?'COMMIT':'RELEASE SAVEPOINT '+name);return result;
  }catch(e){
   // ROLLBACK TO preserves the savepoint; release it after undoing the inner work.
   if(this.db.isTransaction)this.db.exec(depth===0?'ROLLBACK':'ROLLBACK TO SAVEPOINT '+name+'; RELEASE SAVEPOINT '+name);
   throw e;
  }finally{this.transactionDepth=depth;}
 }
 ensureTenant(id:string,name=id){if(!id)throw new MirrorError('INVALID_TENANT','Tenant ID is required.');this.db.prepare('INSERT INTO tenants(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id,name);}
 createKey(actor:Actor,ttlMs:number=86400000*30):string{this.assertActorActive(actor);this.ensureTenant(actor.tenantId);const token='whm_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');this.transaction(()=>{this.db.prepare('INSERT INTO api_keys(hash,tenant_id,user_id,role,expires_at) VALUES(?,?,?,?,?)').run(sha256(token),actor.tenantId,actor.userId,actor.role,Date.now()+ttlMs);if(actor.ownerUserId)this.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha256(token),actor.ownerUserId);});return token;}
 authenticate(token:string):Actor{
  const row=this.db.prepare('SELECT * FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)').get(sha256(token),Date.now()) as JsonObject|undefined;
  if(!row)throw new MirrorError('UNAUTHORIZED','A valid, unexpired API key is required.',{},401);
  const owner=this.db.prepare('SELECT user_id FROM credential_owners WHERE hash=?').get(sha256(token)) as JsonObject|undefined;
  const actor:Actor={tenantId:row.tenant_id,userId:row.user_id,role:row.role,...(owner?{ownerUserId:owner.user_id}:{})};this.authenticatedActors.set(actor,sha256(token));this.assertActorActive(actor);return actor;
 }
 /** HTTP actors retain a process-local credential identity without exposing the token or hash. */
 bindActorCheck(actor:Actor,check:()=>void){this.actorChecks.set(actor,check);}
 assertActorActive(actor:Actor):void{
  this.actorChecks.get(actor)?.();
  if(actor.userId==='workspace-admin'&&this.db.prepare("SELECT 1 FROM documents WHERE tenant_id=? AND kind='account_settings' AND id='owner_migration'").get(actor.tenantId))throw new MirrorError('OWNER_LOGIN_REQUIRED','The administrator workspace was migrated. Sign in with the owner account and explicitly resume pending work.',{},401);
   const version=(actor as JsonObject).accountVersion;if(actor.ownerUserId&&typeof version==='number'){const user=this.db.prepare('SELECT version FROM amcp_users WHERE id=?').get(actor.ownerUserId) as JsonObject|undefined;if(!user||user.version!==version)throw new MirrorError('ACCOUNT_ACCESS_REVOKED','Account security changed. Sign in again and explicitly resume this job or schedule.',{},401);}
  if(actor.ownerUserId){const membership=this.db.prepare('SELECT role FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND active=1').get(actor.tenantId,actor.ownerUserId) as JsonObject|undefined;const rank:Record<string,number>={viewer:0,reader:0,operator:1,admin:2,owner:2};if(!membership||rank[membership.role]!<rank[actor.role]!)throw new MirrorError('MEMBERSHIP_REVOKED','Workspace access was removed or reduced. Sign in or authorize the connector again.',{},403);}
  const hash=this.authenticatedActors.get(actor);if(!hash)return; // Trusted local/stdio actors have no bearer credential.
  const row=this.db.prepare('SELECT tenant_id,user_id,role FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)').get(hash,Date.now()) as JsonObject|undefined;
  if(!row||row.tenant_id!==actor.tenantId||row.user_id!==actor.userId||row.role!==actor.role)throw new MirrorError('UNAUTHORIZED','Connector access expired, changed or was revoked during this request.',{},401);
 }
 revokeKey(token:string){this.db.prepare('UPDATE api_keys SET revoked=1 WHERE hash=?').run(sha256(token));}
 bindJobActor(actor:Actor,id:string):string{
  this.assertActorActive(actor);if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Background verification requires encryption.');
  return this.box.seal({actor,credential_hash:this.authenticatedActors.get(actor)??null},scopeKey(actor.tenantId,'job-actor',id));
 }
 acquireLock(key:string,owner:string,ttl=45000):boolean{return this.transaction(()=>{const now=Date.now();this.db.prepare('DELETE FROM service_locks WHERE key=? AND expires_at<=?').run(key,now);return this.db.prepare('INSERT OR IGNORE INTO service_locks(key,owner,expires_at) VALUES(?,?,?)').run(key,owner,now+ttl).changes===1;});}
 releaseLock(key:string,owner:string){this.db.prepare('DELETE FROM service_locks WHERE key=? AND owner=?').run(key,owner);}
 providerPermit(key:string){return this.transaction(()=>{const now=Date.now(),cooldown=this.db.prepare('SELECT until_at FROM provider_cooldowns WHERE key=?').get(key) as JsonObject|undefined;if(cooldown?.until_at>now)throw new MirrorError('PLATFORM_RATE_LIMIT','The shared provider cooldown is active.',{retry_after_ms:cooldown!.until_at-now},429,true);const record=this.db.prepare("SELECT data FROM documents WHERE tenant_id='__service_limits__' AND kind='provider_budget' AND id=?").get(sha256(key)) as JsonObject|undefined,old=record?JSON.parse(record.data):{tokens:30,at:now},tokens=Math.min(30,old.tokens+(now-old.at)/200);if(tokens<1)throw new MirrorError('TENANT_RATE_LIMIT','The shared platform request budget is exhausted.',{retry_after_ms:Math.ceil((1-tokens)*200)},429,true);this.putDocument('__service_limits__','provider_budget',sha256(key),{tokens:tokens-1,at:now});});}
 providerCooldown(key:string,milliseconds:number){const until=Date.now()+Math.max(1000,Math.min(3600000,milliseconds));this.db.prepare('INSERT INTO provider_cooldowns VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until_at=max(until_at,excluded.until_at)').run(key,until);}
 retryJob(id:string,leaseToken:string,error:unknown,delayMs:number){const now=Date.now(),r=this.db.prepare("UPDATE jobs SET state='queued',error=?,available_at=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").run(JSON.stringify(redact(error)),now+Math.max(1000,Math.min(3600000,delayMs)),now,id,leaseToken,now);if(!r.changes)throw new MirrorError('STALE_JOB_LEASE','This worker no longer owns the job lease.',{},409);}
 restoreJobActor(tenant:string,id:string,binding:string):Actor{
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Background verification requires encryption.');
  const value=this.box.open<{actor:Actor;credential_hash:string|null}>(binding,scopeKey(tenant,'job-actor',id)),actor=value.actor;
  if(actor.tenantId!==tenant)throw new MirrorError('FORBIDDEN','Invalid job tenant.');
  if(value.credential_hash)this.authenticatedActors.set(actor,value.credential_hash);this.assertActorActive(actor);return actor;
 }
 putConnection(actor:Actor,connection:Connection,credentials:Credentials){
  if(actor.role!=='admin'||actor.tenantId!==connection.tenantId)throw new MirrorError('FORBIDDEN','Only a tenant administrator can provision a connection.',{},403);
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Configure MIRROR_MASTER_KEY before storing credentials.',{},503);
  if(connection.enabled&&!connection.accounts.length||connection.accounts.some(x=>typeof x!=='string'||!x))throw new MirrorError('INVALID_ACCOUNT_BINDING','Enabled connections require explicit nonempty account bindings.');
  if(connection.writeAccounts!==undefined&&(!Array.isArray(connection.writeAccounts)||connection.writeAccounts.some(id=>typeof id!=='string'||!connection.accounts.includes(id))))throw new MirrorError('INVALID_WRITE_BINDING','Write grants must be a subset of the connection account grants.');
  if(connection.accountCustomers!==undefined&&(typeof connection.accountCustomers!=='object'||Array.isArray(connection.accountCustomers)||Object.entries(connection.accountCustomers).some(([id,v])=>!connection.accounts.includes(id)||typeof v!=='string'||! /^[1-9][0-9]*$/.test(v))))throw new MirrorError('INVALID_ACCOUNT_BINDING','Microsoft parent customers must map selected accounts to decimal identifiers.');
  if(connection.accountLoginCustomers!==undefined&&(!connection.accountLoginCustomers||connection.gateway!=='google_ads_native_action'||typeof connection.accountLoginCustomers!=='object'||Array.isArray(connection.accountLoginCustomers)||Object.entries(connection.accountLoginCustomers).some(([id,v])=>!connection.accounts.includes(id)||typeof v!=='string'||!/^\d+$/.test(v))))throw new MirrorError('INVALID_ACCOUNT_BINDING','Google login customers must map selected accounts to decimal identifiers.');
  for(const binding of connection.resourceBindings??[])if(!connection.accounts.includes(binding.accountId)||!/^\/[a-zA-Z0-9]/.test(binding.pathPrefix)||binding.pathPrefix.endsWith('/')||/[?%#\\]|\/\.\.?($|\/)/.test(binding.pathPrefix))throw new MirrorError('INVALID_RESOURCE_BINDING','Resource bindings require an exact safe path prefix and a configured account.');
  this.ensureTenant(actor.tenantId);
  const secret='v2:'+this.box.seal(credentials,scopeKey(connection.tenantId,connection.id));
  this.db.prepare('INSERT INTO connections(id,tenant_id,data,secret) VALUES(?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET data=excluded.data,secret=excluded.secret').run(connection.id,connection.tenantId,JSON.stringify(connection),secret);
  this.db.prepare('DELETE FROM resource_ownership WHERE tenant_id=? AND connection_id=?').run(connection.tenantId,connection.id);
 }
 listConnections(tenantId:string):Connection[]{return (this.db.prepare('SELECT data FROM connections WHERE tenant_id=?').all(tenantId) as {data:string}[]).map(x=>JSON.parse(x.data));}
 credentials(tenantId:string,id:string):Credentials{
  const row=this.db.prepare('SELECT secret FROM connections WHERE tenant_id=? AND id=?').get(tenantId,id) as {secret:string}|undefined;
  if(!row||!this.box)throw new MirrorError('CONNECTION_REQUIRED','Connection credentials are unavailable for this tenant.',{},403);
  if(row.secret.startsWith('v2:'))return this.box.open<Credentials>(row.secret.slice(3),scopeKey(tenantId,id));
  // Legacy delimiter encoding is migratable only when both components lack that delimiter.
  if(tenantId.includes('/')||id.includes('/'))throw new MirrorError('REAUTHORIZATION_REQUIRED','Re-provision this legacy connection to establish an unambiguous encryption scope.',{},401);
  const value=this.box.open<Credentials>(row.secret,tenantId+'/'+id);this.replaceCredentials(tenantId,id,value);return value;
 }
 replaceCredentials(tenantId:string,id:string,value:Credentials){if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Credential encryption unavailable.');const result=this.db.prepare('UPDATE connections SET secret=? WHERE tenant_id=? AND id=?').run('v2:'+this.box.seal(value,scopeKey(tenantId,id)),tenantId,id);if(!result.changes)throw new MirrorError('CONNECTION_REQUIRED','Connection was removed.');}
 rememberResource(connection:Connection,accountId:string,resource:string,ttlMs=300000){
  this.db.prepare('INSERT INTO resource_ownership VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,connection_id,account_id,resource) DO UPDATE SET expires_at=excluded.expires_at').run(connection.tenantId,connection.id,accountId,resource,Date.now()+Math.min(ttlMs,300000));
 }
 ownsResource(connection:Connection,accountId:string,resource:string):boolean{return !!this.db.prepare('SELECT 1 FROM resource_ownership WHERE tenant_id=? AND connection_id=? AND account_id=? AND resource=? AND expires_at>?').get(connection.tenantId,connection.id,accountId,resource,Date.now());}
 resolveConnection(actor:Actor,gateway:string,accountId?:string,connectionId?:string):Connection{
  this.assertActorActive(actor);
  const normalize=(id:string)=>gateway==='google_ads_native_action'?id.replaceAll('-',''):gateway==='meta_native_action'?id.replace(/^act_/,''):id;
  const available=this.listConnections(actor.tenantId).filter(c=>c.enabled&&c.gateway===gateway&&(!connectionId||c.id===connectionId)&&(!accountId||c.accounts.some(a=>normalize(a)===normalize(accountId))));
  if(!available.length)throw new MirrorError('CONNECTION_REQUIRED','No authorized connection is configured for this gateway/account.',{gateway,account_id:accountId??null},403);
  if(available.length!==1){const defaults=available.filter(c=>c.isDefault===true);if(!connectionId&&defaults.length===1)return defaults[0]!;throw new MirrorError('AMBIGUOUS_CONNECTION','Specify a connection_id to select one connection.');}
  return available[0]!;
 }
 appendAudit(tenantId:string,requestId:string,event:unknown){
  const payload=stable(redact(event));
  this.transaction(()=>{const prev=this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as {hash:string}|undefined;const previous=prev?.hash??'GENESIS';const at=Date.now();const hash=sha256(stable({tenantId,requestId,payload,previous,at}));this.db.prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)').run(tenantId,requestId,payload,previous,hash,at);});
 }
 audit(tenantId:string,limit=100,after=0){return this.db.prepare('SELECT * FROM audit WHERE tenant_id=? AND seq>? ORDER BY seq LIMIT ?').all(tenantId,after,Math.min(1000,Math.max(1,limit)));}
 // The activity feed needs the latest rows; forward audit cursors retain their existing ordering.
 recentAudit(tenantId:string,limit=100){return this.db.prepare('SELECT * FROM audit WHERE tenant_id=? ORDER BY seq DESC LIMIT ?').all(tenantId,Math.min(1000,Math.max(1,limit)));}
 verifyAudit(){let previous='GENESIS';for(const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').iterate() as Iterable<JsonObject>){const hash=sha256(stable({tenantId:row.tenant_id,requestId:row.request_id,payload:row.event,previous,at:row.created_at}));if(row.previous_hash!==previous||row.hash!==hash)return false;previous=hash;}return true;}
 claim(tenantId:string,key:string,fingerprint:string):{fresh:boolean;result?:unknown}{return this.transaction(()=>{
  const row=this.db.prepare('SELECT * FROM idempotency WHERE tenant_id=? AND key=?').get(tenantId,key) as JsonObject|undefined;
  if(row){if(row.fingerprint!==fingerprint)throw new MirrorError('IDEMPOTENCY_CONFLICT','The same key was used for a different request.',{},409);if(row.state==='complete')return {fresh:false,result:JSON.parse(row.result)};throw new MirrorError('WRITE_OUTCOME_UNCERTAIN','This key is pending or has an uncertain outcome. Read back the platform state before resolving it.',{},409);}
  this.db.prepare("INSERT INTO idempotency(tenant_id,key,fingerprint,state,created_at) VALUES(?,?,?,'pending',?)").run(tenantId,key,fingerprint,Date.now());return {fresh:true};
 });}
 complete(tenantId:string,key:string,result:unknown){this.db.prepare("UPDATE idempotency SET state='complete',result=? WHERE tenant_id=? AND key=?").run(JSON.stringify(redact(result)),tenantId,key);}
 uncertain(tenantId:string,key:string){this.db.prepare("UPDATE idempotency SET state='uncertain' WHERE tenant_id=? AND key=?").run(tenantId,key);}
 putDocument(tenantId:string,kind:string,id:string,data:unknown,expectedRevision?:number){return this.transaction(()=>{
  const old=this.db.prepare('SELECT revision FROM documents WHERE tenant_id=? AND kind=? AND id=?').get(tenantId,kind,id) as {revision:number}|undefined;
  if(expectedRevision!==undefined&&old?.revision!==expectedRevision)throw new MirrorError('REVISION_CONFLICT','The document changed since it was read.',{},409);
  const revision=(old?.revision??0)+1;this.db.prepare('INSERT INTO documents(tenant_id,kind,id,data,revision) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data=excluded.data,revision=excluded.revision').run(tenantId,kind,id,JSON.stringify(data),revision);return {id,revision};
 });}
 document(tenantId:string,kind:string,id:string):JsonObject{const row=this.db.prepare('SELECT data,revision FROM documents WHERE tenant_id=? AND kind=? AND id=?').get(tenantId,kind,id) as {data:string;revision:number}|undefined;if(!row)throw new MirrorError('NOT_FOUND','Document not found in this tenant.',{},404);return {...JSON.parse(row.data),id,revision:row.revision};}
 documents(tenantId:string,kind:string):JsonObject[]{return (this.db.prepare('SELECT id,data,revision FROM documents WHERE tenant_id=? AND kind=? ORDER BY id').all(tenantId,kind) as JsonObject[]).map(r=>({...JSON.parse(r.data),id:r.id,revision:r.revision}));}
 enqueue(tenantId:string,kind:string,input:unknown,availableAt=Date.now()):string{const id=randomUUID(),at=Date.now();this.db.prepare("INSERT INTO jobs(id,tenant_id,kind,input,state,available_at,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?)").run(id,tenantId,kind,JSON.stringify(input),availableAt,at,at);return id;}
 activateJob(tenantId:string,id:string){const result=this.db.prepare("UPDATE jobs SET available_at=?,updated_at=? WHERE tenant_id=? AND id=? AND state='queued'").run(Date.now(),Date.now(),tenantId,id);if(!result.changes){const job=this.job(tenantId,id);if(!['running','complete'].includes(job.state))throw new MirrorError('INVALID_JOB_STATE','Only a queued run can be executed.',{},409);}}
 listTenants():string[]{return (this.db.prepare('SELECT id FROM tenants ORDER BY id').all() as {id:string}[]).map(r=>r.id);}
 enqueueSchedule(tenantId:string,scheduleId:string,revision:number,nextRunAt:number):string|undefined{return this.transaction(()=>{
  const schedule=this.document(tenantId,'reporting_schedule',scheduleId),now=Date.now();
  if(schedule.revision!==revision||!schedule.is_active||schedule.next_run_at>now)return;
  const query=this.document(tenantId,'reporting_query',schedule.schedule_config.query_id),{id,revision:oldRevision,...data}=schedule;
  const job=this.enqueue(tenantId,'report',{query_id:query.id,query_revision:query.revision,query_config:query.query_config,schedule_id:scheduleId});
  this.db.prepare('UPDATE documents SET data=?,revision=revision+1 WHERE tenant_id=? AND kind=? AND id=?').run(JSON.stringify({...data,next_run_at:nextRunAt,last_run_id:job,last_run_at:new Date(now).toISOString()}),tenantId,'reporting_schedule',scheduleId);return job;
 });}
 leaseJob(leaseMs=60000):JsonObject|undefined{return this.transaction(()=>{
  if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>3600000)throw new MirrorError('INVALID_LEASE','Lease duration must be between 1 ms and 1 hour.');
  const now=Date.now();this.db.prepare("UPDATE jobs SET state='queued',lease_until=NULL,lease_token=NULL WHERE state='running' AND lease_until<=?").run(now);
  const row=this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY available_at,created_at LIMIT 1").get(now) as JsonObject|undefined;
  if(!row)return;const token=randomUUID();this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=?").run(now+leaseMs,token,now,row.id);return {...row,input:JSON.parse(row.input),attempts:row.attempts+1,lease_token:token,lease_until:now+leaseMs};
 });}
 finishJob(id:string,leaseToken:string,result:unknown){const now=Date.now();const r=this.db.prepare("UPDATE jobs SET state='complete',result=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").run(JSON.stringify(redact(result)),now,id,leaseToken,now);if(!r.changes)throw new MirrorError('STALE_JOB_LEASE','This worker no longer owns the job lease.',{},409);}
 failJob(id:string,leaseToken:string,error:unknown){const now=Date.now();const r=this.db.prepare("UPDATE jobs SET state='failed',error=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").run(JSON.stringify(redact(error)),now,id,leaseToken,now);if(!r.changes)throw new MirrorError('STALE_JOB_LEASE','This worker no longer owns the job lease.',{},409);}
 renewJob(id:string,leaseToken:string,leaseMs=60000){if(!Number.isInteger(leaseMs)||leaseMs<1||leaseMs>3600000)throw new MirrorError('INVALID_LEASE','Invalid lease duration.');const now=Date.now();const r=this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").run(now+leaseMs,now,id,leaseToken,now);if(!r.changes)throw new MirrorError('STALE_JOB_LEASE','This worker no longer owns the job lease.',{},409);}
 job(tenantId:string,id:string):JsonObject{const row=this.db.prepare('SELECT * FROM jobs WHERE tenant_id=? AND id=?').get(tenantId,id) as JsonObject|undefined;if(!row)throw new MirrorError('NOT_FOUND','Job not found in this tenant.',{},404);const {lease_token,...publicRow}=row;return {...publicRow,input:JSON.parse(row.input),result:row.result?JSON.parse(row.result):null,error:row.error?JSON.parse(row.error):null};}
}
