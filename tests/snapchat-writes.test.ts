import test from 'node:test';
import assert from 'node:assert/strict';
import {assertWriteShape,snapshotPlans} from '../src/write-review.js';
import {Registry} from '../src/catalog.js';
import {MirrorError} from '../src/errors.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {WriteVerifier} from '../src/write-verification.js';
import type {CompiledRequest,JsonObject} from '../src/types.js';

/**
 * Snapchat carries a full reviewed-write contract but had no focused suite, and its JSON Patch
 * route is the one place the owner activation policy was reachable by an ordinary user.
 */
const plan=(over:Partial<CompiledRequest>):CompiledRequest=>({
 gateway:'snapchat_native_action',accountId:'acc1',action:'snapchat_write',method:'POST',
 path:'/v1/adaccounts/acc1/campaigns',query:{},body:{},headers:{},readOnly:false,
 destructive:false,requiresConfirmation:true,evidence:'fixture',warnings:[],...over});

const refused=(p:CompiledRequest,code:string)=>{
 try{assertWriteShape(p);}catch(e){
  if(!(e instanceof MirrorError))throw e;
  assert.equal(e.code,code,'expected '+code+' but got '+e.code+': '+e.message);return;
 }
 throw new Error('expected '+code+', but the contract accepted the request');
};
const accepted=(p:CompiledRequest)=>assert.doesNotThrow(()=>assertWriteShape(p));

test('documented Snapchat collection PUT for creatives has exact resource state reads',()=>{
 const request=plan({method:'PUT',path:'/v1/adaccounts/acc1/creatives',body:{creatives:[{id:'creative1',ad_account_id:'acc1',headline:'Updated'}]}});
 accepted(request);
 const reads=snapshotPlans(request,new Registry());
 assert.deepEqual(reads.map(r=>[r.method,r.path]),[['GET','/v1/creatives/creative1']]);
 assert.throws(()=>snapshotPlans({...request,body:{creatives:[{headline:'Missing ID'}]}},new Registry()),{code:'MISSING_PARAMETER'});
 assert.throws(()=>snapshotPlans({...request,body:{creatives:[{id:'same'},{id:'same'}]}},new Registry()),{code:'INVALID_ARGUMENT'});
});

test('Snapchat creative PUT reviews impact, preserves exact account scope, executes once and verifies the changed creative',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,43).toString('base64')),registry=new Registry(),actor={tenantId:'t',userId:'u',role:'admin' as const};
 const connection={id:'c',tenantId:'t',gateway:'snapchat_native_action',accounts:['123'],writeAccounts:['123'],scopes:[],enabled:true,label:'Synthetic'};
 store.putConnection(actor,connection,{accessToken:'synthetic'});store.rememberResource(connection,'123','creatives/creative1');
 let row={id:'creative1',ad_account_id:'123',type:'WEB_VIEW',name:'Before',headline:'Before',brand_name:'Synthetic',call_to_action:'LEARN_MORE',shareable:false,top_snap_media_id:'media1',profile_properties:{profile_id:'profile1'},web_view_properties:{url:'https://example.test',block_preload:true}},mutations=0;
 const transport=new NativeTransport(async(input,init)=>{
  const url=new URL(String(input));if(init?.method==='PUT'){assert.equal(url.pathname,'/v1/adaccounts/123/creatives');mutations++;row={...row,...JSON.parse(String(init.body)).creatives[0]};}else assert.equal(url.pathname,'/v1/creatives/creative1');
  return Response.json({request_status:'SUCCESS',creatives:[{sub_request_status:'SUCCESS',creative:row}]});
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(creative:JsonObject)=>service.call('amcp_write',{action:'prepare',gateway:connection.gateway,arguments:{action:'snapchat_adaccounts_ad_account_id_creatives_update',account_id:'123',payload:{creatives:[creative]}}},actor);
 try{
  const sparse=await prepare({id:row.id,ad_account_id:row.ad_account_id,type:row.type,name:'After',headline:'After'});assert.equal(sparse.error.code,'INCOMPLETE_CREATIVE_REPLACEMENT');assert.ok(sparse.error.details.missing_fields.includes('/shareable'));assert.equal(mutations,0);
  const nested=await prepare({...row,web_view_properties:{url:'https://example.test/changed'}});assert.equal(nested.error.code,'INCOMPLETE_CREATIVE_REPLACEMENT');assert.deepEqual(nested.error.details.missing_fields,['/web_view_properties/block_preload']);assert.equal(mutations,0);
  const prepared=await prepare({...row,name:'After',headline:'After'});
  assert.equal(prepared.success,true,JSON.stringify(prepared));assert.equal(prepared.data.creative_impact.provider,'snapchat');assert.equal(prepared.data.creative_impact.affected_ad_ids,null);
  const input={action:'execute',review_id:prepared.data.review_id,idempotency_key:prepared.data.review_id,confirmed:true};assert.equal((await service.call('amcp_write',input,actor)).data.success,true);
  assert.equal((await new WriteVerifier(store,registry,transport,service.credentials).verify(actor,prepared.data.review_id)).status,'verified');
  assert.equal((await service.call('amcp_write',input,actor)).data.replayed,true);assert.equal(mutations,1);
 }finally{store.close();}
});

