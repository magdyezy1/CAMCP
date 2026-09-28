import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {inspectDrive} from '../dist/src/media-routing.js';

const link='https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view';
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),crypto.randomBytes(3*1024*1024)]);
// A body delivered in 64 KiB chunks, like a network stream.
const body=bytes=>new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=65536)c.enqueue(new Uint8Array(bytes.subarray(i,i+65536)));c.close();}});
const respond=()=>new Response(body(png),{status:200,headers:{'content-type':'image/png'}});

test('Drive inspection hashes the file as it streams and reports what a full download would',async()=>{
 const r=await inspectDrive(link,async()=>respond(),'w1');
 assert.equal(r.files[0].size_bytes,png.length);
 assert.equal(r.files[0].sha256,crypto.createHash('sha256').update(png).digest('hex'));
 assert.equal(r.files[0].mime_type,'image/png');assert.equal(r.files[0].media_type,'image');
});

test('one Drive inspection runs per workspace at a time; other workspaces are not held up',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const slow=inspectDrive(link,async()=>{await gate;return respond();},'busy');
 await assert.rejects(inspectDrive(link,async()=>respond(),'busy'),e=>e.code==='MEDIA_INSPECTION_BUSY'&&e.status===429&&e.retryable===true);
 assert.equal((await inspectDrive(link,async()=>respond(),'other')).files[0].size_bytes,png.length);
 release();await slow;
 // The slot is released when the inspection ends, also after a failure.
 await assert.rejects(inspectDrive(link,async()=>new Response('no',{status:404}),'busy'),e=>e.code==='DRIVE_FILE_UNAVAILABLE');
 assert.equal((await inspectDrive(link,async()=>respond(),'busy')).files[0].size_bytes,png.length);
});
