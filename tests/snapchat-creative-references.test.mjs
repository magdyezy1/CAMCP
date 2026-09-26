import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * Snapchat creative PUT and PATCH may repoint a creative to other top-snap media or another lead form. References
 * the creative already has stay usable; a changed reference must be owned by this login, at review and again at
 * execution, like the lead-form create contract's dependency reads.
 */
const SNAP='12121212-1212-4121-8121-121212121212',gateway='snapchat_native_action',account='acct1';
const actor={tenantId:'snap-creative-refs',userId:'operator',role:'operator'},owner={...actor,role:'admin'},key=Buffer.alloc(32,68).toString('base64');
function fixture(){
 const store=new Store(':memory:',key),connection={id:SNAP,tenantId:actor.tenantId,gateway,accounts:[account],writeAccounts:[account],enabled:true,label:'Synthetic Snap',scopes:[]};
 store.putConnection(owner,connection,{accessToken:'synthetic'});
 const creatives=new Map(Object.entries({
  creative1:{id:'creative1',ad_account_id:account,type:'WEB_VIEW',name:'Web view',headline:'Visit',brand_name:'Synthetic',call_to_action:'LEARN_MORE',shareable:false,top_snap_media_id:'media1',profile_properties:{profile_id:'profile1'},web_view_properties:{url:'https://example.test',block_preload:true}},
  creative2:{id:'creative2',ad_account_id:account,type:'LEAD_GENERATION',name:'Lead form',headline:'Book',brand_name:'Synthetic',call_to_action:'SIGN_UP',shareable:true,top_snap_media_id:'media1',profile_properties:{profile_id:'profile1'},lead_generation_form_id:'form1'}}));
 for(const id of creatives.keys())store.rememberResource(connection,account,'creatives/'+id);
 const requests=[],writes=[];let n=0;
 const wrap=rows=>Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,creatives:rows.map(r=>({sub_request_status:'SUCCESS',creative:r}))});
 const list=(kind,rows)=>Response.json({request_status:'SUCCESS',request_id:'r'+ ++n,[kind]:rows.map(r=>({sub_request_status:'SUCCESS',[kind==='media'?'media':kind.slice(0,-1)]:r}))});
 const transport=new NativeTransport(async(raw,init={})=>{
  const path=new URL(String(raw)).pathname,method=init.method??'GET';requests.push(method+' '+path);let m;
  if(method==='GET'&&path==='/v1/adaccounts/acct1/media')return list('media',[{id:'media1',ad_account_id:account},{id:'media2',ad_account_id:account}]);
  if(method==='GET'&&path==='/v1/adaccounts/acct1/lead_generation_forms')return list('lead_generation_forms',[{id:'form1',ad_account_id:account},{id:'form2',ad_account_id:account}]);
  if(method==='GET'&&(m=/^\/v1\/creatives\/([^/]+)$/.exec(path)))return wrap([creatives.get(m[1])]);
  if(method==='PUT'&&path==='/v1/adaccounts/acct1/creatives'){writes.push(method);return wrap(JSON.parse(init.body).creatives.map(c=>{creatives.set(c.id,{...creatives.get(c.id),...c});return creatives.get(c.id);}));}
  if(method==='PATCH'&&(m=/^\/v1\/adaccounts\/acct1\/creatives\/([^/]+)$/.exec(path))){writes.push(method);const c={...creatives.get(m[1])};for(const op of JSON.parse(init.body))c[op.path.slice(1)]=op.value;creatives.set(m[1],c);return wrap([c]);}
  throw new Error('Unexpected Snapchat request '+method+' '+path);
 });
 const service=new MirrorService(new Registry(),store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0});
 const call=(tool,input)=>service.call(tool,input,actor);
 const put=row=>call('amcp_write',{action:'prepare',gateway,connection_id:SNAP,arguments:{action:'snapchat_adaccounts_ad_account_id_creatives_update',account_id:account,payload:{creatives:[row]}}});
 const patch=(id,ops)=>call('amcp_write',{action:'prepare',gateway,connection_id:SNAP,arguments:{action:'snapchat_creative_patch',account_id:account,path_params:{creative_id:id},payload:ops}});
 const execute=p=>call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.review_id,confirmed:true});
 const list_=action=>call(gateway,{action,connection_id:SNAP,account_id:account});
 return {store,connection,creatives,requests,writes,put,patch,execute,ownMedia:()=>list_('snapchat_media_list'),ownForms:()=>list_('snapchat_lead_forms_list')};
}

