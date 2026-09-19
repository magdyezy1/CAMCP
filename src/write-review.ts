import {reviewedWriteFamily} from './reviewed-routes.js';
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {gtmWorkspaceKind,assertGtmWorkspace,gtmWorkspaceSnapshots,validateGtmWorkspaceState,readGtmWorkspace,validateGtmWorkspacePrerequisites,gtmWorkspaceOutcome,gtmWorkspaceReceipt} from './gtm-workspace-writes.js';
import {gtmWorkflowKind,assertGtmWorkflow,assertGtmWorkflowActor,gtmWorkflowSnapshots,validateGtmWorkflowState,readGtmWorkflow,gtmSafeConfiguration,validateGtmWorkflowPrerequisites,gtmWorkflowOutcome} from './gtm-workflow-writes.js';
import {appleEntityKind,appleSharedAccounts,appleSharedAccountReads,validateAppleEntityPrerequisites} from './apple-entity-writes.js';
import {dv360ListKind,assertDV360ListWrite,dv360ListSnapshots,validateDV360ListState,readDV360List,validateDV360ListPrerequisites,dv360ListOutcome} from './dv360-list-writes.js';
import {googleConfigurationKind,assertGoogleConfiguration,googleConfigurationSnapshots,validateGoogleConfigurationState,googleConfigurationOutcome} from './google-configuration-writes.js';
import {checkSpendPolicy} from './spend-policy.js';
import {randomUUID} from 'node:crypto';
import {MirrorError,errorRemedy} from './errors.js';
import {validateMetaCampaign} from './meta-contracts.js';
import {validateGoogleRequest} from './google-contracts.js';
import {linkedinDSC,assertLinkedInDSC,linkedinDSCReads,linkedinMediaProjection,linkedinPostId} from './linkedin-posts.js';
import {writeImpact} from './write-impact.js';
import {executionEvidence} from './contract-evidence.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport,type TransportResult} from './transport.js';
import {ScopeGuard,normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import {authorizeExecution,type ExecutionPolicy} from './preflight.js';
import {guardInput,redact,sha256,stable} from './security.js';
import type {Actor,CallOptions,CompiledRequest,Connection,JsonObject} from './types.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {normalizeSnapshot,reviewStateHash,changedStateFields} from './review-state.js';
import {nextPage} from './pagination.js';
import {assertAccountWrite} from './write-access.js';
import {assertXCreative,xCreativeKind,xCreativeEdit,xCreativeSnapshots,readXCreativeState,xCreativeOutcome} from './x-creative-writes.js';
import {validateMetaCreative} from './creative-validation.js';
import {googleTargetingKind,assertGoogleTargeting,googleTargetingSnapshots,validateGoogleTargetingState} from './google-targeting-writes.js';
import {googleAssetLinkKind,assertGoogleAssetLinks,googleAssetLinkSnapshots,validateGoogleAssetLinkState,googleAssetLinkOutcome} from './google-asset-links.js';
import {xTargetingKind,assertXTargeting,xTargetingSnapshots,validateXTargetingState} from './x-targeting-writes.js';
import {assertRedditWrite,assertRedditWriteScopes,redditSnapshots,validateRedditState,redditOutcome} from './reddit-writes.js';
import {microsoftGateway,microsoftScope,assertMicrosoftWrite,microsoftSnapshots,validateMicrosoftResponse,microsoftOutcome} from './microsoft-native.js';
import {validateMicrosoftAssociationState} from './microsoft-associations.js';
import {measurementWriteGateways,assertMeasurementWrite,assertMeasurementScopes,measurementSnapshots,optionalMissingState,validateMeasurementState,measurementOutcome} from './measurement-writes.js';

export const writeTool={name:'amcp_write',description:'Inspect, prepare and execute a reviewed native advertising or measurement mutation. inspect checks local write-contract support without credentials or network calls. Preparation reads account/resource state and returns a five-minute, actor-bound frozen request. Execution requires its review_id, idempotency_key and explicit confirmation. Operator role and administrator account write grants are required. This is an AMCP extension, not a captured AMCP tool.',inputSchema:{type:'object',required:['action'],properties:{action:{type:'string',enum:['inspect','prepare','execute']},gateway:{type:'string'},arguments:{type:'object'},connection_id:{type:'string'},review_id:{type:'string'},idempotency_key:{type:'string'},confirmed:{type:'boolean'},spend_change_confirmed:{type:'boolean'},creative_edit_confirmed:{type:'boolean',description:'Explicitly acknowledge a reviewed X card edit/deletion or Tweet rename that may disrupt promoted ads. Freeze this choice during prepare and repeat it during execute.'}},additionalProperties:false}};
export const writeContractGateways=new Set(['meta_native_action','tiktok_native_action','snapchat_native_action','google_ads_native_action','linkedin_native_action','x_ads_native_action','dv360_native_action','reddit_native_action',microsoftGateway,...measurementWriteGateways]);
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const snake=(s:string)=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
function fail(code:string,message:string,details:JsonObject={}):never{throw new MirrorError(code,message,details);}
export function writeOutcome(result:TransportResult,plan?:CompiledRequest,before:unknown[]=[]):JsonObject {
 const errors:JsonObject[]=[];
 const walk=(value:unknown,path='$')=>{
  if(Array.isArray(value)){value.forEach((v,i)=>walk(v,path+'['+i+']'));return;}
  if(!value||typeof value!=='object')return;
  for(const [key,v]of Object.entries(value)){
   // Microsoft batch errors can align with request items using null success
   // slots. This exception is exact and provider-specific; false/objects fail.
   if(plan?.gateway===microsoftGateway&&path==='$'&&key==='PartialErrors'&&Array.isArray(v)&&v.every(item=>item===null))continue;
   const nonempty=v!==null&&v!==false&&v!==''&&v!==0&&(!Array.isArray(v)||v.length>0)&&(!v||typeof v!=='object'||Object.keys(v).length>0);
   if(nonempty&&/error|fail/i.test(key)||/^(?:is_)?success$/.test(key)&&v===false||/status$/i.test(key)&&(typeof v==='string'&&/ERROR|FAIL|PARTIAL/i.test(v)||typeof v==='number'&&v>=400))errors.push({path:path+'.'+key,value:v});
   else walk(v,path+'.'+key);
  }
 };walk(result.data);
 if(!plan&&result.status!==204&&result.status!==205&&!result.headers['x-restli-id']&&(result.data===null||typeof result.data!=='object'||!Object.keys(result.data).length))errors.push({path:'$',value:'Provider returned no verifiable mutation result.'});
 if(plan&&!confirmedMutationResult(plan,result,before))errors.push({path:'$',value:'The response does not confirm every mutation under this provider response contract.'});
 return {success:errors.length===0,executed:true,outcome:errors.length?'partial_or_failed':'succeeded',data:plan?.gateway==='gtm_native_action'?gtmSafeConfiguration(result.data):result.data,status:result.status,headers:result.headers,...(result.headers['x-restli-id']?{created_id:result.headers['x-restli-id']}:{ }),...(errors.length?{failures:plan?.gateway==='gtm_native_action'?gtmSafeConfiguration(errors):errors,retry_safe:false}:{}),...(plan&&gtmWorkspaceKind(plan)?gtmWorkspaceReceipt(plan,result):{})};
}
function confirmedMutationResult(plan:CompiledRequest,result:TransportResult,before:unknown[]):boolean {
 if(gtmWorkspaceKind(plan))return gtmWorkspaceOutcome(plan,result,before);
 if(gtmWorkflowKind(plan))return gtmWorkflowOutcome(plan,result);
 if(dv360ListKind(plan))return dv360ListOutcome(plan,result);
 if(googleConfigurationKind(plan))return googleConfigurationOutcome(plan,result);
 if(googleAssetLinkKind(plan))return googleAssetLinkOutcome(plan,result);
 if(linkedinDSC(plan))return result.status===201&&linkedinPostId(result.headers['x-restli-id']);
 if(xCreativeKind(plan))return xCreativeOutcome(plan,result);
 if(plan.gateway==='reddit_native_action')return redditOutcome(plan,result);
 if(plan.gateway===microsoftGateway)return microsoftOutcome(plan,result);
 if(measurementWriteGateways.has(plan.gateway))return measurementOutcome(plan,result);
 const d=object(result.data),b=object(plan.body),segments=plan.path.split('/'),last=segments.at(-1)!,hasId=(v:unknown)=>typeof v==='string'&&v.length>0||typeof v==='number'&&Number.isSafeInteger(v);
 if(plan.gateway==='meta_native_action')return /^\/v[^/]+\/act_/.test(plan.path)?hasId(d.id):d.success===true;
 if(plan.gateway==='google_ads_native_action')return Array.isArray(d.results)&&d.results.length===b.operations.length&&d.results.every((r:JsonObject,i:number)=>{
  const op=b.operations[i],expected=op.remove??op.update?.resource_name??op.update?.resourceName;return typeof r.resourceName==='string'&&(expected?r.resourceName===expected:r.resourceName.startsWith('customers/'+plan.accountId+'/'+last.replace(':mutate','')+'/'));
 });
 if(plan.gateway==='tiktok_native_action'){
  if(d.code!==0)return false;if(!plan.path.endsWith('/create/'))return true;
  const kind=segments[2]!,data=object(d.data);
  if(kind==='ad'){const ids=data.ad_ids??[data.ad_id];return Array.isArray(ids)&&ids.length===1&&typeof ids[0]==='string'&&/^\d+$/.test(ids[0]);}
  return hasId(data[kind+'_id'])||Array.isArray(data[kind+'_ids'])&&data[kind+'_ids'].length>0&&data[kind+'_ids'].every(hasId);
 }
 if(plan.gateway==='snapchat_native_action'){
  if(String(d.request_status).toUpperCase()!=='SUCCESS')return false;
  const kind=[...segments].reverse().find(k=>['campaigns','adsquads','ads','creatives'].includes(k))!,rows=d[kind];
  if(plan.method==='DELETE')return Array.isArray(rows)&&rows.length===0;
  const singular=kind==='adsquads'?'adsquad':kind.slice(0,-1),expected=Array.isArray(b[kind])?b[kind].length:1;
  return Array.isArray(rows)&&rows.length===expected&&rows.every((r,i)=>String(r.sub_request_status).toUpperCase()==='SUCCESS'&&hasId(r[singular]?.id)&&(plan.method==='POST'||String(r[singular].id)===String(plan.method==='PUT'?b[kind][i].id:last)));
 }
 if(plan.gateway==='linkedin_native_action')return result.status===201?hasId(result.headers['x-restli-id']):result.status===204;
 if(plan.gateway==='x_ads_native_action')return Array.isArray(d.data)?plan.method==='POST'&&d.data.length>0&&d.data.every(r=>hasId(r.id)):hasId(d.data?.id)&&(plan.method==='POST'||String(d.data.id)===last);
 if(plan.gateway==='dv360_native_action'){
  if(plan.method==='DELETE')return result.status===200&&result.data!==null&&Object.keys(d).length===0||result.status===204;
  const kind=plan.method==='POST'?last:segments.at(-2)!,key:Record<string,string>={campaigns:'campaignId',insertionOrders:'insertionOrderId',lineItems:'lineItemId',creatives:'creativeId'};return hasId(d[key[kind]!])&&(plan.method==='POST'||String(d[key[kind]!])===last);
 }
 return false;
}
export function validateState(read:CompiledRequest,result:TransportResult):void {
 if(read.gateway==='gtm_native_action'&&read.gtmWorkspaceState){validateGtmWorkspaceState(read,result);return;}
 if(read.gateway==='gtm_native_action'&&read.gtmState){validateGtmWorkflowState(read,result);return;}
 if(read.gateway==='dv360_native_action'&&read.dv360ListState&&!read.dv360ListState.collection&&result.status===404){const d=object(result.data);if(read.action!=='AMCP_STATE_OPTIONAL'||d.amcp_absent!==true||d.path!==read.path)fail('STATE_TARGET_MISMATCH','Unqualified absent DV360 target.');return;}
 if(read.gateway===microsoftGateway)validateMicrosoftResponse(read,result,true);
 if(result.status===404&&measurementWriteGateways.has(read.gateway)){validateMeasurementState(read,result);return;}
 if(read.gateway==='gtm_native_action'&&read.path.endsWith('/status')&&result.status===200){validateMeasurementState(read,result);return;}
 const data=object(result.data),id=normalizeAccount(read.gateway,read.accountId!);
 // Search Console's sitemap `errors` is a documented content-error count, not
 // a failed API envelope. Real error objects and malformed counts still fail.
 const sitemap=read.gateway==='google_search_console_native_action'&&read.path.includes('/sitemaps/');
 const sitemapCount=sitemap&&(typeof data.errors==='number'&&Number.isSafeInteger(data.errors)&&data.errors>=0||typeof data.errors==='string'&&/^\d+$/.test(data.errors));
 if(sitemap&&Object.hasOwn(data,'errors')&&!sitemapCount)fail('STATE_READ_FAILED','Search Console sitemap content-error counts must be nonnegative integers.');
 // ProtoJSON omits an empty repeated `results` field. Only a server-derived
 // optional association query can interpret that as absence, after raw errors
 // and continuation fields have still been checked.
 const optionalGoogle=read.gateway==='google_ads_native_action'&&read.googleState?.allowMissing===true;
 const emptyGoogle=optionalGoogle&&result.status===200&&result.data!==null&&typeof result.data==='object'&&!Array.isArray(result.data)&&data.results===undefined&&(Object.keys(data).length===0||typeof data.fieldMask==='string'||typeof data.queryResourceConsumption==='string');
 // A failed GA4 export is a readable job resource, not a failed HTTP read.
 // Preserve its native errorMessage for verification while still rejecting
 // API error envelopes, malformed errors and incomplete responses normally.
 const ga4Job=read.gateway==='ga4_native_action'&&/^\/v1(?:alpha|beta)\/properties\/\d+\/(?:audienceExports|reportTasks)\/[^/]+$/.test(read.path);
 let jobData=data;
 const withoutJobError=(value:JsonObject)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='errorMessage'));
 if(ga4Job&&data.state==='FAILED'&&typeof data.errorMessage==='string')jobData=withoutJobError(jobData);
 if(ga4Job&&data.reportMetadata?.state==='FAILED'&&typeof data.reportMetadata.errorMessage==='string')jobData={...jobData,reportMetadata:withoutJobError(data.reportMetadata)};
 const statusResult=sitemapCount?{...result,data:{...data,errors:0}}:emptyGoogle?{...result,data:{...data,results:[]}}:jobData!==data?{...result,data:jobData}:result;
 if(read.gateway!==microsoftGateway&&writeOutcome(statusResult).success!==true)fail('STATE_READ_FAILED','Failed or partial provider responses cannot verify before-state.');
 // Reuse provider pagination contracts (including Reddit pagination.next_url)
 // before envelope projection; discarding cursors is never proof of completeness.
 if(nextPage(read,data))fail('INCOMPLETE_STATE','State read was paginated; narrow the mutation.');
 const inspect=(v:unknown)=>{if(Array.isArray(v)){v.forEach(inspect);return;}if(!v||typeof v!=='object')return;
  const r=object(v);if(r.has_more===true||r.hasMore===true||r.nextPageToken||r.next_page_token||r.next_cursor&&r.next_cursor!=='0'||r.next_link||r.paging?.next||r.page_info?.total_page>1||Array.isArray(r.links)&&r.links.some((l:JsonObject)=>l.rel==='next'))fail('INCOMPLETE_STATE','State read was paginated; narrow the mutation.');Object.values(r).forEach(inspect);
 };inspect(data);
 if(read.gateway===microsoftGateway)return;
 if(measurementWriteGateways.has(read.gateway)){validateMeasurementState(read,result);return;}
 if(read.gateway==='dv360_native_action'&&(read.action==='AMCP_DV360_LIST_STATE'||read.dv360ListState)){validateDV360ListState(read,result);return;}
 if(read.gateway==='reddit_native_action'){validateRedditState(read,result);return;}
 const sameIds=(actual:unknown[],expected:unknown[])=>{const clean=(ids:unknown[])=>ids.map(x=>String(x)).sort();if(actual.length!==expected.length||stable(clean(actual))!==stable(clean(expected)))fail('STATE_TARGET_MISMATCH','State read did not return every exact requested target.');};
 if(read.gateway==='google_ads_native_action'){
  if(emptyGoogle)data.results=[];
  if(!Array.isArray(data.results)||!data.results.length&&!optionalGoogle)fail('STATE_NOT_FOUND','Google state query returned no target rows.');
  const q=String(object(read.body).query),type=q.match(/ FROM ([a-z_]+)/)?.[1];
  if(type==='customer'){sameIds(data.results.map((r:JsonObject)=>r.customer?.id),[id]);return;}
  if(!type)fail('STATE_READ_FAILED','Unrecognized Google state query.');
  const expected=[...q.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]),camel=type.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),actual=data.results.map((r:JsonObject)=>(r[camel]??r[type])?.resourceName??(r[camel]??r[type])?.resource_name);
  if(optionalGoogle){if(read.googleState!.resource!==type||stable(read.googleState!.names)!==stable(expected)||new Set(actual).size!==actual.length||actual.some((name:unknown)=>typeof name!=='string'||!expected.includes(name)))fail('STATE_TARGET_MISMATCH','Optional state must contain only unique, exactly requested association identities.');}
  else sameIds(actual,expected);return;
 }
 if(read.gateway==='tiktok_native_action'){
  if(data.code!==0||!Array.isArray(data.data?.list))fail('STATE_READ_FAILED','TikTok state must confirm success and contain its native list.');
  const kind=read.path.split('/')[2]!,key=kind==='advertiser'?'advertiser_id':kind+'_id';
  sameIds(data.data.list.map((r:JsonObject)=>r[key]),kind==='advertiser'?[id]:read.query.filtering[kind+'_ids']);return;
 }
 const target=decodeURIComponent(read.path.split('/').at(-1)!).replace(/^act_/,'').split(':').at(-1);
 if(read.gateway==='meta_native_action'){
  sameIds([String(data.id).replace(/^act_/,'')],[target]);
  if(String(read.query.fields).split(',').includes('status')&&!Object.hasOwn(data,'status'))fail('STATE_READ_FAILED','Meta did not return the requested target status.');return;
 }
 if(read.gateway==='snapchat_native_action'){
  const kind=read.path.split('/').at(-2)!,rows=data[kind];if(!Array.isArray(rows)||rows.length!==1)fail('STATE_READ_FAILED','Snapchat must return one exact target record.');const singular=kind==='adsquads'?'adsquad':kind==='media'?'media':kind.slice(0,-1);sameIds(rows.map((r:JsonObject)=>(r[singular]??r).id),[target]);return;
 }
 if(read.gateway==='x_ads_native_action'){sameIds([data.data?.id],[target]);return;}
 if(read.gateway==='linkedin_native_action'){const exact=decodeURIComponent(read.path.split('/').at(-1)!);if(exact.startsWith('urn:li:')&&data.id!==exact)fail('STATE_TARGET_MISMATCH','LinkedIn returned a different resource URN.');sameIds([String(data.id??'').split(':').at(-1)],[target]);return;}
 if(read.gateway==='dv360_native_action'){const key:Record<string,string>={advertisers:'advertiserId',campaigns:'campaignId',insertionOrders:'insertionOrderId',lineItems:'lineItemId',creatives:'creativeId'};sameIds([data[key[read.path.split('/').at(-2)!]!]], [target]);return;}
 fail('STATE_READ_FAILED','No response contract exists for this state read.');
}
export function assertWriteShape(plan:CompiledRequest){
 assertProviderActionAvailable(plan);
 validateGoogleRequest(plan);
 validateMetaCampaign(plan);
 if(!writeContractGateways.has(plan.gateway))fail('WRITE_CONTRACT_UNAVAILABLE','This platform has no reviewed mutation contract.');
 if(plan.readOnly)fail('MUTATION_REQUIRED','Use the original native gateway to perform this read.');
 if(plan.gateway==='reddit_native_action'){assertRedditWrite(plan);return;}
 if(plan.gateway===microsoftGateway){assertMicrosoftWrite(plan);return;}
 if(plan.specialTransport)fail('WRITE_CONTRACT_UNAVAILABLE','For Google Drive media imports, use amcp_media prepare and execute. Other binary transports need a dedicated upload contract.');
 if(plan.headers['X-HTTP-Method-Override']||plan.headers['X-RestLi-Method']&&!['CREATE','PARTIAL_UPDATE','DELETE'].includes(plan.headers['X-RestLi-Method'].toUpperCase()))fail('WRITE_CONTRACT_UNAVAILABLE','This REST.li method override is not qualified for reviewed execution.');
 if(gtmWorkflowKind(plan)){assertGtmWorkflow(plan);return;}
 if(gtmWorkspaceKind(plan)){assertGtmWorkspace(plan);return;}
 if(linkedinDSC(plan)){if(Object.keys(plan.query).length)fail('WRITE_CONTRACT_UNAVAILABLE','DSC creation does not accept query actions or method overrides.');assertLinkedInDSC(plan);return;}
 const body=object(plan.body);
 const route=plan.path,method=plan.method;
 if(measurementWriteGateways.has(plan.gateway))assertMeasurementWrite(plan);
 const supported=reviewedWriteFamily(plan);
 if(!supported)fail('WRITE_CONTRACT_UNAVAILABLE','This route is outside the reviewed campaign-management execution contracts. Use a local dry run.');
 if(dv360ListKind(plan))assertDV360ListWrite(plan);
 if(plan.gateway==='meta_native_action'&&route.endsWith('/adcreatives'))validateMetaCreative(body);
 if(Object.keys(plan.query).some(k=>!(plan.gateway==='dv360_native_action'&&k==='updateMask'||plan.gateway==='gtm_native_action'&&k==='fingerprint')))fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed writes accept body fields and qualified concurrency parameters only.');
 if(plan.gateway==='linkedin_native_action'&&method==='POST'&&/^\/rest\/adAccounts\/[^/]+\/[^/]+\/[^/]+$/.test(route)&&(!body.patch||plan.headers['X-RestLi-Method']?.toUpperCase()!=='PARTIAL_UPDATE'))fail('WRITE_CONTRACT_UNAVAILABLE','LinkedIn entity POST requires a native patch and restli_method PARTIAL_UPDATE.');
 if(['method','_method','http_method','method_override','batch','adbatch'].some(k=>plan.query[k]!==undefined||body[k]!==undefined)||/\/batch\//.test(plan.path))fail('WRITE_CONTRACT_UNAVAILABLE','Batch and method-tunneled writes require individual reviewed native requests.');
 if(plan.method==='GET'||plan.method==='HEAD')fail('WRITE_CONTRACT_UNAVAILABLE','Side-effecting GET/HEAD actions are not qualified for execution.');
 const expect=(record:JsonObject,key:string,values:string[])=>{if(!values.includes(record[key]))fail('PAUSED_CREATION_REQUIRED','New serving entities require an explicit paused or draft state.',{field:key,allowed:values});};
 if(plan.gateway==='meta_native_action'&&/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads)$/.test(plan.path)&&plan.method==='POST')expect(body,'status',['PAUSED']);
 if(plan.gateway==='tiktok_native_action'&&/^\/v1\.3\/(?:campaign|adgroup)\/create\/$/.test(plan.path))expect(body,'operation_status',['DISABLE']);
 if(plan.gateway==='tiktok_native_action'&&plan.path==='/v1.3/ad/create/'){
  if(!Array.isArray(body.creatives)||body.creatives.length!==1||!body.creatives[0]||Array.isArray(body.creatives[0])||typeof body.creatives[0]!=='object')fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.');
  if(Object.hasOwn(body,'operation_status'))fail('INVALID_ARGUMENT','TikTok ad creation uses creatives[0].operation_status; a top-level status does not pause the creative.');
  expect(body.creatives[0],'operation_status',['DISABLE']);
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='POST'){
  const kind=plan.path.split('/').at(-1)!;if(!Array.isArray(body[kind])||!body[kind].length||body[kind].length>25)fail('MISSING_PAYLOAD','Provide 1–25 native '+kind+' records.');if(kind!=='creatives')for(const row of body[kind])expect(object(row),'status',['PAUSED']);
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'){
  if(!Array.isArray(plan.body)||!plan.body.length||plan.body.length>25||plan.body.some(op=>!op||!['add','remove','replace','test'].includes(op.op)||typeof op.path!=='string'||!/^\/[a-zA-Z0-9_/-]+$/.test(op.path)||op.path.split('/').some((part:string)=>['__proto__','constructor','prototype'].includes(part))||op.op!=='remove'&&!Object.hasOwn(op,'value')))fail('INVALID_PATCH','Use 1–25 native JSON Patch add, remove, replace or test operations.');
 }
 if(plan.gateway==='x_ads_native_action'&&/^\/12\/accounts\/[^/]+\/(campaigns|line_items)$/.test(plan.path)&&plan.method==='POST')expect(body,'entity_status',['PAUSED']);
 assertXCreative(plan);
 assertXTargeting(plan);
 if(plan.gateway==='linkedin_native_action'&&/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(plan.path)&&plan.method==='POST'){
  const creative=plan.path.endsWith('/creatives');if(creative&&Object.hasOwn(body,'status'))fail('INVALID_ARGUMENT','LinkedIn creatives use intendedStatus; remove the unsupported status field.');
  expect(body,creative?'intendedStatus':'status',['PAUSED','DRAFT']);
 }
 if(plan.gateway==='dv360_native_action'&&/^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems)$/.test(plan.path)&&plan.method==='POST')expect(body,'entityStatus',['ENTITY_STATUS_PAUSED','ENTITY_STATUS_DRAFT']);
 if(plan.gateway==='google_ads_native_action'){
  if(!Array.isArray(body.operations)||!body.operations.length||body.operations.length>25)fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed Google mutations require 1–25 homogeneous native operations.');
  if(/\/(campaigns|adGroups|adGroupAds|assetGroups):mutate$/.test(plan.path))for(const op of body.operations)if(op.create)expect(op.create,'status',['PAUSED']);
  if(body.partial_failure===true||body.partialFailure===true)fail('WRITE_CONTRACT_UNAVAILABLE','Execute homogeneous Google mutations atomically; partial_failure must be false.');
  if(body.validate_only===true||body.validateOnly===true)fail('WRITE_CONTRACT_UNAVAILABLE','This tool executes mutations; use a local dry run for validation-only plans.');
  for(const op of body.operations)if(!op||typeof op!=='object'||['create','update','remove'].filter(k=>op[k]!==undefined).length!==1)fail('INVALID_MUTATION','Each Google operation must contain exactly one create, update or remove.');
  assertGoogleTargeting(plan);
  assertGoogleAssetLinks(plan);
  assertGoogleConfiguration(plan);
 }
}

