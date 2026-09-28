import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {reviewedFamilies,familyOf,familyOfRead,readThroughFamilies} from '../dist/src/reviewed-families.js';

const families=reviewedFamilies();
const rows=actionContracts(new Registry());
// The same synthetic plan per ledger route that the action ledger classifies.
const planOf=r=>({gateway:r.gateway,action:r.operation?r.operation+(r.action!==r.operation?'/'+r.action:''):r.action,method:r.method,
 path:r.path.startsWith('https://')?new URL(r.path.replace(/\{[^}]+\}/g,'123')).pathname:r.path.split('?')[0].replace(/\{[^}]+\}/g,'123'),
 origin:r.origin,query:{},body:{},headers:{},readOnly:false,destructive:r.method==='DELETE',requiresConfirmation:false,accountId:'123',evidence:'',warnings:[]});
const routes=rows.filter(r=>r.method&&r.path);

test('every registered family is complete and owns routes in the action ledger',()=>{
 assert.ok(families.length>=57);
 assert.equal(new Set(families.map(f=>f.name)).size,families.length,'family names are unique');
 for(const f of families){
  assert.match(f.name,/^[a-z0-9]+(?:_[a-z0-9]+)+$/,f.name);
  assert.equal(typeof f.kind,'function',f.name);
  assert.ok(fs.existsSync(f.files[0]),f.name+': '+f.files[0]);
  for(const t of f.files[1])assert.ok(fs.existsSync(t),f.name+': '+t);
  // A family that marks reads must recognise them, or its reads would reach no validator or projection.
  if(f.reader||f.validateState||f.observed)assert.equal(typeof f.isRead,'function',f.name+' marks reads without isRead');
  // A message may depend on the request; either way it names the flag the caller must send.
  if(f.spendConfirmation)assert.ok(String(f.spendConfirmation.message).includes('spend_change_confirmed=true'),f.name+' names the flag');
  assert.ok(rows.some(r=>r.family===f.name&&r.status==='reviewed_write_family'),f.name+' owns no ledger route');
 }
});

test('no ledger route is claimed by two families, registered or still wired in reviewed-routes.ts',async()=>{
 // Families not yet registered are recognised by reviewed-routes.ts, one `if(kind(p))return 'name'` statement each.
 const src=fs.readFileSync('src/reviewed-routes.ts','utf8'),imports=new Map();
 for(const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g))for(const n of m[1].split(',').map(n=>n.trim()).filter(Boolean))imports.set(n,m[2]);
 const wired=[];
 for(const m of src.matchAll(/if\s*\((\w+)\(p\)\)\s*return\s*'(\w+)'/g)){const mod=await import('../dist/src/'+imports.get(m[1]));wired.push({name:m[2],kind:mod[m[1]]});}
 assert.ok(wired.length>50);
 const all=[...families,...wired];let claimed=0;
 for(const r of routes){
  const plan=planOf(r),hits=all.filter(f=>{try{return !!f.kind(plan);}catch{return false;}}).map(f=>f.name);
  assert.ok(hits.length<=1,r.gateway+' '+r.method+' '+r.path+' is claimed by '+hits.join(' and '));
  if(families.some(f=>f.name===hits[0]))claimed++;
 }
 assert.ok(claimed>0);
});

test('a request or read two families claim is refused before anything is sent',()=>{
 const claim=name=>({name,files:['src/x.ts',[]],kind:()=>true,isRead:()=>true});
 const plan=planOf(routes[0]);
 for(const lookup of [familyOf,familyOfRead])assert.throws(()=>lookup(plan,[claim('a_one'),claim('b_two')]),e=>e.code==='REVIEWED_FAMILY_CONFLICT'&&e.status===500&&/a_one, b_two/.test(e.message));
 assert.equal(familyOf(plan,[claim('a_one')]).name,'a_one');
 assert.equal(familyOf(plan,[]),undefined);
});

test('family readers pass every read they did not mark to the next reader unchanged',async()=>{
 const gateways=[...new Set(routes.map(r=>r.gateway))];
 for(const gateway of gateways){
  const read={gateway,action:'GET_STATE',method:'GET',path:'/state',query:{},headers:{},body:undefined,readOnly:true,destructive:false,requiresConfirmation:false,accountId:'123',evidence:'',warnings:[]};
  const seen=[],sentinel={status:200,headers:{},data:{ok:true}};
  for(const f of families.filter(f=>f.reader)){
   seen.length=0;
   assert.equal(await f.reader(read,r=>{seen.push(r);return Promise.resolve(sentinel);}),sentinel,f.name);
   assert.equal(seen.length,1,f.name);assert.equal(seen[0],read,f.name+' passed on a copy');
  }
  seen.length=0;
  assert.equal(await readThroughFamilies(read,r=>{seen.push(r);return Promise.resolve(sentinel);}),sentinel);
  assert.deepEqual(seen,[read]);
  assert.equal(familyOfRead(read),undefined);
 }
});

test('lifecycle modules reach registered families only through the registry',()=>{
 const lifecycle=['write-review','write-verification','write-impact','preflight','review-state','reviewed-routes','scope','spend-policy','execution-risk','action-contracts'];
 const allowed=new Set();
 const hookNames=new Set(['kind','assert','scope','authorize','snapshots','isRead','reader','validateState','prerequisites','impact','outcome','verification','observed','needed','message','activates','destructive','policyAmounts','snapshotState','verifiedResources']);
 const names=new Set();
 for(const f of families)for(const v of [...Object.values(f),f.spendConfirmation?.needed])if(typeof v==='function'&&v.name&&!hookNames.has(v.name))names.add(v.name);
 for(const f of families)if(f.scope)names.delete(f.scope.name); // shared assertions such as assertGoogleAdsScope
 const found=[];
 for(const m of lifecycle){
  const src=fs.readFileSync('src/'+m+'.ts','utf8');
  for(const n of names)if(new RegExp('\\b'+n+'\\b').test(src)&&!allowed.has(m+':'+n))found.push(m+':'+n);
 }
 assert.deepEqual(found,[]);
});
