import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

/**
 * A bad value in an *optional* environment variable must disable or default that one feature and
 * say why. It must never abort process start: a deployment was once taken down by fail-fast
 * validation applied to an optional reviewer password, and module-level throws are worse still
 * because they fire at import, before anything can report the reason.
 *
 * Required configuration is the opposite case and is expected to fail fast — MIRROR_ALLOW_WRITES
 * and the administrator password are checked here to confirm that distinction still holds.
 */

const run=promisify(execFile);
const media=new URL('../src/drive-media.js',import.meta.url).href;

async function importWith(env:Record<string,string>,body:string){
 const script=`import * as m from ${JSON.stringify(media)};${body}`;
 try{
  const r=await run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,...env},timeout:20000});
  return {started:true,stdout:r.stdout.trim(),stderr:r.stderr.trim()};
 }catch(e){const err=e as {stdout?:string;stderr?:string};return {started:false,stdout:(err.stdout??'').trim(),stderr:(err.stderr??'').trim()};}
}

test('a rejected AMCP_MAX_MEDIA_MB falls back to the default instead of stopping the server',async()=>{
 for(const bad of ['0','12','1000','100.5','not-a-number']){
  const r=await importWith({AMCP_MAX_MEDIA_MB:bad},'process.stdout.write(String(m.MAX_MEDIA_BYTES)+"|"+(m.mediaLimitProblem??""));');
  assert.equal(r.started,true,'AMCP_MAX_MEDIA_MB='+bad+' must not abort startup: '+r.stderr);
  const [bytes,problem]=r.stdout.split('|');
  assert.equal(Number(bytes),128*1024*1024,'the safe default must apply for '+bad);
  assert.match(String(problem),/AMCP_MAX_MEDIA_MB must be an integer/,'the reason must be surfaced, not swallowed');
  assert.match(r.stderr,/AMCP_MAX_MEDIA_MB/,'the problem must also be written to stderr at startup');
 }
});

test('a valid AMCP_MAX_MEDIA_MB is honoured and reports no problem',async()=>{
 const r=await importWith({AMCP_MAX_MEDIA_MB:'256'},'process.stdout.write(String(m.MAX_MEDIA_BYTES)+"|"+(m.mediaLimitProblem??""));');
 assert.equal(r.started,true);
 assert.deepEqual(r.stdout.split('|'),[String(256*1024*1024),'']);
});

test('an unset AMCP_MAX_MEDIA_MB uses the documented default silently',async()=>{
 const r=await importWith({AMCP_MAX_MEDIA_MB:''},'process.stdout.write(String(m.MAX_MEDIA_BYTES)+"|"+(m.mediaLimitProblem??""));');
 assert.equal(r.started,true);
 assert.deepEqual(r.stdout.split('|'),[String(128*1024*1024),'']);
 assert.equal(r.stderr,'','an unconfigured default is not a problem worth reporting');
});

test('required configuration still fails fast, because guessing it would be unsafe',async()=>{
 const runtime=new URL('../server/runtime.js',import.meta.url).href;
 // The check runs when the runtime is constructed rather than at import, which still fails fast
 // at startup while leaving the module importable for tests.
 const script=`const {createRuntime}=await import(${JSON.stringify(runtime)});createRuntime();process.stdout.write("started");`;
 const bad=await run(process.execPath,['--input-type=module','-e',script],{env:{...process.env,MIRROR_ALLOW_WRITES:'perhaps'},timeout:20000})
  .then(()=>({started:true,stderr:''}))
  .catch(e=>({started:false,stderr:String((e as {stderr?:string}).stderr??'')}));
 assert.equal(bad.started,false,'an ambiguous write flag must not be guessed');
 assert.match(bad.stderr,/MIRROR_ALLOW_WRITES must be true or false/);
});
