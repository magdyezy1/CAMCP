import assert from 'node:assert/strict';
export function unwrap(result) {
 const block=result?.content?.find(x=>x.type==='text');
 return block ? JSON.parse(block.text) : result;
}
export function pageInfo(result) {
 const envelope=unwrap(result);
 if(envelope?.success===false || result?.isError) throw new Error('Catalog call failed: '+JSON.stringify(envelope));
 if(/\[\d+ more (?:items|characters) truncated\]/.test(JSON.stringify(envelope))) throw new Error('Catalog response is truncated');
 const data=Array.isArray(envelope?.actions)?envelope:envelope?.data;
 if(!Array.isArray(data?.actions)) throw new Error('No actions array in catalog response');
 const total=data.total_actions??data.total;
 if(!Number.isInteger(total)||total<0) throw new Error('No nonnegative catalog denominator');
 return {envelope,data,actions:data.actions,total};
}
export function normalizeAction(raw) {
 const name=raw.name??raw.action??raw.canonical_action;
 assert.equal(typeof name,'string','Missing action name');
 assert.ok(name.length,'Empty action name');
 return {name,canonical_name:raw.canonical_action??name,
 aliases:raw.aliases??[],method:raw.method??null,path:raw.path??raw.endpoint??null,
 read_only:typeof raw.read_only==='boolean'?raw.read_only:null,
 destructive:typeof raw.destructive==='boolean'?raw.destructive:null,
 required:raw.required_parameters??raw.required_fields??[],
 path_parameters:raw.path_parameters??[],
 evidence:'OBSERVED',raw};
}
export async function capturePages({gateway,call,save,limit=100,cursor=false,maxPages=1000,requestOptions={}}) {
 const pages=[]; const seen=new Set(); let offset=0; let expected=null;
 for(let index=0;index<maxPages;index++){
  const args={...requestOptions,action:'LIST_ACTIONS',limit,[cursor?'cursor':'offset']:offset};
  const response=await call(args);
  await save({gateway,index,args,response});
  const page=pageInfo(response);
  if(expected===null)expected=page.total;
  assert.equal(page.total,expected,'Catalog drift: denominator changed mid-capture');
  for(const raw of page.actions){
   const key=normalizeAction(raw).name;
   assert.ok(!seen.has(key),'Duplicate/repeated action page: '+key); seen.add(key);
  }
  pages.push(page);
  const hasMore=page.data.has_more??(page.data.next_cursor!==null&&page.data.next_cursor!==undefined&&page.data.next_cursor!=='');
  if(!hasMore){assert.equal(seen.size,expected,'Catalog count does not reconcile');return {pages,total:expected};}
  assert.ok(page.actions.length,'Empty page with more results');
  const next=cursor?Number(page.data.next_cursor):offset+page.actions.length;
  assert.ok(Number.isInteger(next)&&next>offset,'Catalog pagination made no progress');
  offset=next;
 }
 throw new Error('Exceeded bounded catalog pages');
}
