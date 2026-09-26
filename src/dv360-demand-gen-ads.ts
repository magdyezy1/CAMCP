import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import {validateDiscoveryBody} from './discovery-body.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {dv360AdGroupStateRead,readDV360AdGroups} from './dv360-demand-gen-ad-groups.js';

/**
 * Demand Gen ads on Display & Video 360 API v4, per the pinned Discovery document (AdGroupAd, DemandGenVideoAd,
 * DemandGenImageAd, DemandGenCarouselAd, DemandGenProductAd, adGroupAds.create, patch and delete) and "Create a Demand Gen
 * ad" of the Demand Gen guide (checked 2026-09-27).
 * - An ad is one of four types, built from text, URLs and ad assets: YouTube videos by ad asset ID and images by asset
 *   ID. Only Demand Gen ads can be written; the ad group and the type cannot change.
 * - An ad serves only while it, its ad group and its line item are active; Google recommends creating ads paused.
 * - YouTube video assets are read back by ID; the API does not read image assets, so DV360 checks those.
 */
const origin='https://displayvideo.googleapis.com';
const collection=/^\/v4\/advertisers\/([1-9]\d*)\/adGroupAds$/,single=/^\/v4\/advertisers\/([1-9]\d*)\/adGroupAds\/([1-9]\d*)$/;
type Kind='create'|'patch'|'delete';
type Scope={adGroupAdId?:string;adGroupId?:string;videoAssetIds:string[];optional?:boolean};
const types=['demandGenVideoAd','demandGenImageAd','demandGenCarouselAd','demandGenProductAd'];
/** Writable fields; creation also sets the immutable adGroupId. */
export const dv360AdFields=['displayName','entityStatus',...types];
const videoActions=['AUTOMATED','LEARN_MORE','GET_QUOTE','APPLY_NOW','SIGN_UP','CONTACT_US','SUBSCRIBE','DOWNLOAD','BOOK_NOW','SHOP_NOW','BUY_NOW','DONATE_NOW','ORDER_NOW','PLAY_NOW','SEE_MORE','START_NOW','VISIT_SITE','WATCH_NOW'];
const productActions=['AUTOMATED','APPLY_NOW','BOOK_NOW','CONTACT_US','DOWNLOAD','GET_QUOTE','LEARN_MORE','SHOP_NOW','SIGN_UP','SUBSCRIBE'];
const statuses=['ENTITY_STATUS_ACTIVE','ENTITY_STATUS_PAUSED'];
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown)=>/^[1-9]\d*$/.test(String(v??''));
let schemas:Record<string,JsonObject>|undefined;
const models=()=>schemas??=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../.mirror/VENDOR/dv360-v4.json',import.meta.url)),'utf8')).document.schemas as Record<string,JsonObject>;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_AD',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function mismatch(message:string):never{return fail('STATE_TARGET_MISMATCH',message,{},409);}

export function dv360AdKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!=='dv360_native_action'||p.origin!==undefined&&p.origin!==origin||p.specialTransport)return;
 if(p.method==='POST'&&collection.test(p.path))return 'create';
 if(p.method==='PATCH'&&single.test(p.path))return 'patch';
 if(p.method==='DELETE'&&single.test(p.path))return 'delete';
 return;
}
const advertiserOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const adOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
const mask=(p:CompiledRequest):string[]=>String(p.query.updateMask??'').split(',').map(s=>s.trim()).filter(Boolean);

