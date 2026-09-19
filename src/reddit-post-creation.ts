import {isIP} from 'node:net';
import {MirrorError} from './errors.js';
import {sha256,stable} from './security.js';
import {publicReportAddress} from './microsoft-report-download.js';
import type {Store} from './store.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const invalid=(message:string):never=>{throw new MirrorError('INVALID_REDDIT_MUTATION',message);};
const scope=(message:string):never=>{throw new MirrorError('RESOURCE_SCOPE_REQUIRED',message,{},403);};
const shape=(v:unknown,keys:string[]):JsonObject=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))invalid('Unexpected Reddit post field or object shape.');return v as JsonObject;};
const text=(v:unknown,max=40000):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0');
const nativeId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const postId=(v:unknown):v is string=>typeof v==='string'&&/^t3_[A-Za-z0-9]+$/.test(v);
const jobStatuses=['QUEUED','PROCESSING','SUCCESS','CLIENT_ERROR','SERVER_ERROR'];
const callsToAction=['Apply Now','Contact Us','Download','Get a Quote','Get Showtimes','Install','Learn More','Order Now','Play Now','Pre-order Now','See Menu','Shop Now','Sign Up','View More','Watch Now','Book Now','Buy Tickets','Get Directions','Listen Now','Read More','Subscribe','Visit Store','Donate Now','Remind Me'];