test('unchanged media and form references stay usable without ownership observations',async()=>{
 const f=fixture();try{
  const renamed=await f.put({...f.creatives.get('creative1'),name:'Renamed'});assert.equal(renamed.success,true,JSON.stringify(renamed));
  assert.equal((await f.execute(renamed)).success,true);
  const patched=await f.patch('creative2',[{op:'replace',path:'/name',value:'Renamed lead form'},{op:'replace',path:'/lead_generation_form_id',value:'form1'}]);assert.equal(patched.success,true,JSON.stringify(patched));
  assert.equal((await f.execute(patched)).success,true);assert.deepEqual(f.writes,['PUT','PATCH']);
 }finally{f.store.close();}
});

test('a PUT that changes top-snap media needs that media to be owned',async()=>{
 const f=fixture();try{
  const blind=await f.put({...f.creatives.get('creative1'),top_snap_media_id:'media2'});
  assert.equal(blind.error?.code,'RESOURCE_SCOPE_REQUIRED',JSON.stringify(blind));assert.equal(blind.error.details.path,'/v1/media/media2');assert.equal(blind.error.details.field,'top_snap_media_id');
  assert.equal((await f.ownMedia()).success,true);
  const p=await f.put({...f.creatives.get('creative1'),top_snap_media_id:'media2'});assert.equal(p.success,true,JSON.stringify(p));
  assert.equal((await f.execute(p)).success,true);assert.equal(f.creatives.get('creative1').top_snap_media_id,'media2');assert.deepEqual(f.writes,['PUT']);
 }finally{f.store.close();}
});

test('a PATCH that repoints a lead creative to another form needs that form to be owned; malformed IDs are refused',async()=>{
 const f=fixture();try{
  const blind=await f.patch('creative2',[{op:'replace',path:'/lead_generation_form_id',value:'form2'}]);
  assert.equal(blind.error?.code,'RESOURCE_SCOPE_REQUIRED',JSON.stringify(blind));assert.equal(blind.error.details.path,'/v1/lead_generation_forms/form2');
  const malformed=await f.patch('creative1',[{op:'replace',path:'/top_snap_media_id',value:'../media/media1'}]);assert.equal(malformed.error?.code,'INVALID_ARGUMENT',JSON.stringify(malformed));
  await f.ownForms();const p=await f.patch('creative2',[{op:'replace',path:'/lead_generation_form_id',value:'form2'}]);assert.equal(p.success,true,JSON.stringify(p));
  assert.equal((await f.execute(p)).success,true);assert.equal(f.creatives.get('creative2').lead_generation_form_id,'form2');assert.deepEqual(f.writes,['PATCH']);
 }finally{f.store.close();}
});

test('ownership of the changed reference is checked again at execution',async()=>{
 const f=fixture();try{
  await f.ownMedia();const p=await f.put({...f.creatives.get('creative1'),top_snap_media_id:'media2'});assert.equal(p.success,true,JSON.stringify(p));
  f.store.db.prepare('DELETE FROM resource_ownership WHERE resource=?').run('media/media2');
  const e=await f.execute(p);assert.equal(e.error?.code,'RESOURCE_SCOPE_REQUIRED',JSON.stringify(e));assert.equal(e.error.details.path,'/v1/media/media2');assert.equal(f.writes.length,0);
 }finally{f.store.close();}
});
