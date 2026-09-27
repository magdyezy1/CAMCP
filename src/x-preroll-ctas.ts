import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Call-to-action buttons of X Ads pre-roll line items, Ads API v12 (Creatives reference, "Preroll Call To Actions";
 * docs.x.com copy read on 2026-09-27). POST sets the optional button (GO_TO, SEE_MORE, SHOP, VISIT_SITE or WATCH_NOW) and
 * its destination URL for a PREROLL_VIEWS line item, PUT changes either, and DELETE removes the button. X documents the
 * button per line item, so AMCP keeps one per line item and changes it with PUT.
 */
type Kind='create'|'update'|'delete';
type State={lineItemId?:string;ctaId?:string};
type Read=CompiledRequest&{xPrerollCtaState?:State};
const gateway='x_ads_native_action',nativeId=/^[a-z0-9]{1,32}$/,buttons=['GO_TO','SEE_MORE','SHOP','VISIT_SITE','WATCH_NOW'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_X_PREROLL_CTA',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
export function xPrerollCtaKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.specialTransport)return;
 if(p.method==='POST'&&/^\/12\/accounts\/[a-z0-9]{1,32}\/preroll_call_to_actions$/.test(p.path))return 'create';
 if(['PUT','DELETE'].includes(p.method)&&/^\/12\/accounts\/[a-z0-9]{1,32}\/preroll_call_to_actions\/[a-z0-9]{1,32}$/.test(p.path))return p.method==='PUT'?'update':'delete';
 return;
}
const account=(p:CompiledRequest)=>p.path.split('/')[3]!,ctaOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
function destination(v:unknown):void{
 if(typeof v!=='string'||v.length>2048||/[\s\u0000-\u001f\u007f]/.test(v))invalid('call_to_action_url is the destination: at most 2048 characters without spaces or control characters.');
 let u:URL;try{u=new URL(v as string);}catch{return invalid('call_to_action_url must be an absolute URL.');}
 if(!['https:','http:'].includes(u.protocol)||!u.hostname.includes('.')||u.username||u.password)invalid('call_to_action_url must be an HTTP(S) destination without embedded credentials.');
}
export function assertXPrerollCta(p:CompiledRequest):void{
 const kind=xPrerollCtaKind(p);if(!kind)return;
 if(account(p)!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','The request must use the selected account.',{},403);
 if(Object.keys(p.query).length||Object.keys(p.headers??{}).length)invalid('Pre-roll call-to-action writes take their parameters in the body, without query or header overrides.');
 const b=p.body===undefined?{}:p.body;if(!object(b))invalid('Provide the native call-to-action parameters.');
 const allowed=kind==='create'?['line_item_id','call_to_action','call_to_action_url']:kind==='update'?['call_to_action','call_to_action_url']:[];
 const extra=Object.keys(b).filter(k=>!allowed.includes(k));
 if(extra.length)invalid((kind==='update'&&extra.includes('line_item_id')?'The line item of a call to action does not change; delete it and create one for the other line item. ':'')+'Unqualified fields: '+extra.join(', ')+'.');
 if(kind==='delete')return;
 if(kind==='create'&&(typeof b.line_item_id!=='string'||!nativeId.test(b.line_item_id)))invalid('line_item_id is the native ID of a pre-roll line item of the selected account.');
 if(kind==='create'&&(b.call_to_action===undefined||b.call_to_action_url===undefined))invalid('A call to action needs call_to_action and call_to_action_url.');
 if(kind==='update'&&b.call_to_action===undefined&&b.call_to_action_url===undefined)invalid('Send call_to_action, call_to_action_url or both.');
 if(b.call_to_action!==undefined&&!buttons.includes(b.call_to_action))invalid('call_to_action is one of '+buttons.join(', ')+'.');
 if(b.call_to_action_url!==undefined)destination(b.call_to_action_url);
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):Read{return {...p,action:'AMCP_X_PREROLL_CTA_READ',method:'GET',path:'/12/accounts/'+account(p)+path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,xPrerollCtaState:undefined};}
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,''),xPrerollCtaState:state});
/** One marked read of the account; the reader adds the call to action, its line item and campaign, and the line item's calls to action. */
export function xPrerollCtaSnapshots(p:CompiledRequest):Read[]{
 return [stateRead(p,xPrerollCtaKind(p)==='create'?{lineItemId:String(body(p).line_item_id)}:{ctaId:ctaOf(p)})];
}
export function isXPrerollCtaRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).xPrerollCtaState;}
const ctaView=(t:JsonObject)=>({id:String(t.id),lineItemId:String(t.line_item_id),button:t.call_to_action??null,url:t.call_to_action_url??null,deleted:t.deleted===true});
export async function readXPrerollCtas(p:CompiledRequest,send:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).xPrerollCtaState;if(!s)return send(p);
 let requests=0;
 const get=async(q:Read)=>{if(++requests>8)unverified('Pre-roll call-to-action reads exceeded their bound.');const r=await send(q),d=r.data;if(r.status!==200||!object(d)||Array.isArray(d.errors)&&d.errors.length)unverified('X returned a failed or unrecognized read.');return d as JsonObject;};
 const acct=await get(read(p,''));if(!object(acct.data)||String(acct.data.id)!==account(p))unverified('X returned another account.');
 let cta:JsonObject|null=null,lineItemId=s.lineItemId;
 if(s.ctaId){
  const d=(await get(read(p,'/preroll_call_to_actions/'+s.ctaId,{with_deleted:true}))).data;
  if(!object(d)||String(d.id)!==s.ctaId||!nativeId.test(String(d.line_item_id)))fail('STATE_TARGET_MISMATCH','Pre-roll call to action '+s.ctaId+' is not in the selected account.',{preroll_call_to_action_id:s.ctaId},409);
  cta=ctaView(d);lineItemId=String(d.line_item_id);
 }
 const l=(await get(read(p,'/line_items/'+lineItemId,{with_deleted:true}))).data;
 if(!object(l)||String(l.id)!==lineItemId)fail('STATE_TARGET_MISMATCH','Line item '+lineItemId+' is not a line item of the selected account.',{line_item_id:lineItemId!},409);
 const campaignId=String(l.campaign_id??''),c=nativeId.test(campaignId)?(await get(read(p,'/campaigns/'+campaignId,{with_deleted:true}))).data:undefined;
 if(!object(c)||String(c.id)!==campaignId)unverified('Line item '+lineItemId+' names no readable campaign.');
 const listed=await get(read(p,'/preroll_call_to_actions',{line_item_ids:lineItemId,count:1000}));
 if(!Array.isArray(listed.data)||listed.next_cursor)unverified('The calls to action of line item '+lineItemId+' are incomplete.');
 const ctas:JsonObject={};
 for(const row of listed.data as unknown[]){if(!object(row)||!nativeId.test(String(row.id))||String(row.line_item_id)!==lineItemId||Object.hasOwn(ctas,'c'+String(row.id)))unverified('A call-to-action row is foreign, malformed or repeated.');if(row.deleted!==true){const v=ctaView(row);ctas['c'+v.id]={button:v.button,url:v.url};}}
 return {status:200,headers:{},data:{accountId:account(p),line:{id:lineItemId,campaignId,name:l.name??null,objective:l.objective??null,status:l.entity_status??null,deleted:l.deleted===true},campaign:{id:campaignId,status:c.entity_status??null,deleted:c.deleted===true},cta,ctas}};
}
export function validateXPrerollCtaState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).xPrerollCtaState,d=r.data;
 if(!s||r.status!==200||!object(d)||!object(d.line)||!object(d.campaign)||!object(d.ctas)||!!s.ctaId!==object(d.cta))unverified('Missing verified pre-roll call-to-action state.');
}
export function xPrerollCtaPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=xPrerollCtaKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.line)||!object(s.ctas))unverified('Missing verified pre-roll call-to-action state.');
 if(kind!=='create'){const cta=s.cta;if(!object(cta)||cta.deleted===true)invalid('Pre-roll call to action '+ctaOf(p)+' is deleted.');if(kind==='delete')return;}
 if(s.line.deleted===true)invalid('Line item '+s.line.id+' is deleted.');
 if(s.line.objective!=='PREROLL_VIEWS')invalid('Line item '+s.line.id+' has the '+String(s.line.objective)+' objective; pre-roll calls to action apply to PREROLL_VIEWS line items.');
 const b=body(p);
 if(kind==='create'){
  const other=Object.keys(s.ctas)[0];
  if(other)fail('CONFIGURATION_EXISTS','Line item '+s.line.id+' already has call to action '+other.slice(1)+'; change it with PUT.',{preroll_call_to_action_id:other.slice(1)});
  return;
 }
 const cta=s.cta as JsonObject;
 if((b.call_to_action===undefined||b.call_to_action===cta.button)&&(b.call_to_action_url===undefined||b.call_to_action_url===cta.url))invalid('Pre-roll call to action '+ctaOf(p)+' already has this button and URL.');
}
export function xPrerollCtaImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=xPrerollCtaKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},b=body(p),cta=object(s.cta)?s.cta:null,line=object(s.line)?s.line:null,campaign=object(s.campaign)?s.campaign:null;
 const serving=line?.status==='ACTIVE'&&campaign?.status==='ACTIVE';
 const after=kind==='delete'?null:{button:b.call_to_action??cta?.button??null,url:b.call_to_action_url??cta?.url??null};
 return {provider:'x',scope:'preroll_call_to_action',operation:kind,line_item:line,campaign,before:cta,after,may_affect_serving:serving,
  effect:(kind==='delete'?'Removes the button from the pre-roll ads of the line item; viewers can no longer click through to its URL.':'Shows the button on the pre-roll ads of the line item and sends viewers who click it to the URL.')+(serving?' The line item and its campaign are active, so this applies at once.':'')+' Delivery and budgets do not change.',
  verification:kind==='delete'?'Reads the call to action again and checks that it is deleted.':'Reads the call to action again: its line item, button and URL.',
  source:'https://docs.x.com/x-ads-api/creatives/reference'};
}
export function xPrerollCtaOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=xPrerollCtaKind(p)!,d=r.data,t=object(d)&&object(d.data)?d.data:undefined,b=body(p);
 if(![200,201].includes(r.status)||!t||!nativeId.test(String(t.id))||Array.isArray((d as JsonObject).errors)&&(d as JsonObject).errors.length)return false;
 if(kind==='create')return t.line_item_id===b.line_item_id&&t.call_to_action===b.call_to_action&&t.call_to_action_url===b.call_to_action_url&&t.deleted!==true;
 if(kind==='update')return t.id===ctaOf(p)&&(b.call_to_action===undefined||t.call_to_action===b.call_to_action)&&(b.call_to_action_url===undefined||t.call_to_action_url===b.call_to_action_url)&&t.deleted!==true;
 return t.id===ctaOf(p)&&t.deleted===true;
}
export function xPrerollCtaVerification(p:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=xPrerollCtaKind(p)!,created=result.data?.data?.id,id=kind==='create'?created:ctaOf(p);
 if(typeof id!=='string'||!nativeId.test(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no pre-roll call to action to verify.');
 const first=before[0],prior=object(first)&&object(first.cta)?first.cta:{},b=body(p);
 const expected=kind==='delete'?{id,deleted:true}:{id,lineItemId:kind==='create'?b.line_item_id:prior.lineItemId,button:b.call_to_action??prior.button,url:b.call_to_action_url??prior.url,deleted:false};
 return [{read:stateRead(p,{ctaId:id}),expected:{cta:expected},id:'pre-roll call to action '+id}];
}
export function xPrerollCtaObserved(_read:CompiledRequest,data:JsonObject):JsonObject{return {cta:object(data.cta)?data.cta:null};}
