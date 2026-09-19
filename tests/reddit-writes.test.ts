import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {JsonObject} from '../src/types.js';
import {redditSnapshots,validateRedditState} from '../src/reddit-writes.js';
const gateway='reddit_native_action',actor={tenantId:'reddit-writes',userId:'u',role:'operator' as const},admin={...actor,role:'admin' as const},registry=new Registry();
const campaign={name:'Campaign',configured_status:'PAUSED',objective:'CLICKS'};
function fixture(options:{scopes?:readonly string[];grant?:boolean;badReceipt?:boolean}={}){
 const store=new Store(':memory:',Buffer.alloc(32,74).toString('base64')),c={id:'r',tenantId:actor.tenantId,gateway,accounts:['a2_111'],writeAccounts:options.grant===false?[]:['a2_111'],enabled:true,label:'Synthetic',scopes:[...(options.scopes??['adsread','adsedit'])],userAgent:'server:amcp-tests:0.1.0 (local mock)'};
 store.putConnection(admin,c,{accessToken:'synthetic'});store.rememberResource(c,'a2_111','posts/t3_123');
 const state=new Map<string,JsonObject>(),calls:JsonObject[]=[];let writes=0;
 const ids:Record<string,string>={campaigns:'100',ad_groups:'200',ads:'300',saved_audiences:'400'};
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname,method=init?.method??'GET';calls.push({path,method});
  if(method==='GET'){
   const reply=(data:JsonObject)=>Response.json({data,futureEnvelopeTelemetry:{cost:calls.length},request_id:String(calls.length)});
   if(path==='/api/v3/ad_accounts/a2_111')return reply({id:'a2_111',name:'Account'});
   if(path==='/api/v3/posts/t3_123')return reply({id:'t3_123',profile_id:'t2_123',type:'TEXT',headline:'Fixture post',body:'Fixture body',allow_comments:false});
   if(path==='/api/v3/ad_accounts/a2_111/profiles')return Response.json({data:[{id:'123',reddit_user_id:'t2_123',business_id:'business'}],pagination:{next_url:null}});
   const d=state.get(path);assert.ok(d,'Missing fixture state '+path);return reply(d);
  }
  writes++;const b=JSON.parse(String(init?.body)).data,kind=method==='POST'?path.split('/').at(-1)!:path.split('/').at(-2)!,id=method==='POST'?ids[kind]!:path.split('/').at(-1)!,target='/api/v3/'+kind+'/'+id;
  const d={...state.get(target),...b,id,ad_account_id:'a2_111'};state.set(target,d);
  return Response.json({data:options.badReceipt?{...d,ad_account_id:'a2_999'}:d},{status:method==='POST'?201:200});
 }),undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const prepare=(action:string,data:JsonObject,params:JsonObject={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{operation:action.includes('AUDIENCE')?'reddit_account_ops':'reddit_campaign_ops',arguments:{action,account_id:'a2_111',payload:{data},params}}},actor);
 const execute=(p:JsonObject)=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);
 return {store,c,service,state,calls,prepare,execute,writes:()=>writes};
}
test('Reddit campaign, saved audience, ad group and existing-post ad chain binds every created parent immediately',async(t)=>{
 t.mock.timers.enable({apis:['Date']});
 const f=fixture();try{
  const steps:[string,JsonObject][]=[['CREATE_CAMPAIGN',campaign],['CREATE_SAVED_AUDIENCE',{name:'Saved targeting',type:'REDDIT_AUDIENCE',targeting:{keywords:['travel']}}],['CREATE_AD_GROUP',{name:'Group',configured_status:'PAUSED',campaign_id:'100',saved_audience_id:'400',conversion_pixel_id:'pixel123',bid_strategy:'MANUAL_BIDDING',bid_type:'CPC',bid_value:1000000}],['CREATE_AD',{name:'Example ad',configured_status:'PAUSED',ad_group_id:'200',post_id:'t3_123'}]];
  for(const [action,data]of steps){t.mock.timers.tick(3000);const p=await f.prepare(action,data);assert.equal(p.success,true,JSON.stringify(p));const e=await f.execute(p);assert.equal(e.success,true,JSON.stringify(e));assert.equal((await f.execute(p)).data.replayed,true);}
  assert.equal(f.writes(),4);for(const [kind,id]of [['campaigns','100'],['saved_audiences','400'],['ad_groups','200'],['ads','300']])assert.equal(f.store.ownsResource(f.c,'a2_111',kind+'/'+id),true);
  for(const [action,param,id]of [['UPDATE_CAMPAIGN','campaign_id','100'],['UPDATE_AD_GROUP','ad_group_id','200'],['UPDATE_AD','ad_id','300'],['UPDATE_SAVED_AUDIENCE','saved_audience_id','400']]){
   t.mock.timers.tick(3000);const p=await f.prepare(action!,action!.includes('AUDIENCE')?{targeting:{keywords:['travel','hotel']}}:{configured_status:'DELETED'},{[param!]:id});assert.equal(p.success,true,JSON.stringify(p));assert.equal((await f.execute(p)).success,true);
  }assert.equal(f.writes(),8);
 }finally{f.store.close();}
});
test('Reddit review catches changed configuration and rejects missing grants, missing scopes and unqualified create types',async()=>{
 const f=fixture();try{
  await f.execute(await f.prepare('CREATE_CAMPAIGN',campaign));
  const p=await f.prepare('UPDATE_CAMPAIGN',{name:'Rename'},{campaign_id:'100'});assert.equal(p.success,true,JSON.stringify(p));f.state.get('/api/v3/campaigns/100')!.name='Changed';
  const e=await f.execute(p);assert.equal(e.error.code,'STATE_CHANGED');assert.ok(JSON.stringify(e.error.details.changed_fields).includes('name'));assert.equal(f.writes(),1);
  for(const d of [{...campaign,configured_status:'ACTIVE'},{...campaign,type:'AUTOMATED'},{...campaign,is_campaign_budget_optimization:true}])assert.equal((await f.prepare('CREATE_CAMPAIGN',d)).success,false);
  assert.equal((await f.prepare('UPDATE_AD',{name:'Unknown'},{ad_id:'999'})).error.code,'RESOURCE_SCOPE_REQUIRED');
 }finally{f.store.close();}
 for(const [options,code]of [[{grant:false},'WRITE_ACCOUNT_FORBIDDEN'],[{scopes:['adsread']},'INSUFFICIENT_SCOPE']] as const){const x=fixture(options);try{assert.equal((await x.prepare('CREATE_CAMPAIGN',campaign)).error.code,code);assert.equal(x.calls.length,0);}finally{x.store.close();}}
});
test('Reddit mismatched mutation receipts never register resource ownership or report success',async()=>{
 const f=fixture({badReceipt:true});try{const p=await f.prepare('CREATE_CAMPAIGN',campaign);assert.equal(p.success,true,JSON.stringify(p));const e=await f.execute(p);assert.equal(e.success,false);assert.equal(f.store.ownsResource(f.c,'a2_111','campaigns/100'),false);assert.equal(f.writes(),1);await f.execute(p);assert.equal(f.writes(),1);}finally{f.store.close();}
});
test('Reddit audience extensions are discoverable without modifying captured metadata',()=>{
 const tool=registry.tools.get(gateway)!,runtime=tool.operations!.find(o=>o.operation==='reddit_account_ops')!,captured=registry.data.tools.find(t=>t.name===gateway)!.operations!.find(o=>o.operation==='reddit_account_ops')!;
 assert.ok(runtime.argumentsSchema.properties.action.enum.includes('CREATE_SAVED_AUDIENCE'));assert.ok(!captured.argumentsSchema.properties.action.enum.includes('CREATE_SAVED_AUDIENCE'));
 assert.ok(registry.help({gateway,operation:'reddit_account_ops'},{mode:'strict',flags:{}}).argumentsSchema.properties.action.enum.includes('UPDATE_SAVED_AUDIENCE'));
});
test('Reddit funding reviews use the documented filtered account collection and require its exact target',()=>{
 const f=fixture();try{
  const p=f.service.delegatedCompiler.compile(gateway,{operation:'reddit_campaign_ops',arguments:{action:'CREATE_CAMPAIGN',account_id:'a2_111',payload:{data:campaign}}});p.body={data:{...campaign,funding_instrument_id:'500'}};
  const read=redditSnapshots(p).at(-1)!;assert.equal(read.path,'/api/v3/ad_accounts/a2_111/funding_instruments');assert.deepEqual(read.query,{funding_instrument_ids:'500',mode:'ALL'});
  validateRedditState(read,{status:200,headers:{},data:{data:[{id:'500',ad_account_id:'a2_111'}]}});
  assert.throws(()=>validateRedditState(read,{status:200,headers:{},data:{data:[{id:'501'}]}}),/funding instrument/);
 }finally{f.store.close();}
});
