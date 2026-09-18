import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService,strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {googleAssetLinkContracts,googleAssetContentFields} from '../src/google-asset-links.js';
import {saveSpendPolicy,checkSpendPolicy} from '../src/spend-policy.js';
import {Compiler} from '../src/compiler.js';
import type {JsonObject} from '../src/types.js';

const registry=new Registry(),gateway='google_ads_native_action',actor={tenantId:'asset-links',userId:'writer',role:'operator' as const},admin={...actor,role:'admin' as const};
const n=(kind:string,id:string)=>'customers/123/'+kind+'/'+id;
const actions:Record<string,string>={campaignAssets:'google_ads_v23_campaign_asset_mutate_campaign_assets',adGroupAssets:'google_ads_v23_ad_group_asset_mutate_ad_group_assets',customerAssets:'google_ads_v23_customer_asset_mutate_customer_assets',assetGroupAssets:'google_ads_v23_asset_group_asset_mutate_asset_group_assets'};
const pack=Array.from({length:11},(_,i)=>({create:{campaign:n('campaigns','100'),asset:n('assets',String(200+i)),fieldType:i<6?'SITELINK':i<10?'CALLOUT':'STRUCTURED_SNIPPET'}}));
function setup(){
 const store=new Store(':memory:',Buffer.alloc(32,73).toString('base64'));store.putConnection(admin,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:[]},{accessToken:'synthetic',developerToken:'synthetic'});
 const records=new Map<string,JsonObject>([
  [n('campaigns','100'),{resourceName:n('campaigns','100'),name:'Synthetic',status:'PAUSED',advertisingChannelType:'SEARCH',campaignBudget:n('campaignBudgets','10')}],
  [n('adGroups','101'),{resourceName:n('adGroups','101'),name:'Group',status:'PAUSED',campaign:n('campaigns','100')}],
  [n('assetGroups','102'),{resourceName:n('assetGroups','102'),name:'Performance Max',status:'PAUSED',campaign:n('campaigns','100')}],
  ...pack.map((op,i)=>[op.create.asset,{resourceName:op.create.asset,type:op.create.fieldType,source:'ADVERTISER',finalUrls:['https://example.test/'+i],...(i<6?{sitelinkAsset:{linkText:'Sitelink '+i,description1:'First line',description2:'Second line'}}:i<10?{calloutAsset:{calloutText:'Callout '+i}}:{structuredSnippetAsset:{header:'Types',values:['First','Second','Third']}})}] as [string,JsonObject]),
  [n('assets','300'),{resourceName:n('assets','300'),type:'TEXT',source:'ADVERTISER',textAsset:{text:'Example headline'}}]
 ]);
 let writes=0,reads=0,mode='',omitEmpty=true;const calls:JsonObject[]=[];
 const service=new MirrorService(registry,store,new NativeTransport(async(url,init)=>{
  const path=new URL(String(url)).pathname,b=JSON.parse(String(init?.body));calls.push({path,body:b});
  if(path.endsWith('googleAds:search')){
   reads++;const entity=b.query.match(/ FROM ([a-z_]+)/)[1],key=entity.replace(/_([a-z])/g,(_:string,c:string)=>c.toUpperCase()),names=[...b.query.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]);
   const rows:JsonObject[]=entity==='customer'?[{customer:{id:'123',currencyCode:'USD',timeZone:'UTC'}}]:names.filter(name=>records.has(name)).map(name=>({[key]:structuredClone(records.get(name)!)}));
   if(mode==='empty_object'&&entity.endsWith('_asset'))return Response.json({});
   if(mode==='foreign'&&entity.endsWith('_asset'))rows.push({[key]:{resourceName:'customers/999/campaignAssets/100~200~SITELINK'}});
   if(mode==='duplicate'&&rows.length)rows.push(rows[0]!);
   const data:JsonObject={...(!omitEmpty||rows.length?{results:rows}:{}),fieldMask:b.query.split(' FROM')[0].slice(7),queryResourceConsumption:String(reads*13),futureQueryTelemetry:reads};
   if(mode==='pagination')data.nextPageToken='unread-page';if(mode==='read_error')data.error={code:403};
   return Response.json(data);
  }
  writes++;const kind=path.match(/\/([^/]+):mutate$/)![1],cfg=googleAssetLinkContracts[kind as keyof typeof googleAssetLinkContracts];
  const results=b.operations.map((op:JsonObject)=>{const r=op.create??op.update,name=op.remove??op.update?.resourceName??n(kind!,[...(cfg.parent?[r[cfg.parent].split('/').at(-1)]:[]),r.asset.split('/').at(-1),r.fieldType].join('~'));
   if(op.remove)records.delete(name);else records.set(name,{...records.get(name),...r,resourceName:name,status:r.status??'ENABLED'});
   return {resourceName:mode==='wrong_receipt'?name.replace('~200~','~999~'):name};
  });return Response.json({results:mode==='partial_receipt'?results.slice(1):results});
 }),undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(kind='campaignAssets',operations:JsonObject[]=pack,legacy?:string)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action:legacy??actions[kind],account_id:'123',payload:{operations,partialFailure:false}}},actor);
 const execute=(p:JsonObject)=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,spend_change_confirmed:true},actor);
 return {store,service,records,calls,prepare,execute,writes:()=>writes,reads:()=>reads,mode:(value:string)=>{mode=value;},explicitEmpty:()=>{omitEmpty=false;}};
}
for(const surface of ['rpc','legacy'])test('Google eleven-asset pack links and verifies all six sitelinks, four callouts and snippet: '+surface,async()=>{
 const x=setup();try{
  const inspected=await x.service.call('amcp_write',{action:'inspect',gateway,arguments:{action:surface==='rpc'?actions.campaignAssets:'CREATE_CAMPAIGN_ASSET',account_id:'123',payload:{operations:pack}}},actor);
  assert.equal(inspected.data.review_contract_supported,true,JSON.stringify(inspected));assert.equal(x.reads(),0);
  const p=await x.prepare('campaignAssets',pack,surface==='legacy'?'CREATE_CAMPAIGN_ASSET':undefined);assert.equal(p.success,true,JSON.stringify(p));assert.equal(x.writes(),0);
  assert.equal(x.reads(),5,'one link query, one campaign, three asset-type batches');
  assert.ok(x.calls.some(c=>c.body.query?.includes('asset.sitelink_asset.description1')));
  assert.ok(x.calls.every(c=>!c.body.query?.includes('metrics.')));
  const e=await x.execute(p);assert.equal(e.success,true,JSON.stringify(e));assert.equal(x.writes(),1);
  assert.equal((await x.execute(p)).data.replayed,true);assert.equal(x.writes(),1);
  const verified=await x.service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
  assert.equal(verified.data.status,'verified',JSON.stringify(verified));assert.equal(verified.data.checks.length,11);assert.equal(x.writes(),1);
 }finally{x.store.close();}
});

