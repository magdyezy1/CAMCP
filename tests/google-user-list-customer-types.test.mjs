import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Customer types of user lists, Google Ads API v23 (pinned Discovery document: UserListCustomerTypeService and
 * UserListCustomerTypeErrorEnum; the user_list_customer_type GAQL resource; checked 2026-09-27).
 */
const gateway='google_ads_native_action',registry=new Registry(),C='customers/123/';
const action='google_ads_v23_user_list_customer_type_mutate_user_list_customer_types';
const actor={tenantId:'customer-types',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
const list=id=>C+'userLists/'+id,type=(id,category)=>C+'userListCustomerTypes/'+id+'~'+category;
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,93).toString('base64')),calls=[];let writes=0;
 store.putConnection(owner,{id:'g',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic Google Ads',scopes:['https://www.googleapis.com/auth/adwords']},{accessToken:'synthetic',developerToken:'synthetic'});
 const lists={
  501:{name:'CRM purchasers',type:'CRM_BASED',accountUserListStatus:'ENABLED',accessReason:'OWNED'},
  502:{name:'Lead form visitors',type:'RULE_BASED',accountUserListStatus:'ENABLED',accessReason:'OWNED'},
  503:{name:'Combined',type:'LOGICAL',accountUserListStatus:'ENABLED',accessReason:'OWNED'},
  504:{name:'Revoked share',type:'CRM_BASED',accountUserListStatus:'DISABLED',accessReason:'SHARED'}
 };
 const types=new Set(['501~ALL_CUSTOMERS','502~LOYALTY_TIER_1_MEMBERS']);
 const tracking=mode==='untracked'?'NOT_CONVERSION_TRACKED':mode==='cross'?'CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER':'CONVERSION_TRACKING_MANAGED_BY_SELF';
 const inList=(query,field)=>[...(new RegExp(field+' IN \\(([^)]*)\\)').exec(query)?.[1]??'').matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});
  if(path==='/v23/customers/123/googleAds:search'){
   const q=body.query;
   if(/FROM customer /.test(q+' '))return Response.json({results:[{customer:{resourceName:'customers/123',id:'123',manager:false,conversionTrackingSetting:{conversionTrackingStatus:tracking}}}]});
   if(/FROM user_list_customer_type /.test(q+' ')){const names=inList(q,'user_list_customer_type.user_list');return Response.json({results:[...types].filter(k=>names.includes(list(k.split('~')[0]))).map(k=>({userListCustomerType:{resourceName:type(...k.split('~')),userList:list(k.split('~')[0]),customerTypeCategory:k.split('~')[1]}}))});}
   if(/FROM user_list /.test(q+' ')){const names=inList(q,'user_list.resource_name');return Response.json({results:names.filter(n=>lists[n.split('/').at(-1)]).map(n=>({userList:{resourceName:n,id:n.split('/').at(-1),...lists[n.split('/').at(-1)]}}))});}
   throw new Error('Unexpected query '+q);
  }
  if(path==='/v23/customers/123/userListCustomerTypes:mutate'){
   writes++;
   return Response.json({results:body.operations.map((op,i)=>{
    const key=op.remove?op.remove.split('/').at(-1):op.create.userList.split('/').at(-1)+'~'+op.create.customerTypeCategory;
    if(mode!=='ignore'){if(op.remove)types.delete(key);else types.add(key);}
    return {resourceName:mode==='other'&&i===0?type('999','PURCHASERS'):C+'userListCustomerTypes/'+key};
   })});
  }
  throw new Error('Unexpected '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const prepare=(operations,extra={})=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,account_id:'123',payload:{operations,...extra}}},actor);
 const execute=p=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,types,prepare,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};
const attach=(id,category)=>({create:{userList:list(id),customerTypeCategory:category}}),detach=(id,category)=>({remove:type(id,category)});

test('customer types are attached and removed once, without spending confirmation, and verify against every list',async()=>{
 const f=fixture();try{
  const p=ok(await f.prepare([attach(501,'PURCHASERS'),detach(501,'ALL_CUSTOMERS'),attach(502,'QUALIFIED_LEADS')])),impact=p.data.creative_impact;
  assert.equal(impact.scope,'user_list_customer_types');assert.deepEqual(impact.changes.map(c=>c.change),['attach','remove','attach']);
  assert.deepEqual(impact.after,{l501:['PURCHASERS'],l502:['LOYALTY_TIER_1_MEMBERS','QUALIFIED_LEADS']});
  ok(await f.execute(p));assert.equal(f.writes(),1);assert.deepEqual([...f.types].sort(),['501~PURCHASERS','502~LOYALTY_TIER_1_MEMBERS','502~QUALIFIED_LEADS']);
  assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
 }finally{f.store.close();}
});

