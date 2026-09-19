import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {googleCampaignBidSnapshots,readGoogleCampaignBidState,googleCampaignBidFields,googleCampaignBidStrategyFields} from '../src/google-campaign-bid-modifiers.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject,CompiledRequest} from '../src/types.js';
const gateway='google_ads_native_action',rpc='google_ads_v23_campaign_bid_modifier_mutate_campaign_bid_modifiers',registry=new Registry(),actor={tenantId:'call-bids',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const},key=Buffer.alloc(32,39).toString('base64');
const res=(collection:string,id:string)=>'customers/123/'+collection+'/'+id,campaign=res('campaigns','100'),name=res('campaignBidModifiers','100~500');
const update=(value=1.2,id=name)=>({update:{resourceName:id,bidModifier:value},updateMask:'bid_modifier'});
function fixture(file=':memory:'){
 const otherCampaigns:JsonObject[]=[];
 const store=new Store(file,key),calls:JsonObject[]=[],modifiers=new Map<string,JsonObject>([[name,{resourceName:name,campaign,criterionId:'500',bidModifier:1,interactionType:{type:'CALLS'}}]]),camp:JsonObject={resourceName:campaign,name:'Search campaign',status:'PAUSED',advertisingChannelType:'SEARCH',biddingStrategyType:'MANUAL_CPC',campaignBudget:res('campaignBudgets','10')},budget:JsonObject={resourceName:res('campaignBudgets','10'),name:'Budget',status:'ENABLED',amountMicros:'30000000',explicitlyShared:false,deliveryMethod:'STANDARD'},strategy:JsonObject={resourceName:res('biddingStrategies','20'),name:'Portfolio',status:'ENABLED',type:'TARGET_CPA',targetCpa:{targetCpaMicros:'1000000'},currencyCode:'USD'};
 const connection:Connection={id:'google',tenantId:actor.tenantId,gateway,label:'Synthetic',enabled:true,accounts:['123'],writeAccounts:['123'],scopes:['https://www.googleapis.com/auth/adwords']};
 const provision=(change:Partial<Connection>={})=>store.putConnection(owner,{...connection,...change},{accessToken:'synthetic',developerToken:'synthetic'});if(!store.listConnections(actor.tenantId).length)provision();
 let mode='success',reads=0,campaignReads=0;
 const transport=new NativeTransport(async(url,init)=>{const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));calls.push({path,body});
  if(path.endsWith('/googleAds:search')){
   reads++;const kind=/ FROM ([a-z_]+)/.exec(body.query)![1]!,camel=kind.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());if(kind==='campaign')campaignReads++;
   if(mode==='revoke_account')provision({accounts:['999'],writeAccounts:['999']});if(mode==='revoke_write')provision({writeAccounts:[]});if(mode==='revoke_scope')provision({scopes:[]});
   if(mode==='error')return Response.json({error:{code:403,message:'Synthetic denied'}});if(mode==='forbidden')return Response.json({error:{code:403,message:'Synthetic denied'}},{status:403});
   let values:JsonObject[]=kind==='customer'?[{id:'123',currencyCode:'USD',timeZone:'UTC',manager:false}]:kind==='campaign'?[camp,...otherCampaigns]:kind==='campaign_budget'?[budget]:kind==='bidding_strategy'?[strategy]:[...modifiers.values()];
   if(mode==='missing_parent'&&kind==='campaign')values=[];if(mode==='foreign_parent'&&kind==='campaign')values=[{...camp,resourceName:res('campaigns','999')}];if(mode==='moving_parent'&&kind==='campaign'&&campaignReads%2===0)values=[{...camp,name:'Changed during dependencies'}];
   if(mode==='duplicate'&&kind==='campaign_bid_modifier')values=[...values,...values];if(mode==='foreign_modifier'&&kind==='campaign_bid_modifier')values=[{...values[0],campaign:'customers/999/campaigns/100'}];if(mode==='unknown_criterion'&&kind==='campaign_bid_modifier')values=[{...values[0],interactionType:{type:'UNKNOWN'}}];
   let token:string|undefined;if(mode==='pages'&&kind==='campaign_bid_modifier'){if(!body.pageToken){values=values.slice(0,1);token='second';}else values=values.slice(1);}if(mode==='repeat_page'&&kind==='campaign_bid_modifier')token='same';
   return Response.json({...(values.length?{results:structuredClone(values).reverse().map(v=>({[camel]:v}))}:{}),queryResourceConsumption:String(reads),fieldMask:'synthetic',...(token?{nextPageToken:token}:{}),...(mode==='count'?{totalResultsCount:'99'}:{}),...(mode==='warning'?{warnings:['incomplete']}:{}),...(mode==='new_envelope'?{futureEnvelope:true}:{})});
  }
  assert.equal(path,'/v23/customers/123/campaignBidModifiers:mutate');if(mode==='lost')throw Error('Synthetic lost response');if(mode==='partial')return Response.json({results:[],partialFailureError:{code:3,message:'Synthetic partial'}});if(mode==='unknown')return Response.json({});
  const results=body.operations.map((op:JsonObject)=>{const id=op.remove??op.update.resourceName;if(mode!=='ignored'){if(op.remove)modifiers.delete(id);else modifiers.set(id,{...modifiers.get(id),...op.update});}return {resourceName:mode==='foreign_receipt'?id.replace('/123/','/999/'):id};});return Response.json({results});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(operations=[update()] as JsonObject[],action=rpc)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload:{operations}}},actor);
 const execute=(r:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:r.data.review_id,idempotency_key:r.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 return {store,service,calls,connection,provision,modifiers,camp,otherCampaigns,budget,strategy,prepare,execute,mode:(v:string)=>{mode=v;},writes:()=>calls.filter(c=>!c.path.endsWith('/googleAds:search')).length};
}
async function prepared(f:ReturnType<typeof fixture>,operations=[update()] as JsonObject[],action=rpc){const r=await f.prepare(operations,action);assert.equal(r.success,true,JSON.stringify(r));return r;}