test('Google implicit enabled asset associations require separate spend confirmation',async()=>{
 const x=setup();try{const p=await x.prepare();assert.equal(p.success,true,JSON.stringify(p));const denied=await x.service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);assert.equal(denied.error.code,'SPEND_CONFIRMATION_REQUIRED');assert.equal(x.writes(),0);}finally{x.store.close();}
});
for(const kind of Object.keys(actions))test('Google asset associations create, update status and verify removal at '+kind,async()=>{
 const x=setup();try{
  const cfg=googleAssetLinkContracts[kind as keyof typeof googleAssetLinkContracts],r:JsonObject={asset:n('assets',kind==='assetGroupAssets'?'300':'200'),fieldType:kind==='assetGroupAssets'?'HEADLINE':'SITELINK',status:'PAUSED',...(cfg.parent?{[cfg.parent]:n(cfg.collection,kind==='campaignAssets'?'100':kind==='adGroupAssets'?'101':'102')}:{})};
  const p=await x.prepare(kind,[{create:r}]);assert.equal(p.success,true,JSON.stringify(p));const e=await x.execute(p);assert.equal(e.success,true,JSON.stringify(e));
  const name=e.data.data.results[0].resourceName;
  const u=await x.prepare(kind,[{update:{resource_name:name,status:'ENABLED'},update_mask:'status'}]);assert.equal(u.success,true,JSON.stringify(u));assert.equal((await x.execute(u)).success,true);
  const uv=await x.service.call('amcp_campaign',{action:'verify',review_id:u.data.review_id},actor);assert.equal(uv.data.status,'verified',JSON.stringify(uv));
  const d=await x.prepare(kind,[{remove:name}]);assert.equal(d.success,true,JSON.stringify(d));assert.equal((await x.execute(d)).success,true);
  const dv=await x.service.call('amcp_campaign',{action:'verify',review_id:d.data.review_id},actor);assert.equal(dv.data.status,'verified',JSON.stringify(dv));
 }finally{x.store.close();}
});
test('Google asset links reject malformed, cross-account, duplicated, mismatched and missing prerequisites',async()=>{
 const x=setup();try{
  for(const op of [
   {create:{...pack[0]!.create,asset:'customers/999/assets/200'}},
   {create:{...pack[0]!.create,fieldType:'HEADLINE'}},
   {create:{...pack[0]!.create,status:'REMOVED'}},
   {update:{resourceName:n('campaignAssets','100~200~SITELINK'),asset:n('assets','201')},updateMask:'asset'},
   {create:{...pack[0]!.create,resourceName:n('campaignAssets','100~200~SITELINK')}},
   {remove:n('campaignAssets','100~200')}
  ])assert.equal((await x.prepare('campaignAssets',[op])).success,false,JSON.stringify(op));
  assert.equal((await x.prepare('campaignAssets',[pack[0]!,pack[0]!])).error.code,'INVALID_ASSET_LINK');assert.equal(x.reads(),0);
  x.records.get(n('assets','200'))!.type='CALLOUT';assert.equal((await x.prepare()).error.code,'ASSET_TYPE_MISMATCH');
  x.records.delete(n('assets','200'));assert.equal((await x.prepare()).error.code,'STATE_TARGET_MISMATCH');assert.equal(x.writes(),0);
 }finally{x.store.close();}
});
for(const change of ['asset_copy','parent','association'])test('Google asset link optimistic concurrency protects '+change,async()=>{
 const x=setup();try{
  const p=await x.prepare();assert.equal(p.success,true,JSON.stringify(p));
  if(change==='asset_copy')x.records.get(n('assets','200'))!.sitelinkAsset.description1='Changed';
  else if(change==='parent')x.records.get(n('campaigns','100'))!.name='Changed';
  else x.records.set(n('campaignAssets','100~200~SITELINK'),{...pack[0]!.create,resourceName:n('campaignAssets','100~200~SITELINK'),status:'ENABLED'});
  const e=await x.execute(p);assert.equal(e.error.code,'STATE_CHANGED',JSON.stringify(e));assert.ok(e.error.details.changed_fields.length);assert.equal(x.writes(),0);
  if(change==='association')assert.equal((await x.prepare()).error.code,'ASSET_LINK_EXISTS');
 }finally{x.store.close();}
});
for(const mode of ['pagination','read_error','foreign','duplicate'])test('Google optional association reads cannot hide '+mode,async()=>{
 const x=setup();try{x.mode(mode);assert.equal((await x.prepare()).success,false);assert.equal(x.writes(),0);}finally{x.store.close();}
});
for(const mode of ['empty_object','explicit_empty'])test('Google documented ProtoJSON absence: '+mode,async()=>{
 const x=setup();try{if(mode==='explicit_empty')x.explicitEmpty();else x.mode(mode);const p=await x.prepare();assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);}finally{x.store.close();}
});
for(const mode of ['wrong_receipt','partial_receipt'])test('Google asset mutation requires all exact association receipts: '+mode,async()=>{
 const x=setup();try{const p=await x.prepare();x.mode(mode);const e=await x.execute(p);assert.equal(e.data.success,false,JSON.stringify(e));assert.equal(x.writes(),1);await x.execute(p);assert.equal(x.writes(),1);assert.equal(e.data.verification,undefined);}finally{x.store.close();}
});
test('Google default-enabled links cannot bypass the owner activation policy',async()=>{
 const x=setup();try{
  saveSpendPolicy(x.store,admin,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await x.prepare()).error.code,'POLICY_ACTIVATION_FORBIDDEN');
  const paused=pack.map(op=>({create:{...op.create,status:'PAUSED'}})),p=await x.prepare('campaignAssets',paused);assert.equal(p.success,true,JSON.stringify(p));assert.equal((await x.execute(p)).success,true);
 }finally{x.store.close();}
});
test('Google concurrent asset executions submit the frozen batch once',async()=>{
 const x=setup();try{const p=await x.prepare();const results=await Promise.all([x.execute(p),x.execute(p)]);assert.ok(results.some(r=>r.success));assert.equal(x.writes(),1);}finally{x.store.close();}
});
test('Google asset content snapshots only select fields in the pinned official GAQL reference',()=>{
 const evidence=JSON.parse(fs.readFileSync('tests/fixtures/google-asset-fields-v23.json','utf8'));
 assert.equal(evidence.source,'https://developers.google.com/google-ads/api/fields/v23/asset');assert.match(evidence.source_sha256,/^[0-9a-f]{64}$/);
 for(const field of Object.values(googleAssetContentFields).flat())assert.equal(evidence.fields[field]?.selectable,true,field);
 assert.ok(!Object.values(googleAssetContentFields).flat().includes('lead_form_asset.delivery_methods'),'linking never retrieves delivery credentials');
});

