import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {readGoogleBidState,googleBidSnapshots,googleBidPrerequisites,googleBidFields} from '../src/google-bid-modifiers.js';
import {removeTestDirectory} from './temp.js';
import type {Connection,JsonObject} from '../src/types.js';
const gateway='google_ads_native_action',rpc='google_ads_v23_ad_group_bid_modifier_mutate_ad_group_bid_modifiers',actor={tenantId:'bid-modifiers',userId:'operator',role:'operator' as const},owner={...actor,role:'admin' as const},registry=new Registry(),key=Buffer.alloc(32,24).toString('base64');
const res=(collection:string,id:string)=>'customers/123/'+collection+'/'+id;
const group=res('adGroups','200'),name=res('adGroupBidModifiers','200~500'),campaign=res('campaigns','100');
const criteria:JsonObject[]=[{device:{type:'MOBILE'}},{hotelDateSelectionType:{type:'USER_SELECTED'}},{hotelAdvanceBookingWindow:{minDays:'1',maxDays:'14'}},{hotelLengthOfStay:{minNights:'1',maxNights:'7'}},{hotelCheckInDay:{dayOfWeek:'MONDAY'}},{hotelCheckInDateRange:{startDate:'2026-12-01',endDate:'2026-12-31'}}];
test('bid-modifier state selects only fields from the complete official v23 field evidence',()=>{const evidence=JSON.parse(readFileSync('tests/fixtures/google-bid-fields-v23.json','utf8'));assert.equal(evidence.api_version,'v23');assert.equal(Object.keys(evidence.fields).length,15);for(const field of googleBidFields)assert.equal(evidence.fields[field]?.selectable,true,field);});
function fixture(file=':memory:'){
 const store=new Store(file,key),calls:JsonObject[]=[],modifiers=new Map<string,JsonObject>(),parent:JsonObject={resourceName:group,campaign,name:'Selected group',status:'PAUSED',type:'HOTEL_ADS',cpcBidMicros:'1000000'},camp:JsonObject={resourceName:campaign,name:'Selected campaign',status:'PAUSED',advertisingChannelType:'HOTEL',biddingStrategyType:'MANUAL_CPC',campaignBudget:res('campaignBudgets','10')},budget={resourceName:res('campaignBudgets','10'),name:'Selected budget',status:'ENABLED',amountMicros:'30000000',deliveryMethod:'STANDARD',explicitlyShared:false};
 const c:Connection={id:'google',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:['https://www.googleapis.com/auth/adwords']};if(!store.listConnections(actor.tenantId).length)store.putConnection(owner,c,{accessToken:'synthetic',developerToken:'synthetic'});
 let mode='success',reads=0;
 const transport=new NativeTransport(async(url,init)=>{const body=JSON.parse(String(init?.body)),path=new URL(String(url)).pathname;calls.push({path,body});
  if(path.endsWith('/googleAds:search')){
   reads++;if(mode==='revoked')store.putConnection(owner,{...c,writeAccounts:[]},{accessToken:'synthetic',developerToken:'synthetic'});
   if(mode==='error')return Response.json({error:{code:403,message:'Synthetic'}});
   const kind=/ FROM ([a-z_]+)/.exec(body.query)![1],camel=kind!.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
   let values=kind==='customer'?[{id:'123',currencyCode:'USD',timeZone:'UTC'}]:kind==='ad_group'?[parent]:kind==='campaign'?[camp]:kind==='campaign_budget'?[budget]:[...modifiers.values()];
   if(mode==='missing_parent'&&kind==='ad_group')values=[];
   if(mode==='foreign_parent'&&kind==='ad_group')values=[{...parent,resourceName:res('adGroups','999')}];
   if(mode==='duplicate'&&kind==='ad_group_bid_modifier')values=[...values,...values];
   if(mode==='foreign_modifier'&&kind==='ad_group_bid_modifier')values=[{...values[0],resourceName:'customers/999/adGroupBidModifiers/200~500'}];
   let token:string|undefined;if(mode==='pages'&&kind==='ad_group_bid_modifier'){if(!body.pageToken){values=values.slice(0,1);token='page-2';}else values=values.slice(1);}if(mode==='repeat_page'&&kind==='ad_group_bid_modifier')token='same';
   return Response.json({...(values.length?{results:[...values].reverse().map(v=>({[camel]:v}))}:{}),fieldMask:'synthetic',queryResourceConsumption:String(reads),...(token?{nextPageToken:token}:{})});
  }
  assert.equal(path,'/v23/customers/123/adGroupBidModifiers:mutate');
  if(mode==='lost')throw Error('Synthetic lost response');if(mode==='partial')return Response.json({results:[],partialFailureError:{code:3,message:'Synthetic'}});if(mode==='unknown')return Response.json({});
  const results=body.operations.map((op:JsonObject,i:number)=>{const id=op.remove??op.update?.resourceName??res('adGroupBidModifiers','200~'+(500+i));
   if(mode!=='ignored'){if(op.remove){if(mode==='inherited')modifiers.set(id,{...modifiers.get(id),bidModifier:1,bidModifierSource:'CAMPAIGN'});else modifiers.delete(id);}else if(op.update)modifiers.set(id,{...modifiers.get(id),...op.update,bidModifierSource:'AD_GROUP'});else modifiers.set(id,{...op.create,resourceName:id,criterionId:id.split('~').at(-1),baseAdGroup:group,bidModifierSource:'AD_GROUP'});}
   return {resourceName:mode==='foreign_receipt'?id.replace('/200~','/999~'):id};
  });return Response.json({results});
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(operations:JsonObject[],action=rpc)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload:{operations}}},actor);
 const execute=(r:JsonObject,extra:JsonObject={})=>service.call('amcp_write',{action:'execute',review_id:r.data.review_id,idempotency_key:r.data.idempotency_key,confirmed:true,spend_change_confirmed:true,...extra},actor);
 return {store,service,c,calls,parent,camp,budget,modifiers,prepare,execute,mode:(v:string)=>{mode=v;},writes:()=>calls.filter(c=>!c.path.endsWith('/googleAds:search')).length};
}
async function create(f:ReturnType<typeof fixture>,criterion=criteria[0]!,bidModifier=1.2){const r=await f.prepare([{create:{adGroup:group,bidModifier,...criterion}}]);assert.equal(r.success,true,JSON.stringify(r));return r;}
const seed=(f:ReturnType<typeof fixture>,criterion=criteria[0]!)=>f.modifiers.set(name,{resourceName:name,adGroup:group,baseAdGroup:group,criterionId:'500',bidModifier:1.2,bidModifierSource:'AD_GROUP',...criterion});
for(const criterion of criteria)test('Google bid modifier lifecycle: '+Object.keys(criterion)[0],async()=>{
 const f=fixture();try{const r=await create(f,criterion);assert.equal((await f.execute(r)).success,true);assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'verified');assert.equal((await f.execute(r)).data.replayed,true);assert.equal(f.writes(),1);
  const u=await f.prepare([{update:{resourceName:name,bidModifier:0.8},updateMask:'bid_modifier'}]);assert.equal(u.success,true,JSON.stringify(u));assert.equal((await f.execute(u)).success,true);assert.equal((await f.service.verifyWrite(actor,u.data.review_id)).status,'verified');
  const d=await f.prepare([{remove:name}]);assert.equal(d.success,true,JSON.stringify(d));assert.equal((await f.execute(d)).success,true);assert.equal((await f.service.verifyWrite(actor,d.data.review_id)).status,'verified');assert.equal(f.writes(),3);
 }finally{f.store.close();}
});
test('device zero and deletion restoring campaign inheritance verify without claiming no bidding effect',async()=>{
 const f=fixture();try{const r=await create(f,criteria[0],0);assert.equal((await f.execute(r)).success,true);assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'verified');const d=await f.prepare([{remove:name}]);f.mode('inherited');assert.equal((await f.execute(d)).success,true);assert.equal((await f.service.verifyWrite(actor,d.data.review_id)).status,'verified');assert.equal(f.modifiers.get(name)?.bidModifierSource,'CAMPAIGN');}finally{f.store.close();}
});
test('duplicate criteria, foreign resources, immutable fields, masks and invalid multipliers fail before egress',async()=>{
 const f=fixture();try{for(const operations of [
  [{create:{adGroup:group,bidModifier:0,...criteria[1]}}],[{create:{adGroup:group,bidModifier:10.1,...criteria[0]}}],[{create:{adGroup:group,bidModifier:1.2}}],
  [{create:{adGroup:group,bidModifier:1.2,...criteria[0],...criteria[1]}}],[{create:{adGroup:group.replace('/123/','/999/'),bidModifier:1.2,...criteria[0]}}],
  [{create:{adGroup:group,bidModifier:1.2,hotelCheckInDateRange:{startDate:'2026-02-30',endDate:'2026-03-02'}}}],
  [{update:{resourceName:name,bidModifier:1.2},updateMask:'*'}],[{update:{resourceName:name,bidModifier:1.2,adGroup:group},updateMask:'bid_modifier,ad_group'}],
  [{create:{adGroup:group,bidModifier:1.2,...criteria[0]}},{create:{adGroup:group,bidModifier:1.5,...criteria[0]}}]
 ])assert.equal((await f.prepare(operations)).success,false,JSON.stringify(operations));assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});
test('complete modifier pages exclude telemetry and row order, but parent bids, budgets and sibling modifiers conflict',async()=>{
 for(const mode of ['pages','parent','sibling','budget','campaign_bid']){const f=fixture();try{seed(f);f.modifiers.set(res('adGroupBidModifiers','200~501'),{...f.modifiers.get(name),resourceName:res('adGroupBidModifiers','200~501'),criterionId:'501',device:{type:'DESKTOP'}});f.mode('pages');const r=await f.prepare([{update:{resourceName:name,bidModifier:1.3},updateMask:'bidModifier'}]);assert.equal(r.success,true,JSON.stringify(r));if(mode==='parent')f.parent.cpcBidMicros='2000000';if(mode==='sibling')f.modifiers.get(res('adGroupBidModifiers','200~501'))!.bidModifier=1.7;if(mode==='budget')f.budget.amountMicros='40000000';if(mode==='campaign_bid')f.camp.targetRoas={targetRoas:2};const e=await f.execute(r);assert.equal(e.success,mode==='pages',JSON.stringify(e));if(mode!=='pages'){assert.equal(e.error.code,'STATE_CHANGED');assert.ok(e.error.details.changed_fields.length);assert.equal(f.writes(),0);}}finally{f.store.close();}}
});
test('a missing, failed, foreign or incomplete read cannot authorize a modifier',async()=>{
 for(const mode of ['error','missing_parent','foreign_parent','foreign_modifier','duplicate','repeat_page']){const f=fixture();try{seed(f);f.mode(mode);const r=await f.prepare([{update:{resourceName:name,bidModifier:1.3},updateMask:'bidModifier'}]);assert.equal(r.success,false,mode);assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('explicit existing overrides require updates and hotel criteria require Hotel parents',async()=>{
 const f=fixture();try{seed(f);assert.equal((await f.prepare([{create:{adGroup:group,bidModifier:1.1,...criteria[0]}}])).error.code,'BID_MODIFIER_EXISTS');f.camp.advertisingChannelType='SEARCH';assert.equal((await f.prepare([{create:{adGroup:group,bidModifier:1.1,...criteria[1]}}])).success,false);f.modifiers.get(name)!.device=undefined;f.modifiers.get(name)!.hotelCheckInDay={dayOfWeek:'MONDAY'};assert.equal((await f.prepare([{update:{resourceName:name,bidModifier:0},updateMask:'bidModifier'}])).success,false);assert.equal(f.writes(),0);}finally{f.store.close();}
});
test('scope and grant revocation, including during reads, and owner activation/deletion policies remain effective',async()=>{
 for(const mode of ['scope','grant','inflight','activation','deletion','confirmation']){const f=fixture();try{seed(f);const r=await f.prepare([{remove:name}]);assert.equal(r.success,true,JSON.stringify(r));if(mode==='scope')f.store.putConnection(owner,{...f.c,scopes:['openid']},{accessToken:'synthetic'});if(mode==='grant')f.store.putConnection(owner,{...f.c,writeAccounts:[]},{accessToken:'synthetic'});if(mode==='inflight')f.mode('revoked');if(mode==='activation'||mode==='deletion')saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{[mode==='activation'?'allow_activation':'allow_deletion']:false}});const e=await f.execute(r,mode==='confirmation'?{spend_change_confirmed:false}:{});assert.equal(e.success,false,mode);assert.equal(f.writes(),0);}finally{f.store.close();}}
});
test('ignored writes remain inconclusive, malformed and lost receipts cannot repeat a dispatch',async()=>{
 for(const mode of ['ignored','partial','unknown','lost','foreign_receipt']){const f=fixture();try{const r=await create(f);f.mode(mode);const e=await f.execute(r);assert.equal(e.success,mode==='ignored',JSON.stringify(e));if(mode==='ignored')assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'inconclusive');await f.execute(r);assert.equal(f.writes(),1);}finally{f.store.close();}}
});
test('completed and uncertain bid claims survive restart, with concurrent calls dispatching only once',async()=>{
 for(const mode of ['success','lost']){const dir=mkdtempSync(join(tmpdir(),'amcp-google-bids-')),file=join(dir,'test.sqlite');let f=fixture(file);try{const r=await create(f);f.mode(mode);const all=await Promise.all([f.execute(r),f.execute(r)]);assert.equal(all.some(e=>e.success),mode==='success');assert.equal(f.writes(),1);f.store.close();f=fixture(file);const replay=await f.execute(r);assert.equal(replay.success,mode==='success');assert.equal(f.calls.length,0);}finally{f.store.close();removeTestDirectory(dir,'amcp-google-bids-');}}
});

test('legacy create, update and remove use the same server-read contract',async()=>{
 const f=fixture();try{
  for(const [action,operations]of [['CREATE_AD_GROUP_BID_MODIFIER',[{create:{adGroup:group,bidModifier:1.3,...criteria[0]}}]],['UPDATE_AD_GROUP_BID_MODIFIER',[{update:{resourceName:name,bidModifier:0},updateMask:'bid_modifier'}]],['REMOVE_AD_GROUP_BID_MODIFIER',[{remove:name}]]]as [string,JsonObject[]][]){const p=await f.prepare(operations,action);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);assert.equal((await f.service.verifyWrite(actor,p.data.review_id)).status,'verified');}
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
});

test('verification cache and native bypass cannot override current access',async()=>{
 const f=fixture();try{const r=await create(f);assert.equal((await f.execute(r)).success,true);assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'verified');const before=f.calls.length;f.store.putConnection(owner,{...f.c,scopes:[]},{accessToken:'synthetic'});await assert.rejects(()=>f.service.verifyWrite(actor,r.data.review_id),{code:'INSUFFICIENT_SCOPE'});assert.equal(f.calls.length,before);
  const bypass=await f.service.call(gateway,{action:rpc,account_id:'123',payload:{operations:[{remove:name}]},dry_run:false,confirmed:true,idempotency_key:'12345678-1234-4234-9234-123456789abc'},actor);assert.equal(bypass.error.code,'WRITE_REVIEW_REQUIRED');assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('hotel int64 criterion identities reconcile native decimal strings without reordering mutation inputs',async()=>{
 const f=fixture();try{const c={hotelLengthOfStay:{minNights:1,maxNights:7}},r=await create(f,c);assert.equal((await f.execute(r)).success,true);f.modifiers.get(name)!.hotelLengthOfStay={minNights:'1',maxNights:'7'};assert.equal((await f.service.verifyWrite(actor,r.data.review_id)).status,'verified');assert.equal((await f.prepare([{create:{adGroup:group,bidModifier:1.3,...c}}])).error.code,'BID_MODIFIER_EXISTS');assert.equal(f.calls.find(c=>!c.path.endsWith('/googleAds:search'))!.body.operations[0].create.hotelLengthOfStay.minNights,1);
 }finally{f.store.close();}
});

test('malformed continuation, counts, unknown envelopes and byte/time budgets fail before a state can be used',async t=>{
 const f=fixture();try{const plan=f.service.compiler.compile(gateway,{action:rpc,account_id:'123',payload:{operations:[{create:{adGroup:group,bidModifier:1.2,...criteria[0]}}]}},{mode:'strict',flags:{}}),read=googleBidSnapshots(plan)[0]!;
  for(const mode of ['unknown','count','cursor_type','loop','pages','response_bytes','total_bytes','deadline']){let calls=0,elapsed=0;t.mock.method(performance,'now',()=>elapsed);
   await assert.rejects(()=>readGoogleBidState(read,async()=>{calls++;const data:JsonObject={results:[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC'}}]};
    if(mode==='unknown')data.partialResults=true;if(mode==='count')data.totalResultsCount='2';if(mode==='cursor_type')data.nextPageToken=0;if(mode==='loop'||mode==='pages')data.nextPageToken=mode==='loop'?'same':String(calls);if(mode==='response_bytes'||mode==='total_bytes'){data.fieldMask='x'.repeat((mode==='response_bytes'?4:3)*1024*1024);if(mode==='total_bytes')data.nextPageToken=String(calls);}if(mode==='deadline')elapsed=60001;return {status:200,headers:{},data};
   }),{code:'BID_MODIFIER_STATE_UNVERIFIED'},mode);
   assert.equal(calls,mode==='pages'?25:mode==='loop'?2:mode==='total_bytes'?3:1,mode);t.mock.restoreAll();
  }
 }finally{t.mock.restoreAll();f.store.close();}
});

test('capacity considers all creates in a batch and never mistakes a set of 1000 for an incomplete page',async()=>{
 const f=fixture();try{for(let i=0;i<1000;i++){const id=res('adGroupBidModifiers','200~'+(1000+i));f.modifiers.set(id,{resourceName:id,adGroup:group,baseAdGroup:group,criterionId:String(1000+i),bidModifier:1.2,bidModifierSource:'AD_GROUP',hotelAdvanceBookingWindow:{minDays:String(i),maxDays:String(i+1)}});}
  const target=res('adGroupBidModifiers','200~1000'),r=await f.prepare([{update:{resourceName:target,bidModifier:1.3},updateMask:'bidModifier'}]);assert.equal(r.success,true,JSON.stringify(r));
  const p=f.service.compiler.compile(gateway,{action:rpc,account_id:'123',payload:{operations:[{create:{adGroup:group,bidModifier:1.2,...criteria[0]}},{create:{adGroup:group,bidModifier:1.2,...criteria[1]}}]}},{mode:'strict',flags:{}});
  const state=r.data.before_state[0];assert.equal(Object.keys(state.modifiers).length,1000);delete state.modifiers[res('adGroupBidModifiers','200~1999')];assert.throws(()=>googleBidPrerequisites(p,[state]),{code:'INVALID_BID_MODIFIER'});delete state.modifiers[res('adGroupBidModifiers','200~1998')];assert.doesNotThrow(()=>googleBidPrerequisites(p,[state]));
  const extra=res('adGroupBidModifiers','200~2000');f.modifiers.set(extra,{...f.modifiers.get(target),resourceName:extra,criterionId:'2000',hotelAdvanceBookingWindow:{minDays:'1000',maxDays:'1001'}});assert.equal((await f.prepare([{update:{resourceName:target,bidModifier:1.3},updateMask:'bidModifier'}])).error.code,'BID_MODIFIER_STATE_UNVERIFIED');assert.equal(f.writes(),0);
 }finally{f.store.close();}
});

test('mixed numeric criterion encodings and duplicate response criteria cannot evade identity checks',async()=>{
 const f=fixture();try{seed(f,{hotelLengthOfStay:{minNights:'1',maxNights:'7'}});const r=await f.prepare([{create:{adGroup:group,bidModifier:1.1,hotelLengthOfStay:{minNights:'01',maxNights:7}}}]);assert.equal(r.error.code,'BID_MODIFIER_EXISTS');f.modifiers.set(res('adGroupBidModifiers','200~501'),{...f.modifiers.get(name),resourceName:res('adGroupBidModifiers','200~501'),criterionId:'501'});assert.equal((await f.prepare([{remove:name}])).error.code,'BID_MODIFIER_STATE_UNVERIFIED');assert.equal(f.writes(),0);}finally{f.store.close();}
});
