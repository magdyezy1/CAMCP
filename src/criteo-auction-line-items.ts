import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Criteo Retail Media auction (Onsite Sponsored Products) line items on API 2026-01, per the pinned OpenAPI document
 * (CreateAuctionLineItem, UpdateAuctionLineItem, GetAuctionLineItem) and the "Onsite Sponsored Products Line Items" and
 * "Line Items" guides (checked 2026-09-26).
 * - Creation adds a line item to an auction campaign. It starts in draft: it promotes no products and serves nothing
 *   until products are added and it is set to active.
 * - The update is a complete PUT: a writable field left out becomes null or its default, so every field is required.
 *   Users set the status to active or paused; Criteo derives draft, scheduled, ended and the budget statuses.
 * - Names are unique within a campaign. The retailer and the keyword strategy are fixed at creation.
 */
const gateway='criteo_native_action',origin='https://api.criteo.com',prefix='/2026-01/retail-media';
const actions={create:'criteo_line_item_ops/CREATE_AUCTION_LINE_ITEM',update:'criteo_line_item_ops/UPDATE_AUCTION_LINE_ITEM'} as const;
type Kind=keyof typeof actions;
type Scope={campaignId?:string;lineItemId?:string;siblings:boolean;products?:boolean};
/** Writable in both models. Creation adds targetRetailerId and an optional keywordStrategy; the update adds status. */
export const criteoLineItemFields=['name','startDate','endDate','budget','monthlyPacing','dailyPacing','isAutoDailyPacing','bidStrategy','optimizationStrategy','targetBid','maxBid','flightSchedule'];
const keywordStrategies=['genericAndBranded','conquesting','genericBrandedAndConquesting'];
const days=['sunday','monday','tuesday','wednesday','thursday','friday','saturday','everyday','weekdays','weekends'];
const statuses=['active','scheduled','draft','paused','budgetHit','ended','archived','noFunds'];
/** Statuses Criteo derives for a line item that is set to active. */
const running=['active','scheduled','budgetHit','noFunds','ended'];
const documented=[...criteoLineItemFields,'id','campaignId','targetRetailerId','keywordStrategy','status','budgetSpent','budgetRemaining','createdAt','updatedAt'];
const limits=['budget','monthlyPacing','dailyPacing'];
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const day=(v:string)=>new Date(v.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)===v.slice(0,10);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)&&day(v)&&Number.isFinite(Date.parse(v));
const time=(v:unknown):v is string=>typeof v==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const positive=(v:unknown,min=0)=>typeof v==='number'&&Number.isFinite(v)&&v>min&&v<=Number.MAX_SAFE_INTEGER;
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const instant=(v:string)=>new Date(v).toISOString();
const order=(x:JsonObject,y:JsonObject)=>{const a=stable(x),b=stable(y);return a<b?-1:a>b?1:0;};
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_CRITEO_LINE_ITEM',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function mismatch(message:string):never{return fail('STATE_TARGET_MISMATCH',message,{},409);}

export function criteoLineItemKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.origin&&p.origin!==origin||p.specialTransport)return;
 if(p.action===actions.create&&p.method==='POST'&&/^\/2026-01\/retail-media\/campaigns\/[1-9][0-9]{0,18}\/auction-line-items$/.test(p.path))return 'create';
 if(p.action===actions.update&&p.method==='PUT'&&/^\/2026-01\/retail-media\/auction-line-items\/[1-9][0-9]{0,18}$/.test(p.path))return 'update';
 return;
}
/** The campaign ID of a creation path, or the line item ID of an update path. */
const target=(p:CompiledRequest)=>p.path.split('/')[4]!;
const attributes=(p:CompiledRequest):JsonObject=>(p.body as JsonObject).data.attributes;