function text(v:unknown,label:string):void{if(typeof v!=='string'||!v.trim()||v!==v.trim()||/[\u0000-\u001f]/.test(v))invalid(label+' must be text without surrounding spaces or control characters.');}
function texts(v:unknown,label:string):void{
 if(!Array.isArray(v)||!v.length||v.length>15)invalid(label+' lists 1–15 texts.');
 v.forEach((x,i)=>text(x,label+'['+i+']'));if(new Set(v).size!==v.length)invalid(label+' repeats a text.');
}
function url(v:unknown,label:string):void{
 const refuse=()=>invalid(label+' must be a complete http(s) URL without spaces or credentials.');
 if(typeof v!=='string'||v.length>2048||/\s/.test(v))refuse();
 let u:URL;try{u=new URL(v as string);}catch{return refuse();}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)refuse();
}
function image(v:unknown,label:string):void{if(!obj(v)||Object.keys(v).some(k=>k!=='assetId')||!numeric(v.assetId))invalid(label+' is {assetId} with the ID of an image asset.');}
function images(v:unknown,label:string):void{if(!Array.isArray(v)||v.length>20)invalid(label+' lists up to 20 images.');v.forEach((x,i)=>image(x,label+'['+i+']'));}
function common(a:JsonObject,label:string):void{
 url(a.finalUrl,label+'.finalUrl');
 for(const k of ['finalMobileUrl','userSpecifiedTrackingUrl'])if(a[k]!==undefined)url(a[k],label+'.'+k);
 for(const k of ['businessName','finalUrlSuffix','displayUrlBreadcrumb1','displayUrlBreadcrumb2'])if(a[k]!==undefined)text(a[k],label+'.'+k);
 if(a.customParameters!==undefined&&(!obj(a.customParameters)||Object.entries(a.customParameters).some(([k,x])=>!/^[A-Za-z0-9_]{1,32}$/.test(k)||typeof x!=='string'||!x||/\s/.test(x))))invalid(label+'.customParameters maps alphanumeric names to values without spaces.');
}
function ad(type:string,a:unknown):void{
 if(!obj(a))invalid(type+' is an object.');
 common(a,type);
 if(type==='demandGenVideoAd'){
  if(!videoActions.includes(a.callToAction))invalid(type+'.callToAction is one of '+videoActions.join(', ')+'.');
  texts(a.headlines,type+'.headlines');texts(a.longHeadlines,type+'.longHeadlines');texts(a.descriptions,type+'.descriptions');
  if(!Array.isArray(a.videos)||!a.videos.length||a.videos.length>5||a.videos.some((v:unknown)=>!obj(v)||Object.keys(v).some(k=>k!=='videoAssetId')||!numeric(v.videoAssetId))||new Set(a.videos.map((v:JsonObject)=>String(v.videoAssetId))).size!==a.videos.length)invalid(type+'.videos lists 1–5 distinct {videoAssetId} of YouTube video ad assets.');
  for(const k of ['logo','companionBanner'])if(a[k]!==undefined)image(a[k],type+'.'+k);
 }else if(type==='demandGenImageAd'){
  text(a.callToAction,type+'.callToAction');texts(a.headlines,type+'.headlines');texts(a.descriptions,type+'.descriptions');
  for(const k of ['marketingImages','squareMarketingImages','portraitMarketingImages','logoImages'])if(a[k]!==undefined)images(a[k],type+'.'+k);
  if(![a.marketingImages,a.squareMarketingImages,a.portraitMarketingImages].some(x=>Array.isArray(x)&&x.length))invalid(type+' needs at least one marketing image.');
 }else if(type==='demandGenCarouselAd'){
  text(a.headline,type+'.headline');text(a.description,type+'.description');if(a.logo!==undefined)image(a.logo,type+'.logo');
  if(!Array.isArray(a.cards)||a.cards.length<2||a.cards.length>10)invalid(type+'.cards lists 2–10 cards.');
  a.cards.forEach((c:unknown,i:number)=>{
   const l=type+'.cards['+i+']';if(!obj(c))invalid(l+' is an object.');
   url(c.finalUrl,l+'.finalUrl');if(c.finalMobileUrl!==undefined)url(c.finalMobileUrl,l+'.finalMobileUrl');text(c.headline,l+'.headline');
   if(typeof c.callToAction!=='string'||!c.callToAction.trim()||[...c.callToAction].length>10)invalid(l+'.callToAction is 1–10 characters.');
   for(const k of ['marketingImage','squareMarketingImage','portraitMarketingImage'])if(c[k]!==undefined)image(c[k],l+'.'+k);
   if(!c.marketingImage&&!c.squareMarketingImage&&!c.portraitMarketingImage)invalid(l+' needs an image.');
  });
 }else{
  text(a.headline,type+'.headline');text(a.description,type+'.description');if(a.logo!==undefined)image(a.logo,type+'.logo');
  if(!productActions.includes(a.callToAction))invalid(type+'.callToAction is one of '+productActions.join(', ')+'.');
 }
}
export function assertDV360Ad(p:CompiledRequest):void{
 const kind=dv360AdKind(p);if(!kind)return;
 if(advertiserOf(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected advertiser.',{},403);
 if(Object.keys(p.headers).length||Object.keys(p.query).some(k=>kind!=='patch'||k!=='updateMask'))invalid('Ad requests take no query or header overrides'+(kind==='patch'?' besides updateMask':'')+'.');
 if(kind==='delete'){if(p.body!==undefined&&!(obj(p.body)&&!Object.keys(p.body).length))invalid('Deleting an ad takes no body.');return;}
 const a=p.body;if(!obj(a))invalid('Provide the native AdGroupAd object.');
 const allowed=kind==='create'?[...dv360AdFields,'adGroupId']:dv360AdFields,unknown=Object.keys(a).filter(k=>!allowed.includes(k));
 if(unknown.length)invalid('Unqualified ad fields: '+unknown.join(', ')+'. IDs, names and policy are assigned by DV360'+(kind==='patch'?', and the ad group cannot change':'')+'; only Demand Gen ads can be written.');
 validateDiscoveryBody('AdGroupAd',models(),a,kind==='create');
 let set:string[];
 if(kind==='create'){
  if(typeof a.adGroupId!=='string'||!numeric(a.adGroupId))invalid('adGroupId is the numeric ID of the Demand Gen ad group, as a string.');
  const missing=['displayName','entityStatus'].filter(k=>a[k]===undefined);if(missing.length)invalid('Creation needs '+missing.join(', ')+'.');
  if(types.filter(t=>a[t]!==undefined).length!==1)invalid('An ad is exactly one of '+types.join(', ')+'.');
  set=Object.keys(a);
 }else{
  set=mask(p);
  if(!set.length||set.some(f=>!dv360AdFields.includes(f))||new Set(set).size!==set.length)invalid('updateMask lists distinct top-level fields among '+dv360AdFields.join(', ')+'.');
  const extra=Object.keys(a).filter(k=>!set.includes(k)),absent=set.filter(k=>a[k]===undefined);
  if(extra.length||absent.length)invalid('The body carries exactly the fields in updateMask'+(extra.length?'; not masked: '+extra.join(', '):'')+(absent.length?'; missing: '+absent.join(', '):'')+'.');
  if(set.filter(f=>types.includes(f)).length>1)invalid('A patch sets at most one ad type.');
 }
 if(set.includes('displayName')&&(typeof a.displayName!=='string'||!a.displayName.trim()||a.displayName!==a.displayName.trim()||Buffer.byteLength(a.displayName,'utf8')>255||/[\u0000-\u001f]/.test(a.displayName)))invalid('displayName is 1–255 UTF-8 bytes without surrounding spaces or control characters.');
 if(set.includes('entityStatus')&&!statuses.includes(a.entityStatus))invalid('entityStatus is ENTITY_STATUS_PAUSED or ENTITY_STATUS_ACTIVE.');
 for(const t of types)if(set.includes(t))ad(t,a[t]);
}

const videoIds=(p:CompiledRequest):string[]=>{const a=obj(p.body)&&obj(p.body.demandGenVideoAd)&&Array.isArray(p.body.demandGenVideoAd.videos)?p.body.demandGenVideoAd.videos:[];return [...new Set<string>(a.map((v:JsonObject)=>String(v?.videoAssetId)))].sort();};
const read=(p:CompiledRequest,path:string):CompiledRequest=>({...p,action:'AMCP_DV360_AD_READ',method:'GET',path,query:{},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:undefined,dv360AdState:undefined,dv360AdGroupState:undefined});
/** One marked read of the advertiser; the reader below adds the ad, its ad group and line item, and the video assets. */
const stateRead=(p:CompiledRequest,scope:Scope):CompiledRequest=>({...read(p,'/v4/advertisers/'+advertiserOf(p)),dv360AdState:scope});
export function dv360AdReads(p:CompiledRequest):CompiledRequest[]{
 const kind=dv360AdKind(p),a=obj(p.body)?p.body:{};
 return [stateRead(p,{...(kind==='create'?{adGroupId:String(a.adGroupId)}:{adGroupAdId:adOf(p)}),videoAssetIds:videoIds(p)})];
}
export function isDV360AdRead(p:CompiledRequest):boolean{return p.gateway==='dv360_native_action'&&!!p.dv360AdState;}
function body(r:TransportResult,what:string):JsonObject{if(r.status!==200||!obj(r.data)||r.data.error)unverified('DV360 did not return the '+what+'.');return r.data;}
/** Output-only fields dropped, following the pinned model, plus the video availability note. */
function clean(schema:JsonObject,value:unknown):unknown{
 const s=schema.$ref?models()[schema.$ref as string]??{}:schema;
 if(Array.isArray(value))return value.map(v=>clean(obj(s.items)?s.items:{},v));
 if(obj(value)){const out:JsonObject={};for(const [k,v] of Object.entries(value)){const child=obj(s.properties)?s.properties[k]:undefined;if(!obj(child)||child.readOnly===true||k==='unavailableReason')continue;out[k]=clean(child,v);}return out;}
 return value;
}
const creative=(type:string,value:unknown)=>clean(models().AdGroupAd!.properties[type] as JsonObject,value);
function adState(d:JsonObject,advertiser:string,id:string):JsonObject{
 if(String(d.advertiserId)!==advertiser||String(d.adGroupAdId)!==id||d.name!=='advertisers/'+advertiser+'/adGroupAds/'+id)mismatch('DV360 returned a different ad.');
 const type=types.find(t=>obj(d[t]));if(!type)invalid('Ad '+id+' is not a Demand Gen ad; only Demand Gen ads can be written.');
 return {adGroupAdId:id,adGroupId:String(d.adGroupId),displayName:d.displayName??null,entityStatus:d.entityStatus??null,type,creative:creative(type,d[type])};
}
/**
 * Up to 12 reads: the advertiser, the ad when one is named (absent after a verified deletion), its ad group and line item
 * through the Demand Gen ad group reader, and each YouTube video asset of the request.
 */
export async function readDV360Ads(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const scope=p.dv360AdState;if(!scope)return fetch(p);
 const advertiser=advertiserOf(p),plain={...p,dv360AdState:undefined};
 let ad:JsonObject|null=null,adGroupId=scope.adGroupId;
 if(scope.adGroupAdId){
  let r:TransportResult|undefined;
  try{r=await fetch(read(p,'/v4/advertisers/'+advertiser+'/adGroupAds/'+scope.adGroupAdId));}
  catch(e){if(!(scope.optional&&e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND')))throw e;}
  if(r){ad=adState(body(r,'ad'),advertiser,scope.adGroupAdId);adGroupId=ad.adGroupId as string;}
 }
 let group:JsonObject={};
 if(adGroupId)group=(await readDV360AdGroups(dv360AdGroupStateRead(plain,{adGroupId}),fetch)).data as JsonObject;
 const videoAssets:JsonObject[]=[];
 for(const id of scope.videoAssetIds){
  let r:TransportResult;
  // The API reads YouTube video assets only; a missing one, or an image asset ID, is not a video asset of the advertiser.
  try{r=await fetch(read(p,'/v4/advertisers/'+advertiser+'/adAssets/'+id));}
  catch(e){if(e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND'))mismatch('Ad asset '+id+' is not a YouTube video asset of the advertiser.');throw e;}
  const d=body(r,'ad asset '+id);
  if(String(d.adAssetId)!==id||d.adAssetType!=='AD_ASSET_TYPE_YOUTUBE_VIDEO')mismatch('Ad asset '+id+' is not a YouTube video asset of the advertiser.');
  videoAssets.push({adAssetId:id,youtubeVideoId:obj(d.youtubeVideoAsset)?d.youtubeVideoAsset.youtubeVideoId??null:null,entityStatus:d.entityStatus??null});
 }
 return {status:200,headers:{},data:{advertiserId:advertiser,ad,adGroup:group.adGroup??null,lineItem:group.lineItem??null,videoAssets}};
}
export function validateDV360AdState(read:CompiledRequest,r:TransportResult):void{
 const d=r.data,s=read.dv360AdState;
 if(r.status!==200||!obj(d)||d.advertiserId!==advertiserOf(read)||!Array.isArray(d.videoAssets))unverified('Missing verified DV360 ad state.');
 if(s?.adGroupAdId&&!s.optional&&!obj(d.ad)||(obj(d.ad)||s?.adGroupId)&&(!obj(d.adGroup)||!obj(d.lineItem)))unverified('Missing verified DV360 ad state.');
}
export function dv360AdReviewState(d:JsonObject):JsonObject{return {ad:d.ad??null,adGroup:d.adGroup??null,lineItem:d.lineItem??null,videoAssets:d.videoAssets??[]};}

/** The ad as the request leaves it, in the form above. */
function after(plan:CompiledRequest,before:JsonObject|null):JsonObject{
 const a=plan.body as JsonObject,kind=dv360AdKind(plan),set=kind==='create'?Object.keys(a):mask(plan);
 const out:JsonObject=before?{...before}:{adGroupAdId:null,adGroupId:a.adGroupId,displayName:null,entityStatus:null,type:null,creative:null};
 for(const f of set){if(types.includes(f)){out.type=f;out.creative=creative(f,a[f]);}else if(f==='displayName'||f==='entityStatus')out[f]=a[f];}
 return out;
}
export function validateDV360AdPrerequisites(plan:CompiledRequest,states:unknown[]):void{
 const kind=dv360AdKind(plan);if(!kind)return;
 const s=states[0];if(!obj(s)||!obj(s.adGroup)||!obj(s.lineItem))unverified('Missing verified DV360 ad state.');
 if(s.adGroup.entityStatus==='ENTITY_STATUS_ARCHIVED'||s.lineItem.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Ad group '+s.adGroup.adGroupId+' or its line item is archived.');
 if(kind!=='create'){
  if(!obj(s.ad))unverified('Missing verified DV360 ad state.');
  if(s.ad.entityStatus==='ENTITY_STATUS_ARCHIVED')invalid('Ad '+s.ad.adGroupAdId+' is archived.');
 }
 if(kind==='delete')return;
 const archived=(s.videoAssets as JsonObject[]).filter(v=>v.entityStatus==='ENTITY_STATUS_ARCHIVED').map(v=>v.adAssetId);
 if(archived.length)invalid('Video ad assets '+archived.join(', ')+' are archived.');
 if(kind==='patch'){
  const next=after(plan,s.ad as JsonObject);
  if(next.type!==s.ad.type)invalid('Ad '+s.ad.adGroupAdId+' is a '+s.ad.type+'; its type cannot change.');
  if(stable(next)===stable(s.ad))invalid('Ad '+s.ad.adGroupAdId+' already matches this request.');
 }
}
/** An active ad serves once its ad group and line item are active; the DV360 owner rule counts an active status as activation. */
export function dv360AdNeedsConfirmation(plan:CompiledRequest):boolean{
 const kind=dv360AdKind(plan);return (kind==='create'||kind==='patch')&&obj(plan.body)&&plan.body.entityStatus==='ENTITY_STATUS_ACTIVE';
}
export function dv360AdImpact(plan:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=dv360AdKind(plan);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},before=obj(s.ad)?s.ad:null,result=kind==='delete'?null:after(plan,before),group=obj(s.adGroup)?s.adGroup:null,line=obj(s.lineItem)?s.lineItem:null;
 const active=result?.entityStatus==='ENTITY_STATUS_ACTIVE',chain=group?.entityStatus==='ENTITY_STATUS_ACTIVE'&&line?.entityStatus==='ENTITY_STATUS_ACTIVE';
 return {provider:'dv360',scope:'demand_gen_ad',operation:kind,ad_group:group?{ad_group_id:group.adGroupId,display_name:group.displayName,entity_status:group.entityStatus}:null,line_item:line?{line_item_id:line.lineItemId,entity_status:line.entityStatus}:null,
  before,after:result,video_assets:s.videoAssets??[],may_affect_serving:kind==='delete'?before?.entityStatus==='ENTITY_STATUS_ACTIVE':active||before?.entityStatus==='ENTITY_STATUS_ACTIVE',
  effect:kind==='delete'?'Deletes the Demand Gen ad.':active?'The ad serves '+(chain?'at once: its ad group and line item are active.':'once its ad group and line item are active.'):'The ad stays paused and serves nothing until it is set to active.',
  checks:'YouTube video assets are read by ID; image assets cannot be read through the API, so DV360 checks their IDs, sizes and policy.',
  verification:kind==='delete'?'Reads the ad again and expects it to be gone.':'Reads the ad again and compares its name, status, type and every creative field sent.',
  source:'https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-dg-ad'};
}
export function dv360AdOutcome(plan:CompiledRequest,r:TransportResult):boolean{
 const kind=dv360AdKind(plan)!,d=r.data;
 if(r.status!==200)return false;
 if(kind==='delete')return d==null||obj(d)&&!Object.keys(d).length;
 if(!obj(d)||d.error||String(d.advertiserId)!==advertiserOf(plan)||!numeric(d.adGroupAdId)||!types.some(t=>obj(d[t])))return false;
 return kind==='create'?String(d.adGroupId)===String((plan.body as JsonObject).adGroupId):String(d.adGroupAdId)===adOf(plan);
}
export function dv360AdVerification(plan:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=dv360AdKind(plan)!,first=before[0],prior=obj(first)&&obj(first.ad)?first.ad:null;
 const id=kind==='create'?String(result.data?.adGroupAdId??''):adOf(plan);
 if(!numeric(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no ad to verify.');
 return [{read:stateRead(plan,{adGroupAdId:id,videoAssetIds:[],optional:kind==='delete'}),expected:{ad:kind==='delete'?null:{...after(plan,prior),adGroupAdId:id}},id:'Demand Gen ad '+id}];
}
export function dv360AdObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {ad:obj(data.ad)?data.ad:null};}
