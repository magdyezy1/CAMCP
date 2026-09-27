import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Customer types of Google Ads user lists, API v23 (pinned Discovery document: UserListCustomerTypeService
 * MutateUserListCustomerTypes, UserListCustomerTypeOperation, UserListCustomerType with its category enum, and
 * UserListCustomerTypeErrorEnum; the user_list_customer_type GAQL resource; checked 2026-09-27). A customer type marks a
 * list as purchasers, leads, subscribers, loyalty members or cart abandoners; customer acquisition goals use these lists to
 * tell new customers from existing ones. A type is attached (create) or removed; there is no update. The service errors
 * state the rules: only CRM-based, rule-based, data-model and GCN lists take types; seven pairs of types, and any two
 * loyalty tiers, conflict on one list; and the account must track its own conversions or be the manager that tracks them.
 */
type Context={lists:string[];keys?:string[]};
type Read=CompiledRequest&{googleCustomerTypeState?:Context};
type Send=(p:CompiledRequest)=>Promise<TransportResult>;
const tiers=[1,2,3,4,5,6,7].map(n=>'LOYALTY_TIER_'+n+'_MEMBERS');
export const googleCustomerTypeCategories=['ALL_CUSTOMERS','PURCHASERS','HIGH_VALUE_CUSTOMERS','DISENGAGED_CUSTOMERS','QUALIFIED_LEADS','CONVERTED_LEADS','PAID_SUBSCRIBERS','LOYALTY_SIGN_UPS','CART_ABANDONERS',...tiers];
/** The pairs UserListCustomerTypeError.CONFLICTING_CUSTOMER_TYPES names; two different loyalty tiers conflict as well. */
export const googleCustomerTypeConflicts=[['PURCHASERS','CONVERTED_LEADS'],['PURCHASERS','QUALIFIED_LEADS'],['PURCHASERS','CART_ABANDONERS'],['QUALIFIED_LEADS','CONVERTED_LEADS'],['DISENGAGED_CUSTOMERS','CONVERTED_LEADS'],['DISENGAGED_CUSTOMERS','QUALIFIED_LEADS'],['DISENGAGED_CUSTOMERS','CART_ABANDONERS']];
/** v23 names CRM-based and rule-based lists; data-model and GCN lists, also eligible, have no v23 type and read as UNKNOWN. */
const eligible=['CRM_BASED','RULE_BASED'];
const tracked=['CONVERSION_TRACKING_MANAGED_BY_SELF','CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER'];
const maxOperations=100;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_GOOGLE_CUSTOMER_TYPE',message);}
function unverified(message:string):never{return fail('CUSTOMER_TYPE_STATE_UNVERIFIED',message,{},502);}
const account=(p:CompiledRequest)=>{const id=p.accountId?.replaceAll('-','');if(!id||!/^\d+$/.test(id))invalid('Select one Google Ads customer.');return id!;};
export function googleCustomerTypeKind(p:CompiledRequest):boolean{
 return p.gateway==='google_ads_native_action'&&p.method==='POST'&&!p.specialTransport&&(!p.origin||p.origin==='https://googleads.googleapis.com')&&/^\/v23\/customers\/\d+\/userListCustomerTypes:mutate$/.test(p.path);
}
const operations=(p:CompiledRequest)=>googleJson(p.body).operations as JsonObject[];
const listName=(p:CompiledRequest,id:string)=>'customers/'+account(p)+'/userLists/'+id;
/** The list ID and category an operation attaches or removes: "{list ID}~{category}", as in the resource name. */
function keyOf(p:CompiledRequest,op:JsonObject):string{
 if(op.remove!==undefined)return String(op.remove).split('/').at(-1)!;
 return String(op.create.userList).split('/').at(-1)+'~'+String(op.create.customerTypeCategory);
}
const listOf=(key:string)=>key.split('~')[0]!,categoryOf=(key:string)=>key.split('~')[1]!;
export function assertGoogleCustomerTypes(p:CompiledRequest):void{
 if(!googleCustomerTypeKind(p))return;
 if(p.path.split('/')[3]!==account(p))fail('ACCOUNT_SCOPE_MISMATCH','The path must use the selected customer.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Customer type reviews take no query or header overrides.');
 const b=googleJson(p.body);
 if(!object(b)||Object.keys(b).some(k=>!['operations','partialFailure','validateOnly'].includes(k)))invalid('Send {operations} only.');
 if(b.partialFailure!==undefined&&b.partialFailure!==false)invalid('partialFailure must be false: every operation is applied, or none.');
 if(b.validateOnly!==undefined&&b.validateOnly!==false)invalid('validateOnly must be false; inspect the review instead.');
 if(!Array.isArray(b.operations)||!b.operations.length||b.operations.length>maxOperations)invalid('Send 1–'+maxOperations+' operations.');
 const seen=new Set<string>(),lists=new Set<string>();
 (b.operations as unknown[]).forEach((op,i)=>{
  const at='operations['+i+']';
  if(!object(op)||Object.keys(op).length!==1||!['create','remove'].includes(Object.keys(op)[0]!))invalid(at+' is {create} or {remove}; customer types have no update.');
  if(op.create!==undefined){
   const c=op.create;
   if(!object(c)||Object.keys(c).some(k=>!['userList','customerTypeCategory'].includes(k)))invalid(at+'.create is {userList, customerTypeCategory}.');
   if(typeof c.userList!=='string'||!new RegExp('^customers/'+account(p)+'/userLists/[1-9][0-9]*$').test(c.userList))invalid(at+'.create.userList is a user list resource name of the selected customer.');
   if(!googleCustomerTypeCategories.includes(c.customerTypeCategory))invalid(at+'.create.customerTypeCategory is one of '+googleCustomerTypeCategories.join(', ')+'.');
  }else if(typeof op.remove!=='string'||!new RegExp('^customers/'+account(p)+'/userListCustomerTypes/[1-9][0-9]*~('+googleCustomerTypeCategories.join('|')+')$').test(op.remove))invalid(at+'.remove is customers/{customer}/userListCustomerTypes/{user list ID}~{category} of the selected customer.');
  const key=keyOf(p,op);if(seen.has(key))invalid('Each list and category appears once: '+key+'.');seen.add(key);lists.add(listOf(key));
 });
 if(lists.size>50)invalid('A review covers at most 50 user lists.');
}
const quote=(names:string[])=>names.map(n=>"'"+n+"'").join(', ');
function read(p:CompiledRequest,query:string):Read{return {...p,action:'AMCP_CUSTOMER_TYPE_READ',method:'POST',path:'/v23/customers/'+account(p)+'/googleAds:search',body:{query},query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,googleCustomerTypeState:undefined};}
const customerQuery='SELECT customer.id, customer.manager, customer.conversion_tracking_setting.conversion_tracking_status FROM customer LIMIT 1';
export function googleCustomerTypeSnapshots(p:CompiledRequest):Read[]{
 const lists=[...new Set(operations(p).map(op=>listOf(keyOf(p,op))))].sort();
 return [{...read(p,customerQuery),googleCustomerTypeState:{lists}}];
}
export function isGoogleCustomerTypeRead(p:CompiledRequest):p is Read{return !!(p as Read).googleCustomerTypeState;}
/** The customer, each list and every customer type of those lists; list keys are "l" and the list ID. */
export async function readGoogleCustomerTypes(p:CompiledRequest,send:Send):Promise<TransportResult>{
 const c=(p as Read).googleCustomerTypeState;if(!c)return send(p);
 let requests=0,rows=0;
 const search=async(query:string):Promise<JsonObject[]>=>{
  const out:JsonObject[]=[],tokens=new Set<string>();let token:string|undefined;
  for(let page=0;;page++){
   if(page>=10||++requests>20)unverified('Customer type state exceeded its page or request bound.');
   const plan=read(p,query);if(token)(plan.body as JsonObject).pageToken=token;
   const r=await send(plan),d=r.data;
   if(r.status!==200||!object(d)||d.results!==undefined&&!Array.isArray(d.results)||d.nextPageToken!==undefined&&typeof d.nextPageToken!=='string')unverified('Google returned a failed or unrecognized search response.');
   const values=(d.results??[]) as unknown[];rows+=values.length;if(rows>2000)unverified('Customer type state exceeded 2000 rows.');
   for(const v of values){if(!object(v))unverified('A search row is malformed.');out.push(v);}
   if(!d.nextPageToken)return out;
   if(tokens.has(d.nextPageToken)||!values.length)unverified('Search pagination is repeated or incomplete.');tokens.add(d.nextPageToken);token=d.nextPageToken;
  }
 };
 const customer=await search(customerQuery),row=customer[0]?.customer;
 if(customer.length!==1||!object(row)||String(row.id)!==account(p))unverified('Verify the selected customer.');
 const names=c.lists.map(id=>listName(p,id)),lists:JsonObject={},types:JsonObject=Object.fromEntries(c.lists.map(id=>['l'+id,[]]));
 for(const r of await search('SELECT user_list.resource_name, user_list.id, user_list.name, user_list.type, user_list.read_only, user_list.account_user_list_status, user_list.access_reason FROM user_list WHERE user_list.resource_name IN ('+quote(names)+')')){
  const v=object(r.userList)?r.userList:{},id=String(v.resourceName).split('/').at(-1)!;
  if(!names.includes(String(v.resourceName))||Object.hasOwn(lists,'l'+id))unverified('A user list was foreign or repeated.');
  lists['l'+id]={id,name:v.name??null,type:v.type??null,readOnly:v.readOnly===true,status:v.accountUserListStatus??null,access:v.accessReason??null};
 }
 for(const r of await search('SELECT user_list_customer_type.resource_name, user_list_customer_type.user_list, user_list_customer_type.customer_type_category FROM user_list_customer_type WHERE user_list_customer_type.user_list IN ('+quote(names)+')')){
  const v=object(r.userListCustomerType)?r.userListCustomerType:{},list=String(v.userList),id=list.split('/').at(-1)!,category=String(v.customerTypeCategory);
  if(!names.includes(list)||v.resourceName!=='customers/'+account(p)+'/userListCustomerTypes/'+id+'~'+category||(types['l'+id] as string[]).includes(category))unverified('A customer type row is foreign, malformed or repeated.');
  (types['l'+id] as string[]).push(category);
 }
 for(const k of Object.keys(types))(types[k] as string[]).sort();
 return {status:200,headers:{},data:{customer:{id:account(p),manager:row.manager===true,tracking:row.conversionTrackingSetting?.conversionTrackingStatus??null},lists,types}};
}
export function validateGoogleCustomerTypeState(p:CompiledRequest,r:TransportResult):void{
 const c=(p as Read).googleCustomerTypeState,d=r.data;
 if(!c||r.status!==200||!object(d)||!object(d.customer)||d.customer.id!==account(p)||!object(d.lists)||!object(d.types)||c.lists.some(id=>!Array.isArray(d.types['l'+id])))unverified('Complete customer type state is missing.');
}
/** The types each list has after the operations; the review, the impact and verification use it. */
function after(p:CompiledRequest,types:JsonObject):Record<string,string[]>{
 const out:Record<string,string[]>=Object.fromEntries(Object.entries(types).map(([k,v])=>[k,[...(v as string[])]]));
 for(const op of operations(p)){
  const key=keyOf(p,op),list='l'+listOf(key),category=categoryOf(key);out[list]??=[];
  out[list]=op.create?[...out[list]!,category]:out[list]!.filter(x=>x!==category);
 }
 for(const k of Object.keys(out))out[k]=[...new Set(out[k])].sort();
 return out;
}
function conflict(categories:string[]):string[]|undefined{
 const pair=googleCustomerTypeConflicts.find(([a,b])=>categories.includes(a!)&&categories.includes(b!));if(pair)return pair;
 const loyalty=categories.filter(x=>tiers.includes(x));return loyalty.length>1?loyalty.slice(0,2):undefined;
}
export function googleCustomerTypePrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!googleCustomerTypeKind(p))return;
 const s=states[0];if(!object(s)||!object(s.customer)||!object(s.lists)||!object(s.types))unverified('Complete customer type state is missing.');
 const tracking=s.customer.tracking;
 if(tracking==='NOT_CONVERSION_TRACKED')invalid('Conversion tracking is not enabled in this account; customer types need it.');
 if(tracking==='CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER')invalid('This account uses cross-account conversion tracking from its manager; set customer types in that manager account.');
 if(!tracked.includes(tracking))unverified('The conversion tracking status of the account is not recognized.');
 for(const op of operations(p)){
  const key=keyOf(p,op),id=listOf(key),category=categoryOf(key),list=s.lists['l'+id],current=s.types['l'+id] as string[];
  if(!object(list))fail('STATE_TARGET_MISMATCH','User list '+id+' is not a user list of the selected customer.',{user_list:listName(p,id)},409);
  if(list.status==='DISABLED')invalid('User list '+id+' is no longer shared with this account.');
  if(op.create){
   if(!eligible.includes(list.type))invalid('User list '+id+' is '+String(list.type)+'; customer types apply to CRM-based and rule-based lists.');
   if(current.includes(category))fail('CONFIGURATION_EXISTS','User list '+id+' already has the customer type '+category+'.',{user_list:listName(p,id),category});
  }else if(!current.includes(category))invalid('User list '+id+' has no customer type '+category+' to remove.');
 }
 for(const [list,categories] of Object.entries(after(p,s.types))){const pair=conflict(categories);if(pair)invalid('User list '+list.slice(1)+' would have the conflicting customer types '+pair.join(' and ')+'.');}
}
export function googleCustomerTypeImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!googleCustomerTypeKind(p))return;
 const first=state[0],s:JsonObject=object(first)?first:{},lists=object(s.lists)?s.lists:{},types=object(s.types)?s.types:{},next=after(p,types);
 const changes=operations(p).map(op=>{const key=keyOf(p,op),l=lists['l'+listOf(key)];return {user_list:listName(p,listOf(key)),name:object(l)?l.name??null:null,customer_type:categoryOf(key),change:op.create?'attach':'remove'};});
 return {provider:'google',scope:'user_list_customer_types',changes,before:types,after:next,may_affect_serving:true,
  effect:'Changes which of the advertiser\'s lists count as purchasers, leads, subscribers, loyalty members or cart abandoners. Campaigns with a customer acquisition goal use them to tell new customers from existing ones, which can change their bids. Budgets and list members do not change.',
  verification:'Reads the customer types of every list again and compares them with the types after this request.',
  source:'https://developers.google.com/google-ads/api/reference/rpc/v23/UserListCustomerTypeService'};
}
export function googleCustomerTypeOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const ops=operations(p),d=r.data;
 if(r.status!==200||!object(d)||d.partialFailureError!==undefined&&d.partialFailureError!==null||!Array.isArray(d.results)||d.results.length!==ops.length)return false;
 return d.results.every((v:unknown,i:number)=>object(v)&&v.resourceName==='customers/'+account(p)+'/userListCustomerTypes/'+keyOf(p,ops[i]!));
}
export function googleCustomerTypeVerification(p:CompiledRequest,_result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const first=before[0],s:JsonObject=object(first)?first:{},read=googleCustomerTypeSnapshots(p)[0]!;
 const next=after(p,object(s.types)?s.types:{}),lists=read.googleCustomerTypeState!.lists;
 return [{read,expected:{types:Object.fromEntries(lists.map(id=>['l'+id,next['l'+id]??[]]))},id:lists.map(id=>listName(p,id)).join(',')}];
}
export function googleCustomerTypeObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {types:object(data.types)?data.types:{}};}
