import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Introspection} from '../src/introspection.js';
import {strictOptions} from '../src/service.js';
const registry=new Registry(),introspection=new Introspection(registry);
test('20 captured tools, Microsoft extension and 112 delegated schemas load and validate',()=>{
 assert.equal(registry.tools.size,21);assert.equal(registry.data.tools.flatMap(t=>t.operations??[]).length,112);
 assert.equal(registry.data.catalogs.length,19);
 assert.deepEqual(registry.help({},strictOptions),registry.data.discovery);
});
test('gateway help preserves the captured direct schemas',()=>{
 for(const tool of registry.data.tools.filter(t=>t.mode==='direct'))assert.deepEqual(registry.help({gateway:tool.name},strictOptions).inputSchema,tool.inputSchema);
});
test('strict full catalog pages match frozen live metadata',()=>{
 for(const c of registry.data.catalogs.filter(c=>c.denominator_kind==='LIST_ACTIONS')){
  const dir='.mirror/RAW/'+c.gateway;
  for(const name of fs.readdirSync(dir).filter(n=>/^catalog-\d{4}\.json$/.test(n))){
   const e=JSON.parse(fs.readFileSync(dir+'/'+name,'utf8')),observed=JSON.parse(e.response.content[0].text).data;
   assert.deepEqual(introspection.list(c.gateway,e.request.args,strictOptions),observed,c.gateway+'/'+name);
  }
 }
});
test('unknown denominators remain unknown and cannot report full catalog coverage',()=>{
 for(const name of ['amazon_native_action','apple_ads_native_action']){assert.equal(registry.catalogs.get(name)?.reported_total,null);assert.throws(()=>introspection.list(name,{action:'LIST_ACTIONS'},strictOptions),/does not expose/);}
});
test('each improvement is individually flagged and has strict fallback',()=>{
 const input={action:'LIST_ACTIONS',limit:5};const gateway='snapchat_native_action';const baseline=introspection.list(gateway,input,strictOptions);
 assert.ok('total'in baseline);const on=introspection.list(gateway,input,{mode:'enhanced',flags:{catalogEnvelope:true}});assert.ok('total_actions'in on);assert.ok(!('total'in on));
 assert.deepEqual(introspection.list(gateway,input,{mode:'enhanced',flags:{catalogEnvelope:false}}),baseline);
 const g=registry.tools.get('google_ads_native_action')!;
 assert.equal(registry.schema(g,strictOptions).properties.dry_run.default,undefined);
 assert.equal(registry.schema(g,{mode:'enhanced',flags:{dryRunSchemaDefault:true}}).properties.dry_run.default,true);
 assert.equal(registry.schema(g,{mode:'enhanced',flags:{dryRunSchemaDefault:false}}).properties.dry_run.default,undefined);
});
test('invalid nested schema and unsafe large IDs fail without mutation',()=>{
 assert.throws(()=>registry.validate('amcp_native_action',{operation:'create_campaign',arguments:{}},strictOptions),/operation schema/);
 assert.throws(()=>registry.validate('tiktok_native_action',{action:'tiktok_campaign_get',params:{advertiser_id:7999999999999999999}},strictOptions),/identifiers as strings/);
});
