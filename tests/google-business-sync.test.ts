import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {businessScope,collectBusinessAssets} from '../src/google-business-assets.js';
import type {Actor,Connection,JsonObject} from '../src/types.js';
import {actionContracts} from '../src/action-contracts.js';
import {effectiveProviderContract} from '../src/provider-contracts.js';
import {MirrorError} from '../src/errors.js';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {removeTestDirectory} from './temp.js';

const registry=new Registry(),gateway='google_business_native_action',key=Buffer.alloc(32,83).toString('base64'),owner:Actor={tenantId:'business-sync',userId:'owner',role:'admin'},id='336ecb51-2df8-4967-8bd3-cba64d552296';
function fixture(file=':memory:'){const store=new Store(file,key),connection:Connection={id,tenantId:owner.tenantId,gateway,label:'Synthetic business',enabled:true,accounts:['123','locations/456'],writeAccounts:['locations/456'],scopes:[businessScope]};store.putConnection(owner,connection,{accessToken:'synthetic-business-token'});const calls:URL[]=[];let hook:((url:URL)=>Response|Promise<Response>)|undefined;
 const fetcher:typeof fetch=async(u)=>{const url=new URL(String(u));calls.push(url);if(hook)return hook(url);if(url.pathname==='/v1/accounts')return Response.json({accounts:[{name:'accounts/123',accountName:'Client group',type:'LOCATION_GROUP',role:'OWNER'},{name:'accounts/789',accountName:'Organization',type:'ORGANIZATION',role:'MANAGER'}]});return Response.json({locations:[{name:'locations/456',title:'Main branch',storeCode:'BR1'}]});};
 const service=new MirrorService(registry,store,new NativeTransport(fetcher,async()=>{}));return {store,connection,service,calls,hook:(h:typeof hook)=>hook=h,call:(input:JsonObject={},actor=owner)=>service.call(gateway,{operation:'gmb_connection_ops',arguments:{action:'sync_assets',connection_id:id,...input}},actor)};
}

test('Business Profile sync previews the selected identity without credentials, egress or grant changes',async()=>{
 const f=fixture();try{const spy=mock.method(f.store,'credentials',()=>{throw Error('Preview must not decrypt credentials');});const r=await f.call();assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.dry_run,true);assert.equal(r.data.effective_read_mask,'name,title,storeCode');assert.equal(f.calls.length,0);assert.equal(spy.mock.callCount(),0);}finally{f.store.close();}
});

test('Business Profile sync preserves numeric account and prefixed location grants and merges shared parents',async()=>{
 const f=fixture();try{const r=await f.call({dry_run:false});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.complete,true);assert.equal(r.data.accounts[0].id,'123');assert.equal(r.data.locations[0].id,'locations/456');assert.deepEqual(r.data.locations[0].parentIds,['123','789']);assert.equal(r.data.shared_location_memberships,1);assert.equal(f.calls.length,3);assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.accounts,f.connection.accounts);assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.writeAccounts,f.connection.writeAccounts);assert.equal(f.store.document(owner.tenantId,'website_assets',id).groups.length,2);}finally{f.store.close();}
});

test('account-only sync does not fetch locations or describe old location metadata as refreshed',async()=>{
 const f=fixture();try{const r=await f.call({dry_run:false,include_locations:false,max_locations_per_account:0});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.locations_included,false);assert.equal(f.calls.length,1);assert.equal(f.store.document(owner.tenantId,'website_assets',id).groups.length,1);}finally{f.store.close();}
});

test('account-only sync preserves existing location timestamps and marks selected locations unchecked',async()=>{
 const f=fixture();try{const old={kind:'locations',assets:[{id:'locations/456',name:'Old'}],complete:true,checkedAt:1};f.store.putDocument(owner.tenantId,'website_assets',id,{groups:[old],selected:['locations:locations/456']});const r=await f.call({dry_run:false,include_locations:false});assert.equal(r.success,true);const saved=f.store.document(owner.tenantId,'website_assets',id);assert.deepEqual(saved.groups.find((g:any)=>g.kind==='locations'),old);assert.deepEqual(saved.selected,['locations:locations/456']);assert.deepEqual(r.data.unchecked_selected_ids,['locations/456']);assert.deepEqual(r.data.missing_selected_ids,[]);}finally{f.store.close();}
});

