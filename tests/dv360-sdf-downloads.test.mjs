import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * SDF download tasks on Display & Video 360 API v4 (pinned Discovery document, checked 2026-09-27).
 */
const gateway='dv360_native_action',registry=new Registry(),action='DV360_SDFDOWNLOADTASKS_CREATE';
const actor={tenantId:'dv360-sdf',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const error=(status,code,message)=>Response.json({error:{code:status,status:code,message}},{status});
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,72).toString('base64')),calls=[];
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'synthetic'});
 const operations=new Map([['sdfdownloadtasks/operations/other',{done:true,response:{resourceName:'download/sdfdownloadtasks/media/9'}}]]);let writes=0,next=1;
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method;calls.push({path,method});
  if(u.searchParams.has('partnerId'))return error(400,'INVALID_ARGUMENT','Unexpected partner access.');
  if(method==='GET'&&path==='/v4/advertisers/123')return Response.json({name:'advertisers/123',advertiserId:'123',partnerId:'1',entityStatus:'ENTITY_STATUS_ACTIVE'});
  let m=/^\/v4\/(sdfdownloadtasks\/operations\/[\w-]+)$/.exec(path);
  if(method==='GET'&&m){const o=operations.get(m[1]);return o?Response.json({name:m[1],metadata:{},...o}):error(404,'NOT_FOUND','Not found.');}
  m=/^\/download\/(download\/sdfdownloadtasks\/media\/\d+)$/.exec(path);
  // Metadata of the prepared files; how their bytes are transferred is outside this family.
  if(method==='GET'&&m)return Response.json({resourceName:m[1]});
  if(method==='POST'&&path==='/v4/sdfdownloadtasks'){writes++;const name='sdfdownloadtasks/operations/op'+next++;if(mode==='error')return Response.json({name,done:true,error:{code:3,message:'Invalid filter'}});if(mode!=='ignore')operations.set(name,{done:false});return Response.json({name,done:false,metadata:{}});}
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=body=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,params:{},body:{advertiserId:'123',version:'SDF_VERSION_9',...body}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 const operation=name=>service.call(gateway,{action:'DV360_SDFDOWNLOADTASKS_OPERATIONS_GET',params:{name}},actor);
 return {store,calls,operations,service,prepare,execute,verify,operation,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const lines={parentEntityFilter:{fileType:['FILE_TYPE_LINE_ITEM','FILE_TYPE_AD_GROUP'],filterType:'FILTER_TYPE_ADVERTISER_ID',filterIds:['123']}};

test('an SDF download task starts without spending confirmation and verifies once done; its operation and files are then readable',async()=>{
 const f=fixture();try{
  const p=ok(await f.prepare(lines));assert.equal(p.data.creative_impact.scope,'sdf_download_task');assert.equal(p.data.creative_impact.may_affect_serving,false);
  assert.equal((await f.operation('sdfdownloadtasks/operations/other')).success,false);
  ok(await f.execute(p));assert.equal(f.writes(),1);assert.notEqual(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  f.operations.set('sdfdownloadtasks/operations/op1',{done:true,response:{resourceName:'download/sdfdownloadtasks/media/7'}});
  assert.equal(ok(await f.verify(p)).data.status,'verified');
  ok(await f.operation('sdfdownloadtasks/operations/op1'));
  ok(await f.service.call(gateway,{action:'DV360_MEDIA_DOWNLOAD',params:{resourceName:'download/sdfdownloadtasks/media/7'}},actor));
  assert.equal((await f.service.call(gateway,{action:'DV360_MEDIA_DOWNLOAD',params:{resourceName:'download/sdfdownloadtasks/media/9'}},actor)).success,false);
  const ids=ok(await f.prepare({idFilter:{lineItemIds:['501','502']}}));ok(await f.execute(ids));f.operations.set('sdfdownloadtasks/operations/op2',{done:true,response:{resourceName:'download/sdfdownloadtasks/media/8'}});assert.equal(ok(await f.verify(ids)).data.status,'verified');
 }finally{f.store.close();}
});

test('malformed tasks are refused before any request',async()=>{
 const cases=[
  ['partner',{partnerId:'1',...lines}],
  ['other advertiser',{advertiserId:'999',...lines}],
  ['no filter',{}],
  ['two filters',{...lines,idFilter:{lineItemIds:['501']}}],
  ['unknown file type',{parentEntityFilter:{fileType:['FILE_TYPE_CREATIVE'],filterType:'FILTER_TYPE_NONE'}}],
  ['ids without filter ids',{parentEntityFilter:{fileType:['FILE_TYPE_LINE_ITEM'],filterType:'FILTER_TYPE_CAMPAIGN_ID'}}],
  ['another advertiser filter',{parentEntityFilter:{fileType:['FILE_TYPE_LINE_ITEM'],filterType:'FILTER_TYPE_ADVERTISER_ID',filterIds:['999']}}],
  ['empty id filter',{idFilter:{lineItemIds:[]}}],
  ['version',{version:'LATEST',...lines}]
 ];
 for(const [label,body] of cases){const f=fixture();try{const r=await f.prepare(body);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label+': '+JSON.stringify(r).slice(0,300));}finally{f.store.close();}}
});

test('a failed operation is a failure never resubmitted, an ignored task is not verified, the models match and the ledger lists the write',async()=>{
 const f=fixture('error');try{const p=ok(await f.prepare(lines));assert.equal((await f.execute(p)).success,false);assert.equal((await f.execute(p)).success,false);assert.equal(f.writes(),1);}finally{f.store.close();}
 const g=fixture('ignore');try{const p=ok(await g.prepare(lines));ok(await g.execute(p));assert.notEqual(ok(await g.verify(p)).data.status,'verified');}finally{g.store.close();}
 const d=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')),doc=d.document??d,S=doc.schemas;
 assert.deepEqual(Object.keys(S.CreateSdfDownloadTaskRequest.properties).sort(),['advertiserId','idFilter','inventorySourceFilter','parentEntityFilter','partnerId','version']);
 assert.match(doc.resources.sdfdownloadtasks.methods.create.description,/must be retrieved with media.download/);
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1);assert.equal(rows[0].status,'reviewed_write_family');assert.equal(rows[0].family,'dv360_sdf_downloads');
});
