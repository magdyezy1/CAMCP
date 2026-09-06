import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {SecretBox,redact,stable} from '../src/security.js';
import {Store} from '../src/store.js';
import type {Actor,Connection} from '../src/types.js';
const actor:Actor={tenantId:'tenant-a',userId:'test',role:'admin'};
const connection:Connection={id:'connection',tenantId:'tenant-a',gateway:'meta_native_action',accounts:['123'],label:'Test',enabled:true,scopes:[]};
test('encrypted credentials are bound to tenant and connection',()=>{
 const box=new SecretBox(randomBytes(32).toString('base64'));const value=box.seal({accessToken:'secret'},'a/c');assert.ok(!value.includes('secret'));assert.deepEqual(box.open(value,'a/c'),{accessToken:'secret'});assert.throws(()=>box.open(value,'b/c'),/decryption failed/);
});
test('tenant isolation applies to credentials, documents, jobs and API keys',()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64'));
 try{store.putConnection(actor,connection,{accessToken:'secret'});assert.equal(store.credentials('tenant-a','connection').accessToken,'secret');assert.throws(()=>store.credentials('tenant-b','connection'),/unavailable/);assert.equal(store.listConnections('tenant-b').length,0);
  assert.throws(()=>store.putConnection({...actor,tenantId:'tenant-b'},connection,{accessToken:'secret'}),/administrator/);
  store.putDocument('tenant-a','report','r',{secret:'data'});assert.throws(()=>store.document('tenant-b','report','r'),/not found/);
  const job=store.enqueue('tenant-a','report',{});assert.throws(()=>store.job('tenant-b',job),/not found/);
  const key=store.createKey(actor);assert.deepEqual(store.authenticate(key),actor);store.revokeKey(key);assert.throws(()=>store.authenticate(key),/valid, unexpired/);
 }finally{store.close();}
});
test('idempotency survives duplicate claims and rejects changed requests',()=>{
 const store=new Store(':memory:');try{
  assert.deepEqual(store.claim('a','key','hash'),{fresh:true});assert.throws(()=>store.claim('a','key','hash'),/uncertain outcome/);
  store.complete('a','key',{id:'123'});assert.deepEqual(store.claim('a','key','hash'),{fresh:false,result:{id:'123'}});
  assert.throws(()=>store.claim('a','key','different'),/different request/);assert.deepEqual(store.claim('b','key','different'),{fresh:true});
 }finally{store.close();}
});
test('audit records are append-only, redacted and tamper-evident',()=>{
 const store=new Store(':memory:');try{store.appendAudit('a','r1',{Authorization:'Bearer secret',nested:{access_token:'secret'}});store.appendAudit('b','r2',{value:1});assert.equal(store.verifyAudit(),true);const rows=store.audit('a');assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('secret'));assert.throws(()=>store.db.exec("UPDATE audit SET event='{}'"),/append only/);assert.throws(()=>store.db.exec('DELETE FROM audit'),/append only/);}finally{store.close();}
});
test('redaction and stable fingerprints preserve ordinary data',()=>{
 assert.deepEqual(redact({name:'Example',headers:{Authorization:'Bearer xyz'},url:'https://x.com/?access_token=xyz&n=1'}),{name:'Example',headers:{Authorization:'[REDACTED]'},url:'https://x.com/?access_token=[REDACTED]&n=1'});
 assert.equal(stable({b:2,a:1}),stable({a:1,b:2}));
});