test('administrator, tenant, exact login and scope checks stop unauthorized discovery before egress',async()=>{
 const f=fixture();try{for(const role of ['operator','reader'] as const)assert.equal((await f.call({dry_run:false},{...owner,role})).error?.code,'FORBIDDEN');assert.equal((await f.call({dry_run:false},{...owner,tenantId:'other'})).error?.code,'CONNECTION_NOT_FOUND');assert.equal((await f.call({dry_run:false,connection_id:'b9a767a2-e9a5-4863-9806-05a459367597'})).error?.code,'CONNECTION_NOT_FOUND');f.store.putConnection(owner,{...f.connection,scopes:[]},{accessToken:'synthetic'});assert.equal((await f.call({dry_run:false})).error?.code,'INSUFFICIENT_SCOPE');assert.equal(f.calls.length,0);}finally{f.store.close();}
});

test('multiple identities require the exact UUID or unique enabled default; disabled provisioned identities can be discovered',async()=>{
 const f=fixture();try{f.store.putConnection(owner,{...f.connection,id:'b9a767a2-e9a5-4863-9806-05a459367597'},{accessToken:'other'});assert.equal((await f.call({connection_id:undefined})).error?.code,'AMBIGUOUS_CONNECTION');f.store.putConnection(owner,{...f.connection,isDefault:true},{accessToken:'synthetic-business-token'});assert.equal((await f.call({connection_id:undefined})).data?.connection_id,id);f.store.putConnection(owner,{...f.connection,enabled:false},{accessToken:'synthetic-business-token'});const r=await f.call({dry_run:false});assert.equal(r.success,true);assert.equal(f.store.listConnections(owner.tenantId).find(c=>c.id===id)!.enabled,false);}finally{f.store.close();}
});

test('unsafe read masks, OAuth inputs and invalid bounds cannot dispatch discovery',async()=>{
 const f=fixture();try{for(const extra of [{read_mask:'*'},{read_mask:'name,metadata'},{read_mask:'name,name'},{read_mask:''},{code:'private-code'},{state:'private-state'},{redirect_uri:'https://evil.invalid/'},{max_accounts:0},{max_accounts:501},{max_locations_per_account:0},{max_locations_per_account:501},{include_locations:'yes'}]){const r=await f.call({dry_run:false,...extra});assert.equal(r.success,false,JSON.stringify(extra));}assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.store.audit(owner.tenantId)).includes('private-code'),false);}finally{f.store.close();}
});

test('native pages use separate fixed origins, required fields and opaque encoded cursors',async()=>{
 const seen:any[]=[];const result=await collectBusinessAssets(async p=>{seen.push(p);if(p.path==='/v1/accounts')return p.query.pageToken?{accounts:[{name:'accounts/789'}]}:{accounts:[{name:'accounts/123',accountName:'<script>provider data</script>'}],nextPageToken:'page+two/='};if(p.path.includes('123'))return p.query.pageToken?{locations:[{name:'locations/457',title:'Second'}]}:{locations:[{name:'locations/456',title:'First',storeCode:''}],nextPageToken:'location+two/='};return {};},{readMask:'storeCode'});
 assert.equal(seen.length,5);assert.ok(seen.every(p=>p.method==='GET'&&p.readOnly));assert.equal(seen[0].origin,'https://mybusinessaccountmanagement.googleapis.com');assert.equal(seen[0].query.pageSize,20);assert.equal(seen[1].query.pageToken,'page+two/=');assert.equal(seen[2].origin,'https://mybusinessbusinessinformation.googleapis.com');assert.equal(seen[2].query.readMask,'name,title,storeCode');assert.equal(seen[2].query.pageSize,100);assert.equal(seen[3].query.pageToken,'location+two/=');assert.equal(result.locations[0]!.storeCode,undefined);assert.equal(result.locations.length,2);
});

test('documented empty collections remain empty without deleting selected grants',async()=>{
 const f=fixture();try{f.hook(()=>Response.json({}));const r=await f.call({dry_run:false});assert.equal(r.success,true);assert.deepEqual(r.data.accounts,[]);assert.deepEqual(r.data.locations,[]);assert.deepEqual(r.data.missing_selected_ids,f.connection.accounts);assert.deepEqual(f.store.listConnections(owner.tenantId)[0]!.accounts,f.connection.accounts);}finally{f.store.close();}
});

