import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePages,normalizeAction,pageInfo} from './core.mjs';
const result=data=>({content:[{type:'text',text:JSON.stringify({success:true,data})}]});
test('offset paging preserves order and honors exact denominator',async()=>{
 const calls=[]; const r=await capturePages({gateway:'test',limit:1,save:async()=>{},call:async args=>{
 calls.push(args);return result({total_actions:2,has_more:args.offset===0,actions:[{action:'a'+args.offset,endpoint:'/x',custom:{x:1}}]});}});
 assert.equal(r.total,2);assert.deepEqual(calls.map(x=>x.offset),[0,1]);
 assert.deepEqual(normalizeAction(r.pages[0].actions[0]).raw.custom,{x:1});
});
test('Snapchat cursor variant terminates at null',async()=>{
 const r=await capturePages({gateway:'snap',cursor:true,limit:1,save:async()=>{},call:async args=>result({total:2,next_cursor:args.cursor===0?'1':null,actions:[{name:'a'+args.cursor}]})});
 assert.equal(r.pages.length,2);
});
test('truncated, duplicate and drifting catalogs fail closed',async()=>{
 await assert.rejects(capturePages({gateway:'x',save:async()=>{},call:async()=>result({total_actions:2,has_more:false,actions:[{name:'a'}]})}),/reconcile/);
 await assert.rejects(capturePages({gateway:'x',save:async()=>{},call:async()=>result({total_actions:2,has_more:true,actions:[{name:'a'}]})}),/Duplicate/);
 await assert.rejects(capturePages({gateway:'x',save:async()=>{},call:async args=>result({total_actions:2+args.offset,has_more:true,actions:[{name:'a'+args.offset}]})}),/drift/);
});
test('upstream errors and missing metadata cannot pass',()=>{
 assert.throws(()=>pageInfo(result({error:'bad'})),/actions array/);
 assert.throws(()=>pageInfo(result({actions:[]})),/denominator/);
 assert.throws(()=>pageInfo(result({total_actions:2,actions:[{name:'a'},'[1 more items truncated]']})),/truncated/);
});
