import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import {request} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {listenForFetch} from './http-listener.js';

const entry=fileURLToPath(new URL('../server/http.js',import.meta.url));
async function portLease(){
 const server=await listenForFetch((_req,res)=>res.end());
 return {port:(server.address() as AddressInfo).port,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
function start(env:NodeJS.ProcessEnv){
 // Do not inherit provider credentials, live database paths or worker settings.
 const child=spawn(process.execPath,[entry],{windowsHide:true,env:{
  SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,TMP:process.env.TMP,
  NODE_ENV:'production',MIRROR_DB:':memory:',MIRROR_MASTER_KEY:Buffer.alloc(32,41).toString('base64'),
  AMCP_ADMIN_PASSWORD:'Synthetic startup password only',AMCP_PUBLIC_ORIGIN:'https://startup.example.test',
  AMCP_RUN_WORKER:'false',MIRROR_ALLOW_WRITES:'false',...env
 },stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const closed=once(child,'close');
 return {child,closed,output:()=>({stdout,stderr}),stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;}};
}
async function getWithHost(port:number,path:string,host:string){
 return new Promise<number|undefined>((resolve,reject)=>{
  // Node fetch can replace Host; use the wire-level client for this assertion.
  const req=request({hostname:'127.0.0.1',port,path,headers:{host},signal:AbortSignal.timeout(3000)},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end();
 });
}
for(const host of ['0.0.0.0','127.0.0.1'])test(`HTTP startup reports the actual ${host} listener as info on stdout`,{timeout:20000},async()=>{
 const lease=await portLease();await lease.close();
 const proc=start({PORT:String(lease.port),MIRROR_PORT:'1',...(host==='127.0.0.1'?{MIRROR_HOST:host}:{})});
 try{
  const end=performance.now()+10000;
  while(!/AMCP.*listening/.test(proc.output().stdout+proc.output().stderr)&&proc.child.exitCode===null&&performance.now()<end)await delay(25);
  const {stdout,stderr}=proc.output();
  assert.match(stdout,/AMCP.*listening/,'a successful HTTP start belongs on stdout');
  assert.doesNotMatch(stderr,/AMCP.*listening/,'Railway treats stderr as an error');
  const log=JSON.parse(stdout.trim());assert.equal(log.level,'info');assert.equal(log.event,'http_listening');
  assert.equal(log.host,host);assert.equal(log.port,lease.port);assert.equal(log.public_origin,'https://startup.example.test');
  const base='http://127.0.0.1:'+lease.port;
  assert.equal(await getWithHost(lease.port,'/healthz','healthcheck.railway.app'),200);
  const health=await fetch(base+'/healthz',{signal:AbortSignal.timeout(3000)});
  assert.equal(health.status,200);assert.equal((await health.json() as {status:string}).status,'up');
  assert.equal(await getWithHost(lease.port,'/privacy','untrusted.example.test'),403,'diagnostic changes must preserve host validation');
  const mcp=await fetch(base+'/mcp',{method:'POST',signal:AbortSignal.timeout(3000)});
  assert.equal(mcp.status,401,'listening is not proof of MCP authorization');
  assert.doesNotMatch(stdout+stderr,/Synthetic startup password only/);
 }finally{await proc.stop();}
});

for(const worker of [false,true])test(`a real HTTP bind failure exits with an error and no listening event (worker=${worker})`,{timeout:20000},async()=>{
 const lease=await portLease(),proc=start({PORT:String(lease.port),MIRROR_HOST:'127.0.0.1',AMCP_RUN_WORKER:String(worker)});
 try{
  const [code]=await proc.closed;assert.notEqual(code,0);const {stdout,stderr}=proc.output();
  assert.doesNotMatch(stdout,/http_listening|AMCP.*listening/);assert.match(stderr,/EADDRINUSE/);
  const line=stderr.split(/\r?\n/).find(s=>s.includes('http_listen_failed'));assert.ok(line);
  assert.equal(JSON.parse(line).level,'error');assert.equal(JSON.parse(line).code,'EADDRINUSE');
 }finally{await proc.stop();await lease.close();}
});