test('unknown, malformed, repeated and foreign resource records cannot become complete discovery',async()=>{
 for(const body of [{accounts:null},{accounts:'invalid'},{unexpected:true},{error:{code:403}},{accounts:[],paging:{}},{accounts:[{name:'accounts/../secret'}]},{accounts:[{name:'accounts/123',type:'FUTURE'}]},{accounts:[{name:'accounts/123'},{name:'accounts/123'}]},{accounts:[],nextPageToken:12}])await assert.rejects(collectBusinessAssets(async()=>body),{code:'ASSET_RESPONSE_INVALID'});
 for(const body of [{locations:null},{locations:[{name:'accounts/456',title:'Wrong'}]},{locations:[{name:'locations/456'}]},{locations:[{name:'locations/456',title:'x',storeCode:1}]},{locations:[{name:'locations/456',title:'x'},{name:'locations/456',title:'x'}]}])await assert.rejects(collectBusinessAssets(async p=>p.path==='/v1/accounts'?{accounts:[{name:'accounts/123'}]}:body),{code:'ASSET_RESPONSE_INVALID'});
 let calls=0;await assert.rejects(collectBusinessAssets(async()=>{calls++;return {accounts:[],nextPageToken:'same'};}),{code:'ASSET_RESPONSE_INVALID'});assert.equal(calls,2);
});

test('conflicting shared-location metadata fails instead of arbitrarily selecting a parent response',async()=>{
 await assert.rejects(collectBusinessAssets(async p=>p.path==='/v1/accounts'?{accounts:[{name:'accounts/123'},{name:'accounts/789'}]}:{locations:[{name:'locations/456',title:p.path.includes('123')?'Old':'New'}]}),{code:'ASSET_RESPONSE_INVALID'});
});

test('account and location bounds retain the previous complete snapshot and report failure',async()=>{
 for(const extra of [{max_accounts:1},{max_locations_per_account:1}]){const f=fixture();try{const groups=[{kind:'business_accounts',assets:[{id:'old'}],complete:true,checkedAt:1},{kind:'locations',assets:[{id:'locations/old'}],complete:true,checkedAt:1}];f.store.putDocument(owner.tenantId,'website_assets',id,{groups,lastSync:1});if(extra.max_locations_per_account)f.hook(u=>Response.json(u.pathname==='/v1/accounts'?{accounts:[{name:'accounts/123'}]}:{locations:[{name:'locations/456',title:'One'},{name:'locations/457',title:'Two'}]}));const r=await f.call({dry_run:false,...extra});assert.equal(r.error?.code,'ASSET_SYNC_LIMIT');const saved=f.store.document(owner.tenantId,'website_assets',id);assert.ok(saved.groups.every((g:any)=>!g.complete&&g.checkedAt===1));assert.deepEqual(saved.groups.map((g:any)=>g.assets),groups.map(g=>g.assets));assert.equal(saved.lastSync,1);}finally{f.store.close();}}
});

test('page, byte, request, asset and monotonic limits fail closed',async()=>{
 let pages=0;await assert.rejects(collectBusinessAssets(async()=>({accounts:[],nextPageToken:String(++pages)})),{code:'ASSET_SYNC_LIMIT'});assert.equal(pages,50);
 await assert.rejects(collectBusinessAssets(async()=>({accounts:[],unexpected:'x'.repeat(8*1024*1024)})),{code:'ASSET_SYNC_LIMIT'});
 let requests=0;await assert.rejects(collectBusinessAssets(async p=>{requests++;return p.path==='/v1/accounts'?{accounts:Array.from({length:250},(_,i)=>({name:'accounts/'+(i+1)}))}:{};},{maxAccounts:500}),{code:'ASSET_SYNC_LIMIT'});assert.equal(requests,250);
 await assert.rejects(collectBusinessAssets(async p=>p.path==='/v1/accounts'?{accounts:Array.from({length:21},(_,i)=>({name:'accounts/'+(i+1)}))}:{locations:Array.from({length:500},(_,i)=>({name:'locations/'+(Number(p.path.split('/')[3])*1000+i+1),title:'Synthetic'}))},{maxLocationsPerAccount:500}),{code:'ASSET_SYNC_LIMIT'});
 for(const deadline of [performance.now()-1,NaN,Infinity]){let calls=0;await assert.rejects(collectBusinessAssets(async()=>{calls++;return {};},{deadline}),{code:'ASSET_SYNC_LIMIT'});assert.equal(calls,0);}
});

test('HTTP failures and in-body errors preserve old data without copying provider error text to discovery metadata',async()=>{
 for(const status of [200,403]){const f=fixture();try{f.store.putDocument(owner.tenantId,'website_assets',id,{groups:[{kind:'business_accounts',assets:[{id:'old'}],complete:true}],lastSync:1});f.hook(()=>Response.json({error:{code:403,message:'private-provider-message'}},{status}));const r=await f.call({dry_run:false});assert.equal(r.success,false);const saved=f.store.document(owner.tenantId,'website_assets',id);assert.equal(saved.groups[0].complete,false);assert.equal(saved.lastSync,1);assert.equal(JSON.stringify(saved).includes('private-provider-message'),false);}finally{f.store.close();}}
});

