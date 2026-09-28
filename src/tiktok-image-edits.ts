import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Editing TikTok library images, per API for Business v1.3 "Edit an image" (checked 2026-09-28). POST
 * /v1.3/creative/image/edit/ takes advertiser_id, image_id, width and height, edit_method (fix_size: "fixed length and width
 * cropping, no trimming"; only_gauss_pad: "only Gaussian blur trimming, no cropping"; gauss_padding_reserve_score:
 * Gaussian blur fitted to the main subject; fix_size by default) and image_name. It "only supports cropping/trimming of an
 * image that has been uploaded to the Asset Library. The edited images will be automatically uploaded to the Asset Library
 * and the new picture ID will be returned" with its width, height, format and file_name. Library image names have 1–100
 * characters and a taken name gets a millisecond timestamp ("Update the name of an image"). The source image is searched
 * before and the new image after.
 */
type State={image:string;name?:string};
type Read=CompiledRequest&{tiktokImageEditState?:State};
const gateway='tiktok_native_action',editPath='/v1.3/creative/image/edit/',nameMax=100;
const methods:Record<string,string>={fix_size:'cropped to the size, without padding',only_gauss_pad:'padded with Gaussian blur to the size, without cropping',gauss_padding_reserve_score:'fitted to the size around its main subject with Gaussian blur padding'};
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
// Image IDs are web URIs such as ad-site-i18n-sg/202011165d0d...
const imageId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_.\/-]{1,256}$/.test(v)&&!v.includes('..');
const pixels=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_TIKTOK_IMAGE_EDIT',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function tiktokImageEditKind(p:CompiledRequest):boolean{return p.gateway===gateway&&p.method==='POST'&&!p.specialTransport&&p.path===editPath;}
const body=(p:CompiledRequest):JsonObject=>obj(p.body)?p.body:{};
export function assertTiktokImageEdit(p:CompiledRequest):void{
 if(!tiktokImageEditKind(p))return;
 if(Object.keys(p.query).length)invalid('An image edit takes no query parameters.');
 const b=p.body;if(!obj(b))invalid('Send the request as a JSON object.');
 if(String(b.advertiser_id)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','advertiser_id must be the selected advertiser.',{},403);
 const extra=Object.keys(b).filter(k=>!['advertiser_id','image_id','edit_method','width','height','image_name'].includes(k));
 if(extra.length)invalid('An image edit takes image_id, width, height, edit_method and image_name, not '+extra.join(', ')+'.');
 if(!imageId(b.image_id))invalid('image_id names one image of the asset library.');
 if(b.edit_method!==undefined&&!Object.hasOwn(methods,String(b.edit_method)))invalid('edit_method is fix_size (the default), only_gauss_pad or gauss_padding_reserve_score.');
 if(!pixels(b.width)||!pixels(b.height))invalid('width and height are whole numbers of pixels above zero.');
 const n=b.image_name;
 if(n!==undefined&&(typeof n!=='string'||!n.trim()||n!==n.trim()||[...n].length>nameMax||/[\u0000-\u001f\u007f]/.test(n)))invalid('image_name has 1–'+nameMax+' characters without leading or trailing spaces, like other library image names.');
}
const search=(p:CompiledRequest,id:string,state?:State):Read=>({...p,action:'tiktok_file_image_ad_search',method:'GET',path:'/v1.3/file/image/ad/search/',query:{advertiser_id:p.accountId,filtering:{image_ids:[id]},page:1,page_size:20},body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,tiktokImageEditState:state});
export function tiktokImageEditSnapshots(p:CompiledRequest):Read[]{const id=String(body(p).image_id);return [search(p,id,{image:id})];}
export function isTiktokImageEditRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).tiktokImageEditState;}
const size=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):null;
/** The named image of the advertiser's library: name, width, height and format, or absent. */
export async function readTiktokImageEdits(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).tiktokImageEditState;if(!s)return request(p);
 const r=await request({...(p as Read),tiktokImageEditState:undefined} as Read),d=r.data;
 if(r.status!==200||!obj(d)||d.code!==0||!obj(d.data))unverified('TikTok did not return the image search.');
 const list=(d.data as JsonObject).list,rows=list===undefined||list===null?[]:Array.isArray(list)?list:unverified('TikTok did not list the images.');
 if(rows.some(x=>!obj(x)||String(x.image_id)!==s.image))fail('STATE_TARGET_MISMATCH','TikTok listed an image that was not named.',{},409);
 const row=rows[0] as JsonObject|undefined;
 return {status:200,headers:{},data:{image:row?{present:true,id:s.image,name:typeof row.file_name==='string'?row.file_name:null,width:size(row.width),height:size(row.height),format:typeof row.format==='string'?row.format:null}:{present:false,id:s.image}}};
}
export function validateTiktokImageEditState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).tiktokImageEditState||r.status!==200||!obj(d)||!obj(d.image)||typeof d.image.present!=='boolean')unverified('Missing verified image state.');
}
export function tiktokImageEditPrerequisites(p:CompiledRequest,states:unknown[]):void{
 if(!tiktokImageEditKind(p))return;
 const s=states[0],img=obj(s)&&obj(s.image)?s.image:unverified('Missing verified image state.'),b=body(p);
 if(img.present!==true)fail('STATE_NOT_FOUND','Image '+String(b.image_id)+' is not in the asset library of the selected advertiser.',{image_id:String(b.image_id)},404);
 if(img.width===b.width&&img.height===b.height)invalid('Image '+String(b.image_id)+' is already '+String(b.width)+'×'+String(b.height)+'; an edit would only copy it.');
}
export function tiktokImageEditImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 if(!tiktokImageEditKind(p))return;
 const first=state[0],img=obj(first)&&obj(first.image)?first.image:{},b=body(p),method=String(b.edit_method??'fix_size');
 return {provider:'tiktok',scope:'image',operation:'edit',original:{id:b.image_id,name:img.name??null,width:img.width??null,height:img.height??null},creating:{width:b.width,height:b.height,edit_method:method,name:b.image_name??null},may_affect_serving:false,
  effect:'Adds a '+String(b.width)+'×'+String(b.height)+' copy of the image to the asset library, '+methods[method]+'. The source image and the ads that use it are unchanged.',
  verification:'Searches the new image and compares its size'+(b.image_name!==undefined?' and name (a taken name may end with TikTok\'s millisecond timestamp)':'')+'.',source:'https://business-api.tiktok.com/portal/docs/edit-an-image/v1.3'};
}
export function tiktokImageEditOutcome(_p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;return r.status===200&&obj(d)&&d.code===0&&obj(d.data)&&imageId(d.data.image_id);
}
export function tiktokImageEditVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const id=result.data?.data?.image_id;if(!imageId(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no new image to verify.');
 const b=body(p),named=b.image_name!==undefined;
 return [{read:search(p,id,{image:id,...(named?{name:String(b.image_name)}:{})}),expected:{image:{present:true,width:b.width,height:b.height,...(named?{name:b.image_name}:{})}},id:'image '+id}];
}
/** The new image reads as the sent name, or the sent name with TikTok's millisecond timestamp when the name was taken. */
export function tiktokImageEditObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const s=(read as Read).tiktokImageEditState,img=obj(data.image)?data.image:{};
 if(img.present!==true)return {image:{present:false}};
 const name=typeof img.name==='string'?img.name:null,sent=s?.name;
 const suffixed=sent!==undefined&&name!==null&&name!==sent&&name.startsWith(sent)&&/^[ _-]?\d{13}$/.test(name.slice(sent.length));
 return {image:{present:true,width:img.width,height:img.height,...(sent!==undefined?{name:suffixed?sent:name}:{})}};
}
