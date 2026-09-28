import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {Store} from './store.js';
import type {TransportResult} from './transport.js';
import {assertLinkedInOrganization} from './linkedin-posts.js';

/**
 * Editing and deleting LinkedIn Direct Sponsored Content posts, per "Posts API" (li-lms-2026-09, checked 2026-09-28).
 * POST /rest/posts/{encoded post URN} with X-RestLi-Method PARTIAL_UPDATE and {patch: {$set: {...}}} updates the fields
 * the reference lists (commentary, contentCallToActionLabel, contentLandingPage, lifecycleState, adContext dscName and
 * dscStatus) and answers 204; DELETE /rest/posts/{encoded post URN} deletes a post ("Post deletions are idempotent", 204;
 * "Batch delete of Posts is not supported"). Creatives find the posts they sponsor through the creative search
 * (contentReferences). Only DSC posts that AMCP created and verified for the connection and account change here, with the
 * organization binding and grants of their creation; lifecycle state and adContext stay as created.
 */
type Kind='update'|'delete';
type State={kind:Kind|'verify';post:string};
type Read=CompiledRequest&{linkedinDscEditState?:State};
const gateway='linkedin_native_action',origin='https://api.linkedin.com',pageSize=100,maxPages=10;
const labels=['APPLY','DOWNLOAD','VIEW_QUOTE','LEARN_MORE','SIGN_UP','SUBSCRIBE','REGISTER','JOIN','ATTEND','REQUEST_DEMO'];
const editable=['commentary','contentLandingPage','contentCallToActionLabel'];
const postUrn=/^urn:li:(?:ugcPost|share):[1-9][0-9]{0,19}$/;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_LINKEDIN_DSC_EDIT',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
const account=(p:CompiledRequest)=>{if(!/^[1-9][0-9]{0,19}$/.test(p.accountId??''))invalid('Select the sponsored account of the DSC post.');return p.accountId!;};
/** REST.li 2.0 scalar encoding of a URN path key. */
const restliKey=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function linkedinDscEditKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.specialTransport||p.origin!==undefined&&p.origin!==origin||!/^\/rest\/posts\/[^/]+$/.test(p.path))return;
 return p.method==='POST'?'update':p.method==='DELETE'?'delete':undefined;
}
function postOf(p:CompiledRequest):string{try{return decodeURIComponent(p.path.split('/').at(-1)!);}catch{return '';}}
const patchOf=(p:CompiledRequest):JsonObject=>((p.body as JsonObject).patch as JsonObject).$set as JsonObject;
export function assertLinkedInDscEdit(p:CompiledRequest):void{
 const kind=linkedinDscEditKind(p);if(!kind)return;
 account(p);
 if(!postUrn.test(postOf(p)))invalid('The path names one post URN: urn:li:ugcPost:{id} or urn:li:share:{id}.');
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))invalid('Use the native versioned REST.li 2.0 contract without other headers.');
 const method=p.headers['X-RestLi-Method']?.toUpperCase();
 if(kind==='update'?method!=='PARTIAL_UPDATE':method!==undefined&&method!=='DELETE')invalid(kind==='update'?'A post edit is a PARTIAL_UPDATE (restli_method).':'A post deletion is a DELETE of one post; batch deletion of posts is not supported.');
 if(Object.keys(p.query).length)invalid('Post edits and deletions take no query parameters.');
 if(kind==='delete'){if(p.body!==undefined&&p.body!==null&&!(object(p.body)&&!Object.keys(p.body).length))invalid('A post deletion has no payload.');return;}
 const b=p.body;
 if(!object(b)||Object.keys(b).join()!=='patch'||!object(b.patch)||Object.keys(b.patch).join()!=='$set'||!object(b.patch.$set))invalid('Send {patch: {$set: {...}}} with commentary, contentLandingPage and/or contentCallToActionLabel.');
 const set=patchOf(p),extra=Object.keys(set).filter(k=>!editable.includes(k));
 if(!Object.keys(set).length||extra.length)invalid('A DSC edit sets commentary, contentLandingPage and/or contentCallToActionLabel'+(extra.length?', not '+extra.join(', '):'')+'; lifecycle state, distribution, media and adContext stay as created.');
 if(set.commentary!==undefined&&(typeof set.commentary!=='string'||!set.commentary.trim()||set.commentary.length>3000))invalid('commentary has 1–3000 characters, as at creation.');
 if(set.contentLandingPage!==undefined){let url:URL;try{url=new URL(String(set.contentLandingPage));}catch{return invalid('contentLandingPage is a complete HTTPS URL.');}if(typeof set.contentLandingPage!=='string'||url.protocol!=='https:'||url.username||url.password)invalid('contentLandingPage is an HTTPS URL without embedded credentials.');}
 if(set.contentCallToActionLabel!==undefined&&!labels.includes(String(set.contentCallToActionLabel)))invalid('contentCallToActionLabel is one of '+labels.join(', ')+'.');
}
/** Editing a DSC post changes what members see in every ad that sponsors it. */
export function linkedinDscEditNeedsConfirmation(p:CompiledRequest):boolean{return linkedinDscEditKind(p)==='update';}
function retained(store:Store,c:Connection,urn:string):JsonObject|undefined{
 try{return store.document(c.tenantId,'linkedin_post',c.id+'/'+urn);}catch(e){if(e instanceof MirrorError&&e.code==='NOT_FOUND')return undefined;throw e;}
}
/** A validated edit or deletion of a DSC post AMCP created and verified for this connection and account, with its organization bound. */
export function authorizeLinkedInDscEdit(p:CompiledRequest,c:Connection,store:Store,id:string):boolean{
 if(!linkedinDscEditKind(p))return false;
 assertLinkedInDscEdit(p);
 if(p.accountId!==id)fail('ACCOUNT_SCOPE_MISMATCH','Select the sponsored account of the DSC post.',{},403);
 const doc=retained(store,c,postOf(p));
 if(!doc||doc.account_id!==id||typeof doc.author!=='string')fail('RESOURCE_SCOPE_REQUIRED','Only DSC posts that AMCP created and verified with this connection and account change here.',{},403);
 assertLinkedInOrganization(c,id,doc.author);
 if(!['w_organization_social','r_organization_social'].every(s=>c.scopes.includes(s)))fail('INSUFFICIENT_SCOPE','Editing or deleting DSC posts requires w_organization_social and r_organization_social, as their creation does.',{},403);
 return true;
}
const read=(p:CompiledRequest,path:string,query:JsonObject={},extra:JsonObject={}):Read=>({...p,action:'AMCP_LINKEDIN_DSC_EDIT_READ',method:'GET',path,query,body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0',...extra},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,linkedinDscEditState:undefined});
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,'/rest/adAccounts/'+account(p)),linkedinDscEditState:state});
export function linkedinDscEditSnapshots(p:CompiledRequest):Read[]{return [stateRead(p,{kind:linkedinDscEditKind(p)!,post:postOf(p)})];}
export function isLinkedInDscEditRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).linkedinDscEditState;}
const gone=(e:unknown)=>e instanceof MirrorError&&(e.status===404||e.status===410||e.code==='NOT_FOUND');
/** The post (sponsoring account, author, the editable fields) and, for a review, the account's creatives that sponsor it. */
export async function readLinkedInDscEdits(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).linkedinDscEditState;if(!s)return request(p);
 let post:JsonObject|null=null;
 try{const r=await request(read(p,'/rest/posts/'+restliKey(s.post)));if(r.status!==200||!object(r.data))unverified('LinkedIn did not return the post.');post=r.data as JsonObject;}catch(e){if(!gone(e))throw e;}
 if(post&&post.id!==s.post)fail('STATE_TARGET_MISMATCH','LinkedIn returned another post than '+s.post+'.',{},409);
 const view:JsonObject=post?{present:true,id:s.post,author:post.author??null,dscAdAccount:object(post.adContext)?post.adContext.dscAdAccount??null:null,lifecycleState:post.lifecycleState??null,
  commentary:post.commentary??null,contentLandingPage:post.contentLandingPage??null,contentCallToActionLabel:post.contentCallToActionLabel??null}:{present:false,id:s.post};
 const creatives:JsonObject[]=[];
 if(post&&s.kind!=='verify'){
  let token:string|undefined;
  for(let page=0;;page++){
   if(page>=maxPages)unverified('More creatives sponsor the post than one review reads ('+maxPages*pageSize+').');
   const r=await request(read(p,'/rest/adAccounts/'+account(p)+'/creatives',{q:'criteria',contentReferences:[s.post],pageSize,...(token?{pageToken:token}:{})},{'X-RestLi-Method':'FINDER'})),d=r.data;
   if(r.status!==200||!object(d)||!Array.isArray(d.elements))unverified('LinkedIn did not list the creatives that sponsor the post.');
   for(const c of d.elements as unknown[]){
    if(!object(c)||typeof c.id!=='string')unverified('A creative row is malformed.');
    if(object(c.content)&&c.content.reference!==undefined&&c.content.reference!==s.post)continue;
    creatives.push({id:c.id,intendedStatus:c.intendedStatus??null,campaign:c.campaign??null});
   }
   token=object(d.metadata)&&typeof d.metadata.nextPageToken==='string'&&d.metadata.nextPageToken?d.metadata.nextPageToken:undefined;
   if(!token||(d.elements as unknown[]).length<pageSize)break;
  }
  creatives.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 }
 return {status:200,headers:{},data:{post:view,creatives}};
}
export function validateLinkedInDscEditState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data;if(!(p as Read).linkedinDscEditState||r.status!==200||!object(d)||!object(d.post)||typeof d.post.present!=='boolean'||!Array.isArray(d.creatives))unverified('Missing verified DSC post state.');
}
export function linkedinDscEditPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=linkedinDscEditKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.post)||!Array.isArray(s.creatives))unverified('Missing verified DSC post state.');
 const post=s.post as JsonObject,urn=postOf(p);
 if(post.present!==true)fail('STATE_NOT_FOUND','Post '+urn+' was not found.',{post:urn},404);
 if(post.dscAdAccount!=='urn:li:sponsoredAccount:'+account(p))fail('RESOURCE_SCOPE_REQUIRED','Post '+urn+' is not direct sponsored content of the selected account.',{post:urn},403);
 const creatives=s.creatives as JsonObject[];
 if(kind==='delete'){
  const used=creatives.filter(c=>c.intendedStatus!=='REMOVED');
  if(used.length)fail('ASSET_IN_USE','Creatives '+used.map(c=>String(c.id)).join(', ')+' sponsor post '+urn+'; delete or change them first.',{post:urn,creatives:used.map(c=>String(c.id))},409);
  return;
 }
 const set=patchOf(p);
 if(Object.entries(set).every(([k,v])=>post[k]===v))invalid('Post '+urn+' already has these values.');
 if((set.contentCallToActionLabel!==undefined||post.contentCallToActionLabel)&&!(set.contentLandingPage??post.contentLandingPage))invalid('A call-to-action label needs a contentLandingPage.');
}
export function linkedinDscEditImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=linkedinDscEditKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},post=object(s.post)?s.post:{},creatives=Array.isArray(s.creatives)?s.creatives as JsonObject[]:[];
 const live=creatives.filter(c=>c.intendedStatus==='ACTIVE');
 if(kind==='delete')return {provider:'linkedin',scope:'dsc_post',operation:'delete',post:{id:postOf(p),commentary:post.commentary??null},creatives,may_affect_serving:false,
  effect:'Deletes the post; no creative of the account sponsors it. A deletion cannot be undone.',verification:'Reads the post again and expects it gone.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09'};
 return {provider:'linkedin',scope:'dsc_post',operation:'update',post:{id:postOf(p),commentary:post.commentary??null,contentLandingPage:post.contentLandingPage??null,contentCallToActionLabel:post.contentCallToActionLabel??null},changes:patchOf(p),creatives,may_affect_serving:live.length>0,
  effect:live.length?'Changes the post that '+live.length+' active creative(s) sponsor: members see the new text or link in those ads.':'Changes the post; no active creative sponsors it now.',
  verification:'Reads the post again and compares the changed fields.',source:'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09'};
}
export function linkedinDscEditOutcome(_p:CompiledRequest,r:TransportResult):boolean{return r.status===204||r.status===200&&(r.data===undefined||r.data===null||r.data===''||object(r.data)&&!Object.keys(r.data).length);}
export function linkedinDscEditVerification(p:CompiledRequest):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=linkedinDscEditKind(p)!,urn=postOf(p);
 return [{read:stateRead(p,{kind:'verify',post:urn}),expected:{post:kind==='delete'?{present:false}:{present:true,...patchOf(p)}},id:'post '+urn}];
}
export function linkedinDscEditObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 const post=object(data.post)?data.post:{};
 return {post:post.present===true?{present:true,commentary:post.commentary??null,contentLandingPage:post.contentLandingPage??null,contentCallToActionLabel:post.contentCallToActionLabel??null}:{present:false}};
}