test('removed or replaced login, revoked actor and removed scope withhold in-flight discovery',async()=>{
 for(const change of ['remove','replace','actor','scope']){const f=fixture();try{const apiKey=f.store.createKey(owner),actor=f.store.authenticate(apiKey);f.hook(()=>{if(change==='remove')f.store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId,id);if(change==='replace')f.store.putConnection(owner,f.connection,{accessToken:'new-login'});if(change==='scope')f.store.putConnection(owner,{...f.connection,scopes:[]},{accessToken:'synthetic-business-token'});if(change==='actor')f.store.revokeKey(apiKey);return Response.json({accounts:[],nextPageToken:'second'});});const r=await f.call({dry_run:false},actor);assert.equal(r.success,false);assert.equal(f.calls.length,1);assert.equal(f.store.documents(owner.tenantId,'website_assets').length,0);}finally{f.store.close();}}
});

test('a changed login is fenced before a transport retry and a rejected old refresh cannot mark new metadata stale',async()=>{
 const f=fixture();try{f.hook(()=>{f.store.putConnection(owner,f.connection,{accessToken:'replacement'});return Response.json({error:'temporary'},{status:503});});assert.equal((await f.call({dry_run:false})).error?.code,'CONNECTION_CHANGED');assert.equal(f.calls.length,1);assert.equal(f.store.documents(owner.tenantId,'website_assets').length,0);}finally{f.store.close();}
 const g=fixture(),spy=mock.method(g.service.credentials,'get',async()=>{g.store.putConnection(owner,g.connection,{accessToken:'replacement'});throw new MirrorError('CONNECTION_CHANGED','Refresh was fenced.');});try{assert.equal((await g.call({dry_run:false})).error?.code,'CONNECTION_CHANGED');assert.equal(g.calls.length,0);assert.equal(g.store.documents(owner.tenantId,'website_assets').length,0);}finally{spy.mock.restore();g.store.close();}
});

test('new selection and a stolen lease win over an older discovery operation',async()=>{
 for(const change of ['metadata','lease']){const f=fixture();try{f.hook(()=>{if(change==='metadata')f.store.putDocument(owner.tenantId,'website_assets',id,{groups:[],selected:['business_accounts:789'],newer:true});else f.store.db.prepare("UPDATE service_locks SET owner='replacement-worker'").run();return Response.json({accounts:[]});});assert.equal((await f.call({dry_run:false})).error?.code,'ASSET_SYNC_CHANGED');const docs=f.store.documents(owner.tenantId,'website_assets');if(change==='metadata'){assert.equal(docs[0]!.newer,true);assert.deepEqual(docs[0]!.groups,[]);}else assert.equal(docs.length,0);}finally{f.store.close();}}
});

test('late responses cannot publish and retained groups are explicitly stale',async()=>{
 const f=fixture();let time:ReturnType<typeof mock.method>|undefined;try{f.store.putDocument(owner.tenantId,'website_assets',id,{groups:[{kind:'business_accounts',assets:[{id:'old'}],complete:true}],lastSync:1});f.hook(()=>{const now=performance.now();time=mock.method(performance,'now',()=>now+70000);return Response.json({accounts:[]});});assert.equal((await f.call({dry_run:false})).error?.code,'ASSET_SYNC_LIMIT');assert.equal(f.store.document(owner.tenantId,'website_assets',id).groups[0].complete,false);assert.equal(f.calls.length,1);}finally{time?.mock.restore();f.store.close();}
});

test('separate SQLite workers share the lease and completed metadata survives reopening',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'amcp-business-sync-')),file=join(dir,'test.sqlite'),f=fixture(file),second=new Store(file,key);let release!:(r:Response)=>void,arrived!:()=>void;const ready=new Promise<void>(r=>arrived=r);
 try{f.hook(()=>{arrived();return new Promise(r=>release=r);});const run=f.call({dry_run:false});await ready;const service=new MirrorService(registry,second,new NativeTransport(async()=>{throw Error('No second worker egress');}));const other=await service.call(gateway,{operation:'gmb_connection_ops',arguments:{action:'sync_assets',connection_id:id,dry_run:false}},owner);assert.equal(other.error?.code,'ASSET_SYNC_IN_PROGRESS');release(Response.json({accounts:[]}));assert.equal((await run).success,true);const reopened=new Store(file,key);try{assert.equal(reopened.document(owner.tenantId,'website_assets',id).groups[0].complete,true);assert.deepEqual(reopened.listConnections(owner.tenantId)[0]!.writeAccounts,['locations/456']);}finally{reopened.close();}}
 finally{f.store.close();second.close();removeTestDirectory(dir,'amcp-business-sync-');}
});

