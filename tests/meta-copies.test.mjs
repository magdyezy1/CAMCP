import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Meta native copies (Marketing API reference, checked 2026-09-26): paused shallow campaign copies, paused ad set
 * copies with up to three ads, and paused ad copies into owned targets. Meta rejects fields a node type lacks, so
 * a source read with type-specific fields proves the copied type. Copied budgets count as new budgets.
 */
const META='66666666-6666-4666-8666-666666666666',gateway='meta_native_action',account='123';
const actor={tenantId:'meta-copies',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,64).toString('base64');
const seed=()=>new Map(Object.entries({
 100:{type:'campaign',id:'100',account_id:account,name:'Leads',status:'ACTIVE',objective:'OUTCOME_LEADS',daily_budget:'5000'},
 101:{type:'campaign',id:'101',account_id:account,name:'Target',status:'PAUSED',objective:'OUTCOME_LEADS'},
 200:{type:'adset',id:'200',account_id:account,campaign_id:'100',name:'Riyadh',status:'ACTIVE',optimization_goal:'LEAD_GENERATION',daily_budget:'2000'},
 201:{type:'adset',id:'201',account_id:account,campaign_id:'101',name:'Target set',status:'PAUSED',optimization_goal:'LEAD_GENERATION'},
 300:{type:'ad',id:'300',account_id:account,campaign_id:'100',adset_id:'200',name:'Video A',status:'ACTIVE'},
 301:{type:'ad',id:'301',account_id:account,campaign_id:'100',adset_id:'200',name:'Video B',status:'ACTIVE'},
 900:{type:'adset',id:'900',account_id:'999',campaign_id:'990',name:'Elsewhere',status:'PAUSED',optimization_goal:'REACH'}}));
