import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import type {Actor,Credentials,JsonObject} from '../src/types.js';
const sandboxHosts=new Set(['ads-api-sandbox.x.com','campaign.api.sandbox.bingads.microsoft.com','clientcenter.api.sandbox.bingads.microsoft.com','reporting.api.sandbox.bingads.microsoft.com']);
export function sandboxFetch(fetcher:typeof fetch):typeof fetch{return async(input,init)=>{
 const url=new URL(String(input));if(url.protocol!=='https:'||url.port||url.username||url.password||!sandboxHosts.has(url.hostname)||init?.method==='DELETE')throw new MirrorError('SANDBOX_ROUTE_UNQUALIFIED','Sandbox checks cannot reach production, external media URLs or delete/reset accounts.');
 return fetcher(input,{...init,redirect:'error'});
};}
export function validateSandboxFixture(config:JsonObject){
 if(!['x_ads_native_action','microsoft_ads_native_action'].includes(config.gateway)||typeof config.account_id!=='string'||!config.account_id||!Array.isArray(config.steps)||!config.steps.length||config.steps.length>20)throw Error('Use an X or Microsoft sandbox account and 1–20 explicit reviewed write steps. Google/TikTok account isolation is not yet qualified by this runner.');
 if(config.steps.some((s:JsonObject)=>s.kind!=='write'||s.gateway!==config.gateway||s.account_id!==config.account_id||s.connection_id!=='sandbox'||!s.arguments||/delete/i.test(String(s.arguments.action))))throw Error('Every sandbox step must be a non-delete write in the exact fixture account/gateway/connection.');
}
export async function runSandbox(config:JsonObject,store:Store,credentials:Credentials,runId:string,fixtureHash:string,fetcher:typeof fetch=fetch){
 validateSandboxFixture(config);if(!/^[A-Za-z0-9_-]{1,80}$/.test(runId))throw Error('Use an explicit stable sandbox run ID for restart recovery.');
 const actor:Actor={tenantId:'sandbox-fixture',userId:'sandbox-operator',role:'admin'},connection={id:'sandbox',tenantId:actor.tenantId,gateway:config.gateway,accounts:[config.account_id],writeAccounts:[config.account_id],enabled:true,label:'Explicit isolated sandbox fixture',scopes:config.gateway==='microsoft_ads_native_action'?['msads.manage']:[],...(config.gateway==='microsoft_ads_native_action'?{accountCustomers:{[config.account_id]:config.customer_id}}:{})};
 let retained=store.documents(actor.tenantId,'sandbox_run').find(r=>r.id===runId);
 if(retained&&retained.fixture_hash!==fixtureHash)throw Error('This run ID belongs to a different fixture; preserve its receipts.');
 store.putConnection(actor,connection,credentials);
 const transport=new NativeTransport(sandboxFetch(fetcher),undefined,30000,8*1024*1024,30,250,2000,'sandbox'),service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const call=async(input:JsonObject)=>{const r=await service.call('amcp_campaign',input,actor);if(!r.success)throw new MirrorError(r.error.code,'Sandbox call failed; inspect the retained local state and original reviews.');return r.data;};
 if(!retained){const created=await call({action:'create',name:'Explicit sandbox contract fixture',brief:'Approved fixture digest '+fixtureHash,steps:config.steps});retained={fixture_hash:fixtureHash,campaign_id:created.id};store.putDocument(actor.tenantId,'sandbox_run',runId,retained);}
 for(let i=0;i<config.steps.length*3+2;i++){
  const prepared=await call({action:'prepare_next',id:retained.campaign_id});
  if(prepared.state==='complete')return {status:'verified',steps:config.steps.length,fixture_sha256:fixtureHash,live_environment:'isolated_sandbox',media_upload_qualified:false};
  if(prepared.blocked||prepared.state==='attention'||prepared.blocked_by)return {status:'blocked_or_inconclusive',fixture_sha256:fixtureHash,recovery:'Resume the same run ID and storage; never reset an uncertain claim or delete the test account.'};
  const next=prepared.next_call;if(next?.tool!=='amcp_campaign'||next.arguments?.action!=='execute_next')return {status:'needs_review',fixture_sha256:fixtureHash};
  const executed=await call({...next.arguments,spend_change_confirmed:true});
  if(executed.state==='complete')return {status:'verified',steps:config.steps.length,fixture_sha256:fixtureHash,live_environment:'isolated_sandbox',media_upload_qualified:false};
  if(executed.state==='attention')return {status:'blocked_or_inconclusive',fixture_sha256:fixtureHash};
 }
 return {status:'inconclusive',fixture_sha256:fixtureHash};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.env.AMCP_LIVE_SANDBOX!=='true')console.log(JSON.stringify({status:'skipped',reason:'Set AMCP_LIVE_SANDBOX=true only for a separately approved isolated sandbox fixture. No credentials or fixture read.'}));
 else{
  const fixture=process.argv[2];if(!fixture)throw Error('Supply a fixture JSON path.');const bytes=fs.readFileSync(fixture),digest=createHash('sha256').update(bytes).digest('hex');
  if(digest!==process.env.AMCP_SANDBOX_FIXTURE_SHA256)throw Error('Fixture digest must match the explicitly approved AMCP_SANDBOX_FIXTURE_SHA256.');
  const config=JSON.parse(bytes.toString('utf8'));validateSandboxFixture(config);
  const runId=process.env.AMCP_SANDBOX_RUN_ID;if(!runId||!/^[A-Za-z0-9_-]{1,80}$/.test(runId))throw Error('Set a stable AMCP_SANDBOX_RUN_ID.');
  const directory=path.resolve('.runtime/sandbox',runId);fs.mkdirSync(directory,{recursive:true});
  const store=new Store(path.join(directory,'state.sqlite'),process.env.AMCP_SANDBOX_STORAGE_KEY??'');
  try{let credentials:Credentials;try{credentials=JSON.parse(process.env.AMCP_SANDBOX_CREDENTIALS_JSON??'{}');}catch{throw Error('Invalid sandbox credential JSON; values are withheld.');}const r=await runSandbox(config,store,credentials,runId,digest);console.log(JSON.stringify(r));if(r.status!=='verified')process.exitCode=1;}finally{store.close();}
 }
}