test('discovery metadata and its audit event commit atomically',async()=>{
 const f=fixture(),original=f.store.appendAudit.bind(f.store),spy=mock.method(f.store,'appendAudit',(tenant:string,request:string,event:unknown)=>{if((event as any).event==='business_connection_synced')throw Error('Synthetic audit failure');return original(tenant,request,event);});try{const r=await f.call({dry_run:false});assert.equal(r.success,false);const saved=f.store.document(owner.tenantId,'website_assets',id);assert.equal(saved.groups[0].complete,false);assert.deepEqual(saved.groups[0].assets,[]);assert.equal(saved.lastSync,undefined);}finally{spy.mock.restore();f.store.close();}
});

test('provider text remains untrusted and sync audits contain counts rather than provider metadata',async()=>{
 const f=fixture();try{f.hook(u=>Response.json(u.pathname==='/v1/accounts'?{accounts:[{name:'accounts/123',accountName:'<script>private-provider-title</script>'}]}:{locations:[]}));const r=await f.call({dry_run:false});assert.equal(r.success,true);assert.match(r.meta.untrusted_provider_content,/data/);assert.equal(r.data.accounts[0].name,'<script>private-provider-title</script>');assert.equal(JSON.stringify(f.store.audit(owner.tenantId)).includes('private-provider-title'),false);}finally{f.store.close();}
});

test('maintained capability reporting qualifies only sync_assets and does not claim website OAuth',()=>{
 const rows=actionContracts(registry).filter(r=>r.implementation.startsWith('src/google-business-sync.ts'));assert.equal(rows.length,1);assert.equal(rows[0]!.action,'sync_assets');assert.equal(rows[0]!.status,'local_workflow');
 const descriptor=effectiveProviderContract('google_business')!;assert.equal(descriptor.website_connection,false);assert.equal(descriptor.discovery,'partial');assert.equal(descriptor.native_reads,'partial');assert.equal(descriptor.live_qualification,'unverified');assert.equal(descriptor.contract_version,8);
 const op=registry.tools.get(gateway)!.operations!.find(o=>o.operation==='gmb_connection_ops')!;assert.match(op.description,/start\/exchange\/refresh.*unimplemented/);assert.match(op.argumentsSchema.properties.read_mask.description,/name,title,storeCode/);
});

test('task examples both preview without egress and execute the same native fixture',async()=>{
 const file=JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/google-business-sync.json','utf8'));assert.equal(file.examples.length,2);for(const example of file.examples){const f=fixture();try{const preview=await f.service.call(example.gateway,example.input,owner);assert.equal(preview.success,true,JSON.stringify(preview));assert.equal(preview.data.dry_run,true);assert.equal(f.calls.length,0);const r=await f.service.call(example.gateway,{...example.input,arguments:{...example.input.arguments,dry_run:false}},owner);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.complete,true);assert.equal(f.calls.length,example.input.arguments.include_locations?3:1);}finally{f.store.close();}}
});

test('the native request bound charges retries and transient recovery reports actual HTTP attempts',async()=>{
 const f=fixture();try{f.hook(()=>f.calls.length===1?Response.json({},{status:503}):Response.json({}));const r=await f.call({dry_run:false});assert.equal(r.success,true);assert.equal(r.data.requests,1);assert.equal(r.data.native_http_attempts,2);}finally{f.store.close();}
 // Advance real request time synthetically so the burst limiter is not the first bound hit.
 // 250 attempts at 210 ms remains inside this operation's original 60-second deadline.
 const g=fixture(),base=performance.now(),wall=Date.now();let elapsed=0;const clock=mock.method(performance,'now',()=>base+elapsed),wallClock=mock.method(Date,'now',()=>wall+elapsed);
 try{const seen=new Set<string>();g.hook(u=>{elapsed+=210;if(!seen.has(u.pathname)){seen.add(u.pathname);return Response.json({},{status:503});}return Response.json(u.pathname==='/v1/accounts'?{accounts:Array.from({length:150},(_,i)=>({name:'accounts/'+(i+1)}))}:{locations:[]});});const r=await g.call({dry_run:false,max_accounts:150});assert.equal(r.error?.code,'ASSET_SYNC_LIMIT');assert.equal(g.calls.length,250);assert.ok(g.store.document(owner.tenantId,'website_assets',id).groups.every((group:any)=>!group.complete));}finally{wallClock.mock.restore();clock.mock.restore();g.store.close();}
});