function flight(v:unknown):void{
 if(v===null)return;
 if(!obj(v)||Object.keys(v).some(k=>k!=='legs')||!Array.isArray(v.legs)||v.legs.length>100)invalid('flightSchedule is null or {legs: [...]} with up to 100 legs.');
 const seen=new Set<string>();
 for(const leg of v.legs){
  if(!obj(leg)||Object.keys(leg).some(k=>!['dayOfWeek','startTime','endTime'].includes(k))||!days.includes(leg.dayOfWeek)||!time(leg.startTime)||!time(leg.endTime)||leg.startTime>=leg.endTime)invalid('Each flight leg names a dayOfWeek ('+days.join(', ')+') and a startTime before its endTime, as HH:mm in the time zone of the start and end dates.');
  const key=leg.dayOfWeek+' '+leg.startTime+' '+leg.endTime;if(seen.has(key))invalid('Flight legs must be distinct.');seen.add(key);
 }
}
function validate(kind:Kind,a:JsonObject):void{
 const own=kind==='create'?['targetRetailerId','keywordStrategy']:['status'];
 const unknown=Object.keys(a).filter(k=>![...criteoLineItemFields,...own].includes(k));
 if(unknown.length)invalid((kind==='update'&&unknown.some(k=>['campaignId','targetRetailerId','keywordStrategy'].includes(k))?'The campaign, retailer and keyword strategy are fixed at creation; leave them out of the update. ':'')+'Unqualified line item fields: '+unknown.join(', ')+'.');
 const missing=[...criteoLineItemFields,...(kind==='create'?['targetRetailerId']:['status'])].filter(k=>!Object.hasOwn(a,k));
 if(missing.length)invalid('Include every writable field, with null where a limit is off. Missing: '+missing.join(', ')+'. '+(kind==='update'?'The PUT sets a field left out to null or its default, so start from the current line item.':'A field left out would take a Criteo default.'));
 if(typeof a.name!=='string'||a.name.length<2||a.name.length>255||a.name!==a.name.trim()||/[\u0000-\u001f]/.test(a.name))invalid('name must be 2–255 characters without surrounding spaces or control characters.');
 if(!timestamp(a.startDate)||a.endDate!==null&&(!timestamp(a.endDate)||Date.parse(a.endDate)<=Date.parse(a.startDate)))invalid('startDate and endDate must be ISO-8601 timestamps with an offset, endDate after startDate (or null to run without an end). A date-only value would default to UTC.');
 for(const key of limits)if(a[key]!==null&&!positive(a[key]))invalid(key+' must be a positive amount in the account currency, or null for no limit.');
 if(typeof a.isAutoDailyPacing!=='boolean')invalid('isAutoDailyPacing must be true or false.');
 if(a.isAutoDailyPacing&&a.dailyPacing!==null)invalid('With isAutoDailyPacing Criteo calculates the daily pace; set dailyPacing to null.');
 if(a.isAutoDailyPacing&&!(a.endDate!==null&&a.budget!==null||a.monthlyPacing!==null))invalid('Automatic daily pacing needs an endDate and a budget, or a monthlyPacing.');
 if(!['manual','automated'].includes(a.bidStrategy))invalid('bidStrategy must be manual or automated.');
 if(!['conversion','clicks','revenue'].includes(a.optimizationStrategy))invalid('optimizationStrategy must be conversion, clicks or revenue.');
 if(a.targetBid!==null&&!positive(a.targetBid))invalid('targetBid must be a positive amount or null.');
 if(a.maxBid!==null&&!(positive(a.maxBid)&&a.maxBid>=0.1))invalid('maxBid must be at least 0.1, or null for no bid ceiling.');
 if(a.bidStrategy==='manual'&&a.targetBid===null)invalid('Manual bidding needs a targetBid.');
 if(a.bidStrategy==='automated'&&a.maxBid===null)invalid('Automated bidding needs a maxBid.');
 flight(a.flightSchedule);
 if(kind==='create'){
  if(!id(a.targetRetailerId))invalid('targetRetailerId must be the numeric ID of the retailer the line item serves on.');
  if(a.keywordStrategy!==undefined&&!keywordStrategies.includes(a.keywordStrategy))invalid('keywordStrategy must be '+keywordStrategies.join(', ')+', or left out for genericAndBranded.');
 }else if(!['active','paused'].includes(a.status))invalid('status must be active or paused; Criteo sets draft, scheduled, ended and the budget statuses itself.');
}
export function assertCriteoLineItem(p:CompiledRequest):void{
 const kind=criteoLineItemKind(p);if(!kind)return;
 if(!id(p.accountId)||Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Use one numeric Criteo account without query or header overrides.');
 const b=p.body;
 if(!obj(b)||Object.keys(b).some(k=>k!=='data')||!obj(b.data)||Object.keys(b.data).some(k=>!['type','attributes'].includes(k))||!obj(b.data.attributes))invalid('Provide the native body {data: {type, attributes}}.');
 if(b.data.type!==undefined&&b.data.type!=='SponsoredProductsLineItem')invalid('data.type is SponsoredProductsLineItem when given.');
 validate(kind,b.data.attributes);
}
export function assertCriteoLineItemScopes(c:Connection,write=false):void{
 const required=['RetailMedia_Accounts_Read','RetailMedia_Campaign_Read',...(write?['RetailMedia_Campaign_Manage']:[])];
 if(!required.every(s=>c.scopes.includes(s)))fail('INSUFFICIENT_SCOPE','The selected Criteo connection needs '+required.join(', ')+'.',{},403);
}

const read=(p:CompiledRequest,path:string,query:JsonObject={}):CompiledRequest=>({...p,action:'AMCP_CRITEO_LINE_ITEM_READ',method:'GET',path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:'repeat',criteoLineItemState:undefined});
/** One marked read of the selected account; the reader below adds the campaign, line item, sibling and product reads. */
export const criteoLineItemStateRead=(p:CompiledRequest,scope:Scope):CompiledRequest=>({...read(p,prefix+'/accounts',{limitToId:[p.accountId!],pageIndex:0,pageSize:2}),criteoLineItemState:scope});
export function criteoLineItemReads(p:CompiledRequest):CompiledRequest[]{
 return [criteoLineItemStateRead(p,criteoLineItemKind(p)==='create'?{campaignId:target(p),siblings:true}:{lineItemId:target(p),siblings:true})];
}
export function isCriteoLineItemRead(p:CompiledRequest):boolean{return p.gateway===gateway&&!!p.criteoLineItemState;}
/** Ownership of the written campaign or line item comes from account-scoped lists; internal reads are bound to the account. */
export function authorizeCriteoLineItem(p:CompiledRequest,c:Connection,store:Store,account:string):boolean{
 if(p.gateway!==gateway)return false;
 const kind=criteoLineItemKind(p);
 if(kind){
  assertCriteoLineItem(p);assertCriteoLineItemScopes(c,true);
  const resource=(kind==='create'?'criteo-report-target/campaigns/':'criteo-report-target/line-items/')+target(p);
  if(!store.ownsResource(c,account,resource))fail('RESOURCE_SCOPE_REQUIRED','List the '+(kind==='create'?'campaigns':'line items')+' of this account first (GET_'+(kind==='create'?'CAMPAIGNS':'LINE_ITEMS')+'_BY_ACCOUNT_ID with limitToId). Preparation rereads the current membership.',{},403);
  return true;
 }
 if(p.action!=='AMCP_CRITEO_LINE_ITEM_READ')return false;
 assertCriteoLineItemScopes(c);
 if(p.accountId!==account||p.method!=='GET'||!p.readOnly||p.body!==undefined||p.specialTransport||p.origin&&p.origin!==origin||Object.keys(p.headers).length)fail('RESOURCE_SCOPE_REQUIRED','Line item reads keep their exact account and origin.',{},403);
 const q=p.query,one=(v:unknown)=>Array.isArray(v)&&v.length===1&&id(v[0]),context=p.scopeContext??{};
 if(p.path===prefix+'/accounts'&&stable(q)===stable({limitToId:[account],pageIndex:0,pageSize:2}))return true;
 if(p.path===prefix+'/accounts/'+account+'/campaigns'&&one(q.limitToId)&&stable(q)===stable({limitToId:q.limitToId,pageIndex:0,pageSize:2}))return true;
 if(p.path===prefix+'/accounts/'+account+'/line-items'&&one(q.limitToId)&&stable(q)===stable({limitToId:q.limitToId,limitToType:'Auction',pageIndex:0,pageSize:2}))return true;
 if(id(context.criteoLineItemCampaignId)&&p.path===prefix+'/campaigns/'+context.criteoLineItemCampaignId+'/auction-line-items'&&q.limit===500&&Number.isSafeInteger(q.offset)&&q.offset>=0&&q.offset<=1000&&Object.keys(q).length===2)return true;
 if(id(context.criteoLineItemId)&&p.path===prefix+'/auction-line-items/'+context.criteoLineItemId&&!Object.keys(q).length)return true;
 if(id(context.criteoLineItemId)&&p.path===prefix+'/line-items/'+context.criteoLineItemId+'/products'&&q.limit===500&&q.fields==='bidOverride,status'&&Number.isSafeInteger(q.offset)&&q.offset>=0&&q.offset<=1500&&Object.keys(q).length===3)return true;
 return fail('RESOURCE_SCOPE_REQUIRED','Line item reads need current account-scoped membership.',{},403);
}

function envelope(r:TransportResult):JsonObject{
 const d=r.data;
 if(r.status!==200||!obj(d)||d.error!==undefined||['errors','warnings'].some(k=>d[k]!=null&&(!Array.isArray(d[k])||d[k].length))||d.links?.next||d.nextPage||d.hasMore||d.has_more)unverified('Criteo returned a failed, partial or unrecognized line item read.');
 return d as JsonObject;
}
function single(d:JsonObject,wanted:string,label:string):JsonObject{
 if(Array.isArray(d.data)&&!d.data.length)mismatch(label+' '+wanted+' is not in the selected account.');
 const m=d.metadata;
 if(!Array.isArray(d.data)||d.data.length!==1||!obj(m)||m.currentPageIndex!==0||!Number.isSafeInteger(m.currentPageSize)||m.currentPageSize<1||m.nextPage||m.totalItemsAcrossAllPages!=null&&m.totalItemsAcrossAllPages!==1||m.totalPages!=null&&m.totalPages!==1)unverified('The filtered account read must return exactly the requested '+label.toLowerCase()+'.');
 const row=d.data[0];if(!obj(row)||row.id!==wanted||!obj(row.attributes))mismatch('The account read returned a different or malformed '+label.toLowerCase()+'.');
 return row;
}
function accountOf(row:JsonObject):JsonObject{
 const a=row.attributes;
 if(a.type!=='demand'||typeof a.currency!=='string'||!/^[A-Z]{3}$/.test(a.currency)||typeof a.timeZone!=='string')unverified('A demand account with a known currency and time zone is required.');
 try{new Intl.DateTimeFormat('en',{timeZone:a.timeZone});}catch{unverified('The account time zone is not recognized.');}
 return {id:row.id,currency:a.currency,timeZone:a.timeZone};
}
function campaignOf(row:JsonObject,account:string):JsonObject{
 const a=row.attributes;
 if(a.accountId!==account)mismatch('Campaign '+row.id+' belongs to another account.');
 if(a.type!=='auction')invalid('Auction line items belong to auction campaigns; campaign '+row.id+' is '+String(a.type)+'.');
 if(a.retailerId!=null&&!id(a.retailerId))unverified('The campaign retailer is malformed.');
 // Spend, remaining budget and computed pacing change while the campaign serves; they are not part of the review state.
 return {id:row.id,name:typeof a.name==='string'?a.name:null,retailerId:a.retailerId??null,budget:number(a.budget),monthlyPacing:number(a.monthlyPacing),dailyPacing:a.isAutoDailyPacing===true?null:number(a.dailyPacing)};
}
/** One normalized form of a line item: instants in UTC, sorted flight legs with lower-case days, no telemetry, the derived statuses of an
 * active line item as "active", and maxBid 0 (how Criteo returns no ceiling) as null. It accepts its own output. */
function lineOf(v:unknown,wanted:string,campaign:string):JsonObject{
 if(!obj(v)||v.id!==wanted||!obj(v.attributes))mismatch('Criteo returned a different line item.');
 const a=v.attributes;
 if(a.campaignId!==campaign)mismatch('Line item '+wanted+' belongs to another campaign.');
 if(!id(a.targetRetailerId)||typeof a.name!=='string'||!statuses.includes(a.status)||typeof a.startDate!=='string'||!Number.isFinite(Date.parse(a.startDate))||a.endDate!=null&&(typeof a.endDate!=='string'||!Number.isFinite(Date.parse(a.endDate))))unverified('Line item '+wanted+' has no recognizable retailer, name, dates or status.');
 const legs=obj(a.flightSchedule)&&Array.isArray(a.flightSchedule.legs)&&a.flightSchedule.legs.length?{legs:a.flightSchedule.legs.map((l:JsonObject)=>({dayOfWeek:typeof l?.dayOfWeek==='string'?l.dayOfWeek.toLowerCase():null,startTime:l?.startTime??null,endTime:l?.endTime??null})).sort(order)}:null;
 return {id:wanted,campaignId:a.campaignId,targetRetailerId:a.targetRetailerId,name:a.name,startDate:instant(a.startDate),endDate:a.endDate==null?null:instant(a.endDate),
  budget:number(a.budget),monthlyPacing:number(a.monthlyPacing),dailyPacing:a.isAutoDailyPacing===true?null:number(a.dailyPacing),isAutoDailyPacing:a.isAutoDailyPacing===true,
  bidStrategy:a.bidStrategy??null,optimizationStrategy:a.optimizationStrategy??null,targetBid:number(a.targetBid),maxBid:a.maxBid===0?null:number(a.maxBid),flightSchedule:legs,
  keywordStrategy:a.keywordStrategy??null,status:running.includes(a.status)?'active':a.status,unknownFields:Object.keys(a).filter(k=>!documented.includes(k)).sort()};
}
/** A promoted product key that survives the case folding of verification (catalog IDs are case-sensitive). */
export const criteoProductKey=(sku:string)=>'p'+Buffer.from(sku,'utf8').toString('hex');
/**
 * Up to ten reads: the account, the line item's account membership (update and verification), its campaign in the account,
 * the line item itself, and either the campaign's line items (line item reviews, up to 1000) or the line item's promoted
 * products (product reviews, up to 1500), each list ended by an empty page. No provider URL is followed.
 */
export async function readCriteoLineItems(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const scope=p.criteoLineItemState;if(!scope)return fetch(p);
 const deadline=performance.now()+60000;let bytes=0,requests=0;
 const get=async(q:CompiledRequest)=>{if(++requests>10||performance.now()>deadline)unverified('Line item reads exceeded their request or time bound.');const d=envelope(await fetch(q));bytes+=Buffer.byteLength(JSON.stringify(d));if(bytes>8*1024*1024)unverified('Line item reads exceed 8 MiB.');return d;};
 const account=accountOf(single(await get({...p,criteoLineItemState:undefined}),p.accountId!,'Account'));
 let campaignId=scope.campaignId;
 if(scope.lineItemId){
  const member=single(await get(read(p,prefix+'/accounts/'+p.accountId+'/line-items',{limitToId:[scope.lineItemId],limitToType:'Auction',pageIndex:0,pageSize:2})),scope.lineItemId,'Auction line item').attributes;
  if(member.type!=='auction'||!id(member.campaignId)||campaignId!==undefined&&member.campaignId!==campaignId)mismatch('Line item '+scope.lineItemId+' is not an auction line item of '+(campaignId?'campaign '+campaignId:'this account')+'.');
  campaignId=member.campaignId;
 }
 const campaign=campaignOf(single(await get(read(p,prefix+'/accounts/'+p.accountId+'/campaigns',{limitToId:[campaignId!],pageIndex:0,pageSize:2})),campaignId!,'Campaign'),p.accountId!);
 let line:JsonObject|null=null;
 if(scope.lineItemId){
  // Bound here to the membership just read; external arguments cannot set this context.
  const bound={...p,scopeContext:{...p.scopeContext,criteoLineItemId:scope.lineItemId}};
  line=lineOf((await get(read(bound,prefix+'/auction-line-items/'+scope.lineItemId))).data,scope.lineItemId,campaignId!);
 }
 const siblings:JsonObject[]=[];
 if(scope.siblings){
  const bound={...p,scopeContext:{...p.scopeContext,criteoLineItemCampaignId:campaignId}},seen=new Set<string>();let offset=0;
  for(;;){
   const d=await get(read(bound,prefix+'/campaigns/'+campaignId+'/auction-line-items',{limit:500,offset})),m=d.metadata;
   if(!Array.isArray(d.data)||!obj(m)||m.offset!==offset||m.limit!==500||d.data.length>500||offset+d.data.length>1000||m.count!=null&&(!Number.isSafeInteger(m.count)||m.count<0||m.count>1000||m.count<d.data.length))unverified('The campaign line items are incomplete or more than 1000.');
   // The count is optional and its scope undocumented; an empty page proves the end.
   if(!d.data.length){if(m.count>0&&m.count!==offset)unverified('The campaign line item count disagrees with the pages read.');break;}
   for(const row of d.data){if(!obj(row)||!id(row.id)||seen.has(row.id)||!obj(row.attributes)||row.attributes.campaignId!==campaignId||typeof row.attributes.name!=='string')unverified('A campaign line item has an unknown identity, parent or name.');seen.add(row.id);siblings.push({id:row.id,name:row.attributes.name});}
   offset+=d.data.length;
  }
 }
 const products:JsonObject[]=[];
 if(scope.products&&scope.lineItemId){
  const bound={...p,scopeContext:{...p.scopeContext,criteoLineItemId:scope.lineItemId}},seen=new Set<string>();let offset=0;
  for(;;){
   const d=await get(read(bound,prefix+'/line-items/'+scope.lineItemId+'/products',{offset,limit:500,fields:'bidOverride,status'})),m=d.meta;
   if(!Array.isArray(d.data)||!obj(m)||m.offset!==offset||m.limit!==500||d.data.length>500||offset+d.data.length>1500||m.count!=null&&(!Number.isSafeInteger(m.count)||m.count<0))unverified('The promoted products are incomplete or more than 1500.');
   if(!d.data.length)break;
   for(const row of d.data){
    const a=row?.attributes;
    if(!obj(row)||typeof row.id!=='string'||!row.id||row.id.length>500||seen.has(row.id)||!obj(a)||a.bidOverride!=null&&(typeof a.bidOverride!=='number'||!Number.isFinite(a.bidOverride)||a.bidOverride<0))unverified('A promoted product has no recognizable ID or bid override.');
    // 0 and null both mean no override; derived statuses of an unpaused product count as active.
    seen.add(row.id);products.push({id:row.id,bidOverride:a.bidOverride>0?a.bidOverride:null,status:a.status==='paused'||a.status==='archived'?a.status:'active'});
   }
   offset+=d.data.length;
  }
 }
 return {status:200,headers:{},data:{accountId:p.accountId,account,campaign,line,siblings:siblings.sort(order),...(scope.products?{products:products.sort(order)}:{})}};
}
export function validateCriteoLineItemState(read:CompiledRequest,r:TransportResult):void{
 const d=r.data;
 if(r.status!==200||!obj(d)||d.accountId!==read.accountId||!obj(d.account)||!obj(d.campaign)||!Array.isArray(d.siblings)||!!read.criteoLineItemState?.lineItemId!==obj(d.line)||!!read.criteoLineItemState?.products!==Array.isArray(d.products))unverified('Missing verified Criteo line item state.');
}
/** The review state; the reader has already normalized every part, so this is idempotent. */
export function criteoLineItemReviewState(d:JsonObject):JsonObject{return {account:d.account,campaign:d.campaign,line:d.line??null,siblings:d.siblings,...(Array.isArray(d.products)?{products:d.products}:{})};}

const pick=(l:JsonObject):JsonObject=>Object.fromEntries(criteoLineItemFields.map(k=>[k,l[k]??null]));
function requested(a:JsonObject):JsonObject{
 const legs=obj(a.flightSchedule)&&a.flightSchedule.legs.length?{legs:a.flightSchedule.legs.map((l:JsonObject)=>({dayOfWeek:l.dayOfWeek,startTime:l.startTime,endTime:l.endTime})).sort(order)}:null;
 return {...pick(a),startDate:instant(a.startDate),endDate:a.endDate===null?null:instant(a.endDate),flightSchedule:legs};
}
export function validateCriteoLineItemPrerequisites(plan:CompiledRequest,states:unknown[]):void{
 const kind=criteoLineItemKind(plan);if(!kind)return;
 const s=states[0],a=attributes(plan);
 if(!obj(s)||!obj(s.campaign)||!Array.isArray(s.siblings))unverified('Missing verified Criteo line item state.');
 if(kind==='create'&&s.campaign.retailerId!==null&&a.targetRetailerId!==s.campaign.retailerId)invalid('Campaign '+s.campaign.id+' is billed to retailer '+s.campaign.retailerId+'; its line items must target that retailer.');
 const self=kind==='update'?target(plan):undefined,name=a.name.toLowerCase(),clash=s.siblings.find((x:JsonObject)=>x.id!==self&&String(x.name).trim().toLowerCase()===name);
 if(clash)fail('CONFIGURATION_EXISTS','Line item '+clash.id+' of this campaign is already named "'+clash.name+'"; names are unique within a campaign.',{name:a.name,line_item_id:clash.id});
 if(kind==='create')return;
 const line=s.line;if(!obj(line))unverified('Missing verified Criteo line item state.');
 if(line.status==='archived')invalid('Line item '+line.id+' is archived and cannot be changed.');
 if(Array.isArray(line.unknownFields)&&line.unknownFields.length)fail('INCOMPLETE_STATE','Line item '+line.id+' has fields this contract does not know ('+line.unknownFields.join(', ')+'); a complete PUT could clear them.',{fields:line.unknownFields},409);
 if(line.status===a.status&&stable(requested(a))===stable(pick(line)))invalid('Line item '+line.id+' already matches this request.');
}
export function criteoLineItemImpact(plan:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=criteoLineItemKind(plan);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},a=attributes(plan),line=obj(s.line)?s.line:undefined,before=kind==='update'&&line?pick(line):null,after=requested(a);
 const draft=line?.status==='draft';
 return {provider:'criteo',scope:'auction_line_item',operation:kind,campaign:s.campaign??null,currency:s.account?.currency??null,time_zone:s.account?.timeZone??null,
  ...(kind==='create'?{target_retailer_id:a.targetRetailerId,keyword_strategy:a.keywordStrategy??'genericAndBranded'}:{line_item_id:target(plan),current_status:line?.status??null,requested_status:a.status}),
  before,after,removed_limits:before?['budget','monthlyPacing','dailyPacing','endDate','targetBid','maxBid','flightSchedule'].filter(k=>before[k]!==null&&after[k]===null):[],may_affect_serving:kind==='update',
  effect:kind==='create'?'Creates a draft auction line item. It promotes no products and serves nothing until products are added and it is set to active.':a.status==='active'?'Replaces every writable field and sets the line item to active: it serves while its dates, budgets, funds and products allow'+(draft?'; it stays in draft until products are added':'')+'.':'Replaces every writable field and pauses the line item.',
  units:'budget, monthlyPacing, dailyPacing, targetBid and maxBid are decimal amounts in the account currency; bids exclude platform fees. null means no limit.',
  verification:'Reads the line item again through the account and compares every field sent, its campaign, retailer and keyword strategy, and whether it is active, paused or in draft.',
  source:'https://developers.criteo.com/retail-media/docs/onsite-sponsored-products-line-items'};
}
export function criteoLineItemOutcome(plan:CompiledRequest,r:TransportResult):boolean{
 const kind=criteoLineItemKind(plan)!,d=r.data;
 if(r.status!==(kind==='create'?201:200)||!obj(d)||d.error!==undefined||['errors','warnings'].some(k=>d[k]!=null&&(!Array.isArray(d[k])||d[k].length))||!obj(d.data)||!id(d.data.id)||!obj(d.data.attributes))return false;
 return kind==='create'?d.data.attributes.campaignId===target(plan):d.data.id===target(plan);
}
export function criteoLineItemVerification(plan:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string;unobservable?:string[]}[]{
 const kind=criteoLineItemKind(plan)!,a=attributes(plan),first=before[0],prior=obj(first)&&obj(first.line)?first.line:undefined;
 const lineId=kind==='create'?result.data?.data?.id:target(plan);
 if(!id(lineId))fail('VERIFICATION_UNSUPPORTED','The receipt names no line item to verify.');
 const campaignId=kind==='create'?target(plan):prior?.campaignId;
 const expected:JsonObject={...requested(a),id:lineId,campaignId,targetRetailerId:kind==='create'?a.targetRetailerId:prior?.targetRetailerId,keywordStrategy:kind==='create'?a.keywordStrategy??'genericAndBranded':prior?.keywordStrategy??null};
 // A new line item stays in draft until products are added. One set to active stays in draft for the same reason, so its
 // status cannot be observed until then.
 let unobservable:string[]|undefined;
 if(kind==='create')expected.status='draft';else if(a.status==='paused'||prior?.status!=='draft')expected.status=a.status;else unobservable=['status'];
 return [{read:criteoLineItemStateRead(plan,{campaignId,lineItemId:lineId,siblings:false}),expected:{line:expected},id:'auction line item '+lineId,...(unobservable?{unobservable}:{})}];
}
export function criteoLineItemObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 const l=obj(data.line)?data.line:undefined;
 return {line:l?{...pick(l),id:l.id,campaignId:l.campaignId,targetRetailerId:l.targetRetailerId,keywordStrategy:l.keywordStrategy,status:l.status}:null,
  ...(Array.isArray(data.products)?{products:Object.fromEntries(data.products.map((x:JsonObject)=>[criteoProductKey(x.id),{present:true,bidOverride:x.bidOverride,status:x.status}]))}:{})};
}
/**
 * Owner policy amounts: the lifetime budget and the monthly and daily paces, each compared with its current value. A
 * limit set to null (no cap) cannot be measured, so it is refused under a monetary policy; a new cap where there was none
 * adds nothing. An automatic daily pace is derived from the other limits.
 */
export function criteoLineItemPolicyAmounts(plan:CompiledRequest,before:unknown,policy:JsonObject={}){
 const kind=criteoLineItemKind(plan);if(!kind)return;
 assertCriteoLineItem(plan);
 const a=attributes(plan),line=kind==='update'&&Array.isArray(before)&&obj(before[0])&&obj(before[0].line)?before[0].line:undefined;
 const monetary=['max_budget_native','max_budget_increase_percent','max_daily_increase_native'].some(k=>policy[k]!==undefined);
 const amounts:{path:string;key:string;amount:number}[]=[],old:{path:string;key:string;amount:number}[]=[];
 for(const key of limits){
  if(key==='dailyPacing'&&a.isAutoDailyPacing===true)continue;
  const path='/data/attributes/'+key;
  if(a[key]===null){if(monetary)fail('POLICY_AMOUNT_UNSUPPORTED','A line item without a '+key+' cap cannot be checked against the owner spending policy. Set an explicit amount.',{field:path});continue;}
  amounts.push({path,key,amount:a[key]});
  if(kind==='update')old.push({path,key,amount:typeof line?.[key]==='number'?line[key]:a[key]});
 }
 return {creating:kind==='create',amounts,old};
}