export function redditPostCreation(p:CompiledRequest):{structured:boolean;profileId:string}|undefined{
 if(p.gateway!=='reddit_native_action'||p.method!=='POST'||p.origin&&p.origin!=='https://ads-api.reddit.com')return;
 const m=/^\/api\/v3\/profiles\/([^/]+)\/(posts|structured_posts\/jobs)$/.exec(p.path);
 if(m)return {structured:m[2]!=='posts',profileId:m[1]!};
}
export const redditPromotedSource=(p:CompiledRequest):string|undefined=>redditPostCreation(p)?.structured&&(p.body as JsonObject)?.data?.creative?.type==='PROMOTED_POST'?(p.body as JsonObject).data.creative.post?.post_id:undefined;
export const redditAdPost=(p:CompiledRequest):string|undefined=>p.gateway==='reddit_native_action'&&((p.method==='POST'&&/^\/api\/v3\/ad_accounts\/[^/]+\/ads$/.test(p.path))||(p.method==='PATCH'&&/^\/api\/v3\/ads\/[^/]+$/.test(p.path)))?(p.body as JsonObject)?.data?.post_id:undefined;
export function redditPublicUrl(value:unknown,media=false):URL{
 let u:URL;try{if(typeof value!=='string'||value.length>8192||/[\s\u0000]/.test(value))throw Error();u=new URL(value);}catch{return invalid('Use a complete public HTTPS URL.');}
 const host=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!host.includes('.')&&!isIP(host)||/^(?:localhost|metadata\.google\.internal)$|\.(?:localhost|local|internal|lan)$/.test(host)||isIP(host)&&!publicReportAddress(host))invalid('Use public HTTPS without embedded credentials, private addresses, custom ports or fragments.');
 if([...u.searchParams.keys()].some(k=>/^(?:access_token|oauth_token|refresh_token|client_secret|authorization)$/i.test(k)))invalid('Do not forward OAuth credentials in a creative URL.');
 if(media&&['drive.google.com','docs.google.com','drive.usercontent.google.com'].includes(host))invalid('Drive sharing/download pages are not qualified native Reddit media URLs. Use a provider-accessible media asset; private Drive needs the server-side media bridge, not an LLM download.');
 return u;
}
function display(value:unknown,url:unknown){if(value==null)return;if(typeof value!=='string')invalid('display_url must be a string.');const shown=redditPublicUrl(/^[a-z]+:\/\//i.test(value as string)?value:'https://'+value);if(shown.hostname!==redditPublicUrl(url).hostname)invalid('display_url must match the destination domain.');}
function cta(value:unknown){if(value!==undefined&&value!==null&&!callsToAction.includes(value as string))invalid('Choose a native Reddit call_to_action value.');}
function destination(value:unknown){const d=shape(value,['type','url','display_url','call_to_action']);if(d.type!=='URL')invalid('Only the documented URL destination is supported.');redditPublicUrl(d.url);display(d.display_url,d.url);cta(d.call_to_action);}
function asset(value:unknown,video=false){
 const a=shape(value,video?['media','name','gifify']:['media','name','crop']),m=shape(a.media,['type','url']);if(m.type!=='URL')invalid('Supply a URL media source.');redditPublicUrl(m.url,true);
 if(a.name!==undefined&&!text(a.name))invalid('Asset names must be nonempty text.');if(video){if(a.gifify!==undefined&&typeof a.gifify!=='boolean')invalid('gifify must be a boolean.');return;}
 if(a.crop!=null){const c=shape(a.crop,['top_left_coordinates','dimensions','type']),xy=shape(c.top_left_coordinates,['x','y']),wh=shape(c.dimensions,['width','height']);if(c.type!==undefined&&c.type!=='MANUAL'||['x','y'].some(k=>!Number.isSafeInteger(xy[k])||xy[k]<0)||['width','height'].some(k=>!Number.isSafeInteger(wh[k])||wh[k]<1))invalid('Use nonnegative integer crop coordinates and positive dimensions; crop type is MANUAL.');}
}
function richText(body:unknown){if(!text(body))invalid('Provide a nonempty text body of at most 40,000 characters.');let v:unknown;try{v=JSON.parse(body as string);}catch{return invalid('Rich text must contain serialized JSON.');}if(!object(v))invalid('Rich text must encode an object; provider document-node validation still applies.');}
function structured(d:JsonObject){
 shape(d,['allow_comments','creative']);const c=d.creative;
 if(!object(c)||!text(c.headline,2000))invalid('Provide an explicit creative and headline of at most 2,000 characters.');
 const common=['type','headline','thumbnail','supplementary_text'];
 const fields:Record<string,string[]>={TEXT:['body','text_format','enhancements'],IMAGE:['image','destination','event','enhancements'],VIDEO:['video','destination','event','enhancements'],CAROUSEL:['carousel'],PROMOTED_POST:['post']};
 if(!fields[c.type])invalid('Choose TEXT, IMAGE, VIDEO, CAROUSEL or PROMOTED_POST.');shape(c,[...common,...fields[c.type]!]);
 if(c.supplementary_text!==undefined&&c.supplementary_text!==null&&!text(c.supplementary_text))invalid('supplementary_text must be nonempty text.');
 if(c.thumbnail!=null)asset(c.thumbnail);
 if(c.type==='TEXT'){if(!text(c.body)||!['PLAIN_TEXT','RICH_TEXT_JSON'].includes(c.text_format))invalid('Text creatives require a body and native text_format.');if(c.text_format==='RICH_TEXT_JSON')richText(c.body);}
 if(c.type==='IMAGE'){asset(c.image);destination(c.destination);}
 if(c.type==='VIDEO'){asset(c.video,true);asset(c.thumbnail);destination(c.destination);}
 if(c.type==='CAROUSEL'){
  // The setup guide is narrower than OpenAPI's 1..40 schema. Use their common range.
  if(!Array.isArray(c.carousel)||c.carousel.length<2||c.carousel.length>7)invalid('The Reddit setup guide qualifies 2–7 ordered carousel cards.');
  for(const item of c.carousel){const card=shape(item,['image','destination','caption']);asset(card.image);destination(card.destination);if(card.caption!==undefined&&!text(card.caption,180))invalid('Carousel captions must be text of at most 180 characters.');}
 }
 if(c.type==='PROMOTED_POST'){const post=shape(c.post,['type','post_id','destination']);if(post.type!=='PROMOTED_COMMUNITY_POST'||!postId(post.post_id)||d.allow_comments!==false)invalid('Community promotion requires an existing t3 post and allow_comments: false. It also disables the original post comments and voting.');if(post.destination!==undefined)destination(post.destination);}
 if(c.event!==undefined){const e=shape(c.event,['type','start_time']);if(e.type!=='REMINDER'||typeof e.start_time!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(e.start_time)||!Number.isFinite(Date.parse(e.start_time)))invalid('Events require type REMINDER and an explicit UTC start_time.');}
 if(c.enhancements!==undefined){const e=shape(c.enhancements,['allow_user_generated_content','user_generated_content']);if(!Object.keys(e).length||e.allow_user_generated_content!==undefined&&typeof e.allow_user_generated_content!=='boolean')invalid('Use explicit enhancement enrollment.');if(e.user_generated_content!==undefined){const u=shape(e.user_generated_content,['enroll_status']);if(!['OPT_IN','OPT_OUT'].includes(u.enroll_status)||e.allow_user_generated_content!==undefined&&e.allow_user_generated_content!==(u.enroll_status==='OPT_IN'))invalid('UGC enhancement settings conflict or have an unknown enrollment value.');}}
}
function legacy(d:JsonObject){
 shape(d,['type','headline','allow_comments','body','is_richtext','content','thumbnail_url']);
 if(!['TEXT','IMAGE','VIDEO','CAROUSEL'].includes(d.type)||!text(d.headline,2000))invalid('Use a native post type and explicit headline.');
 if(d.body!==undefined&&!text(d.body))invalid('The body must be nonempty text of at most 40,000 characters.');if(d.is_richtext!=null&&typeof d.is_richtext!=='boolean')invalid('is_richtext must be boolean or null.');
 if(d.type==='TEXT'&&!text(d.body))invalid('Text posts need a body.');if(d.is_richtext===true)richText(d.body);
 if(d.thumbnail_url!=null)redditPublicUrl(d.thumbnail_url,true);if(d.type==='VIDEO'&&!d.thumbnail_url)invalid('Video posts require a thumbnail URL.');
 if(d.type!=='TEXT'&&(!Array.isArray(d.content)||!d.content.length))invalid('Media posts require native content.');
 if(d.content!==undefined){if(!Array.isArray(d.content)||(d.type==='CAROUSEL'?d.content.length<2||d.content.length>7:d.content.length!==1))invalid('Use one content item, or 2–7 ordered carousel cards.');
  for(const value of d.content){const item=shape(value,['media_url','destination_url','display_url','call_to_action','caption']);if(d.type!=='TEXT'||item.media_url!=null)redditPublicUrl(item.media_url,true);if(['IMAGE','CAROUSEL'].includes(d.type)||item.destination_url!=null)redditPublicUrl(item.destination_url);if(item.display_url!=null)display(item.display_url,item.destination_url);cta(item.call_to_action);if(item.caption!=null&&!text(item.caption,180))invalid('Captions must be text of at most 180 characters.');}
 }
}
export function assertRedditPostCreation(p:CompiledRequest,d:JsonObject){const kind=redditPostCreation(p)!;if(!nativeId(kind.profileId)||typeof d.allow_comments!=='boolean')invalid('Select an exact profile and explicitly choose allow_comments.');if(kind.structured)structured(d);else legacy(d);}

export const redditPostRead=(p:CompiledRequest,path:string,reviewId?:string):CompiledRequest=>({...p,action:'AMCP_REDDIT_POST_VERIFY',path,method:'GET',query:{},headers:{},body:undefined,readOnly:true,destructive:false,requiresConfirmation:false,specialTransport:undefined,responseControls:undefined,redditProfilesState:undefined,scopeContext:{...p.scopeContext,...(reviewId?{redditPostReviewId:reviewId}:{})}});
export function validateRedditPromotion(p:CompiledRequest,states:unknown[]):void{
 const source=redditPromotedSource(p);if(!source)return;const original=(states as JsonObject[]).find(s=>s?.data?.id===source)?.data,requested=(p.body as JsonObject).data.creative;
 if(!object(original)||original.profile_id!==p.scopeContext?.redditProfileUserId||original.headline!==requested.headline||typeof original.allow_comments!=='boolean')scope('Promotion requires the readable original post, the selected profile author and its unchanged headline.');
 let u:URL;try{u=new URL(original.post_url);}catch{return scope('Read a community post with its canonical Reddit URL before promoting.');}
 const community=/^\/r\/([^/]+)\/comments\/([^/]+)(?:\/|$)/.exec(u.pathname);if(u.protocol!=='https:'||u.hostname!=='www.reddit.com'||!community||community[1]!.startsWith('u_')||'t3_'+community[2]!==source)scope('Profile posts cannot be promoted through the API; use an account-bound community post.');
}
export function redditPostCreationOutcome(p:CompiledRequest,response:TransportResult):boolean{
 const kind=redditPostCreation(p)!,d=(response.data as JsonObject)?.data;
 if(response.status!==201||!object(d)||!nativeId(d.id)||d.ad_account_id!==undefined&&d.ad_account_id!==p.accountId||d.profile_id!==undefined&&d.profile_id!==p.scopeContext?.redditProfileUserId)return false;
 return kind.structured?jobStatuses.includes(d.status):postId(d.id)&&d.profile_id===p.scopeContext?.redditProfileUserId&&d.allow_comments===(p.body as JsonObject).data.allow_comments&&d.type===(p.body as JsonObject).data.type;
}
function document(store:Store,tenant:string,kind:string,id:string):JsonObject|undefined{try{return store.document(tenant,kind,id);}catch(e){if(e instanceof MirrorError&&e.code==='NOT_FOUND')return;throw e;}}
/** Purpose-limited internal read capability. Callers cannot supply scopeContext.
 * A returned post ID never grants general ownership before author/config verification. */
export function authorizeRedditPostRead(p:CompiledRequest,c:Connection,store:Store,account:string):boolean{
 if(p.gateway!=='reddit_native_action'||p.method!=='GET'||!p.readOnly)return false;
 const job=/^\/api\/v3\/structured_posts\/jobs\/([A-Za-z0-9_-]+)$/.exec(p.path),post=/^\/api\/v3\/(posts|structured_posts)\/(t3_[A-Za-z0-9]+)$/.exec(p.path);
 if(!job&&!post)return false;
 if(job&&store.ownsResource(c,account,'structured_post_jobs/'+job[1]))return true;
 const reviewId=p.scopeContext?.redditPostReviewId;if(!reviewId){if(job)scope('Read a structured post job created through the selected account and connection.');return false;}
 const review=document(store,c.tenantId,'write_review',reviewId),row=store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(c.tenantId,reviewId) as JsonObject|undefined;
 if(review?.connection_id!==c.id||review.plan?.accountId!==account||!redditPostCreation(review.plan)||row?.state!=='complete'||!row.result)scope('This post verification does not belong to the selected account and connection.');
 const receipt=JSON.parse(row!.result),created=receipt.data?.data;if(receipt.success!==true||!nativeId(created?.id))scope('A completed creation receipt is required.');
 if(job&&redditPostCreation(review!.plan)!.structured&&created.id===job[1])return true;
 if(post&&!redditPostCreation(review!.plan)!.structured&&post[1]==='posts'&&created.id===post[2])return true;
 const resolved=document(store,c.tenantId,'reddit_post_resolution',reviewId);
 if(post&&redditPostCreation(review!.plan)!.structured&&post[1]==='structured_posts'&&resolved?.connection_id===c.id&&resolved.account_id===account&&resolved.job_id===created.id&&resolved.post_id===post[2]&&resolved.profile_user_id===review!.plan.scopeContext.redditProfileUserId)return true;
 return scope('The completed original job has not resolved this exact post for verification.');
}
function responseData(r:TransportResult):JsonObject{const b=r.data as JsonObject;if(r.status!==200||!object(b)||!object(b.data)||Object.keys(b).some(k=>/error|fail/i.test(k)&&b[k]!=null)||b.success===false)throw new MirrorError('STATE_TARGET_MISMATCH','Reddit returned a failed or malformed verification read.',{},502);return b.data;}
function enhancementProjection(value:JsonObject,differences:string[]):JsonObject{
 const out=structuredClone(value),e=out.creative?.enhancements;
 if(object(e)&&Object.hasOwn(e,'allow_user_generated_content')){
  if(typeof e.allow_user_generated_content!=='boolean'||e.user_generated_content!==undefined&&e.user_generated_content?.enroll_status!==(e.allow_user_generated_content?'OPT_IN':'OPT_OUT'))differences.push('/creative/enhancements');
  else{e.user_generated_content={enroll_status:e.allow_user_generated_content?'OPT_IN':'OPT_OUT'};delete e.allow_user_generated_content;}
 }
 return out;
}
const mediaPath=(path:string)=>/\/(?:media_url|thumbnail_url)$/.test(path)||/\/media\/url$/.test(path);
function compare(expected:unknown,actual:unknown,path:string,differences:string[],transforms:JsonObject[]):void{
 if(typeof expected==='string'&&mediaPath(path)){
  try{const url=redditPublicUrl(actual,true);const redditHosted=/(?:^|\.)(?:redd\.it|redditmedia\.com|redditstatic\.com)$/.test(url.hostname);
   if(!redditHosted){differences.push(path);return;}transforms.push({field:path,source_url_sha256:sha256(expected),provider_url_sha256:sha256(String(actual)),basis:'Provider-hosted media returned by the exact created post',byte_identity_verified:false});return;
  }catch{differences.push(path);return;}
 }
 if(Array.isArray(expected)){if(!Array.isArray(actual)||expected.length!==actual.length){differences.push(path);return;}expected.forEach((v,i)=>compare(v,actual[i],path+'/'+i,differences,transforms));return;}
 if(object(expected)){for(const [key,value]of Object.entries(expected))compare(value,object(actual)?actual[key]:undefined,path+'/'+key,differences,transforms);return;}
 // ISO spellings can vary, but never coerce arbitrary configuration strings/numbers.
 if(path.endsWith('/event/start_time')&&typeof expected==='string'&&typeof actual==='string'&&Date.parse(expected)===Date.parse(actual))return;
 if(stable(expected)!==stable(actual??null))differences.push(path);
}
export async function verifyRedditPostCreation(p:CompiledRequest,result:JsonObject,reviewId:string,c:Connection,store:Store,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<{status:string;checks:JsonObject[];resources?:JsonObject[]}>{
 const kind=redditPostCreation(p)!,created=result.data.data,checks:JsonObject[]=[];
 const profiles=await request({...redditPostRead(p,'/api/v3/ad_accounts/'+p.accountId+'/profiles'),redditProfilesState:true}),rows=(profiles.data as JsonObject)?.amcpRedditProfiles;
 if(!Array.isArray(rows)||rows.filter((r:JsonObject)=>r.id===kind.profileId&&r.reddit_user_id===p.scopeContext?.redditProfileUserId).length!==1||rows.filter((r:JsonObject)=>r.reddit_user_id===p.scopeContext?.redditProfileUserId).length!==1)scope('The original post author is no longer an unambiguous current profile of this account.');
 let target=created.id;
 if(kind.structured){
  const job=responseData(await request(redditPostRead(p,'/api/v3/structured_posts/jobs/'+created.id,reviewId)));
  if(job.id!==created.id||!jobStatuses.includes(job.status)||!Object.hasOwn(job,'post_id')||!Object.hasOwn(job,'error_message')||job.error_message!==null&&typeof job.error_message!=='string')throw new MirrorError('STATE_TARGET_MISMATCH','The exact post creation job and outcome are required.',{},502);
  const phase=['QUEUED','PROCESSING'].includes(job.status)?'pending':['CLIENT_ERROR','SERVER_ERROR'].includes(job.status)?'failed':'verified';
  if(phase!=='verified'){if(job.post_id!==null)throw new MirrorError('STATE_TARGET_MISMATCH','A non-successful job returned an ambiguous post ID.',{},502);return {status:phase,checks:[{resource_id:created.id,status:phase,provider_status:job.status,code:phase==='pending'?'REDDIT_POST_PROCESSING':'REDDIT_POST_CREATION_FAILED',automatic_retry_of_mutation:false}]};}
  if(!postId(job.post_id)||job.error_message!==null)throw new MirrorError('STATE_TARGET_MISMATCH','A successful post job must identify one post without an error.',{},502);
  target=job.post_id;const previous=document(store,c.tenantId,'reddit_post_resolution',reviewId);
  if(previous&&previous.post_id!==target)throw new MirrorError('STATE_TARGET_MISMATCH','The original post job changed its resolved post ID.',{},502);
  store.putDocument(c.tenantId,'reddit_post_resolution',reviewId,{connection_id:c.id,account_id:p.accountId,job_id:created.id,post_id:target,profile_user_id:p.scopeContext!.redditProfileUserId});
  checks.push({resource_id:created.id,status:'verified',provider_status:job.status,post_id:target});
 }
 const actual=responseData(await request(redditPostRead(p,'/api/v3/'+(kind.structured?'structured_posts':'posts')+'/'+target,reviewId))),expected={...(p.body as JsonObject).data,id:target,profile_id:p.scopeContext!.redditProfileUserId};
 const differences:string[]=[],transforms:JsonObject[]=[];compare(enhancementProjection(expected,differences),enhancementProjection(actual,differences),'',differences,transforms);
 if(actual.ad_account_id!==undefined&&actual.ad_account_id!==p.accountId)differences.push('/ad_account_id');
 const source=redditPromotedSource(p);if(source){const original=responseData(await request(redditPostRead(p,'/api/v3/posts/'+source)));if(original.id!==source||original.profile_id!==p.scopeContext!.redditProfileUserId||original.allow_comments!==false)differences.push('/original_post/allow_comments');}
 const status=differences.length?'inconclusive':'verified';checks.push({resource_id:target,status,changed_fields:differences,expected_hash:sha256(stable(expected)),actual_hash:sha256(stable(actual)),checked_fields:Object.keys(expected),media_ingestion:transforms,verification_scope:'Requested post configuration, current author and provider-hosted media references; not visual identity, byte identity, ad approval or serving.'});
 if(status==='verified'){for(const collection of ['posts','structured_posts'])store.rememberResource(c,p.accountId!,collection+'/'+target);return {status,checks,resources:[{kind:'reddit_post',id:target,profile_id:p.scopeContext!.redditProfileUserId,account_id:p.accountId,connection_id:c.id}]};}
 return {status,checks};
}