test('Snapchat creates must be explicitly paused',()=>{
 accepted(plan({body:{campaigns:[{name:'Launch',status:'PAUSED'}]}}));
 refused(plan({body:{campaigns:[{name:'Launch',status:'ACTIVE'}]}}),'PAUSED_CREATION_REQUIRED');
 refused(plan({body:{campaigns:[{name:'Launch'}]}}),'PAUSED_CREATION_REQUIRED');
 // One active record among several is still a refusal.
 refused(plan({body:{campaigns:[{name:'A',status:'PAUSED'},{name:'B',status:'ACTIVE'}]}}),'PAUSED_CREATION_REQUIRED');
});

test('Snapchat create payloads must carry 1-25 native records under the route key',()=>{
 refused(plan({body:{campaigns:[]}}),'MISSING_PAYLOAD');
 refused(plan({body:{adsquads:[{name:'Wrong key',status:'PAUSED'}]}}),'MISSING_PAYLOAD');
 refused(plan({body:{campaigns:Array.from({length:26},()=>({name:'Too many',status:'PAUSED'}))}}),'MISSING_PAYLOAD');
 accepted(plan({body:{campaigns:Array.from({length:25},()=>({name:'At the limit',status:'PAUSED'}))}}));
 // Creatives are not serving entities, so they carry no paused requirement.
 accepted(plan({path:'/v1/adaccounts/acc1/creatives',body:{creatives:[{name:'Creative'}]}}));
});

test('Snapchat JSON Patch operations are validated structurally',()=>{
 const patch=(body:unknown)=>plan({method:'PATCH',path:'/v1/adaccounts/acc1/campaigns/c1',body:body as JsonObject});
 accepted(patch([{op:'replace',path:'/name',value:'Renamed'}]));
 accepted(patch([{op:'remove',path:'/name'}]));
 refused(patch([]),'INVALID_PATCH');
 refused(patch([{op:'explode',path:'/name',value:'x'}]),'INVALID_PATCH');
 refused(patch([{op:'replace',path:'/name'}]),'INVALID_PATCH');            // no value
 refused(patch([{op:'replace',path:'name',value:'x'}]),'INVALID_PATCH');   // not rooted
 refused(patch([{op:'replace',path:'/__proto__/x',value:'x'}]),'INVALID_PATCH');
 refused(patch([{op:'replace',path:'/constructor',value:'x'}]),'INVALID_PATCH');
 refused(patch(Array.from({length:26},()=>({op:'replace',path:'/name',value:'x'}))),'INVALID_PATCH');
});

test('Snapchat routes outside the reviewed contract are refused',()=>{
 refused(plan({path:'/v1/adaccounts/acc1/billing'}),'WRITE_CONTRACT_UNAVAILABLE');
 refused(plan({method:'GET',path:'/v1/adaccounts/acc1/campaigns',readOnly:true}),'MUTATION_REQUIRED');
 // Batch and method-tunnelled writes stay banned.
 refused(plan({path:'/v1/batch/campaigns',body:{campaigns:[{name:'B',status:'PAUSED'}]}}),'WRITE_CONTRACT_UNAVAILABLE');
 refused(plan({body:{campaigns:[{name:'B',status:'PAUSED'}],method:'DELETE'}}),'WRITE_CONTRACT_UNAVAILABLE');
 // Query parameters are not part of the Snapchat write contract.
 refused(plan({query:{force:'true'},body:{campaigns:[{name:'B',status:'PAUSED'}]}}),'WRITE_CONTRACT_UNAVAILABLE');
});

test('Snapchat update and delete routes stay inside the allowlist',()=>{
 accepted(plan({method:'PUT',path:'/v1/adaccounts/acc1/campaigns',body:{campaigns:[{id:'c1',name:'Renamed'}]}}));
 accepted(plan({method:'DELETE',path:'/v1/campaigns/c1',destructive:true}));
 refused(plan({method:'DELETE',path:'/v1/adaccounts/acc1',destructive:true}),'WRITE_CONTRACT_UNAVAILABLE');
});