test('campaign call-bid update/removal complete the native reviewed lifecycle and replay once',async()=>{
 const f=fixture();try{for(const [action,op]of [[rpc,update(0.1)],['UPDATE_CAMPAIGN_BID_MODIFIER',update(10)],['REMOVE_CAMPAIGN_BID_MODIFIER',{remove:name}]]as [string,JsonObject][]){const r=await prepared(f,[op],action);assert.equal((await f.execute(r)).success,true);const v=await f.service.verifyWrite(actor,r.data.review_id);assert.equal(v.status,'verified',JSON.stringify(v));assert.equal((await f.execute(r)).data.replayed,true);}assert.equal(f.writes(),3);assert.equal(f.modifiers.size,0);}finally{f.store.close();}
});
test('request telemetry does not block unchanged calls but parent, budget and bid changes do',async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>f.camp.name='Changed',(f:ReturnType<typeof fixture>)=>f.budget.amountMicros='40000000',(f:ReturnType<typeof fixture>)=>f.modifiers.get(name)!.bidModifier=1.8]){const f=fixture();try{const r=await prepared(f);change(f);const out=await f.execute(r);assert.equal(out.success,false);assert.equal(out.error.code,'STATE_CHANGED');assert.ok(out.error.details.changed_fields.some((v:string)=>/name|amountMicros|bidModifier/.test(v)));assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('portfolio dependencies are frozen and manager-owned strategies are never inferred from client access',async()=>{
 const f=fixture();try{f.camp.biddingStrategy=f.strategy.resourceName;f.camp.biddingStrategyType='TARGET_CPA';const r=await prepared(f);f.strategy.targetCpa.targetCpaMicros='2000000';assert.equal((await f.execute(r)).error.code,'STATE_CHANGED');f.camp.biddingStrategy='customers/999/biddingStrategies/20';assert.equal((await f.prepare()).success,false);assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('unsupported creates, foreign identities, immutable fields, masks, zero and unsafe multipliers fail before egress',async()=>{
 const f=fixture();try{for(const op of [{create:{campaign,bidModifier:1.2,interactionType:{type:'CALLS'}}},update(0),update(10.1),update(0.09),update(1.2,name.replace('/123/','/999/')),{update:{resourceName:name,bidModifier:1.2,campaign},updateMask:'bid_modifier'},{update:{resourceName:name,bidModifier:1.2},updateMask:'campaign'},{remove:name,updateMask:'bid_modifier'},update('1.2' as any)])assert.equal((await f.prepare([op])).success,false,JSON.stringify(op));assert.equal((await f.prepare([update(),update()])).success,false);assert.equal((await f.prepare([update()],'CREATE_CAMPAIGN_BID_MODIFIER')).success,false);assert.equal(f.calls.length,0);}finally{f.store.close();}
});
test('full configuration prevents missing, foreign, failed, partial and moving state from becoming a review',async()=>{
 for(const mode of ['missing_parent','foreign_parent','moving_parent','duplicate','foreign_modifier','unknown_criterion','count','warning','new_envelope','error','forbidden']){const f=fixture();try{f.mode(mode);const r=await f.prepare();assert.equal(r.success,false,mode);assert.equal(f.writes(),0);assert.equal(f.store.documents(actor.tenantId,'write_review').length,0);}finally{f.store.close();}}
});
test('disallowed channels and missing native modifiers cannot be changed as inferred defaults',async()=>{
 const f=fixture();try{f.camp.advertisingChannelType='DISPLAY';assert.equal((await f.prepare()).success,false);f.camp.advertisingChannelType='SEARCH';f.modifiers.clear();assert.equal((await f.prepare()).success,false);assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('current scopes and write grants are rechecked between reads and before dispatch',async()=>{
 for(const mode of ['revoke_write','revoke_account','revoke_scope']){const f=fixture();try{const r=await prepared(f);f.mode(mode);assert.equal((await f.execute(r)).success,false,mode);assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('verification catches account or Ads-scope revocation during an in-flight response',async()=>{
 for(const mode of ['revoke_account','revoke_scope']){const f=fixture();try{const r=await prepared(f);assert.equal((await f.execute(r)).success,true);f.mode(mode);const out=await f.service.verifyWrite(actor,r.data.review_id);assert.notEqual(out.status,'verified',JSON.stringify(out));assert.equal(f.writes(),1);}finally{f.store.close();}}
});
test('spend acknowledgement, deletion policy and activation prohibition cover call-bid changes',async()=>{
 const f=fixture();try{let r=await prepared(f);assert.equal((await f.execute(r,{spend_change_confirmed:false})).success,false);saveSpendPolicy(f.store,owner,{account_id:'123',gateway,confirmed:true,policy:{allow_deletion:false}});assert.equal((await f.prepare([{remove:name}])).error.code,'POLICY_DELETION_FORBIDDEN');saveSpendPolicy(f.store,owner,{account_id:'123',gateway,confirmed:true,policy:{allow_activation:false}});assert.equal((await f.prepare()).error.code,'POLICY_ACTIVATION_FORBIDDEN');assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('partial, unknown and foreign receipts and lost responses never repeat a claimed mutation',async()=>{
 for(const mode of ['partial','unknown','foreign_receipt','lost']){const f=fixture();try{const r=await prepared(f);f.mode(mode);const out=await f.execute(r);assert.equal(out.success,false,JSON.stringify(out));await f.execute(r);assert.equal(f.writes(),1,mode);}finally{f.store.close();}}
});
test('unchanged read-back cannot certify an ignored update or deletion',async()=>{
 for(const op of [update(),{remove:name}]){const f=fixture();try{const r=await prepared(f,[op]);f.mode('ignored');assert.equal((await f.execute(r)).success,true);assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'inconclusive');assert.equal(f.writes(),1);}finally{f.store.close();}}
});
test('claims persist across SQLite reopen and simultaneous execution dispatches once',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'amcp-call-bids-')),file=join(directory,'test.sqlite');let f=fixture(file);try{const r=await prepared(f);const outcomes=await Promise.all([f.execute(r),f.execute(r)]);assert.ok(outcomes.some(r=>r.success));assert.equal(f.writes(),1);f.store.close();f=fixture(file);assert.equal((await f.execute(r)).data.replayed,true);assert.equal(f.writes(),0);}finally{f.store.close();removeTestDirectory(directory,'amcp-call-bids-');}
});
test('another actor, tenant, changed review and direct native calls cannot bypass the review',async()=>{
 const f=fixture();try{const r=await prepared(f);const common={action:'execute',review_id:r.data.review_id,idempotency_key:r.data.idempotency_key,confirmed:true,spend_change_confirmed:true};for(const who of [{...actor,userId:'other'},{...actor,tenantId:'other'},{...actor,role:'reader' as const}])assert.equal((await f.service.call('amcp_write',common,who)).success,false);assert.equal((await f.service.call(gateway,{action:rpc,account_id:'123',dry_run:false,skip_preflight:true,payload:{operations:[update()]}},actor)).success,false);const doc=f.store.document(actor.tenantId,'write_review',r.data.review_id)!;const changed=structuredClone(doc);changed.plan.body.operations[0].update.bidModifier=9;f.store.putDocument(actor.tenantId,'write_review',r.data.review_id,changed);assert.equal((await f.execute(r)).success,false);assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('the action inventory qualifies only update/remove plus the constrained RPC and keeps create blocked',()=>{
 const rows=actionContracts(registry).filter(r=>r.path?.includes('/campaignBidModifiers:mutate'));assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.status==='reviewed_write_family').length,3);assert.equal(rows.find(r=>r.action==='CREATE_CAMPAIGN_BID_MODIFIER')!.status,'blocked_write');
});

test('the campaign modifier projection uses every native configuration field and excludes metrics',()=>{
 const evidence=JSON.parse(readFileSync('tests/fixtures/google-campaign-bid-fields-v23.json','utf8'));assert.equal(evidence.api_version,'v23');assert.deepEqual([...googleCampaignBidFields].sort(),Object.keys(evidence.fields).sort());assert.ok(googleCampaignBidFields.every(f=>evidence.fields[f].selectable===true));
 const strategy=JSON.parse(readFileSync('tests/fixtures/google-portfolio-bid-fields-v23.json','utf8'));assert.equal(Object.keys(strategy.fields).length,30);assert.deepEqual([...googleCampaignBidStrategyFields].sort(),Object.keys(strategy.fields).filter(k=>!['campaign_count','non_removed_campaign_count','id'].includes(k)).sort());assert.ok(googleCampaignBidStrategyFields.every(f=>strategy.fields[f].selectable===true));
});
test('complete multi-campaign pagination handles reordered state and verifies every distinct result',async()=>{
 const f=fixture(),other=res('campaigns','101'),target=res('campaignBidModifiers','101~500');try{f.otherCampaigns.push({...f.camp,resourceName:other});f.modifiers.set(target,{...f.modifiers.get(name),resourceName:target,campaign:other});f.mode('pages');const r=await prepared(f,[update(1.3),update(1.4,target)]);assert.equal((await f.execute(r)).success,true);assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'verified');assert.ok(f.calls.some(c=>c.body.pageToken==='second'));assert.equal(f.writes(),1);}finally{f.store.close();}
});
test('looping native pagination fails before a review or mutation',async()=>{
 const f=fixture();try{f.mode('repeat_page');assert.equal((await f.prepare()).error.code,'BID_MODIFIER_STATE_UNVERIFIED');assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('state reading enforces per-page bytes, total bytes, page count and a monotonic deadline',async()=>{
 const p:CompiledRequest={gateway,action:rpc,path:'/v23/customers/123/campaignBidModifiers:mutate',accountId:'123',method:'POST',query:{},headers:{},body:{operations:[update()]},readOnly:false,destructive:false,requiresConfirmation:true,warnings:[],evidence:'synthetic'};
 const snapshot=googleCampaignBidSnapshots(p)[0]!;
 for(const mode of ['page_bytes','total_bytes','page_limit','clock']){
  let count=0;const clock=mode==='clock'?mock.method(performance,'now',()=>count?61001:0):undefined;
  try{await assert.rejects(()=>readGoogleCampaignBidState(snapshot,async()=>{
   count++;const size=mode==='page_bytes'?4*1024*1024:mode==='total_bytes'?3*1024*1024:1;
   return {status:200,headers:{},data:{results:[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC',padding:'x'.repeat(size)}}],...(mode==='page_bytes'||mode==='clock'?{}:{nextPageToken:String(count)})}};
  }),/bound/);assert.ok(count<=25);}finally{clock?.mock.restore();}
 }
});