/** Reads are explicitly derived from the target, never supplied by the caller as proof. */
export function snapshotPlans(plan:CompiledRequest,registry:Registry):CompiledRequest[]{
 if(gtmWorkflowKind(plan))return gtmWorkflowSnapshots(plan);
 if(gtmWorkspaceKind(plan))return gtmWorkspaceSnapshots(plan);
 if(dv360ListKind(plan))return dv360ListSnapshots(plan);
 if(googleConfigurationKind(plan))return googleConfigurationSnapshots(plan);
 if(googleAssetLinkKind(plan))return googleAssetLinkSnapshots(plan);
 if(linkedinDSC(plan))return linkedinDSCReads(plan);
 if(xCreativeKind(plan))return xCreativeSnapshots(plan);
 if(googleTargetingKind(plan))return googleTargetingSnapshots(plan);
 if(xTargetingKind(plan))return xTargetingSnapshots(plan);
 if(plan.gateway==='reddit_native_action')return redditSnapshots(plan);
 if(plan.gateway===microsoftGateway)return microsoftSnapshots(plan);
 if(measurementWriteGateways.has(plan.gateway))return measurementSnapshots(plan);
 const base=(path:string,query:JsonObject={},body?:JsonObject,method='GET'):CompiledRequest=>applyExecutionRisk({...plan,action:'AMCP_STATE_READ',method,path,query,body,headers:plan.gateway==='linkedin_native_action'?Object.fromEntries(Object.entries(plan.headers).filter(([k])=>['LinkedIn-Version','X-Restli-Protocol-Version'].includes(k))):{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined});
 const id=normalizeAccount(plan.gateway,plan.accountId!),body=object(plan.body);
 if(plan.gateway==='google_ads_native_action'){
  const kind=plan.path.match(/\/([^/]+):mutate$/)?.[1],map:Record<string,string>={assets:'asset',campaigns:'campaign',adGroups:'ad_group',adGroupAds:'ad_group_ad',campaignBudgets:'campaign_budget',ads:'ad',assetGroups:'asset_group',campaignCriteria:'campaign_criterion',adGroupCriteria:'ad_group_criterion'};
  if(!kind||!map[kind])fail('WRITE_CONTRACT_UNAVAILABLE','This Google mutation has no implemented state-read contract.');
  const resource=map[kind]!,snapshots:CompiledRequest[]=[],fields=new Set([resource+'.resource_name']),names:string[]=[];
  for(const op of body.operations){const record=object(op.update),name=op.remove??record.resource_name??record.resourceName;
   if(name!==undefined){if(typeof name!=='string'||!new RegExp('^customers/'+id+'/'+kind+'/[0-9~_-]+$').test(name))fail('ACCOUNT_SCOPE_MISMATCH','Google mutation resource does not match the selected customer/type.');names.push(name);}
   if(op.update){const mask=op.update_mask??op.updateMask;if(typeof mask!=='string'||!mask)fail('MISSING_UPDATE_MASK','Updates require an explicit field mask.');for(const f of mask.split(',')){if(!/^[A-Za-z][A-Za-z0-9_.]*$/.test(f))fail('INVALID_UPDATE_MASK','Invalid field mask.');fields.add(resource+'.'+snake(f));}}
   if(op.remove){const deletionFields:Record<string,string[]>={asset:['name','type'],campaign:['name','status','campaign_budget','advertising_channel_type'],ad_group:['name','status','campaign','cpc_bid_micros'],ad_group_ad:['status','ad.id','ad.final_urls'],campaign_budget:['name','amount_micros','delivery_method'],ad:['name','final_urls'],asset_group:['name','status','campaign']};for(const f of deletionFields[resource]??[])fields.add(resource+'.'+f);}
  }
  const search=(query:string)=>base('/v23/customers/'+id+'/googleAds:search',{}, {query},'POST');
  if(names.length)snapshots.push(search('SELECT '+[...fields].join(', ')+' FROM '+resource+' WHERE '+resource+'.resource_name IN ('+names.map(n=>"'"+n+"'").join(', ')+')'));
  if(body.operations.some((op:JsonObject)=>op.create))snapshots.push(search('SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'));
  const parents:Record<string,{kind:string;fields:string}>= {campaign_budget:{kind:'campaignBudgets',fields:'campaign_budget.resource_name, campaign_budget.amount_micros'},campaign:{kind:'campaigns',fields:'campaign.resource_name, campaign.status, campaign.campaign_budget'},ad_group:{kind:'adGroups',fields:'ad_group.resource_name, ad_group.status, ad_group.campaign'}};
  const seen=new Set<string>();for(const op of body.operations)for(const [field,parent]of Object.entries(parents)){
   const record=object(op.create??op.update),name=record[field]??record[field.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())];if(name===undefined||seen.has(name))continue;
   if(typeof name!=='string'||!new RegExp('^customers/'+id+'/'+parent.kind+'/[0-9]+$').test(name))fail('INVALID_PARENT_RESOURCE','Parent resources must exist in the selected customer. Create temporary resources in a separate review.');
   seen.add(name);snapshots.push(search('SELECT '+parent.fields+' FROM '+field+' WHERE '+field+'.resource_name IN (\''+name+'\')'));
  }
  if(!snapshots.length)fail('WRITE_CONTRACT_UNAVAILABLE','Each operation must contain create, update or remove.');return snapshots;
 }
 if(plan.gateway==='tiktok_native_action'){
  const match=/^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
  if(!match)fail('WRITE_CONTRACT_UNAVAILABLE','This TikTok action has no implemented state-read contract.');
  if(match[2]==='create'){
   const reads=[base('/v1.3/advertiser/info/',{advertiser_ids:[id]})],parent=match[1]==='adgroup'?'campaign':match[1]==='ad'?'adgroup':undefined;
   if(parent){const parentId=body[parent+'_id'];if(typeof parentId!=='string'||!/^\d+$/.test(parentId))fail('MISSING_PARAMETER','Child creates require their exact parent ID.');const read=base('/v1.3/'+parent+'/get/',{advertiser_id:id,filtering:{[parent+'_ids']:[parentId]},page_size:100});read.action='tiktok_'+parent+'_get';reads.push(read);}return reads;
  }
  const kind=match[1]!,ids=body[kind+'_ids']??(body[kind+'_id']?[body[kind+'_id']]:undefined);
  if(!Array.isArray(ids)||!ids.length||ids.length>25||ids.some(v=>typeof v!=='string'||!/^\d+$/.test(v)))fail('MISSING_PARAMETER','Supply 1–25 exact '+kind+' IDs.');
  const read=base('/v1.3/'+kind+'/get/',{advertiser_id:id,filtering:{[kind+'_ids']:ids},page_size:100});read.action='tiktok_'+kind+'_get';return [read];
 }
 if(plan.gateway==='meta_native_action'){
  const create=/^\/v[^/]+\/act_[^/]+\//.test(plan.path)&&plan.method==='POST';
  if(create){const reads=[base(plan.path.match(/^\/v[^/]+\/act_[^/]+/)![0],{fields:'id,account_status,currency'})];const parent=plan.path.endsWith('/adsets')?body.campaign_id:plan.path.endsWith('/ads')?body.adset_id:undefined;
   if(plan.path.endsWith('/adsets')||plan.path.endsWith('/ads')){if(typeof parent!=='string'||!/^\d+$/.test(parent))fail('MISSING_PARAMETER','Child creates require their exact parent ID.');reads.push(base(plan.path.split('/').slice(0,2).join('/')+'/'+parent,{fields:'id,name,status'}));}return reads;}
  if(/^\/v[^/]+\/\d+$/.test(plan.path)){const fields=new Set(['id','name','status']);for(const k of Object.keys(body))if(/^[a-z_]+$/.test(k)&&!['execution_options','fields'].includes(k))fields.add(k);return [base(plan.path,{fields:[...fields].join(',')})];}
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PUT'){
  const kind=plan.path.split('/').at(-1)!,rows=body[kind];if(!Array.isArray(rows)||!rows.length||rows.length>25)fail('MISSING_PAYLOAD','Provide 1–25 native update records.');
  if(new Set(rows.map(row=>row?.id)).size!==rows.length)fail('INVALID_ARGUMENT','Each updated Snapchat resource ID must be unique.');
  return rows.map(row=>{if(typeof row?.id!=='string'||!/^[-a-zA-Z0-9]+$/.test(row.id))fail('MISSING_PARAMETER','Each update record requires its exact ID.');return base('/v1/'+kind+'/'+row.id);});
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'){const match=/\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/([^/]+)$/.exec(plan.path)!;return [base('/v1/'+match[1]+'/'+match[2])];}
 const catalog=registry.catalogs.get(plan.gateway);
 const samePath=[...(catalog?.actions??[]),...registry.data.supplemental.filter(a=>a.gateway===plan.gateway)].some(a=>a.method==='GET'&&a.path&&new RegExp('^'+a.path.split('?')[0]!.replace(/[.*+?^$()|[\]\\]/g,'\\$&').replace(/\{[^}]+\}/g,'[^/]+')+'$').test(plan.path));
 const accountPaths:Record<string,RegExp>={snapchat_native_action:/^\/v1\/adaccounts\/[^/]+/,x_ads_native_action:/^\/12\/accounts\/[^/]+/,linkedin_native_action:/^\/rest\/adAccounts\/[^/]+/,dv360_native_action:/^\/v\d+\/advertisers\/[^/]+/};
 const account=accountPaths[plan.gateway]?.exec(plan.path)?.[0];
 if(plan.gateway==='snapchat_native_action'&&plan.method==='POST'&&!account)return [base(plan.path.slice(0,plan.path.lastIndexOf('/')))];
 // On collection creates, snapshot the account. On edits/deletes, the catalog must expose a matching GET.
 if(plan.method==='POST'&&account&&plan.path.slice(account.length).split('/').filter(Boolean).length===1)return [base(account)];
 if(samePath&&['POST','PUT','PATCH','DELETE'].includes(plan.method))return [base(plan.path)];
 fail('WRITE_CONTRACT_UNAVAILABLE','This operation lacks an implemented target-state read. It remains available as a local dry run.');
}