test('Google symbolic asset field types build exact legacy remove identities',()=>{
 const compiler=new Compiler(registry);
 for(const [action,parts,expected]of [
  ['REMOVE_CAMPAIGN_ASSET',{campaign_id:'100',asset_id:'200',field_type:'SITELINK'},n('campaignAssets','100~200~SITELINK')],
  ['REMOVE_AD_GROUP_ASSET',{ad_group_id:'101',asset_id:'200',field_type:'SITELINK'},n('adGroupAssets','101~200~SITELINK')],
  ['REMOVE_CUSTOMER_ASSET',{asset_id:'200',field_type:'SITELINK'},n('customerAssets','200~SITELINK')],
  ['REMOVE_ASSET_GROUP_ASSET',{asset_group_id:'102',asset_id:'300',field_type:'HEADLINE'},n('assetGroupAssets','102~300~HEADLINE')]
 ] as const){
  const p=compiler.compile(gateway,{action,account_id:'123',payload:parts},strictOptions);assert.equal((p.body as JsonObject).operations[0].remove,expected);
  assert.throws(()=>compiler.compile(gateway,{action,account_id:'123',payload:{...parts,field_type:'INVENTED'}},strictOptions),{code:'INVALID_RESOURCE_ID'});
 }
});

test('Google POST removals enforce current deletion policy, including older frozen risk flags',async()=>{
 const x=setup();try{
  const p=await x.prepare();assert.equal((await x.execute(p)).success,true);
  const target=n('campaignAssets','100~200~SITELINK'),r=await x.prepare('campaignAssets',[{remove:target}]);assert.equal(r.success,true,JSON.stringify(r));
  const review=x.store.document(actor.tenantId,'write_review',r.data.review_id);assert.equal(review.plan.destructive,true);
  saveSpendPolicy(x.store,admin,{gateway,account_id:'123',confirmed:true,policy:{allow_deletion:false}});
  assert.equal((await x.execute(r)).error.code,'POLICY_DELETION_FORBIDDEN');assert.equal(x.writes(),1);
  assert.throws(()=>checkSpendPolicy(x.store,actor,{...review.plan,destructive:false},review.state),{code:'POLICY_DELETION_FORBIDDEN'});
 }finally{x.store.close();}
});
