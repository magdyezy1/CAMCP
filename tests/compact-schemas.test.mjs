import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';

const registry=new Registry(),gateway='dv360_native_action';
const listed=flags=>registry.listTools({mode:'strict',flags}).find(t=>t.name===gateway).inputSchema.properties.action.enum;

test('compactSchemas lists each DV360 action once and still accepts its legacy alias',async()=>{
 const full=listed({}),compact=listed({compactSchemas:true}),catalog=registry.data.catalogs.find(c=>c.gateway===gateway);
 // Without the flag the captured schema is listed as captured.
 assert.deepEqual(full,registry.data.tools.find(t=>t.name===gateway).inputSchema.enum??registry.data.tools.find(t=>t.name===gateway).inputSchema.properties.action.enum);
 assert.equal(compact.length,catalog.actions.length);
 assert.deepEqual([...compact].sort(),catalog.actions.map(a=>a.canonical_name).sort());
 assert.ok(full.length>compact.length);
 const size=flags=>JSON.stringify(registry.listTools({mode:'strict',flags})).length;
 assert.ok(size({})-size({compactSchemas:true})>5000,'the listing shrinks');
 // Every other tool is listed unchanged.
 for(const t of registry.listTools({mode:'strict',flags:{compactSchemas:true}}))if(t.name!==gateway)assert.deepEqual(t,registry.listTools({mode:'strict',flags:{}}).find(x=>x.name===t.name),t.name);
 // The alias is still accepted end to end.
 const store=new Store(':memory:'),service=new MirrorService(registry,store,undefined,{mode:'strict',flags:{compactSchemas:true}});
 try{
  const alias=catalog.actions.find(a=>a.canonical_name==='DV360_TARGETING_TYPES_TARGETING_OPTIONS_SEARCH').aliases.find(a=>a!=='DV360_TARGETING_TYPES_TARGETING_OPTIONS_SEARCH');
  assert.ok(alias&&!compact.includes(alias));
  const out=await service.call(gateway,{action:alias,params:{targetingType:'TARGETING_TYPE_GEO_REGION'},body:{advertiserId:'123',geoRegionSearchTerms:{geoRegionQuery:'Cairo'}},dry_run:true},{tenantId:'local',userId:'reader',role:'reader'});
  assert.equal(out.success,true,JSON.stringify(out.error));assert.equal(out.data.executed,false);
 }finally{store.close();}
});
