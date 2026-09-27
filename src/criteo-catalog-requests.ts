import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {Store} from './store.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Criteo Retail Media catalog requests and exports on API 2026-01, per the pinned OpenAPI document
 * (CatalogApi_PostApiV1ExternalAccountCatalogsByAccountId, Catalog_PostApiExternalV1AccountCatalogsSellersByAccountId,
 * CreateBrandCatalogExport, CreateSellerCatalogExport, GetCatalogStatus, GetCatalogOutput; checked 2026-09-27).
 * - Each request asks Criteo to build a file of the products available to the account (by brand, retailer or seller);
 *   the reply is a catalog status with an ID, and GET catalogs/{catalogId}/status reports pending, success, failure or
 *   expired. The output is available once the status is success.
 * - Nothing about campaigns, budgets or serving changes. The first two need RetailMedia_Campaign_Read, the exports
 *   RetailMedia_Campaign_Manage.
 * - A verified request is remembered as the account's, so its status and output can then be read natively.
 */
const gateway='criteo_native_action',origin='https://api.criteo.com',prefix='/2026-01/retail-media';
type Kind='catalog'|'seller_catalog'|'brand_export'|'seller_export';
type State={catalogId?:string;optional?:boolean};
const routes:Record<string,Kind>={catalogs:'catalog','catalogs/sellers':'seller_catalog','brand-catalog-export':'brand_export','seller-catalog-export':'seller_export'};
const fields=['Unknown','Description','ImageUrl','GoogleCategory','RetailerName','Category','BrandName'];
const statuses=['unknown','pending','success','failure','expired'];
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v);
const int32=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0&&(v as number)<=2147483647;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_CRITEO_CATALOG_REQUEST',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function criteoCatalogKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.origin&&p.origin!==origin||p.specialTransport||p.method!=='POST')return;
 const m=/^\/2026-01\/retail-media\/accounts\/[1-9][0-9]{0,18}\/(catalogs|catalogs\/sellers|brand-catalog-export|seller-catalog-export)$/.exec(p.path);
 return m?routes[m[1]!]:undefined;
}
const account=(p:CompiledRequest)=>p.path.split('/')[4]!;
function list(v:unknown,label:string,check:(x:unknown)=>boolean,max=500):void{
 if(v===undefined||v===null)return;
 if(!Array.isArray(v)||!v.length||v.length>max||v.some(x=>!check(x)))invalid(label+' lists 1–'+max+' valid values, or is left out.');
 if(new Set(v.map(x=>stable(x))).size!==v.length)invalid('Each value of '+label+' appears once.');
}
const seller=(x:unknown)=>obj(x)&&Object.keys(x).every(k=>['retailerId','sellerId'].includes(k))&&typeof x.retailerId==='string'&&/^[1-9][0-9]{0,9}$/.test(x.retailerId)&&typeof x.sellerId==='string'&&/^[\w.:-]{1,128}$/.test(x.sellerId);
export function assertCriteoCatalog(p:CompiledRequest):void{
 const kind=criteoCatalogKind(p);if(!kind)return;
 if(!id(p.accountId)||account(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The path must use the selected Criteo account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers).length)invalid('Catalog requests take no query or header overrides.');
 const b=p.body;
 if(!obj(b)||Object.keys(b).some(k=>k!=='data')||!obj(b.data)||Object.keys(b.data).some(k=>!['type','attributes'].includes(k)))invalid('Provide the native body {data: {type, attributes}}.');
 const d=b.data as JsonObject,a=d.attributes===undefined?{}:d.attributes;
 if(kind==='catalog'||kind==='seller_catalog'){if(typeof d.type!=='string'||!/^[A-Za-z]{1,64}$/.test(d.type))invalid('data.type names the resource type, for example '+(kind==='catalog'?'CatalogRequest':'SellerCatalogRequest')+'.');}
 else if(d.type!==undefined&&d.type!==null&&(typeof d.type!=='string'||!/^[A-Za-z]{1,64}$/.test(d.type)))invalid('data.type is a resource type name when given.');
 if(!obj(a))invalid('data.attributes is an object.');
 const allowed={catalog:['format','brandIdFilter'],seller_catalog:['sellers'],brand_export:['brandIdFilter','includeFields','modifiedAfter','retailerIdFilter'],seller_export:['includeFields','modifiedAfter','sellers']}[kind];
 const extra=Object.keys(a).filter(k=>!allowed.includes(k));if(extra.length)invalid('Unqualified catalog request fields: '+extra.join(', ')+'.');
 if(a.format!==undefined&&a.format!=='json-newline')invalid('format is json-newline.');
 list(a.brandIdFilter,'brandIdFilter',id);
 list(a.retailerIdFilter,'retailerIdFilter',int32);
 list(a.includeFields,'includeFields',x=>typeof x==='string'&&fields.includes(x)&&x!=='Unknown',6);
 if(kind==='seller_catalog'&&(!Array.isArray(a.sellers)||!a.sellers.length))invalid('sellers lists the sellers (retailerId and sellerId) to restrict the catalog to.');
 list(a.sellers,'sellers',seller);
 if(a.modifiedAfter!==undefined&&a.modifiedAfter!==null&&(typeof a.modifiedAfter!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.test(a.modifiedAfter)||!Number.isFinite(Date.parse(a.modifiedAfter))||Date.parse(a.modifiedAfter)>Date.now()))invalid('modifiedAfter is an ISO 8601 date-time in the past.');
}
export function assertCriteoCatalogScopes(c:Connection,kind?:Kind):void{
 const required=['RetailMedia_Accounts_Read','RetailMedia_Campaign_Read',...(kind==='brand_export'||kind==='seller_export'?['RetailMedia_Campaign_Manage']:[])];
 if(!required.every(s=>c.scopes.includes(s)))fail('INSUFFICIENT_SCOPE','The selected Criteo connection needs '+required.join(', ')+'.',{},403);
}
const accountRead=(p:CompiledRequest,state:State):CompiledRequest=>({...p,action:'AMCP_CRITEO_CATALOG_READ',method:'GET',path:prefix+'/accounts',query:{limitToId:[p.accountId!],pageIndex:0,pageSize:2},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:'repeat',criteoCatalogState:state});
export function criteoCatalogSnapshots(p:CompiledRequest):CompiledRequest[]{return [accountRead(p,{})];}
export function isCriteoCatalogRead(p:CompiledRequest):boolean{return p.gateway===gateway&&!!p.criteoCatalogState;}
/** Internal reads keep the account; the status read is bound to the catalog ID of a receipt. Remembered catalogs are readable natively. */
export function authorizeCriteoCatalog(p:CompiledRequest,c:Connection,store:Store,account:string):boolean{
 if(p.gateway!==gateway)return false;
 const kind=criteoCatalogKind(p);
 if(kind){assertCriteoCatalog(p);assertCriteoCatalogScopes(c,kind);return true;}
 const own=/^\/2026-01\/retail-media\/catalogs\/([1-9][0-9]{0,18})\/(status|output)$/.exec(p.path);
 if(p.action!=='AMCP_CRITEO_CATALOG_READ'){
  if(own&&p.method==='GET'&&p.readOnly&&p.accountId===account&&store.ownsResource(c,account,'catalogs/'+own[1])){assertCriteoCatalogScopes(c);return true;}
  return false;
 }
 assertCriteoCatalogScopes(c);
 if(p.accountId!==account||p.method!=='GET'||!p.readOnly||p.body!==undefined||p.specialTransport||p.origin&&p.origin!==origin||Object.keys(p.headers).length)fail('RESOURCE_SCOPE_REQUIRED','Catalog reads keep their exact account and origin.',{},403);
 if(p.path===prefix+'/accounts'&&stable(p.query)===stable({limitToId:[account],pageIndex:0,pageSize:2}))return true;
 if(own&&own[2]==='status'&&p.scopeContext?.criteoCatalogId===own[1]&&!Object.keys(p.query).length)return true;
 return fail('RESOURCE_SCOPE_REQUIRED','Catalog reads need the selected account or a catalog ID from a receipt.',{},403);
}
function envelope(r:TransportResult):JsonObject{const d=r.data;if(r.status!==200||!obj(d)||Array.isArray(d.errors)&&d.errors.length)unverified('Criteo returned a failed or unrecognized response.');return d as JsonObject;}
export async function readCriteoCatalog(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=p.criteoCatalogState;if(!s)return fetch(p);
 const d=envelope(await fetch({...p,criteoCatalogState:undefined})),rows=Array.isArray(d.data)?d.data:[];
 if(rows.length!==1||!obj(rows[0])||String(rows[0].id)!==p.accountId||!obj(rows[0].attributes))fail('STATE_TARGET_MISMATCH','Account '+p.accountId+' is not readable with this connection.',{},409);
 const out:JsonObject={account:{id:p.accountId,type:rows[0].attributes.type??null,currency:rows[0].attributes.currency??null}};
 if(s.catalogId){
  // Bound here to the receipt's catalog ID; external arguments cannot set this context.
  const bound={...p,action:'AMCP_CRITEO_CATALOG_READ',method:'GET',path:prefix+'/catalogs/'+s.catalogId+'/status',query:{},criteoCatalogState:undefined,scopeContext:{...p.scopeContext,criteoCatalogId:s.catalogId}};
  const c=envelope(await fetch(bound)),row=obj(c.data)?c.data:undefined,a=obj(row?.attributes)?row!.attributes as JsonObject:undefined;
  if(!row||String(row.id)!==s.catalogId||!a)fail('STATE_TARGET_MISMATCH','Criteo returned another catalog for '+s.catalogId+'.',{catalog_id:s.catalogId},409);
  out.catalog={id:s.catalogId,status:statuses.includes(String(a!.status))?a!.status:'unknown',requested:['pending','success'].includes(String(a!.status)),createdAt:a!.createdAt??null,rowCount:a!.rowCount??null};
 }
 return {status:200,headers:{},data:out};
}
export function validateCriteoCatalogState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data,s=p.criteoCatalogState;
 if(!s||r.status!==200||!obj(d)||!obj(d.account)||!!s.catalogId!==obj(d.catalog))unverified('Missing verified catalog request state.');
}
export function criteoCatalogPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!criteoCatalogKind(p))return;
 const s=states[0];if(!obj(s)||!obj(s.account))unverified('Missing verified catalog request state.');
}
export function criteoCatalogImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=criteoCatalogKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},a=obj(p.body)&&obj(p.body.data)&&obj(p.body.data.attributes)?p.body.data.attributes:{};
 return {provider:'criteo',scope:'catalog_request',operation:kind,account:obj(s.account)?s.account:null,request:a,may_affect_serving:false,
  effect:'Asks Criteo to build a file of the products available to the account'+(kind.startsWith('seller')?' for the sellers named':'')+'; campaigns, budgets and serving do not change. Read catalogs/{catalogId}/status until success, then the output.',
  verification:'Reads the catalog status by the ID in the receipt and expects pending or success.',source:'https://developers.criteo.com/retail-media/reference'};
}
function receiptId(r:TransportResult):string|undefined{const d=r.data;return obj(d)&&obj(d.data)&&id(String(d.data.id))?String(d.data.id):undefined;}
export function criteoCatalogOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;if(![200,201].includes(r.status)||!obj(d)||Array.isArray(d.errors)&&d.errors.length||!receiptId(r))return false;
 const a=obj(d.data)&&obj(d.data.attributes)?d.data.attributes:undefined;
 return !!a&&['pending','success'].includes(String(a.status));
}
export function criteoCatalogVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const catalog=String(result.data?.data?.id??'');
 if(!id(catalog))fail('VERIFICATION_UNSUPPORTED','The receipt names no catalog to verify.');
 return [{read:accountRead(p,{catalogId:catalog}),expected:{catalog:{id:catalog,requested:true}},id:'catalog '+catalog}];
}
export function criteoCatalogObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {catalog:obj(data.catalog)?data.catalog:null};}
