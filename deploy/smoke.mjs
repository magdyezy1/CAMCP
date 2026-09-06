import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const suffix=randomBytes(6).toString('hex'),container='amcp-ci-'+suffix,volume=container+'-data';
const password=randomBytes(24).toString('base64url'),base='http://127.0.0.1:14317',origin='https://amcp.shop';
const env={...process.env,MIRROR_MASTER_KEY:randomBytes(32).toString('base64'),AMCP_ADMIN_PASSWORD:password,AMCP_PUBLIC_ORIGIN:origin};
function docker(...args){const result=spawnSync('docker',args,{encoding:'utf8',env});if(result.status!==0)throw Error('Docker '+args[0]+' failed: '+result.stderr);return result.stdout.trim();}
async function ready(){for(let i=0;i<60;i++){try{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)});if(r.ok){assert.equal((await r.json()).live_writes,false);return;}}catch{}await delay(250);}throw Error('AMCP container did not become healthy');}
const api=(path,method='GET',body,headers={})=>fetch(base+path,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
let created=false,volumeCreated=false;
try{
 docker('volume','create',volume);volumeCreated=true;
 docker('run','-d','--name',container,'-p','127.0.0.1:14317:4317','-v',volume+':/data','-e','MIRROR_MASTER_KEY','-e','AMCP_ADMIN_PASSWORD','-e','AMCP_PUBLIC_ORIGIN','amcp:check');created=true;
 await ready();assert.equal(docker('exec',container,'stat','-c','%u','/data'),'1000');
 for(const path of ['/','/connectors','/assets/app.js','/assets/app.css'])assert.equal((await api(path)).status,200,path);
 const login=await api('/api/session','POST',{password},{Origin:origin});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf,headers={Cookie:cookie,Origin:origin,'X-AMCP-CSRF':csrf};
 const configured=await (await api('/api/platforms','GET',undefined,headers)).json();assert.equal(configured.platforms.length,6);assert.equal(configured.platforms.find(p=>p.id==='snapchat').callback,origin+'/api/auth/snapchat/callback');
 const tokenResponse=await api('/api/connector-tokens','POST',{name:'Synthetic CI client'},headers);assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();
 const mcp=await api('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization:'Bearer '+token.token,Accept:'application/json, text/event-stream'});assert.equal(mcp.status,200);assert.equal((await mcp.json()).result.tools.length,20);
 docker('restart',container);await ready();assert.equal((await (await api('/api/session','GET',undefined,headers)).json()).authenticated,true);
 assert.equal((await api('/api/connector-tokens/'+token.id,'DELETE',undefined,headers)).status,200);assert.equal((await api('/mcp','GET',undefined,{Authorization:'Bearer '+token.token})).status,401);
 console.log('AMCP container checks passed: static pages, non-root volume access, sign-in, MCP, restart persistence and token revocation.');
}finally{
 if(created)docker('rm','-f',container);
 if(volumeCreated)docker('volume','rm',volume);
}