test('malformed customer type operations are refused before any request',async()=>{
 const cases=[
  ['101 operations',Array.from({length:101},(_,i)=>attach(1000+i,'PURCHASERS'))],
  // The pinned Discovery schema refuses an update operation and unknown enum values first.
  ['update',[{update:{resourceName:type(501,'PURCHASERS')}}],'INVALID_VENDOR_BODY'],
  ['create and remove together',[{create:attach(501,'PURCHASERS').create,remove:type(501,'ALL_CUSTOMERS')}]],
  ['unknown category',[attach(501,'VIP')],'INVALID_VENDOR_BODY'],
  ['unspecified category',[attach(501,'UNSPECIFIED')]],
  ['list of another customer',[{create:{userList:'customers/999/userLists/501',customerTypeCategory:'PURCHASERS'}}]],
  ['extra field',[{create:{...attach(501,'PURCHASERS').create,resourceName:type(501,'PURCHASERS')}}]],
  ['malformed removal',[{remove:C+'userListCustomerTypes/501'}]],
  ['repeated key',[attach(501,'PURCHASERS'),detach(501,'PURCHASERS')]]
 ];
 // An empty list never reaches the family: the native compiler requires operations.
 {const f=fixture();try{const r=await f.prepare([]);assert.equal(r.success,false);assert.equal(f.calls.length,0);}finally{f.store.close();}}
 for(const [label,operations,code='INVALID_GOOGLE_CUSTOMER_TYPE'] of cases){const f=fixture();try{const r=await f.prepare(operations);assert.equal(r.error?.code,code,label+': '+JSON.stringify(r).slice(0,300));assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
 for(const [label,extra] of [['partial failure',{partialFailure:true}],['validate only',{validateOnly:true}]]){const f=fixture();try{const r=await f.prepare([attach(501,'PURCHASERS')],extra);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label);}finally{f.store.close();}}
});

test('ineligible, unknown, revoked and conflicting lists, existing or missing types and untracked accounts are refused after reading, without writes',async()=>{
 const f=fixture();try{
  assert.match((await f.prepare([attach(503,'PURCHASERS')])).error?.message??'',/LOGICAL/);
  assert.equal((await f.prepare([attach(501,'ALL_CUSTOMERS')])).error?.code,'CONFIGURATION_EXISTS');
  assert.match((await f.prepare([detach(501,'PURCHASERS')])).error?.message??'',/no customer type PURCHASERS/);
  assert.match((await f.prepare([attach(501,'PURCHASERS'),attach(501,'CONVERTED_LEADS')])).error?.message??'',/conflicting customer types PURCHASERS and CONVERTED_LEADS/);
  assert.match((await f.prepare([attach(502,'LOYALTY_TIER_2_MEMBERS')])).error?.message??'',/conflicting customer types LOYALTY_TIER_1_MEMBERS and LOYALTY_TIER_2_MEMBERS/);
  ok(await f.prepare([detach(502,'LOYALTY_TIER_1_MEMBERS'),attach(502,'LOYALTY_TIER_2_MEMBERS')]));
  assert.equal((await f.prepare([attach(599,'PURCHASERS')])).error?.code,'STATE_TARGET_MISMATCH');
  assert.match((await f.prepare([attach(504,'PURCHASERS')])).error?.message??'',/no longer shared/);
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 for(const [mode,pattern] of [['untracked',/not enabled/],['cross',/manager account/]]){const g=fixture(mode);try{assert.match((await g.prepare([attach(501,'PURCHASERS')])).error?.message??'',pattern,mode);assert.equal(g.writes(),0);}finally{g.store.close();}}
});

test('a result naming another customer type is a failure that is never resubmitted, and an ignored change is not verified',async()=>{
 const other=fixture('other');try{const p=ok(await other.prepare([attach(501,'PURCHASERS')]));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=fixture('ignore');try{const p=ok(await ignored.prepare([attach(501,'PURCHASERS')]));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
});

test('the categories and conflicts match the pinned Discovery document, and the ledger lists the action in the family',async()=>{
 const {googleCustomerTypeCategories,googleCustomerTypeConflicts}=await import('../dist/src/google-user-list-customer-types.js');
 const doc=JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v23.json','utf8')),S=(doc.document??doc).schemas;
 assert.deepEqual(S.GoogleAdsGoogleadsV23Resources__UserListCustomerType.properties.customerTypeCategory.enum,['UNSPECIFIED','UNKNOWN',...googleCustomerTypeCategories]);
 const errors=S.GoogleAdsGoogleadsV23Errors__ErrorCode.properties.userListCustomerTypeError,conflicts=errors.enumDescriptions[errors.enum.indexOf('CONFLICTING_CUSTOMER_TYPES')];
 const label=c=>({PURCHASERS:'Purchasers',CONVERTED_LEADS:'Converted Leads',QUALIFIED_LEADS:'Qualified Leads',CART_ABANDONERS:'Cart Abandoners',DISENGAGED_CUSTOMERS:'Disengaged customers'})[c];
 for(const [a,b] of googleCustomerTypeConflicts)assert.ok(conflicts.includes(label(a)+' - '+label(b)),a+' - '+b);
 assert.ok(conflicts.includes('Loyalty Tier X Members - Loyalty Tier Y Members'));
 assert.match(errors.enumDescriptions[errors.enum.indexOf('USERLIST_NOT_ELIGIBLE')],/CRM_BASED, RULE_BASED/);
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1);assert.equal(rows[0].status,'reviewed_write_family');assert.equal(rows[0].family,'google_user_list_customer_types');
});