const only={campaign:['objective'],adset:['optimization_goal'],ad:['adset_id']};
function fixture({extraAds=0}={}){
 const store=new Store(':memory:',key),connection={id:META,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Meta',scopes:['ads_management']};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const rows=seed();for(let i=0;i<extraAds;i++)rows.set(String(310+i),{type:'ad',id:String(310+i),account_id:account,campaign_id:'100',adset_id:'200',name:'Extra '+i,status:'ACTIVE'});
 const requests=[],writes=[];let next=1000,mode='';
 const own=(...ids)=>{for(const id of ids)store.rememberResource(connection,account,id);};
 const transport=new NativeTransport(async(raw,init={})=>{
  const url=new URL(String(raw)),path=url.pathname,method=init.method??'GET';requests.push(method+' '+path);let m;
  if(method==='GET'&&(m=/^\/v25\.0\/(\d+)\/ads$/.exec(path))){assert.equal(url.searchParams.get('fields'),'id,adset_id');return Response.json({data:[...rows.values()].filter(r=>r.type==='ad'&&r.adset_id===m[1]).map(r=>({id:r.id,adset_id:r.adset_id})),paging:{cursors:{before:'b',after:'a'}}});}
  if(method==='GET'&&(m=/^\/v25\.0\/(\d+)$/.exec(path))){const row=rows.get(m[1]);if(!row)return Response.json({error:{message:'Unsupported get request.',code:100}},{status:400});
   const fields=url.searchParams.get('fields').split(','),wrong=fields.find(f=>Object.entries(only).some(([t,list])=>t!==row.type&&list.includes(f)&&!(row.type==='ad'&&f==='adset_id')));
   if(wrong)return Response.json({error:{message:'(#100) Tried accessing nonexisting field ('+wrong+') on node type ('+row.type+')',code:100}},{status:400});
   return Response.json(Object.fromEntries(fields.filter(f=>row[f]!==undefined).map(f=>[f,row[f]])));}
  if(method==='POST'&&(m=/^\/v25\.0\/(\d+)\/copies$/.exec(path))){writes.push(path);const b=Object.fromEntries(new URLSearchParams(String(init.body))),source=rows.get(m[1]);
   const copy=(row,extra)=>{const id=String(next++);rows.set(id,{...row,...extra,id,status:mode==='active_copy'?'ACTIVE':b.status_option,name:row.name+' - Copy'});return id;};
   let receipt;
   if(source.type==='campaign'){const id=copy(source,{});receipt={copied_campaign_id:id,ad_object_ids:[{ad_object_type:'campaign',source_id:source.id,copied_id:id}]};}
   else if(source.type==='adset'){const id=copy(source,{campaign_id:b.campaign_id??source.campaign_id}),ads=b.deep_copy==='true'?[...rows.values()].filter(r=>r.type==='ad'&&r.adset_id===source.id&&!r.copied):[];
    const ids=ads.map(ad=>({ad_object_type:'ad',source_id:ad.id,copied_id:copy(ad,{adset_id:id,copied:true})}));receipt={copied_adset_id:id,ad_object_ids:[{ad_object_type:'ad_set',source_id:source.id,copied_id:id},...(mode==='drop_child'?ids.slice(1):ids)]};}
   else{const id=copy(source,{adset_id:b.adset_id??source.adset_id,copied:true});receipt={copied_ad_id:id};}
   if(mode==='lost')throw new Error('Synthetic accepted response lost');
   if(mode==='error')return Response.json({error:{message:'Synthetic rejection',code:100}},{status:400});
   return Response.json(mode==='empty_receipt'?{}:receipt);}
  throw new Error('Unexpected Meta request '+method+' '+path);
 });
 const start=()=>new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 let service=start();
 const call=(tool,input)=>service.call(tool,input,actor);
 const prepare=(action,path_params,payload)=>call('amcp_write',{action:'prepare',gateway,connection_id:META,arguments:{action,account_id:account,path_params,payload}});
 const execute=id=>call('amcp_write',{action:'execute',review_id:id,idempotency_key:id,confirmed:true});
 const verify=id=>call('amcp_campaign',{action:'verify',review_id:id});
 return {store,rows,requests,writes,own,call,prepare,execute,verify,mode:v=>{mode=v;},restart:()=>{service=start();}};
}
const campaignCopy=(f,payload={status_option:'PAUSED'})=>f.prepare('meta_campaign_id_copies_copy',{campaign_id:'100'},payload);
const adsetCopy=(f,payload)=>f.prepare('meta_ad_set_id_copies_copy',{ad_set_id:'200'},payload);

test('campaign, ad set and ad copies are a reviewed Meta family',async()=>{
 const f=fixture();try{
  for(const [action,params] of [['meta_campaign_id_copies_copy',{campaign_id:'100'}],['meta_ad_set_id_copies_copy',{ad_set_id:'200'}],['meta_ad_id_copies_copy',{ad_id:'300'}]]){
   const inspected=await f.call('amcp_write',{action:'inspect',gateway,connection_id:META,arguments:{action,account_id:account,path_params:params,payload:{status_option:'PAUSED'}}});
   assert.equal(inspected.data.review_contract_supported,true,action+' '+JSON.stringify(inspected));
  }
  assert.equal(f.requests.length,0);
 }finally{f.store.close();}
});

test('only paused, documented, non-overriding copies are accepted, before any request',async()=>{
 const f=fixture();f.own('100','200','300','101','201');try{
  const cases=[['meta_campaign_id_copies_copy',{campaign_id:'100'},{}],['meta_campaign_id_copies_copy',{campaign_id:'100'},{status_option:'ACTIVE'}],['meta_campaign_id_copies_copy',{campaign_id:'100'},{status_option:'INHERITED_FROM_SOURCE'}],
   ['meta_campaign_id_copies_copy',{campaign_id:'100'},{status_option:'PAUSED',deep_copy:true}],['meta_campaign_id_copies_copy',{campaign_id:'100'},{status_option:'PAUSED',parameter_overrides:{name:'x'}}],
   ['meta_campaign_id_copies_copy',{campaign_id:'100'},{status_option:'PAUSED',start_time:1790400000}],['meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',creative_parameters:{name:'x'}}],
   ['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',create_dco_adset:true}],['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',campaign_id:'act_101'}],
   ['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',deep_copy:'yes'}],['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',start_time:-1}],
   ['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',start_time:1790400000,end_time:1790300000}],['meta_ad_set_id_copies_copy',{ad_set_id:'200'},{status_option:'PAUSED',start_time:'2026-10-01'}],
   ['meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',rename_options:{rename_strategy:'RENAME_ALL'}}],['meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',rename_options:{rename_prefix:'x'.repeat(101)}}],
   ['meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',rename_options:{prefix:'x'}}],['meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',rename_options:'x'}]];
  for(const [action,params,payload] of cases){const r=await f.prepare(action,params,payload);assert.equal(r.error?.code,'INVALID_META_COPY',action+' '+JSON.stringify(payload)+': '+JSON.stringify(r.error??r.data).slice(0,300));}
  assert.equal(f.requests.length,0,'validation happens before any read or write');
 }finally{f.store.close();}
});

test('a campaign copy needs an owned source, copies once, reports the copied budget and verifies paused',async()=>{
 const f=fixture();try{
  const blind=await campaignCopy(f);assert.equal(blind.error.code,'RESOURCE_SCOPE_REQUIRED');f.own('100');
  const p=await campaignCopy(f,{status_option:'PAUSED',rename_options:{rename_strategy:'ONLY_TOP_LEVEL_RENAME',rename_suffix:' - clone'}});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v25.0/100']);
  const impact=p.data.creative_impact;assert.equal(impact.may_activate,false);assert.deepEqual(impact.budgets_copied,[{field:'daily_budget',amount:'5000'}]);assert.equal(impact.copies_expected,1);
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));
  assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.deepEqual(f.writes,['/v25.0/100/copies']);
 }finally{f.store.close();}
});

