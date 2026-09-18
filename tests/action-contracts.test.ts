import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {actionContracts,actionContractPage,actionContractSummary} from '../src/action-contracts.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {Compiler} from '../src/compiler.js';
import {strictOptions} from '../src/service.js';
import {reviewedWriteFamily} from '../src/reviewed-routes.js';
import {vendorContractInventory} from '../tools/vendor-contract-inventory.js';
import type {CompiledRequest} from '../src/types.js';
const registry=new Registry(),rows=actionContracts(registry);

test('vendor denominator includes uncatalogued operations from every pinned spec',()=>{
 const inventory=vendorContractInventory(rows);
 assert.equal(inventory.summary.length,fs.readdirSync('.mirror/VENDOR').filter(f=>f.endsWith('.json')&&f!=='lifecycle-pages.json').length);
 assert.equal(inventory.summary.filter(r=>r.gateway==='microsoft_ads_native_action').reduce((n,r)=>n+r.methods,0),291);
 assert.equal(inventory.summary.find(r=>r.source_file.endsWith('google-ads-v23.json'))!.methods,176);
 const unique=new Set(inventory.methods.map(r=>r.source_file+'/'+r.method+'/'+r.id));assert.equal(unique.size,inventory.methods.length);
 assert.ok(inventory.methods.some(r=>r.id==='AddAdExtensions'&&r.mapping_status==='no_mapped_action'));
 assert.ok(inventory.methods.some(r=>r.id==='AddCampaigns'&&r.mapping_status==='mapped'));
 assert.ok(inventory.methods.every(r=>r.qualification==='unverified'));
});
test('contract ledger covers every local catalog record, nested action enum, supplemental action and alias',()=>{
 for(const c of registry.catalogs.values())for(const a of c.actions){
  const entry=rows.find(r=>r.gateway===c.gateway&&(c.mode==='delegated'?r.operation===a.name:r.action===a.name));assert.ok(entry,c.gateway+'/'+a.name);
  if(c.mode==='direct')for(const alias of a.aliases)assert.ok(entry.aliases.includes(alias)||alias===entry.action,alias);
 }
 for(const tool of registry.tools.values())for(const op of tool.operations??[])for(const action of op.argumentsSchema.properties?.action?.enum??[op.operation])assert.ok(rows.some(r=>r.gateway===tool.name&&r.operation===op.operation&&r.action===action),tool.name+'/'+op.operation+'/'+action);
 for(const a of registry.data.supplemental)if(registry.tools.get(a.gateway!)?.mode==='direct')assert.ok(rows.some(r=>r.gateway===a.gateway&&r.action===a.name));
 assert.equal(new Set(rows.map(r=>[r.gateway,r.operation??'',r.action].join('/'))).size,rows.length);
 for(const r of rows){assert.equal(r.live_qualification,'unverified');for(const path of [r.implementation,...r.tests])if(path&&!path.includes(' / '))assert.ok(fs.existsSync(path),path);}
});
test('asset links and measurement routes appear in the same families execution uses',()=>{
 for(const [gateway,action,family]of [
  ['google_ads_native_action','google_ads_v23_campaign_asset_mutate_campaign_assets','google_asset_links'],
  ['google_ads_native_action','CREATE_CAMPAIGN_ASSET','google_asset_links'],
  ['ga4_native_action','ga4_create_audience_export','ga4_export_jobs'],
  ['gtm_native_action','CREATE_TAG','gtm_entities'],
  ['reddit_native_action','CREATE_SAVED_AUDIENCE','reddit_classic']
 ])assert.equal(rows.find(r=>r.gateway===gateway&&r.action===action)?.family,family,action);
 const dangerous=rows.find(r=>r.gateway==='google_ads_native_action'&&r.path?.includes('customerUserAccessInvitations:mutate'));assert.equal(dangerous?.status,'blocked_write');
 assert.equal(rows.find(r=>r.gateway==='google_ads_native_action'&&r.action==='ADD_EXTENSIONS')?.status,'adapter_requires_input');
});
test('contract inventory is paginated, locally readable without credentials, and does not change authorization',async()=>{
 const store=new Store(':memory:');let network=0;try{
  const service=new MirrorService(registry,store,new NativeTransport(async()=>{network++;throw Error('No network expected');}));
  const actor={tenantId:'inventory',userId:'reader',role:'reader' as const};
  const result=await service.call('amcp_workspace',{action:'contracts',gateway:'google_ads_native_action',search:'campaign_asset',limit:2},actor);
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.data.network_requests,0);assert.ok(result.data.total>2);assert.equal(result.data.actions.length,2);assert.equal(result.data.has_more,true);
  assert.equal((await service.call('amcp_workspace',{action:'contracts',limit:101},actor)).success,false);assert.equal(network,0);
  assert.throws(()=>actionContractPage(registry,{offset:-1}));assert.throws(()=>actionContractPage(registry,{gateway:'invented'}));
  assert.ok(actionContractSummary(registry).every(r=>r.provider_api_coverage==='unknown'));
 }finally{store.close();}
});
test('Google POST removals trigger deletion policy regardless of legacy/RPC catalog flags',()=>{
 const p={gateway:'google_ads_native_action',action:'google_ads_v23_campaign_asset_mutate_campaign_assets',accountId:'123',method:'POST',path:'/v23/customers/123/campaignAssets:mutate',query:{},body:{operations:[{remove:'customers/123/campaignAssets/100~200~SITELINK'}]},headers:{},readOnly:false,destructive:false,requiresConfirmation:true,evidence:'synthetic',warnings:[]} as CompiledRequest;
 assert.equal(applyExecutionRisk(p).destructive,true);assert.equal(reviewedWriteFamily(p),'google_asset_links');
 assert.equal(reviewedWriteFamily({...p,path:'/v23/customers/123/customerUserAccessInvitations:mutate'}),undefined);
});

test('Google root planning RPCs remain read-only and scoped to a configured connection',async()=>{
 const gateway='google_ads_native_action',compiler=new Compiler(registry),store=new Store(':memory:',Buffer.alloc(32,73).toString('base64'));
 const actor={tenantId:'global-reads',userId:'reader',role:'reader' as const},admin={...actor,role:'admin' as const};let calls=0;
 try{
  store.putConnection(admin,{id:'c',tenantId:actor.tenantId,gateway,accounts:['123'],enabled:true,label:'Synthetic',scopes:[]},{accessToken:'synthetic',developerToken:'synthetic'});
  const service=new MirrorService(registry,store,new NativeTransport(async(input,init)=>{calls++;assert.equal(new URL(String(input)).pathname,'/v23:listPlannableLocations');assert.equal(init?.method,'POST');return Response.json({plannableLocations:[{id:'1',name:'Synthetic'}]});}));
  const action='google_ads_v23_reach_plan_list_plannable_locations',args={action,account_id:'123',payload:{}};
  const p=compiler.compile(gateway,args,strictOptions);assert.equal(applyExecutionRisk(p).readOnly,true);
  assert.equal((await service.call(gateway,args,actor)).success,true);
  assert.equal((await service.call(gateway,{...args,account_id:'999'},actor)).success,false);assert.equal(calls,1);
  assert.equal(applyExecutionRisk({...p,path:'/v23:mutate'}).readOnly,false);
  assert.equal(applyExecutionRisk({...p,body:{method:'DELETE'}}).readOnly,false);
 }finally{store.close();}
});
