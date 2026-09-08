import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {removeTestDirectory} from './temp.js';

test('Meta provisioning accepts a hidden pipe and persists only encrypted credentials',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whathead-meta-provision-'));
 const database=path.join(directory,'mirror.sqlite'),key=randomBytes(32).toString('base64'),token='EAA'+randomBytes(100).toString('hex');
 const entry=fileURLToPath(new URL('../tools/meta-connection.js',import.meta.url));
 const run=(input:string,args:string[]=['provision'])=>new Promise<{code:number|null;output:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,[entry,...args],{env:{...process.env,MIRROR_DB:database,MIRROR_MASTER_KEY:key},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));child.stdin.end(input+'\n');
 });
 try{
  const result=await run(token);assert.equal(result.code,0,result.output);assert.ok(!result.output.includes(token));assert.match(result.output,/No vendor requests/);
  const store=new Store(database,key);try{
   assert.equal(store.credentials('local','11111111-2222-4333-8444-000000000001').accessToken,token);
   assert.deepEqual(store.listConnections('local')[0]!.accounts,['111111111111111']);
   assert.equal(store.verifyAudit(),true);assert.ok(!JSON.stringify(store.audit('local')).includes(token));
  }finally{store.close();}
  // Windows may remove transient SQLite shared-memory files between enumeration and reading.
  for(const filename of fs.readdirSync(directory))try{assert.ok(!fs.readFileSync(path.join(directory,filename)).includes(Buffer.from(token)),filename+' contains plaintext');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'||!/-shm(?:\.tmp)?$/i.test(filename))throw e;}
  const rejected=await run('invalid-'+token);assert.equal(rejected.code,1);assert.match(rejected.output,/INVALID_TOKEN_INPUT/);assert.ok(!rejected.output.includes(token));
  assert.equal((await run('',['bind'])).code,1);
  assert.equal((await run('',['bind','2222222222222222?method=POST'])).code,1);
  const bound=await run('',['bind','2222222222222222']);assert.equal(bound.code,0,bound.output);assert.ok(!bound.output.includes(token));assert.match(bound.output,/"vendor_requests": 0/);
  assert.equal((await run(token)).code,0);
  const unchanged=new Store(database,key);try{
   assert.equal(unchanged.credentials('local','11111111-2222-4333-8444-000000000001').accessToken,token);
   assert.deepEqual(unchanged.listConnections('local')[0]!.accounts,['111111111111111','2222222222222222']);
   assert.equal(unchanged.verifyAudit(),true);
  }finally{unchanged.close();}
 }finally{removeTestDirectory(directory,'whathead-meta-provision-');}
});
