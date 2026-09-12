import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {MAX_MEDIA_BYTES} from '../dist/src/drive-media.js';
import {readMediaBody} from '../dist/src/media-buffer.js';
import {operationsHealth} from '../dist/src/operations-health.js';
import {ReportWorker} from '../dist/src/worker.js';
import {NativeTransport} from '../dist/src/transport.js';
const key=Buffer.alloc(32,54).toString('base64');
test('maximum media bytes stream to encrypted staging; two replicas share admission and expiration cleanup',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-media-capacity-')),file=path.join(dir,'db.sqlite'),a=new Store(file,key),b=new Store(file,key);
 try{const lease=a.mediaAdmission('one');assert.throws(()=>b.mediaAdmission('two'),e=>e.code==='MEDIA_MEMORY_BUSY');a.reserveMedia('one','media',Date.now()+300000);
  const start=process.memoryUsage().rss;let peak=start,total=0;const sink=a.mediaSink('one','media',lease.check),chunk=Buffer.alloc(262144,81),stream=new ReadableStream({pull(c){if(total===MAX_MEDIA_BYTES){c.close();return;}c.enqueue(chunk);total+=chunk.length;peak=Math.max(peak,process.memoryUsage().rss);}}),bytes=await readMediaBody(new Response(stream),MAX_MEDIA_BYTES,sink);peak=Math.max(peak,process.memoryUsage().rss);
  assert.equal(bytes.length,MAX_MEDIA_BYTES);assert.equal(bytes.at(-1),81);assert.ok(peak-start<lease.bytes,'RSS delta '+(peak-start)+' exceeds conservative reservation '+lease.bytes);console.log(JSON.stringify({media_capacity:{file_bytes:bytes.length,peak_rss:peak,baseline_rss:start,delta:peak-start,reservation:lease.bytes}}));
  assert.throws(()=>b.stagedMedia('two','media'),e=>e.code==='REVIEW_EXPIRED');assert.ok(!a.db.prepare('SELECT secret FROM media_staging').get().secret.includes('QQQQ'));
  lease.release();const next=b.mediaAdmission('two');next.release();a.db.prepare('UPDATE media_staging SET expires_at=0').run();b.cleanupTransient();assert.equal(a.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n,0);
 }finally{a.close();b.close();fs.rmSync(dir,{recursive:true});}
});
test('over-limit streams and cancelled staging stop consumption and erase partial chunks',async()=>{
 const store=new Store(':memory:',key);try{let cancelled=false;const stream=new ReadableStream({pull(c){c.enqueue(Buffer.alloc(1024));},cancel(){cancelled=true;}});await assert.rejects(()=>readMediaBody(new Response(stream),1000),e=>e.code==='MEDIA_TOO_LARGE');assert.equal(cancelled,true);
 store.reserveMedia('t','s',Date.now()+300000);const sink=store.mediaSink('t','s',()=>{});sink.write(Buffer.alloc(4*1024*1024));store.removeStagedMedia('t','s');assert.throws(()=>sink.write(Buffer.alloc(4*1024*1024)),e=>e.code==='REVIEW_EXPIRED');assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_chunks').get().n,0);
 }finally{store.close();}
});
test('journal and mutation claim commit atomically, survive restart, and never permit a second uncertain mutation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-journal-')),file=path.join(dir,'db');let s=new Store(file,key);try{s.claim('t','review','fingerprint');s.journal('t','review','allocated',{media_id:'123',url:'https://private.test/token',access_token:'secret'});s.close();s=new Store(file,key);assert.throws(()=>s.claim('t','review','fingerprint'),e=>e.code==='WRITE_OUTCOME_UNCERTAIN');const j=s.operationJournal('t','review');assert.equal(j.phase,'allocated');assert.equal(j.automatic_new_mutation,false);assert.ok(!JSON.stringify(j).includes('private.test'));s.uncertain('t','review');assert.equal(s.operationJournal('t','review').phase,'uncertain');assert.throws(()=>s.transaction(()=>{s.claim('t','rollback','f');throw Error('crash');}));assert.equal(s.operationJournal('t','rollback').phase,'unknown');}finally{s.close();fs.rmSync(dir,{recursive:true});}
});
test('two workers distribute ready jobs fairly and stale leases cannot publish after clock changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amcp-leases-')),file=path.join(dir,'db'),a=new Store(file,key),b=new Store(file,key),now=Date.now;let clock=now();Date.now=()=>clock;
 try{for(let i=0;i<5;i++)a.enqueue('a','test',{});a.enqueue('b','test',{});const first=a.leaseJob(100);assert.equal(first.tenant_id,'a');a.finishJob(first.id,first.lease_token,{});const second=b.leaseJob(100);assert.equal(second.tenant_id,'b');clock+=101;const third=a.leaseJob(100);assert.throws(()=>b.finishJob(second.id,second.lease_token,{}),e=>e.code==='STALE_JOB_LEASE');clock-=10000;assert.throws(()=>b.finishJob(second.id,second.lease_token,{}),e=>e.code==='STALE_JOB_LEASE');assert.ok(third);
 }finally{Date.now=now;a.close();b.close();fs.rmSync(dir,{recursive:true});}
});
test('backward time cannot refill the shared provider bucket twice; health exposes stalls with redacted tenant scope',()=>{
 const s=new Store(':memory:',key),now=Date.now;let clock=now();Date.now=()=>clock;try{s.providerPermit('k');clock-=1000;for(let i=0;i<29;i++)s.providerPermit('k');clock+=1000;assert.throws(()=>s.providerPermit('k'),e=>e.code==='TENANT_RATE_LIMIT');const worker=new ReportWorker(s,async()=>{});worker.heartbeat();s.enqueue('other','private-job',{token:'secret'});assert.equal(operationsHealth(s,'t').worker.status,'active');clock+=90001;const health=operationsHealth(s,'t');assert.equal(health.worker.status,'stale');assert.equal(health.queue.length,0);assert.ok(!JSON.stringify(health).includes('secret'));}finally{Date.now=now;s.close();}
});
test('provider pacing maps prune inactive entries and fail boundedly rather than evicting active debt',async()=>{
 const t=new NativeTransport();for(let i=0;i<4096;i++)t.budgets.set(String(i),{at:performance.now(),tokens:-1});assert.throws(()=>t.prune(),e=>e.code==='PROVIDER_COORDINATION_BUSY');for(const b of t.budgets.values())b.at=-100000;t.prune();assert.equal(t.diagnostics().budget_entries,0);
});
