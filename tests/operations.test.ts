import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {removeTestDirectory} from './temp.js';
const exec=promisify(execFile),admin=fileURLToPath(new URL('../tools/admin.js',import.meta.url));

test('administrator backup restores committed WAL data, encrypted credentials and audit integrity',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whathead-recovery-')),source=path.join(directory,'source.sqlite'),copy=path.join(directory,'backup.sqlite'),key=Buffer.alloc(32,13).toString('base64');const store=new Store(source,key);
 try{
  const actor={tenantId:'t',userId:'test',role:'admin' as const};store.putConnection(actor,{id:'c',tenantId:'t',gateway:'meta_native_action',accounts:['111'],label:'mock',enabled:true,scopes:[]},{accessToken:'synthetic-for-recovery'});store.putDocument('t','test','document',{version:'before'});store.appendAudit('t','test',{event:'backup_test'});
  const env={...process.env,MIRROR_DB:source,MIRROR_MASTER_KEY:key};
  const backed=await exec(process.execPath,[admin,'backup',copy],{env});assert.match(backed.stdout,/backup created/);store.putDocument('t','test','document',{version:'after'});
  const restored=new Store(copy,key);try{assert.equal(restored.document('t','test','document').version,'before');assert.equal(restored.credentials('t','c').accessToken,'synthetic-for-recovery');assert.equal(restored.verifyAudit(),true);}finally{restored.close();}
  const checked=await exec(process.execPath,[admin,'audit-verify'],{env:{...env,MIRROR_DB:copy}});assert.match(checked.stdout,/verified/);
  await assert.rejects(exec(process.execPath,[admin,'backup',copy],{env}),(error:any)=>error.stderr.includes('BACKUP_PATH_REQUIRED'));
 }finally{store.close();removeTestDirectory(directory,'whathead-recovery-');}
});

test('concurrent administrator startup serializes schema creation and unsupported schemas roll back',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whathead-migration-')),filename=path.join(directory,'test.sqlite');
 try{
  await Promise.all(Array.from({length:4},(_,i)=>exec(process.execPath,[admin,'init','t'+i],{env:{...process.env,MIRROR_DB:filename,MIRROR_MASTER_KEY:''}})));
  const store=new Store(filename);try{assert.equal(store.listTenants().length,4);assert.equal((store.db.prepare('SELECT version FROM schema_version').get() as any).version,2);}finally{store.close();}
  const future=path.join(directory,'future.sqlite'),db=new DatabaseSync(future);db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(999); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'preserved\');');db.close();
  assert.throws(()=>new Store(future),/migration required/);
  const after=new DatabaseSync(future);try{assert.equal((after.prepare('SELECT value FROM sentinel').get() as any).value,'preserved');assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='connections'").get(),undefined);}finally{after.close();}
 }finally{removeTestDirectory(directory,'whathead-migration-');}
});
