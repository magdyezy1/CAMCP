import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {gtmWorkspaceContracts} from '../src/gtm-workspace-writes.js';
import type {Actor,JsonObject} from '../src/types.js';

const actor:Actor={tenantId:'gtm-workspace-test',userId:'owner',role:'admin'},gateway='gtm_native_action',w='accounts/44/containers/55/workspaces/66',container='accounts/44/containers/55',prefix='/tagmanager/v2/';
// These fixture contracts are explicit, not read out of the implementation.
const kinds:Record<string,[string,string,string]>={tag:['tags','tag','tagId'],trigger:['triggers','trigger','triggerId'],variable:['variables','variable','variableId'],folder:['folders','folder','folderId'],customTemplate:['templates','template','templateId'],client:['clients','client','clientId'],transformation:['transformations','transformation','transformationId'],zone:['zones','zone','zoneId'],gtagConfig:['gtag_config','gtagConfig','gtagConfigId'],builtInVariable:['built_in_variables','builtInVariable','type']};
const scope=(s:string)=>'https://www.googleapis.com/auth/tagmanager.'+s;
const nativeRow=(kind:string,id:string,fields:JsonObject={}):JsonObject=>({path:w+'/'+kinds[kind]![0]+'/'+id,accountId:'44',containerId:'55',workspaceId:'66',[kinds[kind]![2]]:id,...fields});
const change=(kind:string,id:string,fields:JsonObject={},status='updated')=>({[kind]:{[kinds[kind]![2]]:id,...fields},changeStatus:status});
function fixture(action:keyof typeof gtmWorkspaceContracts,initialBody?:JsonObject){
 const store=new Store(':memory:',Buffer.alloc(32,84).toString('base64')),calls:JsonObject[]=[],connection={id:'gtm',tenantId:actor.tenantId,gateway,accounts:['44'],writeAccounts:['44'],enabled:true,label:'Synthetic workspace',scopes:[scope('edit.containers'),scope('edit.containerversions')]};
 store.putConnection(actor,connection,{accessToken:'synthetic'});
 const rows:Record<string,JsonObject[]>=Object.fromEntries(Object.keys(kinds).map(k=>[k,[]]));
 rows.tag=[nativeRow('tag','1',{name:'Local tag',type:'html',parameter:[{type:'template',key:'html',value:'<b>reviewed</b>'}],fingerprint:'entity-1'})];
 rows.trigger=[nativeRow('trigger','3',{name:'Trigger',type:'pageview',fingerprint:'trigger-3'})];
 rows.folder=[nativeRow('folder','2',{name:'Previous folder',fingerprint:'folder-2'})];
 rows.variable=[nativeRow('variable','4',{name:'Obsolete variable',type:'c',fingerprint:'variable-4'})];
 rows.builtInVariable=[nativeRow('builtInVariable','pagePath',{name:'Page Path'})];
 const version:JsonObject={path:container+'/versions/9',accountId:'44',containerId:'55',containerVersionId:'9',tag:[{...rows.tag[0],name:'Original tag'}],trigger:structuredClone(rows.trigger),folder:[{...rows.folder[0],name:'Latest folder'}],client:[nativeRow('client','6',{name:'New server client',type:'gaaw_client',fingerprint:'client-6'})],builtInVariable:structuredClone(rows.builtInVariable)};
 const status:JsonObject={workspaceChange:[{tag:structuredClone(rows.tag[0]),changeStatus:'updated'}],mergeConflict:[]};
 if(action==='RESOLVE_WORKSPACE_CONFLICT')status.mergeConflict=[{entityInWorkspace:structuredClone(status.workspaceChange[0]),entityInBaseVersion:{tag:structuredClone(version.tag[0]),changeStatus:'updated'}}];
 const defaultBody=action==='BULK_UPDATE_WORKSPACE'?{changes:[change('folder','new_1',{name:'New folder'},'added'),change('tag','new_2',{name:'New tag',type:'html',parentFolderId:'new_1',firingTriggerId:['3'],parameter:[{type:'template',key:'html',value:'<i>new</i>'}]},'added'),change('tag','1',{name:'Updated local tag',type:'html',parameter:[]}),change('variable','4',{},'deleted')]}:action==='RESOLVE_WORKSPACE_CONFLICT'?change('tag','1',{name:'Resolved tag',type:'html',parameter:[]}):{};
 let body=initialBody??defaultBody,writes=0,reads=0,mode='',ignore=false,lost=false,revoked=false,statusReads=0;
 const mergedRows=()=>{
  const result=Object.fromEntries(Object.keys(kinds).map(k=>[k,structuredClone(version[k]??[]) as JsonObject[]]));
  for(const entity of status.workspaceChange){const kind=Object.keys(entity).find(k=>k!=='changeStatus')!,id=entity[kind][kinds[kind]![2]];result[kind]=result[kind]!.filter(r=>r[kinds[kind]![2]]!==id);if(entity.changeStatus!=='deleted')result[kind]!.push(structuredClone(entity[kind]));}return result;
 };
 const sync=()=>{const updated=mergedRows();if(!ignore)for(const kind of Object.keys(kinds))rows[kind]=updated[kind]!;return updated;};
 const transport=new NativeTransport(async(input,init)=>{
  const url=new URL(String(input)),path=url.pathname.slice(prefix.length),method=init!.method!,payload=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,payload,query:Object.fromEntries(url.searchParams)});
  if(method==='GET'){
   reads++;if(revoked)store.putConnection(actor,{...connection,enabled:false,writeAccounts:[]},{accessToken:'synthetic'});
   if(mode==='denied')return Response.json({error:{code:403}},{status:403});
   if(path===w)return Response.json({path:w,accountId:'44',containerId:'55',workspaceId:'66',name:'Draft',fingerprint:'workspace-not-the-entity',requestId:'read-'+reads});
   if(path===w+'/status'){statusReads++;const result=structuredClone(status);if(mode==='changing-status'&&statusReads%2===0)result.workspaceChange[0].tag.name='Concurrent edit';return Response.json({...result,requestId:'read-'+reads});}
   if(path===container+'/version_headers:latest'){if(mode==='no-version')return Response.json({error:{code:404}},{status:404});return Response.json({path:version.path,accountId:'44',containerId:'55',containerVersionId:version.containerVersionId});}
   if(path===container+'/versions/9')return Response.json(version);
   const entry=Object.entries(kinds).find(([,v])=>path===w+'/'+v[0]);
   if(!entry)return Response.json({error:{code:404}},{status:404});
   const [kind,model]=entry,offset=Number(url.searchParams.get('pageToken')??'0');
   if(mode==='page-error'&&offset)return Response.json({error:{code:503}},{status:503});
   const slice=structuredClone(rows[kind]!.slice(offset,offset+1));
   if(mode==='foreign'&&slice[0])slice[0].path=slice[0].path.replace('accounts/44','accounts/999');
   if(mode==='duplicate-page'&&offset)slice[0]=structuredClone(rows[kind]![0]!);
   return Response.json({...(slice.length?{[model[1]]:slice}:{}),...(mode==='cursor-cycle'&&slice.length?{nextPageToken:'1'}:offset+1<rows[kind]!.length?{nextPageToken:String(offset+1)}:{})});
  }
  writes++;let response:JsonObject={};
  if(action==='BULK_UPDATE_WORKSPACE'){
   const ids=new Map<string,string>();let next=90;
   for(const edit of payload.changes){const key=Object.keys(edit).find(k=>k!=='changeStatus')!,id=edit[key][kinds[key]![2]];if(id.startsWith('new_'))ids.set(id,String(++next));}
   const remap=(v:any):any=>Array.isArray(v)?v.map(remap):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x)])):ids.get(v)??v;
   const results:JsonObject[]=[];
   for(const edit of payload.changes){const kind=Object.keys(edit).find(k=>k!=='changeStatus')!,fields=remap(edit[kind]),id=fields[kinds[kind]![2]],row=nativeRow(kind,id,{...fields,...(kind==='builtInVariable'?{}:{fingerprint:'stored-'+id})});
    const previous=rows[kind]!.find(r=>r[kinds[kind]![2]]===id);
    if(!ignore){rows[kind]=rows[kind]!.filter(r=>r[kinds[kind]![2]]!==id);if(edit.changeStatus!=='deleted')rows[kind]!.push(mode==='ignore-clearing'&&previous?{...row,parameter:previous.parameter}:row);}
    if(edit.changeStatus!=='deleted')results.push({[kind]:row,changeStatus:edit.changeStatus});
   }
   response={changes:results.toReversed()};
   if(mode==='missing-receipt')response.changes.pop();
   if(mode==='duplicate-receipt')response.changes[1]=structuredClone(response.changes[0]);
   if(mode==='foreign-receipt'){const first=response.changes[0],key=Object.keys(first).find(k=>k!=='changeStatus')!;first[key].path=first[key].path.replace('accounts/44','accounts/999');}
   if(mode==='reused-id'){const created=response.changes.find((r:JsonObject)=>r.tag?.name==='New tag');created.tag=nativeRow('tag','1',{...created.tag,tagId:'1',path:w+'/tags/1'});}
  }else if(action==='RESOLVE_WORKSPACE_CONFLICT'){
   const kind=Object.keys(payload).find(k=>k!=='changeStatus')!,id=payload[kind][kinds[kind]![2]];
   if(!ignore){rows[kind]=rows[kind]!.filter(r=>r[kinds[kind]![2]]!==id);if(payload.changeStatus!=='deleted')rows[kind]!.push(nativeRow(kind,id,{...payload[kind],fingerprint:'resolved'}));status.mergeConflict=status.mergeConflict.filter((c:JsonObject)=>c.entityInWorkspace[kind]?.[kinds[kind]![2]]!==id);}
  }else{
   const updated=sync();response={syncStatus:{syncError:false,mergeConflict:false}};
   if(action==='QUICK_PREVIEW')response.containerVersion={path:container+'/versions/0',accountId:'44',containerId:'55',containerVersionId:'0',...updated};
   if(mode==='conflict'){status.mergeConflict=[{entityInWorkspace:structuredClone(status.workspaceChange[0]),entityInBaseVersion:{tag:structuredClone(version.tag[0]),changeStatus:'updated'}}];response={syncStatus:{mergeConflict:true},mergeConflict:structuredClone(status.mergeConflict)};}
   if(mode==='compiler-error')response.compilerError=true;
   if(mode==='missing-preview-entity')response.containerVersion.tag=[];
   if(mode==='foreign-preview')response.containerVersion.accountId='999';
  }
  if(lost)throw Error('Synthetic accepted request with lost response');return Response.json(response);
 },async()=>{},30000,8*1024*1024,10000,1);
 const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const args=(extra:JsonObject={})=>({operation:'gtm_ops',arguments:{action,account_id:'44',path:w,payload:body,...extra}});
 const prepare=(extra:JsonObject={},who=actor)=>service.call('amcp_write',{action:'prepare',gateway,arguments:args(extra)},who);
 const execute=(p:JsonObject)=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);
 const verify=(p:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,service,connection,calls,rows,version,status,args,prepare,execute,verify,writes:()=>writes,mode:(v:string)=>{mode=v;},ignore:()=>{ignore=true;},lose:()=>{lost=true;},revoke:()=>{revoked=true;}};
}

