import {MirrorError} from './errors.js';
import {sha256,stable} from './security.js';
import {normalizeReviewState} from './review-state.js';
import type {Store} from './store.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Send=(plan:CompiledRequest)=>Promise<TransportResult>;
const gateway='criteo_native_action',prefix='/2026-01/retail-media';
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)&&date(v.slice(0,10))&&Number.isFinite(Date.parse(v));
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=50&&v.every(id)&&new Set(v).size===v.length;
const attributionScopes=['sameSku','sameSkuCategory','sameSkuCategoryBrand'];
export const criteoCampaignFields=['name','budget','dailyPacing','monthlyPacing','isAutoDailyPacing','startDate','endDate','clickAttributionWindow','viewAttributionWindow','clickAttributionScope','viewAttributionScope','companyName','onBehalfCompanyName'];
function fail(message:string,code='CRITEO_CAMPAIGN_INVALID'):never{throw new MirrorError(code,message,{},code==='CRITEO_CAMPAIGN_STATE_UNVERIFIED'?502:400);}
const incomplete=(message:string):never=>fail(message,'CRITEO_CAMPAIGN_STATE_UNVERIFIED');
function only(v:JsonObject,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))fail('Unqualified campaign field. Inspect the version-specific create or complete PUT contract.');}
const attributes=(p:CompiledRequest):JsonObject=>(p.body as JsonObject).data.attributes;
export function criteoCampaignKind(p:CompiledRequest):'create'|'update'|undefined{
 if(p.gateway!==gateway||p.origin&&p.origin!=='https://api.criteo.com'||p.specialTransport)return;
 if(p.action==='criteo_campaign_ops/CREATE_CAMPAIGNS_BY_ACCOUNT_ID'&&p.method==='POST'&&/^\/2026-01\/retail-media\/accounts\/[1-9][0-9]*\/campaigns$/.test(p.path))return 'create';
 if(p.action==='criteo_campaign_ops/UPDATE_CAMPAIGN_BY_CAMPAIGN_ID'&&p.method==='PUT'&&/^\/2026-01\/retail-media\/campaigns\/[1-9][0-9]*$/.test(p.path))return 'update';
}
function validateAttributes(a:JsonObject){
 if(criteoCampaignFields.some(f=>!Object.hasOwn(a,f)))fail('Explicitly include every writable campaign field. Criteo PUT can clear omitted limits; copy the current configuration before editing.');
 if(!text(a.name,255)||a.isAutoDailyPacing!==false||!['budget','dailyPacing','monthlyPacing'].every(k=>money(a[k]))||a.dailyPacing===0||a.monthlyPacing===0)fail('Use a named auction campaign with an explicit finite nonnegative lifetime limit and positive daily/monthly limits and isAutoDailyPacing=false. Uncapped and automatic pacing variants need a separate contract.');
 if(!timestamp(a.startDate)||!timestamp(a.endDate)||Date.parse(a.startDate)>=Date.parse(a.endDate))fail('Explicit startDate and later endDate must be ISO-8601 timestamps with offsets.');
 if(!['7D','14D','30D'].includes(a.clickAttributionWindow)||!['none','1D','7D','14D','30D'].includes(a.viewAttributionWindow)||(parseInt(a.viewAttributionWindow)||0)>parseInt(a.clickAttributionWindow)||!attributionScopes.includes(a.clickAttributionScope)||!attributionScopes.includes(a.viewAttributionScope))fail('Use explicit supported attribution scopes and windows, with view no longer than click.');
 for(const k of ['companyName','onBehalfCompanyName'])if(a[k]!==null&&!text(a[k],255))fail('Company names must be explicit text or null; AMCP does not invent the advertiser identity.');
}
export function assertCriteoCampaign(p:CompiledRequest){
 const kind=criteoCampaignKind(p);if(!kind)return;
 if(!id(p.accountId)||Object.keys(p.query).length||Object.keys(p.headers).length||!object(p.body)||!object(p.body.data)||!object(p.body.data.attributes))fail('Use one numeric account and a native data.attributes body without query/header overrides.');
 only(p.body,['data']);const d=p.body.data;only(d,kind==='create'?['type','attributes']:['id','type','attributes']);
 if(d.type!=='Campaign'||kind==='create'&&p.path!==prefix+'/accounts/'+p.accountId+'/campaigns'||kind==='update'&&(!id(d.id)||p.path!==prefix+'/campaigns/'+d.id))fail('The native wrapper identity must match the exact campaign/account path.');
 only(d.attributes,[...criteoCampaignFields,...(kind==='create'?['type','drawableBalanceIds']:[])]);validateAttributes(d.attributes);
 if(kind==='create'&&(d.attributes.type!=='auction'||!ids(d.attributes.drawableBalanceIds)))fail('Creation requires type=auction and an explicit set of up to 50 drawable balance IDs from this account.');
}
export function assertCriteoCampaignScopes(c:Connection,write=false){
 const required=['RetailMedia_Accounts_Read','RetailMedia_Campaign_Read','RetailMedia_Balance_Read',...(write?['RetailMedia_Campaign_Manage']:[])];
 if(!required.every(s=>c.scopes.includes(s)))fail('The selected connection requires '+required.join(', ')+'.','INSUFFICIENT_SCOPE');
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):CompiledRequest{
 return {...p,action:'AMCP_CRITEO_CAMPAIGN_READ',method:'GET',path,query,body:undefined,headers:{},readOnly:true,requiresConfirmation:false,destructive:false,responseControls:undefined,queryArrayEncoding:'repeat'};
}
export const criteoCampaignSnapshots=(p:CompiledRequest)=>[read(p,prefix+'/accounts',{limitToId:[p.accountId],pageIndex:0,pageSize:2})];
export function authorizeCriteoCampaign(p:CompiledRequest,c:Connection,store:Store,account:string):boolean{
 if(p.gateway!==gateway)return false;
 const kind=criteoCampaignKind(p);
 if(kind){assertCriteoCampaign(p);assertCriteoCampaignScopes(c,true);if(kind==='update'&&!store.ownsResource(c,account,'criteo-report-target/campaigns/'+(p.body as JsonObject).data.id))fail('Discover the campaign in this account/connection before preparing its update. Preparation independently rereads current ownership.','RESOURCE_SCOPE_REQUIRED');return true;}
 if(p.action!=='AMCP_CRITEO_CAMPAIGN_READ')return false;
 assertCriteoCampaignScopes(c);
 if(p.accountId!==account||p.method!=='GET'||!p.readOnly||p.body!==undefined||p.specialTransport||p.origin&&p.origin!=='https://api.criteo.com'||Object.keys(p.headers).length)fail('Internal campaign reads must retain their exact account and origin.','RESOURCE_SCOPE_REQUIRED');
 if(p.path===prefix+'/accounts'&&stable(p.query)===stable({limitToId:[account],pageIndex:0,pageSize:2}))return true;
 if(p.path===prefix+'/accounts/'+account+'/campaigns'||p.path===prefix+'/accounts/'+account+'/balances'){
  if(ids(p.query.limitToId)&&p.query.limitToId.length&&p.query.pageIndex===0&&p.query.pageSize===51&&Object.keys(p.query).length===3)return true;
 }
 const verified=p.scopeContext?.criteoVerifiedCampaignId;
 if(id(verified)&&p.path===prefix+'/campaigns/'+verified+'/campaign-budget-overrides'&&!Object.keys(p.query).length)return true;
 if(id(verified)&&p.path===prefix+'/campaigns/'+verified+'/auction-line-items'&&p.query.limit===500&&Number.isSafeInteger(p.query.offset)&&p.query.offset>=0&&p.query.offset<=1000&&Object.keys(p.query).length===2)return true;
 fail('Campaign dependency reads require current account-scoped membership.','RESOURCE_SCOPE_REQUIRED');
}
function envelope(r:TransportResult):JsonObject{
 const d=r.data;if(r.status!==200||!object(d)||d.error!==undefined||['errors','warnings'].some(k=>d[k]!=null&&(!Array.isArray(d[k])||d[k].length))||d.links?.next||d.nextPage||d.hasMore||d.has_more)incomplete('Criteo returned failed, partial or unrecognized campaign state.');return d as JsonObject;
}
function selected(d:JsonObject,wanted:string[]):JsonObject[]{
 const m=d.metadata;if(!Array.isArray(d.data)||d.data.length!==wanted.length||!object(m)||m.currentPageIndex!==0||!Number.isSafeInteger(m.currentPageSize)||m.currentPageSize<wanted.length||m.nextPage||m.previousPage||m.totalItemsAcrossAllPages!=null&&m.totalItemsAcrossAllPages!==wanted.length||m.totalPages!=null&&m.totalPages!==1)incomplete('Filtered membership did not return every exact resource in one complete page.');
 const seen=new Set<string>();for(const row of d.data){if(!object(row)||!wanted.includes(row.id)||seen.has(row.id)||!object(row.attributes))incomplete('Missing, duplicate or foreign campaign dependency.');seen.add(row.id);}return d.data;
}
function canonicalAttributes(a:JsonObject):JsonObject{
 const out=Object.fromEntries(criteoCampaignFields.map(k=>[k,a[k]]));out.startDate=new Date(a.startDate).toISOString();out.endDate=new Date(a.endDate).toISOString();return out;
}
function campaign(row:JsonObject,account:string):JsonObject{
 const a=row.attributes;if(!id(row.id)||a.accountId!==account||a.type!=='auction'||a.retailerId!=null||!ids(a.drawableBalanceIds)||!Array.isArray(a.promotedBrandIds)||a.promotedBrandIds.some((v:unknown)=>!id(v))||new Set(a.promotedBrandIds).size!==a.promotedBrandIds.length||!['active','inactive','scheduled','ended'].includes(a.status))incomplete('Campaign identity, ownership, type, balances or serving state is unverified.');
 try{validateAttributes(a);}catch{incomplete('Existing standard Criteo-budget campaign must have explicit manual finite pacing, dates and known attribution. Automatic/uncapped campaigns need another contract.');}
 if(Object.keys(a).some(k=>![...criteoCampaignFields,'accountId','type','drawableBalanceIds','promotedBrandIds','retailerId','status','budgetSpent','budgetRemaining','createdAt','updatedAt'].includes(k)))incomplete('An unknown campaign configuration field requires contract review.');
 return {id:row.id,attributes:{...canonicalAttributes(a),accountId:account,type:a.type,drawableBalanceIds:[...a.drawableBalanceIds].sort(),promotedBrandIds:[...a.promotedBrandIds].sort(),retailerId:a.retailerId??null,status:a.status}};
}
async function snapshot(p:CompiledRequest,get:(p:CompiledRequest)=>Promise<JsonObject>,target?:string):Promise<JsonObject>{
 const row=selected(await get(criteoCampaignSnapshots(p)[0]!),[p.accountId!])[0]!,a=row.attributes;
 if(a.type!=='demand'||typeof a.currency!=='string'||!/^[A-Z]{3}$/.test(a.currency)||typeof a.timeZone!=='string')incomplete('A demand account with known currency and timezone is required.');
 try{new Intl.DateTimeFormat('en',{timeZone:a.timeZone});}catch{incomplete('Invalid account timezone.');}
 const state:JsonObject={account:{id:row.id,type:a.type,currency:a.currency,timeZone:a.timeZone},campaign:null,balances:[],lines:[]};
 const campaignId=target??(criteoCampaignKind(p)==='update'?(p.body as JsonObject).data.id:undefined);
 if(campaignId)state.campaign=campaign(selected(await get(read(p,prefix+'/accounts/'+p.accountId+'/campaigns',{limitToId:[campaignId],pageIndex:0,pageSize:51})),[campaignId])[0]!,p.accountId!);
 const balanceIds:string[]=state.campaign?.attributes.drawableBalanceIds??attributes(p).drawableBalanceIds;
 if(balanceIds.length){
  const rows=selected(await get(read(p,prefix+'/accounts/'+p.accountId+'/balances',{limitToId:balanceIds,pageIndex:0,pageSize:51})),balanceIds);
  state.balances=rows.map(row=>{const b=row.attributes;if(!['capped','uncapped'].includes(b.balanceType)||b.spendType!=='Onsite'||b.privateMarketBillingType!=='notApplicable'||b.retailerId!=null||b.accountId!==undefined&&b.accountId!==p.accountId||!date(b.startDate)||b.endDate!==null&&!date(b.endDate)||!['active','scheduled','ended'].includes(b.status)||b.balanceType==='capped'&&!money(b.deposited))incomplete('The selected balance lacks qualified type, funding, dates or billing identity.');return {id:row.id,balanceType:b.balanceType,deposited:b.deposited??null,spendType:b.spendType,privateMarketBillingType:b.privateMarketBillingType,startDate:b.startDate,endDate:b.endDate,status:b.status};}).sort((x:JsonObject,y:JsonObject)=>x.id.localeCompare(y.id,'en'));
 }
 if(campaignId){
  const scoped={...p,scopeContext:{...p.scopeContext,criteoVerifiedCampaignId:campaignId}};
  const d=await get(read(scoped,prefix+'/campaigns/'+campaignId+'/campaign-budget-overrides')),o=d.data?.attributes;
  if(!object(o)||!Array.isArray(o.dailyBudgetOverrides)||!Array.isArray(o.monthlyBudgetOverrides)||o.dailyBudgetOverrides.length||o.monthlyBudgetOverrides.length||Object.keys(o).some(k=>!['dailyBudgetOverrides','monthlyBudgetOverrides'].includes(k)))incomplete('Campaign budget overrides need their own policy and ordered-schedule contract. Use an override-aware campaign contract; this update remains blocked.');
  const seen=new Set<string>();let offset=0;
  for(;;){
   const d=await get(read(scoped,prefix+'/campaigns/'+campaignId+'/auction-line-items',{limit:500,offset})),m=d.metadata;
   if(!Array.isArray(d.data)||!object(m)||m.offset!==offset||m.limit!==500||d.data.length>500||offset+d.data.length>1000||m.count!=null&&(!Number.isSafeInteger(m.count)||m.count<0||m.count>1000||m.count<d.data.length))incomplete('Incomplete, capped or malformed line-item membership.');
   // Metadata.count is nullable and its scope is not explained by the pinned
   // schema. Prove exhaustion with an explicit empty offset page, never count alone.
   if(!d.data.length){if(m.count>0&&m.count!==offset)incomplete('Terminal pagination count disagrees with observed membership.');break;}
   for(const row of d.data){const a=row?.attributes;if(!object(row)||!id(row.id)||seen.has(row.id)||!object(a)||a.campaignId!==campaignId||!id(a.targetRetailerId)||!text(a.name,255)||!['active','scheduled','draft','paused','budgetHit','ended','archived','noFunds'].includes(a.status))incomplete('A dependent line item has unknown identity, parent or status.');seen.add(row.id);
    const telemetry=['budgetSpent','budgetRemaining','createdAt','updatedAt',...(a.isAutoDailyPacing===true?['dailyPacing']:[])];state.lines.push({id:row.id,attributes:Object.fromEntries(Object.entries(a).filter(([k])=>!telemetry.includes(k)))});
   }
   offset+=d.data.length;
  }
  state.lines.sort((x:JsonObject,y:JsonObject)=>x.id.localeCompare(y.id,'en'));
 }
 return state;
}
export async function readCriteoCampaignState(p:CompiledRequest,send:Send,target?:string):Promise<unknown[]>{
 let bytes=0,calls=0;const deadline=performance.now()+60000;
 const get=async(q:CompiledRequest)=>{if(++calls>16||performance.now()>=deadline)incomplete('Campaign dependencies exceeded the request/deadline bound.');const r=await send({...q,criteoCampaignDeadline:deadline});bytes+=Buffer.byteLength(JSON.stringify(r.data));if(bytes>8*1024*1024||performance.now()>=deadline)incomplete('Campaign dependencies exceeded the byte/deadline bound.');return envelope(r);};
 const before=await snapshot(p,get,target),after=await snapshot(p,get,target);if(stable(before)!==stable(after))incomplete('Campaign configuration or dependencies changed during preparation.');return [normalizeReviewState(before)];
}
export function criteoCampaignOutcome(p:CompiledRequest,r:TransportResult):boolean{
 try{const d=r.data;if(r.status!==(criteoCampaignKind(p)==='create'?201:200)||!object(d)||!object(d.data)||!object(d.data.attributes)||['errors','warnings'].some(k=>d[k]!=null&&(!Array.isArray(d[k])||d[k].length))||d.error!==undefined)return false;const row=campaign(d.data,p.accountId!);return criteoCampaignKind(p)==='create'||row.id===(p.body as JsonObject).data.id;}catch{return false;}
}
export function criteoCampaignPolicyAmounts(p:CompiledRequest,before:unknown){
 if(!criteoCampaignKind(p))return;assertCriteoCampaign(p);
 const a=attributes(p),old=Array.isArray(before)?(before[0] as JsonObject)?.campaign?.attributes:undefined;
 const values=(o:JsonObject|undefined)=>o?['budget','dailyPacing','monthlyPacing'].map(key=>{if(!money(o[key]))fail('A finite native campaign limit is required for the owner policy.','POLICY_BASELINE_REQUIRED');return {path:'/data/attributes/'+key,key,amount:o[key] as number};}):[];
 return {creating:criteoCampaignKind(p)==='create',amounts:values(a),old:values(old)};
}
export async function verifyCriteoCampaign(p:CompiledRequest,result:JsonObject,before:unknown[],send:Send){
 const receipt=result.data?.data;if(!object(receipt)||!id(receipt.id))incomplete('No exact campaign receipt is available.');
 const states=await readCriteoCampaignState(p,send,receipt.id),current=states[0] as JsonObject,expected:JsonObject={...canonicalAttributes(attributes(p)),...(criteoCampaignKind(p)==='create'?{type:'auction',drawableBalanceIds:[...attributes(p).drawableBalanceIds].sort()}:{})};
 const actual=current.campaign?.attributes??{},changed=Object.keys(expected).filter(k=>stable(expected[k])!==stable(actual[k]));
 if(stable(current.account)!==stable((before[0] as JsonObject).account))changed.push('account');
 const original=before[0] as JsonObject;if(criteoCampaignKind(p)==='update'){
  for(const key of ['type','drawableBalanceIds','promotedBrandIds','retailerId'])if(stable(actual[key])!==stable(original.campaign.attributes[key]))changed.push(key);
  const config=(lines:JsonObject[])=>lines.map(row=>({...row,attributes:{...row.attributes,status:['active','scheduled','budgetHit','noFunds','ended'].includes(row.attributes.status)?'COMPUTED':row.attributes.status}}));
  if(stable(config(current.lines))!==stable(config(original.lines)))changed.push('lineItems');
 }else if(current.lines.length)changed.push('lineItems');
 if(stable(current.balances)!==stable(original.balances))changed.push('balances');
 return {status:changed.length?'inconclusive':'verified',checks:[{resource_id:receipt.id,status:changed.length?'inconclusive':'verified',changed_fields:changed,expected_hash:sha256(stable(expected)),actual_hash:sha256(stable(Object.fromEntries(Object.keys(expected).map(k=>[k,actual[k]]))))}],resources:changed.length?[]:[{resource_id:receipt.id,account_id:p.accountId,kind:'campaign',read_result:{tool:gateway,arguments:{operation:'criteo_campaign_ops',arguments:{action:'GET_CAMPAIGNS_BY_ACCOUNT_ID',account_id:p.accountId,params:{limitToId:[receipt.id],pageIndex:0,pageSize:2}}}}}]};
}
export const criteoCampaignImpact={provider:'criteo',effect:'Creates or updates an auction campaign with explicit finite lifetime, daily and monthly spend limits. Campaign status is computed by Criteo; a new campaign with funds or an update may permit delivery. Every execution requires spend confirmation and an owner policy that permits activation.',units:'All three limits are decimal amounts in the selected account currency. Owner maximum applies to each limit; the cumulative daily reservation conservatively sums every positive limit increase, without netting decreases. It is not measured spend.',workflow:'Read current account/campaign/balance and complete line-item membership; preserve every writable PUT field. Budget overrides, automatic/uncapped pacing, preferred campaigns, type changes, retailer assignment, funding changes and deletion are not qualified by this family.',limits:'One campaign, up to 50 account-owned standard Criteo-budget Onsite balances, 1000 dependent line items, 16 reads, 8 MiB and 60 seconds. Read the account currency and timezone; enter explicit offset timestamps and attribution values. Native advertiser/retailer eligibility remains a provider check.',recovery:'Keep the original review and idempotency key after a partial or lost response. Verify via fresh account-scoped membership; a returned ID alone never grants ownership. No automatic mutation replay, balance funding or line-item creation is performed.'};
