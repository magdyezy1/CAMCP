import {Store} from './store.js';
import {Registry} from './catalog.js';
import {NativeTransport} from './transport.js';
import {CredentialProvider} from './auth.js';
import {ScopeGuard} from './scope.js';
import {independentlyReadOnly} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {setTimeout as delay} from 'node:timers/promises';
import {xCreativeKind,xPromotion,verifyXCreative} from './x-creative-writes.js';
import {normalizeReviewState} from './review-state.js';
import {validateState,snapshotPlans} from './write-review.js';
import {compileMicrosoft,microsoftGateway,microsoftContracts} from './microsoft-native.js';
import {audit,bad,fingerprint,obj,optional,read} from './workspace-core.js';
import type {Actor,CompiledRequest,JsonObject} from './types.js';
const snake=(s:string)=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const normalize=(v:any):any=>Array.isArray(v)?normalizeReviewState(v.map(normalize)):obj(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[snake(k),normalize(x)])):v;
function differing(expected:any,actual:any,path='',out:string[]=[]):string[]{
 if(obj(expected)){for(const [key,value]of Object.entries(expected))differing(value,actual?.[key],path+'/'+key,out);}
 else if((typeof expected==='number'&&typeof actual==='string'||typeof expected==='string'&&typeof actual==='number')&&String(expected)===String(actual))return out;
 else if(fingerprint(expected)!==fingerprint(actual??null))out.push(path);return out;
}
function verificationReads(plan:CompiledRequest,result:JsonObject,registry:Registry):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const b=(plan.body??{}) as JsonObject,d=result.data??{},gateway=plan.gateway;
 const base=(path:string,query:JsonObject={}):CompiledRequest=>({...plan,path,method:'GET',query,body:undefined,headers:gateway==='linkedin_native_action'?{'LinkedIn-Version':'202605','X-Restli-Protocol-Version':'2.0.0'}:{},readOnly:true,destructive:false,requiresConfirmation:false,action:'AMCP_VERIFY_READ'});
 if(plan.method==='DELETE'||b.operations?.some((o:JsonObject)=>o.remove))return [];
 if(gateway==='google_ads_native_action'){
  const leaves=(value:JsonObject,prefix=''):string[]=>Object.entries(value).flatMap(([k,v])=>obj(v)?leaves(v,prefix+snake(k)+'.'):[prefix+snake(k)]);
  return (d.results??[]).map((r:JsonObject,i:number)=>{const record=b.operations[i].create??b.operations[i].update,expected=Object.fromEntries(Object.entries(record).filter(([k])=>!['resource_name','resourceName'].includes(k))),fake={...plan,body:{operations:[{update:{resource_name:r.resourceName,...expected},update_mask:leaves(expected).join(',')}]}};
   const p=snapshotPlans(fake,registry)[0]!;return {read:p,expected,id:r.resourceName};});
 }
 if(gateway===microsoftGateway){const contract=microsoftContracts.get(plan.action)!;if(!contract.kind)return [];
  const records=b[contract.kind]??[],ids=plan.action.startsWith('Add')?d[contract.result]:records.map((r:JsonObject)=>r.Id),idKey=contract.kind.slice(0,-1)+'Ids';
  return ids.map((id:string,i:number)=>({read:compileMicrosoft({action:'Get'+contract.kind+'ByIds',account_id:plan.accountId,payload:{[idKey]:[id],...(contract.kind==='Campaigns'?{CampaignType:'Search'}:contract.kind==='AdGroups'?{CampaignId:b.CampaignId}:{AdGroupId:b.AdGroupId})}}),expected:records[i],id}));
 }
 if(gateway==='meta_native_action'){const id=String(d.id??plan.path.split('/').at(-1));if(!/^\d+$/.test(id))return [];const expected={...b};delete expected.execution_options;if(expected.creative?.creative_id)expected.creative={id:expected.creative.creative_id};return [{read:base('/v25.0/'+id,{fields:['id',...Object.keys(expected)].join(',')}),expected,id}];}
 if(gateway==='tiktok_native_action'){
  const kind=plan.path.split('/')[2]!,ids=d.data?.[kind+'_ids']??[d.data?.[kind+'_id']??b[kind+'_id']];if(ids.some((id:unknown)=>typeof id!=='string'))return [];
  const expected=kind==='ad'&&plan.path==='/v1.3/ad/create/'?{...b.creatives[0],adgroup_id:b.adgroup_id}:Object.fromEntries(Object.entries(b).filter(([k])=>!['advertiser_id',kind+'_ids'].includes(k)));
  return ids.map((id:string)=>({read:{...base('/v1.3/'+kind+'/get/',{advertiser_id:plan.accountId,filtering:{[kind+'_ids']:[id]},page_size:100}),action:'tiktok_'+kind+'_get'},expected,id}));
 }
 if(gateway==='snapchat_native_action'){
  const kind=Object.keys(d).find(k=>['campaigns','adsquads','ads','creatives'].includes(k));if(!kind)return [];const singular=kind==='adsquads'?'adsquad':kind.slice(0,-1);
  // Array-index patches and removes need before/after reconstruction. Do not label partial checks verified.
  if(Array.isArray(plan.body)&&plan.body.some((p:JsonObject)=>!['add','replace'].includes(p.op)||!/^\/[A-Za-z_]+$/.test(p.path)))return [];
  return d[kind].map((r:JsonObject,i:number)=>{const id=r[singular].id,expected=b[kind]?.[i]??(Array.isArray(plan.body)?Object.fromEntries((plan.body as JsonObject[]).map(p=>[p.path.slice(1),p.value])):b);return {read:base('/v1/'+kind+'/'+id),expected,id};});
 }
 if(gateway==='reddit_native_action'){const kind=plan.method==='POST'?plan.path.split('/').at(-1):plan.path.split('/').at(-2),id=d.data?.id;if(!id)return [];return [{read:base('/api/v3/'+kind+'/'+id),expected:b.data,id}];}
 if(gateway==='x_ads_native_action'){const records=Array.isArray(d.data)?d.data:[d.data];return records.filter(Boolean).map((r:JsonObject)=>({read:base(plan.method==='POST'?plan.path+'/'+r.id:plan.path),expected:b,id:String(r.id)}));}
 if(gateway==='linkedin_native_action'){const id=String(result.created_id??result.headers?.['x-restli-id']??plan.path.split('/').at(-1)),expected=b.patch?.$set??b;return [{read:base(plan.method==='POST'&&result.status===201?plan.path+'/'+encodeURIComponent(id):plan.path),expected,id:id.split(':').at(-1)!}];}
 if(gateway==='dv360_native_action'){const id=d.campaignId??d.insertionOrderId??d.lineItemId??d.creativeId;if(!id)return [];return [{read:base(plan.method==='POST'?plan.path+'/'+id:plan.path),expected:b,id:String(id)}];}
 return [];
}
function entity(plan:CompiledRequest,data:JsonObject):JsonObject{
 if(plan.gateway==='google_ads_native_action')return Object.values(data.results?.[0]??{})[0] as JsonObject;
 if(plan.gateway===microsoftGateway)return data[microsoftContracts.get(plan.action)!.result]?.[0];
 if(plan.gateway==='tiktok_native_action')return data.data?.list?.[0];
 if(plan.gateway==='snapchat_native_action'){const kind=plan.path.split('/').at(-2)!,singular=kind==='adsquads'?'adsquad':kind.slice(0,-1);return data[kind]?.[0]?.[singular];}
 if(['reddit_native_action','x_ads_native_action'].includes(plan.gateway))return data.data;
 return data;
}
export class WriteVerifier{
 constructor(private store:Store,private registry:Registry,private transport:NativeTransport,private credentials:CredentialProvider){}
 async verify(actor:Actor,reviewId:string):Promise<JsonObject>{
  const review=read(this.store,actor,'write_review',reviewId);if(review.user_id!==actor.userId&&actor.role!=='admin')bad('This write belongs to another actor.','FORBIDDEN');
  const row=this.store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,reviewId) as JsonObject|undefined;
  if(row?.state!=='complete'||!row.result)bad('The write outcome is uncertain or unavailable; verification cannot make it safe to resubmit.','WRITE_OUTCOME_UNCERTAIN');
  const result=JSON.parse(row.result),plan=review.plan as CompiledRequest,c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,review.connection_id);
  if(result.success!==true)bad('Inspect the retained partial failure before recovery.','WRITE_PARTIAL_OR_FAILED');
  const cached=optional(this.store,actor.tenantId,'write_verification',reviewId);if(cached?.status==='verified'&&Date.now()-cached.checked_at<10000)return {...cached,cached:true};
  let reads:ReturnType<typeof verificationReads>=[],status='unverified',checks:JsonObject[]=[];
  try{if(xCreativeKind(plan)){
   for(let attempt=0;attempt<3;attempt++){
    if(attempt)await delay(attempt*250);
    const verified=await verifyXCreative(plan,result,async read=>{
     if(!independentlyReadOnly(read))bad('X verification must remain read-only.','VERIFICATION_UNSUPPORTED');
     this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(read,current);
     const auth=await this.credentials.get(current);this.store.assertActorActive(actor);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
     const response=await this.transport.request(read,current,auth);this.store.assertActorActive(actor);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);return response;
    });status=verified.status;checks=verified.checks;
    if(!xPromotion(plan)||status!=='pending')break;
   }
  }else{reads=verificationReads(plan,result,this.registry);for(const item of reads){
   if(!obj(item.expected)||!Object.keys(item.expected).length||!independentlyReadOnly(item.read))bad('No complete configuration read contract exists for this write.','VERIFICATION_UNSUPPORTED');
   this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);new ScopeGuard(this.registry,this.store).authorize(item.read,current);const auth=await this.credentials.get(current);this.store.assertActorActive(actor);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);const response=await this.transport.request(item.read,current,auth);validateState(item.read,response);this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id);
   const actual=normalize(entity(item.read,response.data as JsonObject)),expected=normalize(item.expected),changed=differing(expected,actual);checks.push({resource_id:item.id,status:changed.length?'mismatch':'verified',changed_fields:changed,expected_hash:fingerprint(expected),actual_hash:fingerprint(actual),checked_fields:Object.keys(expected)});
  }status=reads.length?(checks.every(c=>c.status==='verified')?'verified':'mismatch'):'unsupported';}}
  catch(e){checks.push({status:'unverified',code:e instanceof MirrorError?e.code:'READ_FAILED',message:e instanceof MirrorError?e.message:'Verification read failed.'});}
  this.store.assertActorActive(actor);const receipt={review_id:reviewId,connection_id:c.id,account_id:plan.accountId,action:plan.action,status,checks,checked_at:Date.now(),automatic_retry_of_mutation:false,recovery:'Preserve successful resources. Corrective writes need a new reviewed request; verification never resets idempotency.',...(status==='pending'?{retry_read_after_ms:1000,next_call:{tool:'amcp_campaign',arguments:{action:'verify',review_id:reviewId}}}:{})};
  this.store.putDocument(actor.tenantId,'write_verification',reviewId,receipt);audit(this.store,actor,'write_verification',{connection_id:c.id,account_id:plan.accountId,review_id:reviewId,status});return receipt;
 }
}
