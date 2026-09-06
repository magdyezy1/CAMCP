import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {verifyCapturedContracts} from '../src/verification.js';
test('compatibility report counts only captured payloads and route subsets that pass replay',()=>{
 const result=verifyCapturedContracts(new Registry());
 assert.equal(result.gateways.reduce((n,g)=>n+g.tier1.catalog_pages,0),33);
 assert.equal(result.gateways.reduce((n,g)=>n+g.tier1.descriptions,0),20);
 assert.equal(result.gateways.reduce((n,g)=>n+g.tier2.compiled_route_subsets,0),4);
 assert.equal(result.gateways.reduce((n,g)=>n+g.tier2.full_preview_envelopes+g.tier3_live_equivalence_comparisons,0),0);
 assert.equal(result.gateways.find(g=>g.gateway==='linkedin_native_action')!.tier2.compiled_route_subsets,0);
});
