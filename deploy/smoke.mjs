import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const suffix=randomBytes(6).toString('hex'),container='amcp-ci-'+suffix,volume=container+'-data';
const password=randomBytes(24).toString('base64url'),base='http://127.0.0.1:14317',origin='https://amcp.shop';
const writes=process.argv.includes('--writes');
const env={...process.env,MIRROR_MASTER_KEY:randomBytes(32).toString('base64'),AMCP_ADMIN_PASSWORD:password,AMCP_PUBLIC_ORIGIN:origin,MIRROR_ALLOW_WRITES:String(writes)};
function docker(...args){const result=spawnSync('docker',args,{encoding:'utf8',env});if(result.status!==0)throw Error('Docker '+args[0]+' failed: '+result.stderr);return result.stdout.trim();}
async function ready(){for(let i=0;i<60;i++){try{const r=await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)});if(r.ok){assert.equal((await r.json()).live_writes,writes);return;}}catch{}await delay(250);}throw Error('AMCP container did not become healthy');}
const api=(path,method='GET',body,headers={})=>fetch(base+path,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
let created=false,volumeCreated=false;
try{
 docker('volume','create',volume);volumeCreated=true;
 docker('run','-d','--name',container,'-p','127.0.0.1:14317:4317','-v',volume+':/data','-e','MIRROR_MASTER_KEY','-e','AMCP_ADMIN_PASSWORD','-e','AMCP_PUBLIC_ORIGIN','-e','MIRROR_ALLOW_WRITES','amcp:check');created=true;
 await ready();assert.equal(docker('exec',container,'stat','-c','%u','/data'),'1000');
 for(const path of ['/','/connectors','/assets/app.js','/assets/app.css'])assert.equal((await api(path)).status,200,path);
 const login=await api('/api/session','POST',{password},{Origin:origin});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf,headers={Cookie:cookie,Origin:origin,'X-AMCP-CSRF':csrf};
 const configured=await (await api('/api/platforms','GET',undefined,headers)).json();assert.deepEqual(configured.platforms.map(p=>p.id).sort(),['google','meta','tiktok','snapchat','linkedin','x','ga4','gtm','gsc','apple'].sort());assert.equal(configured.platforms.find(p=>p.id==='snapchat').callback,origin+'/api/auth/snapchat/callback');
 for(const id of ['ga4','gtm','gsc','apple'])assert.equal(configured.platforms.find(p=>p.id===id).reviewedWrites,true);
 assert.equal(configured.platforms.find(p=>p.id==='gtm').scopes.includes('https://www.googleapis.com/auth/tagmanager.publish'),writes);
 assert.equal(configured.platforms.find(p=>p.id==='gsc').scopes.includes('https://www.googleapis.com/auth/webmasters'),writes);
 const metadata=await (await api('/.well-known/oauth-authorization-server')).json();assert.deepEqual(metadata.token_endpoint_auth_methods_supported.sort(),['client_secret_post','none']);assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
 const tokenResponse=await api('/api/connector-tokens','POST',{name:'Synthetic CI client',role:'reader'},headers);assert.equal(tokenResponse.status,200);const token=await tokenResponse.json();
 const mcp=await api('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization:'Bearer '+token.token,Accept:'application/json, text/event-stream'});assert.equal(mcp.status,200);assert.equal((await mcp.json()).result.tools.length,writes?22:20);
 const writer=await api('/api/connector-tokens','POST',{name:'Synthetic operator',role:'operator',confirmed:true},headers);assert.equal(writer.status,writes?200:403);
 if(writes){const w=await writer.json();const denied=await api('/mcp','POST',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'amcp_write',arguments:{action:'prepare',gateway:'meta_native_action',arguments:{action:'meta_campaign_create',account_id:'123',payload:{name:'Synthetic',status:'PAUSED'}}}}},{Authorization:'Bearer '+w.token,Accept:'application/json, text/event-stream'});assert.equal((await denied.json()).result.isError,true);}
 docker('restart',container);await ready();assert.equal((await (await api('/api/session','GET',undefined,headers)).json()).authenticated,true);
 assert.equal((await api('/api/connector-tokens/'+token.id,'DELETE',undefined,headers)).status,200);assert.equal((await api('/mcp','GET',undefined,{Authorization:'Bearer '+token.token})).status,401);
 console.log('AMCP container checks passed: static pages, non-root volume access, sign-in, MCP, restart persistence and token revocation.');
}finally{
 if(created)docker('rm','-f',container);
 if(volumeCreated)docker('volume','rm',volume);
}
