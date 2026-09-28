import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {checkProviderSpec} from '../dist/tools/provider-drift.js';

// Pinned vendor documents decide which requests AMCP builds; an edit on disk must not pass unnoticed.
test('every pinned vendor document is sealed with the digest of its content',async()=>{
 const files=fs.readdirSync('.mirror/VENDOR').filter(f=>f.endsWith('.json'));let sealed=0;
 for(const f of files){
  const envelope=JSON.parse(fs.readFileSync('.mirror/VENDOR/'+f,'utf8'));if(!envelope.document)continue;
  assert.equal(envelope.document_sha256,createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex'),f);
  assert.match(envelope.source,/^https:\/\//,f);sealed++;
 }
 assert.ok(sealed>=22,'sealed '+sealed);
 const edited=JSON.parse(fs.readFileSync('.mirror/VENDOR/reddit-v3.json','utf8'));edited.document.info={...edited.document.info,title:'edited'};
 await assert.rejects(checkProviderSpec(edited),/integrity mismatch/);
});