export class WriteReviewService {
 constructor(private registry:Registry,private compiler:Compiler,private store:Store,private transport:NativeTransport,private credentials:CredentialProvider,private options:CallOptions,private policy:ExecutionPolicy,private delegated=new DelegatedNativeCompiler()){}
 private access(actor:Actor,plan:CompiledRequest,connectionId?:string):Connection {
  this.store.assertActorActive(actor);
  assertGtmWorkflowActor(plan,actor);
  if(!this.policy.allowWrites)fail('LIVE_WRITES_DISABLED','Enable MIRROR_ALLOW_WRITES=true for reviewed write support.');
  if(actor.role==='reader')throw new MirrorError('FORBIDDEN','A writer connector and administrator account grant are required.',{},403);
  const c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,connectionId),id=normalizeAccount(plan.gateway,plan.accountId??(c.accounts.length===1?c.accounts[0]:''));
  assertAccountWrite(this.store,c,id);
  for(const account of appleSharedAccounts(plan)){this.store.resolveConnection(actor,plan.gateway,account,c.id);assertAccountWrite(this.store,c,account);}
  if(plan.gateway==='reddit_native_action')assertRedditWriteScopes(c);
  if(dv360ListKind(plan)&&!c.scopes.includes('https://www.googleapis.com/auth/display-video'))fail('PROVIDER_WRITE_SCOPE_REQUIRED','Reconnect DV360 with the display-video OAuth scope.');
  if(plan.gateway===microsoftGateway&&!c.scopes.some(s=>s===microsoftScope||s==='msads.manage'))fail('INSUFFICIENT_SCOPE','Reconnect Microsoft Advertising with msads.manage permission.');
  plan.accountId=id;new ScopeGuard(this.registry,this.store).authorize(plan,c);assertMeasurementScopes(plan,c);return c;
 }
 private async state(actor:Actor,plan:CompiledRequest,connectionId:string,reads:CompiledRequest[]):Promise<unknown[]> {
  if(xCreativeKind(plan))return readXCreativeState(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Creative dependency checks must be read-only.');
   const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);
   const result=await this.transport.request(read,c,auth);this.access(actor,plan,connectionId);return result;
  });
  const values:unknown[]=[];
  for(const read of reads){if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','The state check must be independently read-only.');const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);let result:TransportResult;
   try{result=await readGtmWorkspace(read,workspacePage=>readGtmWorkflow(workspacePage,gtmPage=>readDV360List(gtmPage,async page=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(page,current);const response=await this.transport.request(page,current,auth);this.access(actor,plan,connectionId);return response;})));}catch(e){const absent=optionalMissingState(read,e);if(!absent)throw e;result=absent;}
   this.access(actor,plan,connectionId);validateState(read,result);
   if(appleEntityKind(plan)==='shared_budget'&&read.path===plan.path){
    const accounts=appleSharedAccounts(plan,result.data),frozen=plan.scopeContext?.appleSharedAccountIds;
    for(const account of accounts){const current=this.store.resolveConnection(actor,plan.gateway,account,connectionId);assertAccountWrite(this.store,current,account);}
    if(!frozen){
     plan.scopeContext={...plan.scopeContext,appleSharedAccountIds:accounts};
     for(const extra of appleSharedAccountReads(plan,accounts))if(!reads.some(r=>r.path===extra.path))reads.push(extra);
    }
   }
   values.push(linkedinDSC(plan)&&/^\/rest\/(images|videos)\//.test(read.path)?linkedinMediaProjection(plan,object(result.data)):normalizeSnapshot(read,result.data));
  }
  validateAppleEntityPrerequisites(plan,reads,values);
  validateGtmWorkflowPrerequisites(plan,values);
  validateGtmWorkspacePrerequisites(plan,values);
  validateDV360ListPrerequisites(plan,values);
  if(appleEntityKind(plan)==='shared_budget'&&!plan.scopeContext?.appleSharedOrgId){
   const account=object(values[reads.findIndex(r=>r.path==='/v1/ad-accounts/'+plan.accountId)]).result;
   const target=object(values[reads.findIndex(r=>r.path===plan.path)]).result;
   plan.scopeContext={...plan.scopeContext,appleSharedAccountIds:appleSharedAccounts(plan),appleSharedOrgId:String(account.orgId),appleSharedResultAccounts:(object(plan.body).adAccountIds??target.adAccountIds).map(String)};
  }
  validateGoogleTargetingState(plan,values);validateGoogleAssetLinkState(plan,values);validateGoogleConfigurationState(plan,values);validateMicrosoftAssociationState(plan,values);validateXTargetingState(plan,values);return values;
 }
 async call(input:JsonObject,actor:Actor):Promise<unknown>{
  guardInput(input);for(const key of Object.keys(input))if(!Object.hasOwn(writeTool.inputSchema.properties,key))fail('INVALID_ARGUMENT','Unknown write-tool parameter.',{parameter:key});
  if(input.creative_edit_confirmed!==undefined&&typeof input.creative_edit_confirmed!=='boolean')fail('INVALID_ARGUMENT','creative_edit_confirmed must be a boolean.');
  if(input.action==='prepare'||input.action==='inspect'){
   if(typeof input.gateway!=='string'||!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments))fail('INVALID_ARGUMENT','prepare requires gateway and arguments.');
   const isDelegated=this.registry.tools.get(input.gateway)?.mode==='delegated',nativeArgs=isDelegated?object(input.arguments.arguments):input.arguments;
   if(['aggregate_pages','paginate','allPages'].some(k=>input.arguments[k]||nativeArgs[k]))fail('MUTATION_PAGINATION_FORBIDDEN','A reviewed mutation executes exactly one request.');
   const args=isDelegated?{...input.arguments}:{...input.arguments,dry_run:true};this.registry.validate(input.gateway,args,this.options);const plan=applyExecutionRisk(isDelegated?this.delegated.compile(input.gateway,args):this.compiler.compile(input.gateway,args,this.options));
   if(input.connection_id&&nativeArgs.connection_id&&input.connection_id!==nativeArgs.connection_id)fail('CONFLICTING_PARAMETER','Connection IDs must agree.');
   if(input.action==='inspect'){
    let accountCapability:JsonObject;try{const c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,input.connection_id??nativeArgs.connection_id);accountCapability={connection_id:c.id,account_id:plan.accountId,selected:true,write_granted:c.writeAccounts?.includes(plan.accountId!)??false,granted_scopes:c.scopes,provider_access:'requires live preparation'};}catch(e){accountCapability={selected:false,error:e instanceof MirrorError?{code:e.code,message:e.message}:undefined};}
    try{assertWriteShape(plan);const reads=snapshotPlans(plan,this.registry);return {executed:false,network_requests:0,review_contract_supported:true,request:redact(plan),contract_evidence:executionEvidence(plan),state_reads:reads.map(r=>({method:r.method,path:r.path})),live_permissions_verified:false,account_capability:accountCapability,requirements:{deployment_writes_enabled:this.policy.allowWrites,operator_role:actor.role!=='reader',account_write_grant_required:true},next_step:'Use prepare to verify live state and account access.'};}
    catch(e){if(!(e instanceof MirrorError))throw e;const remedy=errorRemedy(e);return {executed:false,network_requests:0,review_contract_supported:false,request:redact(plan),contract_evidence:executionEvidence(plan),error:{code:e.code,message:e.message,details:e.details,category:remedy.category,remedy},live_permissions_verified:false};}
   }
   assertWriteShape(plan);const c=this.access(actor,plan,input.connection_id??nativeArgs.connection_id),reads=snapshotPlans(plan,this.registry),state=await this.state(actor,plan,c.id,reads);
   validateGoogleAssetLinkState(plan,state,true);
   validateGoogleConfigurationState(plan,state,true);
   validateDV360ListPrerequisites(plan,state,true);
   validateGtmWorkflowPrerequisites(plan,state,true);
   validateMicrosoftAssociationState(plan,state,true);
   if(plan.gateway==='gtm_native_action'&&!gtmWorkspaceKind(plan)){
    const route=this.delegated.data.routes.find(r=>r.gateway===plan.gateway&&r.operation+(r.action?'/'+r.action:'')===plan.action),fingerprint=object(state[0]).fingerprint;
    if(route?.parameters.fingerprint&&typeof fingerprint==='string'&&fingerprint){
     if(plan.query.fingerprint!==undefined&&plan.query.fingerprint!==fingerprint)fail('STATE_CHANGED','The supplied Tag Manager fingerprint is stale.');
     plan.query.fingerprint=fingerprint;
    }
   }
   if(input.creative_edit_confirmed!==undefined&&!xCreativeEdit(plan))fail('INVALID_ARGUMENT','creative_edit_confirmed is only for an X creative edit or deletion.');
   const creativeImpact=writeImpact(plan,state,input.creative_edit_confirmed===true,c.id);
   const override=input.creative_edit_confirmed===true?{creative_edit_confirmed:true}:{};
   const reviewId=randomUUID(),fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,connection:c.id,plan,...override})),expiresAt=Date.now()+300000;
   const stateHash=reviewStateHash(state),spendPolicy=checkSpendPolicy(this.store,actor,plan,state);
   this.store.putDocument(actor.tenantId,'write_review',reviewId,{user_id:actor.userId,connection_id:c.id,plan,reads,state,state_hash:stateHash,fingerprint,expires_at:expiresAt,...override});
   this.store.appendAudit(actor.tenantId,reviewId,{event:'write_prepared',request:plan,fingerprint,expires_at:expiresAt});
   return {success:true,executed:false,review_id:reviewId,idempotency_key:reviewId,expires_at:new Date(expiresAt).toISOString(),request:redact(plan),contract_evidence:executionEvidence(plan),before_state:redact(state),spend_policy:spendPolicy,state_hash:stateHash,state_reads:reads.map(r=>({method:r.method,path:r.path})),fingerprint,confirmation_required:true,...(creativeImpact?{creative_impact:creativeImpact}:{})};
  }
  if(input.action!=='execute'||typeof input.review_id!=='string')fail('INVALID_ARGUMENT','Use prepare or execute with a review_id.');
  if(input.arguments!==undefined||input.gateway!==undefined||input.connection_id!==undefined)fail('INVALID_ARGUMENT','Execute uses the frozen reviewed request; prepare a new review to change it.');
  const review=this.store.document(actor.tenantId,'write_review',input.review_id);
  if(review.user_id!==actor.userId)throw new MirrorError('FORBIDDEN','The review belongs to a different actor.',{},403);
  const plan=review.plan as CompiledRequest;assertWriteShape(plan);this.access(actor,plan,review.connection_id);
  if(input.idempotency_key!==input.review_id)fail('IDEMPOTENCY_REQUIRED','Use the exact idempotency_key returned by prepare.');
  authorizeExecution(actor,plan,{...input,dry_run:false},this.policy,true);
  if(review.creative_edit_confirmed===true&&input.creative_edit_confirmed!==true)fail('CREATIVE_EDIT_CONFIRMATION_REQUIRED','This review permits a potentially destructive creative edit. Also provide creative_edit_confirmed=true to execute.');
  if(input.creative_edit_confirmed===true&&review.creative_edit_confirmed!==true)fail('REVIEW_CHANGED','Prepare a new review to acknowledge creative-edit risk. Execute cannot add an override.');
  const fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,connection:review.connection_id,plan,...(review.creative_edit_confirmed===true?{creative_edit_confirmed:true}:{})}));if(fingerprint!==review.fingerprint)fail('REVIEW_CHANGED','The stored reviewed request failed its integrity check.');
  const previous=this.store.db.prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,input.idempotency_key) as JsonObject|undefined;
  if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','The key is bound to another request.');if(previous.state==='complete')return {...JSON.parse(previous.result),replayed:true};fail('WRITE_OUTCOME_UNCERTAIN','This review was already submitted. Inspect provider state; do not retry with a new key.');}
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Prepare and review a fresh request.');
  // Reproject saved envelopes as well: a still-valid review prepared before an
  // upgrade must not conflict solely because its stored envelope was wider.
  // X creative discovery already returns its own validated resource projection.
  const expectedState=xCreativeKind(plan)?review.state:review.state.map((value:unknown,i:number)=>normalizeSnapshot(review.reads[i],value));
  const current=await this.state(actor,plan,review.connection_id,review.reads),expectedHash=reviewStateHash(expectedState),actualHash=reviewStateHash(current);
  const creativeImpact=writeImpact(plan,current,review.creative_edit_confirmed===true,review.connection_id);
  if(actualHash!==expectedHash)fail('STATE_CHANGED','The provider configuration changed after preparation. Prepare and review a fresh request.',{expected_state_hash:expectedHash,actual_state_hash:actualHash,changed_fields:changedStateFields(expectedState,current)});
  const c=this.access(actor,plan,review.connection_id),auth=await this.credentials.get(c);this.access(actor,plan,review.connection_id);
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Review expired during state verification.');
  const actorBinding=this.store.bindJobActor(actor,input.review_id);
  const claim=this.store.transaction(()=>{checkSpendPolicy(this.store,actor,plan,current,input.review_id);return this.store.claim(actor.tenantId,input.idempotency_key,fingerprint);});if(!claim.fresh)return {...object(claim.result),replayed:true};
  try{
   this.store.appendAudit(actor.tenantId,input.review_id,{event:'write_started',request:plan,fingerprint,before_state:current});
   const response=await this.transport.request(plan,c,auth);this.delegated.validateResponse(plan,response.data,response.status);const result=writeOutcome(response,plan,current);
   const outcome:JsonObject={...result,review_id:input.review_id,action:plan.action,fingerprint,...(creativeImpact?{creative_impact:creativeImpact}:{})};
   this.store.transaction(()=>{
    if(result.success===true)new ScopeGuard(this.registry,this.store).observeCreated(plan,c,response.data);
    if(result.success===true){
     const job=this.store.enqueue(actor.tenantId,'write_verification',{review_id:input.review_id,actor_binding:actorBinding});
     outcome.verification={status:'queued',job_id:job,next_call:{tool:'amcp_campaign',arguments:{action:'verify',review_id:input.review_id}}};
    }
    this.store.complete(actor.tenantId,input.idempotency_key,outcome);this.store.appendAudit(actor.tenantId,input.review_id,{event:'write_completed',outcome});
   });return outcome;
  // The spend reservation taken above is deliberately NOT released here. A write that failed in
  // transport may still have reached the provider — that is why the outcome is recorded as
  // uncertain rather than failed — and releasing the reservation would let repeated "failures"
  // walk past the owner's cumulative daily cap. The accepted cost is that a deterministic
  // rejection, which certainly did not land, still consumes part of the day's allowance. Only
  // release on errors provably raised before dispatch, never on transport-layer uncertainty.
  }catch(e){this.store.uncertain(actor.tenantId,input.idempotency_key);this.store.appendAudit(actor.tenantId,input.review_id,{event:'write_uncertain',code:e instanceof MirrorError?e.code:'INTERNAL_ERROR'});throw e;}
 }
}
