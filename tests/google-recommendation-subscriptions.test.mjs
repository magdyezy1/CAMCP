import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Auto-apply recommendation subscriptions, Google Ads API v23 (pinned Discovery document:
 * RecommendationSubscriptionService.MutateRecommendationSubscription; checked 2026-09-27).
 */
const gateway='google_ads_native_action',registry=new Registry(),C='customers/123/';
const actions={v23:'google_ads_v23_recommendation_subscription_mutate_recommendation_subscription',subscribe:'SUBSCRIBE_RECOMMENDATION',unsubscribe:'UNSUBSCRIBE_RECOMMENDATION',update:'UPDATE_RECOMMENDATION_SUBSCRIPTION'};
const actor={tenantId:'google-subscriptions',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const name=type=>C+'recommendationSubscriptions/'+type;
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,92).toString('base64')),calls=[];let writes=0;
 store.putConnection(owner,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Google Ads',scopes:['https://www.googleapis.com/auth/adwords']},{accessToken:'synthetic',developerToken:'synthetic'});
 const subscriptions=new Map([['KEYWORD','PAUSED'],['CAMPAIGN_BUDGET','ENABLED']]);
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=decodeURIComponent(u.pathname),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});
  if(path==='/v23/customers/123/googleAds:search'){
   if(/FROM recommendation_subscription/.test(body.query))return Response.json({results:[...subscriptions].map(([type,status])=>({recommendationSubscription:{resourceName:name(type),type,status}}))});
   throw new Error('Unexpected query '+body.query);
  }
  if(path==='/v23/customers/123/recommendationSubscriptions:mutateRecommendationSubscription'){
   writes++;
   return Response.json({results:body.operations.map(op=>{
    const type=op.create?op.create.type:op.update.resourceName.split('/').at(-1),status=(op.create??op.update).status;
    if(mode!=='ignore')subscriptions.set(type,status);
    return {resourceName:mode==='other'?name('TEXT_AD'):name(type)};
   })});
  }
  throw new Error('Unexpected '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const mutate=(operations,action=actions.v23)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload:{operations}}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,subscriptions,mutate,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('a paused subscription is created and verifies; enabling needs spending confirmation and verifies; the alias pauses it again; a replay sends nothing',async()=>{
 const f=fixture();try{
  const created=ok(await f.mutate([{create:{type:'SITELINK_ASSET',status:'PAUSED'}}],actions.subscribe));assert.equal(created.data.creative_impact.may_affect_serving,false);
  ok(await f.execute(created));assert.equal(ok(await f.verify(created)).data.status,'verified');assert.equal((await f.execute(created)).data.replayed,true);
  const enabled=ok(await f.mutate([{update:{resourceName:name('SITELINK_ASSET'),status:'ENABLED'},updateMask:'status'}],actions.update));assert.match(enabled.data.creative_impact.effect,/automatically and without a review/);
  assert.equal((await f.execute(enabled)).error?.code,'SPEND_CONFIRMATION_REQUIRED');ok(await f.execute(enabled,{spend_change_confirmed:true}));assert.equal(ok(await f.verify(enabled)).data.status,'verified');
  const paused=ok(await f.mutate([{update:{resourceName:name('SITELINK_ASSET'),status:'PAUSED'},updateMask:'status'},{update:{resourceName:name('CAMPAIGN_BUDGET'),status:'PAUSED'},updateMask:'status'}],actions.unsubscribe));
  ok(await f.execute(paused));assert.equal(ok(await f.verify(paused)).data.status,'verified');assert.equal(f.subscriptions.get('CAMPAIGN_BUDGET'),'PAUSED');
  assert.equal(f.writes(),3);
 }finally{f.store.close();}
 const g=fixture();try{
  saveSpendPolicy(g.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await g.mutate([{update:{resourceName:name('KEYWORD'),status:'ENABLED'},updateMask:'status'}])).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  ok(await g.mutate([{update:{resourceName:name('CAMPAIGN_BUDGET'),status:'PAUSED'},updateMask:'status'}]));
 }finally{g.store.close();}
});

test('malformed subscription requests are refused before any request',async()=>{
 const cases=[
  ['removal',[{remove:name('KEYWORD')}]],
  ['create names itself',[{create:{resourceName:name('TEXT_AD'),type:'TEXT_AD',status:'PAUSED'}}]],
  ['unknown status',[{create:{type:'TEXT_AD',status:'REMOVED'}}]],
  ['unspecified type',[{create:{type:'UNSPECIFIED',status:'PAUSED'}}]],
  ['type in a mask',[{update:{resourceName:name('KEYWORD'),type:'TEXT_AD'},updateMask:'type'}]],
  ['foreign subscription',[{update:{resourceName:'customers/999/recommendationSubscriptions/KEYWORD',status:'ENABLED'},updateMask:'status'}]],
  ['duplicate type',[{create:{type:'TEXT_AD',status:'PAUSED'}},{update:{resourceName:name('TEXT_AD'),status:'ENABLED'},updateMask:'status'}]],
  ['subscribe alias with update',[{update:{resourceName:name('KEYWORD'),status:'ENABLED'},updateMask:'status'}],actions.subscribe],
  ['unsubscribe alias enabling',[{update:{resourceName:name('KEYWORD'),status:'ENABLED'},updateMask:'status'}],actions.unsubscribe]
 ];
 for(const [label,ops,action] of cases){const f=fixture();try{const r=await f.mutate(ops,action);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label+': '+JSON.stringify(r).slice(0,300));}finally{f.store.close();}}
});

test('existing, missing and unchanged subscriptions are refused without writes; a receipt for another type is never resubmitted; an ignored change is not verified; the ledger lists the four writes',async()=>{
 const f=fixture();try{
  assert.equal((await f.mutate([{create:{type:'KEYWORD',status:'ENABLED'}}])).error?.code,'CONFIGURATION_EXISTS');
  assert.equal((await f.mutate([{update:{resourceName:name('TEXT_AD'),status:'ENABLED'},updateMask:'status'}])).error?.code,'STATE_NOT_FOUND');
  assert.equal((await f.mutate([{update:{resourceName:name('KEYWORD'),status:'PAUSED'},updateMask:'status'}])).error?.code,'INVALID_GOOGLE_RECOMMENDATION_SUBSCRIPTION');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 const other=fixture('other');try{const p=ok(await other.mutate([{update:{resourceName:name('KEYWORD'),status:'ENABLED'},updateMask:'status'}]));assert.equal((await other.execute(p,{spend_change_confirmed:true})).success,false);assert.equal((await other.execute(p,{spend_change_confirmed:true})).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=fixture('ignore');try{const p=ok(await ignored.mutate([{update:{resourceName:name('CAMPAIGN_BUDGET'),status:'PAUSED'},updateMask:'status'}]));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
 for(const action of Object.values(actions)){const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1,action);assert.equal(rows[0].status,'reviewed_write_family',action);assert.equal(rows[0].family,'google_recommendation_subscriptions',action);}
});
