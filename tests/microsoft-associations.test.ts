import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {compileMicrosoft,assertMicrosoftWrite,validateMicrosoftResponse,microsoftOutcome,microsoftScope} from '../src/microsoft-native.js';
import {microsoftExtensionTypes,microsoftAssociationSnapshots} from '../src/microsoft-associations.js';
import type {JsonObject} from '../src/types.js';
const gateway='microsoft_ads_native_action',actor={tenantId:'t',userId:'owner',role:'admin' as const};
const input=(AssociationType='Campaign',types=['SitelinkAdExtension','CalloutAdExtension','StructuredSnippetAdExtension'])=>({action:'SetAdExtensionsAssociations',account_id:'123',campaign_id:'100',ad_extension_types:types,payload:{AssociationType,AdExtensionIdToEntityIdAssociations:Array.from({length:11},(_,i)=>({EntityId:AssociationType==='Account'?'123':AssociationType==='AdGroup'?'200':'100',AdExtensionId:String(800+i)}))}});
function fixture(type='Campaign'){
 const store=new Store(':memory:',Buffer.alloc(32,75).toString('base64'));store.putConnection(actor,{id:'ms',tenantId:'t',gateway,accounts:['123'],writeAccounts:['123'],accountCustomers:{'123':'456'},scopes:[microsoftScope],enabled:true,label:'Synthetic'},{accessToken:'synthetic',developerToken:'synthetic'});
 const extensions=Array.from({length:11},(_,i)=>({Id:String(800+i),Status:'Active',Type:i<6?'SitelinkAdExtension':i<10?'CalloutAdExtension':'StructuredSnippetAdExtension',Text:'Synthetic '+i,FinalUrls:['https://example.com/'+i]}));
 const state={links:[] as JsonObject[],writes:0,reads:0,partial:false,lost:false,wrongEntity:false,invalidCollection:false,foreignAsset:false,missingAsset:false,editorial:'Active',reverse:false,requests:[] as JsonObject[]};
 const service=new MirrorService(new Registry(),store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname,b=JSON.parse(String(init?.body));assert.equal(new Headers(init?.headers).get('CustomerAccountId'),'123');assert.equal(new Headers(init?.headers).get('CustomerId'),'456');
  const reply=(data:JsonObject)=>Response.json({...data,TrackingId:String(++state.reads),FutureCost:state.reads});
  if(path.endsWith('/Account/Query'))return reply({Account:{Id:'123'}});
  if(path.endsWith('/Campaigns/QueryByIds'))return reply({Campaigns:b.CampaignIds.map((Id:string)=>({Id,Status:'Paused',CampaignType:'Search',DailyBudget:50}))});
  if(path.endsWith('/AdGroups/QueryByIds')){assert.equal(b.CampaignId,'100');return reply({AdGroups:b.AdGroupIds.map((Id:string)=>({Id,Status:'Paused'}))});}
  if(path.endsWith('/AdExtensions/QueryByIds'))return reply({AdExtensions:state.foreignAsset?[{...extensions[0],Id:'999'}]:state.missingAsset?[null]:b.AdExtensionIds.map((id:string)=>extensions.find(r=>r.Id===id)),PartialErrors:[null]});
  if(path.endsWith('/AdExtensionsAssociations/Query'))return reply({AdExtensionAssociationCollection:state.invalidCollection?[]:b.EntityIds.map((id:string)=>({AdExtensionAssociations:(state.reverse?[...state.links].reverse():state.links).filter(r=>r.EntityId===id).map(r=>({EntityId:state.wrongEntity?'999':id,AssociationType:b.AssociationType,AdExtension:extensions.find(a=>a.Id===r.AdExtensionId),EditorialStatus:state.editorial}))})),PartialErrors:[null]});
  state.writes++;state.requests.push(b);assert.equal(b.ad_extension_types,undefined);assert.equal(b.AdExtensionType,undefined);
  if(init?.method==='DELETE')state.links=state.links.filter(r=>!b.AdExtensionIdToEntityIdAssociations.some((p:JsonObject)=>p.EntityId===r.EntityId&&p.AdExtensionId===r.AdExtensionId));else state.links.push(...b.AdExtensionIdToEntityIdAssociations);
  if(state.lost)throw Error('Synthetic lost response');return reply({PartialErrors:state.partial?[null,{Index:1,Code:100,Message:'Synthetic failure'}]:[null]});
 }),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(args:JsonObject=input(type))=>service.call('amcp_write',{action:'prepare',gateway,arguments:args},actor);
 const execute=(review:JsonObject)=>service.call('amcp_write',{action:'execute',review_id:review.data.review_id,idempotency_key:review.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);
 const verify=(review:JsonObject)=>service.call('amcp_campaign',{action:'verify',review_id:review.data.review_id},actor);
 return {store,service,state,extensions,prepare,execute,verify};
}
test('Microsoft extension contracts use official JSON paths and bounded native type flags without egress',()=>{
 const p=compileMicrosoft(input());assert.equal(p.path,'/CampaignManagement/v13/AdExtensionsAssociations/Set');assertMicrosoftWrite(p);assert.equal(microsoftAssociationSnapshots(p,compileMicrosoft).length,4);
 for(const type of microsoftExtensionTypes)assertMicrosoftWrite(compileMicrosoft(input('Campaign',[type])));
 for(const patch of [{ad_extension_types:undefined},{ad_extension_types:['MadeUp']},{ad_extension_types:['CalloutAdExtension','CalloutAdExtension']},{payload:{AssociationType:'Account',AdExtensionIdToEntityIdAssociations:[{EntityId:'999',AdExtensionId:'800'}]}},{payload:{AssociationType:'Campaign',AdExtensionIdToEntityIdAssociations:[{EntityId:'100',AdExtensionId:'800',Status:'Active'}]}}])assert.throws(()=>assertMicrosoftWrite(compileMicrosoft({...input(),...patch})));
 assert.throws(()=>assertMicrosoftWrite(compileMicrosoft(input('Account',['CallAdExtension']))));assert.throws(()=>assertMicrosoftWrite(compileMicrosoft(input('AdGroup',['LocationAdExtension']))));assert.throws(()=>assertMicrosoftWrite(compileMicrosoft({...input('AdGroup'),campaign_id:undefined})));
 const duplicate=input();duplicate.payload.AdExtensionIdToEntityIdAssociations.push(duplicate.payload.AdExtensionIdToEntityIdAssociations[0]!);assert.throws(()=>assertMicrosoftWrite(compileMicrosoft(duplicate)));
});
for(const type of ['Account','Campaign','AdGroup'])test('Microsoft '+type+' extension links prepare, execute once and verify all eleven; removal verifies absence',async()=>{
 const f=fixture(type);try{
  const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));const [a,b]=await Promise.all([f.execute(p),f.execute(p)]);assert.ok([a,b].some(x=>x.success),JSON.stringify([a,b]));assert.equal(f.state.writes,1);
  f.state.reverse=true;f.state.editorial='Disapproved';const v=await f.verify(p);assert.equal(v.data.status,'verified',JSON.stringify(v));assert.equal(v.data.checks.length,11);
  const duplicate=await f.prepare();assert.equal(duplicate.error.code,'ASSET_LINK_EXISTS');
  const remove=await f.prepare({...input(type),action:'DeleteAdExtensionsAssociations'});assert.equal(remove.success,true,JSON.stringify(remove));f.state.editorial='Active';assert.equal((await f.execute(remove)).success,true);assert.equal(f.state.writes,2);
  const removed=await f.verify(remove);assert.equal(removed.data.status,'verified',JSON.stringify(removed));assert.equal(removed.data.checks.length,11);
 }finally{f.store.close();}
});
test('Microsoft asset content and association membership changes invalidate review before egress',async()=>{
 for(const change of ['content','membership']){const f=fixture();try{const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));if(change==='content')f.extensions[0]!.Text='Changed';else f.state.links.push(input().payload.AdExtensionIdToEntityIdAssociations[0]!);const e=await f.execute(p);assert.equal(e.error.code,'STATE_CHANGED',JSON.stringify(e));assert.equal(f.state.writes,0);assert.ok(e.error.details.changed_fields.length);}finally{f.store.close();}}
});
test('Microsoft association activation needs spend confirmation even without a status field',async()=>{
 const f=fixture();try{const p=await f.prepare();assert.equal(p.success,true,JSON.stringify(p));const denied=await f.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);assert.equal(denied.error.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal(f.state.writes,0);}finally{f.store.close();}
});
test('Microsoft partial, missing, foreign and malformed association reads fail closed',async()=>{
 for(const field of ['foreignAsset','missingAsset','invalidCollection','wrongEntity'] as const){const f=fixture();try{f.state[field]=true;if(field==='wrongEntity')f.state.links.push(input().payload.AdExtensionIdToEntityIdAssociations[0]!);const p=await f.prepare();assert.equal(p.success,false,field);assert.equal(f.state.writes,0);}finally{f.store.close();}}
 const read=compileMicrosoft({action:'GetAdExtensionsByIds',account_id:'123',payload:{AdExtensionIds:['800'],AdExtensionType:'SitelinkAdExtension'}});
 assert.throws(()=>validateMicrosoftResponse(read,{status:200,headers:{},data:{AdExtensions:[{Id:'800'}],PartialErrors:[null,{Index:0,Code:1}]}},true));
 assert.throws(()=>validateMicrosoftResponse(read,{status:200,headers:{},data:{AdExtensions:[{Id:'800'}],PartialErrors:[false]}},true));
 for(const field of ['Errors','OperationErrors'])assert.throws(()=>validateMicrosoftResponse(read,{status:200,headers:{},data:{AdExtensions:[{Id:'800'}],[field]:[null]}},true),'Null-slot exception applies only to PartialErrors');
 assert.equal(microsoftOutcome(compileMicrosoft(input()),{status:200,headers:{},data:{}}),false);
});
test('Microsoft owner activation and deletion policies protect associations and grant revocation after review',async()=>{
 for(const [field,action]of [['allow_activation','SetAdExtensionsAssociations'],['allow_deletion','DeleteAdExtensionsAssociations']]){const f=fixture();try{if(action!.startsWith('Delete'))f.state.links=input().payload.AdExtensionIdToEntityIdAssociations;await f.service.call('amcp_workspace',{action:'save_spend_policy',gateway,account_id:'123',confirmed:true,policy:{[field!]:false}},actor);const p=await f.prepare({...input(),action});assert.equal(p.success,false,JSON.stringify(p));assert.match(p.error.code,/POLICY_(ACTIVATION|DELETION)_FORBIDDEN/);assert.equal(f.state.writes,0);}finally{f.store.close();}}
 const f=fixture();try{const p=await f.prepare();f.store.putConnection(actor,{...f.store.resolveConnection(actor,gateway,'123','ms'),enabled:false},{accessToken:'synthetic',developerToken:'synthetic'});const e=await f.execute(p);assert.equal(e.success,false);assert.equal(f.state.writes,0);}finally{f.store.close();}
});
test('Microsoft indexed errors and lost responses retain the original claim and cannot retry a mutation',async()=>{
 for(const field of ['partial','lost'] as const){const f=fixture();try{const p=await f.prepare();f.state[field]=true;const e=await f.execute(p);assert.ok(e.success===false||e.data?.result?.success===false,JSON.stringify(e));await f.execute(p);assert.equal(f.state.writes,1);assert.equal((await f.verify(p)).success,false);}finally{f.store.close();}}
});
