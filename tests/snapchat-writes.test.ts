import test from 'node:test';
import assert from 'node:assert/strict';
import {assertWriteShape} from '../src/write-review.js';
import {MirrorError} from '../src/errors.js';
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
