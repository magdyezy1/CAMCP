import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {SecretBox,sha256,stable,redact,scopeKey} from './security.js';
import type {Actor,Connection,Credentials,JsonObject} from './types.js';
export class Store {
 readonly db:DatabaseSync;private box?:SecretBox;
 private authenticatedActors=new WeakMap<Actor,string>();
 private transactionDepth=0;
 constructor(filename:string,masterKey?:string){
  if(masterKey)this.box=new SecretBox(masterKey);
  if(filename!==':memory:')fs.mkdirSync(path.dirname(filename),{recursive:true});
  this.db=new DatabaseSync(filename);
  try{
  this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  // Serialize bootstrap and migration together so two starting processes cannot
  // both observe an old schema and attempt the same ALTER TABLE.
  this.transaction(()=>{this.db.exec(`
   CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL); INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
   CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL);
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
  `);
  const version=this.db.prepare('SELECT version FROM schema_version').get() as {version:number};
  if(version.version===1)this.db.exec('ALTER TABLE jobs ADD COLUMN lease_token TEXT; UPDATE schema_version SET version=2;');
  else if(version.version!==2)throw new MirrorError('SCHEMA_VERSION_MISMATCH','Database migration required.',{},500);
  });
  }catch(e){this.db.close();throw e;}
 }
 close(){this.db.close();}
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
 createKey(actor:Actor,ttlMs:number=86400000*30):string{this.ensureTenant(actor.tenantId);const token='whm_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');this.db.prepare('INSERT INTO api_keys(hash,tenant_id,user_id,role,expires_at) VALUES(?,?,?,?,?)').run(sha256(token),actor.tenantId,actor.userId,actor.role,Date.now()+ttlMs);return token;}
 authenticate(token:string):Actor{
  const row=this.db.prepare('SELECT * FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)').get(sha256(token),Date.now()) as JsonObject|undefined;
  if(!row)throw new MirrorError('UNAUTHORIZED','A valid, unexpired API key is required.',{},401);
  const actor:Actor={tenantId:row.tenant_id,userId:row.user_id,role:row.role};this.authenticatedActors.set(actor,sha256(token));return actor;
 }
 /** HTTP actors retain a process-local credential identity without exposing the token or hash. */
 assertActorActive(actor:Actor):void{
  const hash=this.authenticatedActors.get(actor);if(!hash)return; // Trusted local/stdio actors have no bearer credential.
  const row=this.db.prepare('SELECT tenant_id,user_id,role FROM api_keys WHERE hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)').get(hash,Date.now()) as JsonObject|undefined;
  if(!row||row.tenant_id!==actor.tenantId||row.user_id!==actor.userId||row.role!==actor.role)throw new MirrorError('UNAUTHORIZED','Connector access expired, changed or was revoked during this request.',{},401);
 }
 revokeKey(token:string){this.db.prepare('UPDATE api_keys SET revoked=1 WHERE hash=?').run(sha256(token));}
 putConnection(actor:Actor,connection:Connection,credentials:Credentials){
  if(actor.role!=='admin'||actor.tenantId!==connection.tenantId)throw new MirrorError('FORBIDDEN','Only a tenant administrator can provision a connection.',{},403);
  if(!this.box)throw new MirrorError('ENCRYPTION_REQUIRED','Configure MIRROR_MASTER_KEY before storing credentials.',{},503);
  if(connection.enabled&&!connection.accounts.length||connection.accounts.some(x=>typeof x!=='string'||!x))throw new MirrorError('INVALID_ACCOUNT_BINDING','Enabled connections require explicit nonempty account bindings.');
  if(connection.writeAccounts!==undefined&&(!Array.isArray(connection.writeAccounts)||connection.writeAccounts.some(id=>typeof id!=='string'||!connection.accounts.includes(id))))throw new MirrorError('INVALID_WRITE_BINDING','Write grants must be a subset of the connection account grants.');
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