for(const action of ['BULK_UPDATE_WORKSPACE','SYNC_WORKSPACE','QUICK_PREVIEW','RESOLVE_WORKSPACE_CONFLICT'] as const)test('complete Tag Manager workspace lifecycle: '+action,async()=>{
 const f=fixture(action);try{
  const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.ok(f.calls.every(c=>c.method==='GET'));
  if(action==='RESOLVE_WORKSPACE_CONFLICT')assert.equal(p.data.request.query.fingerprint,'entity-1','use conflicted entity, not workspace fingerprint');
  const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));const v=await f.verify(p);assert.equal(v.data.status,'verified',JSON.stringify(v));
  if(action==='QUICK_PREVIEW'){assert.equal(e.data.published,false);assert.ok(!f.calls.some(c=>c.method==='GET'&&c.path.endsWith('/versions/0')));}
  const count=f.calls.length;assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.calls.length,count);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});
test('all four workspace routes have matching pinned native methods, models and scopes',()=>{
 const compiler=new DelegatedNativeCompiler(),methods=JSON.parse(fs.readFileSync('.mirror/VENDOR/gtm-v2.json','utf8')).document.resources.accounts.resources.containers.resources.workspaces.methods;
 for(const [action,c]of Object.entries(gtmWorkspaceContracts)){const route=compiler.data.routes.find(r=>r.gateway===gateway&&r.action===action)!;const method=Object.values(methods).find((m:any)=>m.id===route.vendorMethod) as JsonObject;assert.equal(method.httpMethod,'POST');assert.ok(method.scopes.includes(scope(c.scope)));assert.equal(method.path,'tagmanager/v2/{+path}'+c.suffix);}
 assert.equal(methods.bulk_update.request.$ref,'ProposedChange');assert.equal(methods.resolve_conflict.request.$ref,'Entity');
});
test('bulk create supports each documented Entity kind and reconciles unordered native receipts',async()=>{
 const definitions:Record<string,JsonObject>={tag:{name:'Tag',type:'html'},trigger:{name:'Trigger',type:'pageview'},variable:{name:'Variable',type:'c'},folder:{name:'Folder'},customTemplate:{name:'Template',templateData:'Synthetic template'},client:{name:'Client',type:'gaaw_client'},transformation:{name:'Transform',type:'allow'},zone:{name:'Zone',childContainer:[]},gtagConfig:{type:'gtag'},builtInVariable:{type:'clickId',name:'Click ID'}};
 for(const [kind,fields]of Object.entries(definitions)){const f=fixture('BULK_UPDATE_WORKSPACE',{changes:[change(kind,kind==='builtInVariable'?'clickId':'new_8',fields,'added')]});try{const p=await f.prepare();assert.equal(p.success,true,kind+' '+JSON.stringify(p));assert.equal((await f.execute(p)).success,true,kind);assert.equal((await f.verify(p)).data.status,'verified',kind);}finally{f.store.close();}}
});
test('complete collection reads reject failures, foreign or duplicated entities and repeated cursors',async()=>{
 for(const mode of ['foreign','duplicate-page','page-error','cursor-cycle','changing-status']){const f=fixture('BULK_UPDATE_WORKSPACE');try{f.rows.tag!.push(nativeRow('tag','8',{name:'Extra',type:'html'}));f.mode(mode);assert.equal((await f.prepare()).success,false,mode);assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('exact-body validation rejects unknown fields, ambiguous creates, invalid references and foreign scope before egress',async()=>{
 const invalid=[{changes:[]},{changes:[change('tag','new_1',{name:'A',type:'html',madeUp:true},'added')]},{changes:[change('tag','new_1',{name:'A',type:'html',parentFolderId:'new_9'},'added')]},{changes:[change('tag','new_1',{name:'A',type:'html'},'added'),change('tag','new_2',{name:'A',type:'html'},'added')]},{changes:[change('tag','1',{path:'accounts/999/containers/55/workspaces/66/tags/1',name:'Foreign',type:'html'})]},{changes:[{...change('tag','1',{name:'One',type:'html'}),folder:{folderId:'2',name:'Two'}}]},{changes:[change('tag','1',{name:'Deletion must not edit',type:'html'},'deleted')]},{changes:[change('tag','new_1',{name:'A',type:'html',parameter:[{key:'html',type:'template',value:'new_1'}]},'added')]}];
 for(const body of invalid){const f=fixture('BULK_UPDATE_WORKSPACE',body);try{assert.equal((await f.prepare()).success,false,JSON.stringify(body));assert.equal(f.calls.length,0);}finally{f.store.close();}}
});
test('state changes keep meaningful entity and latest-version conflicts while telemetry and entity order are stable',async()=>{
 for(const action of ['BULK_UPDATE_WORKSPACE','SYNC_WORKSPACE'] as const){const f=fixture(action);try{f.rows.tag!.push(nativeRow('tag','8',{name:'Extra',type:'html'}));const p=await f.prepare();assert.equal(p.success,true);f.rows.tag!.reverse();if(action==='SYNC_WORKSPACE')f.version.name='Version renamed';else f.rows.tag![0]!.name='Edited';const e=await f.execute(p);assert.equal(e.error.code,'STATE_CHANGED',JSON.stringify(e));assert.equal(f.writes(),0);}finally{f.store.close();}}
 const f=fixture('BULK_UPDATE_WORKSPACE');try{f.rows.tag!.push(nativeRow('tag','8',{name:'Extra',type:'html'}));const p=await f.prepare();f.rows.tag!.reverse();assert.equal((await f.execute(p)).success,true);}finally{f.store.close();}
});
test('changed, revoked and insufficient grants or native scopes fail before a mutation',async()=>{
 for(const flag of ['scope','revoke-read','revoke-after-review']){const f=fixture('QUICK_PREVIEW');try{
  if(flag==='scope'){f.store.putConnection(actor,{...f.connection,scopes:[scope('edit.containers')]},{accessToken:'synthetic'});assert.equal((await f.prepare()).error.code,'PROVIDER_WRITE_SCOPE_REQUIRED');assert.equal(f.calls.length,0);}
  if(flag==='revoke-read'){f.revoke();assert.equal((await f.prepare()).success,false);assert.equal(f.calls.length,1);}
  if(flag==='revoke-after-review'){const p=await f.prepare();f.store.putConnection(actor,{...f.connection,writeAccounts:[]},{accessToken:'synthetic'});assert.equal((await f.execute(p)).success,false);}
  assert.equal(f.writes(),0);
 }finally{f.store.close();}}
});
test('bulk deletes, sync, preview and deleted conflict resolutions enforce owner deletion policy',async()=>{
 for(const action of Object.keys(gtmWorkspaceContracts) as (keyof typeof gtmWorkspaceContracts)[]){const f=fixture(action,action==='RESOLVE_WORKSPACE_CONFLICT'?change('tag','1',{},'deleted'):undefined);try{saveSpendPolicy(f.store,actor,{gateway,account_id:'44',confirmed:true,policy:{allow_deletion:false}});assert.equal((await f.prepare()).error.code,'POLICY_DELETION_FORBIDDEN');assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('bulk receipts cannot omit, duplicate, reuse existing create IDs or substitute foreign entities',async()=>{
 for(const mode of ['missing-receipt','duplicate-receipt','foreign-receipt','reused-id']){const f=fixture('BULK_UPDATE_WORKSPACE');try{const p=await f.prepare();f.mode(mode);const e=await f.execute(p);assert.equal(e.success,false,mode+' '+JSON.stringify(e));assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);}finally{f.store.close();}}
});
test('read-back detects ignored mutations, including deletion-only and conflict resolution',async()=>{
 for(const action of Object.keys(gtmWorkspaceContracts) as (keyof typeof gtmWorkspaceContracts)[]){const f=fixture(action);try{const p=await f.prepare();f.ignore();assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'inconclusive',action);}finally{f.store.close();}}
 const f=fixture('BULK_UPDATE_WORKSPACE',{changes:[change('variable','4',{},'deleted')]});try{const p=await f.prepare();assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');}finally{f.store.close();}
});
test('sync conflicts retain applied state and explicit recovery instead of success or mutation replay',async()=>{
 const f=fixture('SYNC_WORKSPACE');try{const p=await f.prepare();f.mode('conflict');const e=await f.execute(p);assert.equal(e.success,false);assert.equal(e.data.provider_effect,'synchronization_returned_conflicts');assert.equal(e.data.retry_safe,false);assert.equal(f.rows.folder![0]!.name,'Latest folder');assert.equal((await f.execute(p)).data.replayed,true);assert.equal((await f.verify(p)).error.code,'WRITE_PARTIAL_OR_FAILED');assert.equal(f.writes(),1);}finally{f.store.close();}
});
test('preview rejects compiler errors, foreign versions and incomplete temporary version content',async()=>{
 for(const mode of ['compiler-error','foreign-preview','missing-preview-entity']){const f=fixture('QUICK_PREVIEW');try{const p=await f.prepare();f.mode(mode);assert.equal((await f.execute(p)).success,false,mode);assert.equal(f.writes(),1);}finally{f.store.close();}}
});
test('conflict resolution selects the exact entity and preserves other conflicts',async()=>{
 const f=fixture('RESOLVE_WORKSPACE_CONFLICT');try{
  f.status.mergeConflict.push({entityInWorkspace:{folder:structuredClone(f.rows.folder![0]),changeStatus:'updated'}});
  assert.equal((await f.prepare({params:{fingerprint:'workspace-not-the-entity'}})).error.code,'STATE_CHANGED');
  const p=await f.prepare();assert.equal((await f.execute(p)).success,true);assert.equal((await f.verify(p)).data.status,'verified');assert.equal(f.status.mergeConflict.length,1);
 }finally{f.store.close();}
 const removed=fixture('RESOLVE_WORKSPACE_CONFLICT',change('tag','1',{name:'Restored',type:'html'}));try{removed.status.mergeConflict[0].entityInWorkspace.changeStatus='deleted';removed.rows.tag=[];const p=await removed.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal((await removed.execute(p)).success,true);assert.equal((await removed.verify(p)).data.status,'verified');}finally{removed.store.close();}
});
test('absent latest version is qualified only by 404, while an existing conflict blocks sync or preview',async()=>{
 const f=fixture('SYNC_WORKSPACE');try{f.mode('no-version');const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal(p.data.before_state[0].latestVersionId,null);}finally{f.store.close();}
 const g=fixture('QUICK_PREVIEW');try{g.mode('denied');assert.equal((await g.prepare()).success,false);assert.equal(g.writes(),0);}finally{g.store.close();}
 const h=fixture('SYNC_WORKSPACE');try{h.status.mergeConflict=[{entityInWorkspace:structuredClone(h.status.workspaceChange[0])}];assert.equal((await h.prepare()).error.code,'STATE_CONFLICT');}finally{h.store.close();}
});
test('concurrency and lost responses keep one durable mutation claim',async()=>{
 const f=fixture('BULK_UPDATE_WORKSPACE');try{const p=await f.prepare();const results=await Promise.all([f.execute(p),f.execute(p)]);assert.ok(results.some(r=>r.success));assert.equal(f.writes(),1);}finally{f.store.close();}
 const g=fixture('SYNC_WORKSPACE');try{const p=await g.prepare();g.lose();assert.equal((await g.execute(p)).success,false);assert.equal((await g.execute(p)).error.code,'WRITE_OUTCOME_UNCERTAIN');assert.equal(g.writes(),1);}finally{g.store.close();}
});
test('replacements preserve explicit fields and verify clearing even when the provider omits empty arrays',async()=>{
 const missing=fixture('BULK_UPDATE_WORKSPACE',{changes:[change('tag','1',{name:'Sparse',type:'html'})]});try{assert.equal((await missing.prepare()).error.code,'INCOMPLETE_GTM_REPLACEMENT');assert.equal(missing.writes(),0);}finally{missing.store.close();}
 for(const mode of ['omit-default','ignore-clearing']){const f=fixture('BULK_UPDATE_WORKSPACE',{changes:[change('tag','1',{name:'Cleared',type:'html',parameter:[]})]});try{const p=await f.prepare();if(mode==='ignore-clearing')f.mode(mode);assert.equal((await f.execute(p)).success,true);if(mode==='omit-default')delete f.rows.tag![0]!.parameter;assert.equal((await f.verify(p)).data.status,mode==='omit-default'?'verified':'inconclusive');}finally{f.store.close();}}
});
test('trigger membership is unordered while parameter sequences retain order in the frozen state',async()=>{
 for(const ordered of [false,true]){const f=fixture('SYNC_WORKSPACE');try{f.rows.tag![0]!.firingTriggerId=['3','9'];f.rows.tag![0]!.parameter=[{type:'template',key:'first',value:'A'},{type:'template',key:'second',value:'B'}];f.status.workspaceChange[0].tag=structuredClone(f.rows.tag![0]);const p=await f.prepare();assert.equal(p.success,true);f.rows.tag![0]![ordered?'parameter':'firingTriggerId'].reverse();f.status.workspaceChange[0].tag=structuredClone(f.rows.tag![0]);const e=await f.execute(p);assert.equal(e.success,!ordered,JSON.stringify(e));if(ordered)assert.equal(e.error.code,'STATE_CHANGED');}finally{f.store.close();}}
});
test('workspace state has a byte bound in addition to entity and page limits',async()=>{
 const f=fixture('BULK_UPDATE_WORKSPACE');try{f.rows.variable=Array.from({length:18},(_,i)=>nativeRow('variable',String(100+i),{name:'Synthetic '+i,type:'c',notes:'x'.repeat(600000)}));const p=await f.prepare();assert.equal(p.error.code,'STATE_TOO_LARGE',JSON.stringify(p).slice(0,300));assert.equal(f.writes(),0);}finally{f.store.close();}
});