test('copied budgets are new budgets under the owner spending policy',async()=>{
 const f=fixture();f.own('100');try{
  saveSpendPolicy(f.store,owner,{scope:'workspace',confirmed:true,policy:{max_budget_native:4000}});
  const r=await campaignCopy(f);assert.equal(r.error?.code,'POLICY_BUDGET_LIMIT',JSON.stringify(r));assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('an ad set copy with its ads lands in the owned target campaign, and every copy verifies',async()=>{
 const f=fixture();f.own('200','101');try{
  const p=await adsetCopy(f,{status_option:'PAUSED',campaign_id:'101',deep_copy:true});assert.equal(p.success,true,JSON.stringify(p));
  assert.deepEqual(p.data.state_reads.map(r=>r.path),['/v25.0/200','/v25.0/101','/v25.0/200/ads']);
  assert.equal(p.data.creative_impact.copies_expected,3);assert.equal(p.data.creative_impact.campaign_id,'101');
  const done=await f.execute(p.data.review_id);assert.equal(done.success,true,JSON.stringify(done));
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.equal(verified.data.checks.length,3);
  const copied=done.data.data.copied_adset_id;assert.equal(f.rows.get(copied).campaign_id,'101');
 }finally{f.store.close();}
});

test('deep copies above the synchronous limit, foreign targets and mistyped sources are refused before any write',async()=>{
 const f=fixture({extraAds:2});f.own('200','900','201');try{
  const large=await adsetCopy(f,{status_option:'PAUSED',deep_copy:true});assert.equal(large.error.code,'META_COPY_TOO_LARGE',JSON.stringify(large));assert.deepEqual(large.error.details,{children:4,limit:3});
  const foreign=await f.prepare('meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',adset_id:'900'});assert.equal(foreign.error.code,'RESOURCE_SCOPE_REQUIRED','the source ad itself is not owned yet');
  f.own('300');const moved=await f.prepare('meta_ad_id_copies_copy',{ad_id:'300'},{status_option:'PAUSED',adset_id:'900'});assert.equal(moved.error.code,'STATE_TARGET_MISMATCH',JSON.stringify(moved));
  // A campaign-only field on an ad set ID is rejected by Meta during the source read.
  const mistyped=await f.prepare('meta_campaign_id_copies_copy',{campaign_id:'200'},{status_option:'PAUSED'});assert.equal(mistyped.error.code,'UPSTREAM_ERROR');
  assert.match(mistyped.error.details.upstream.error.message,/nonexisting field \(objective\)/);
  assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});

test('a deep copy that returns fewer copied ads, or a copy that reads back active, is not verified',async()=>{
 for(const [mode,status,code] of [['drop_child','unverified','META_COPY_INCOMPLETE'],['active_copy','inconclusive','VERIFICATION_INCONCLUSIVE']]){const f=fixture();f.own('200');try{
  const p=await adsetCopy(f,{status_option:'PAUSED',deep_copy:true});f.mode(mode);assert.equal((await f.execute(p.data.review_id)).success,true,mode);
  const verified=await f.verify(p.data.review_id);assert.equal(verified.data.status,status,mode+' '+JSON.stringify(verified));assert.equal(verified.data.code??verified.data.checks[0].code,code,mode);
 }finally{f.store.close();}}
});

test('rejected, empty or lost copy receipts never submit a second copy',async()=>{
 for(const mode of ['error','empty_receipt','lost']){const f=fixture();f.own('100');try{
  const p=await campaignCopy(f);assert.equal(p.success,true,mode);
  // A Meta-declared error is reported once; its outcome is then held as uncertain, never retried.
  const [first,again]={error:['UPSTREAM_ERROR','WRITE_OUTCOME_UNCERTAIN'],empty_receipt:['WRITE_PARTIAL_OR_FAILED','WRITE_PARTIAL_OR_FAILED'],lost:['WRITE_OUTCOME_UNCERTAIN','WRITE_OUTCOME_UNCERTAIN']}[mode];
  f.mode(mode);assert.equal((await f.execute(p.data.review_id)).error?.code,first,mode);f.mode('');
  assert.equal((await f.execute(p.data.review_id)).error?.code,again,mode);assert.equal(f.writes.length,1,mode);
  assert.notEqual((await f.verify(p.data.review_id)).data?.status,'verified',mode);
 }finally{f.store.close();}}
});

test('copy claims survive concurrent execution and restart',async()=>{
 const f=fixture();f.own('100');try{
  const p=await campaignCopy(f);
  const results=await Promise.all([f.execute(p.data.review_id),f.execute(p.data.review_id)]);assert.ok(results.some(r=>r.success));assert.equal(f.writes.length,1);
  f.restart();assert.equal((await f.execute(p.data.review_id)).data.replayed,true);assert.equal((await f.verify(p.data.review_id)).data.status,'verified');assert.equal(f.writes.length,1);
 }finally{f.store.close();}
});
