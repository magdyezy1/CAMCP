import {ownerOperations} from './owner-operations.js';
import {workspaceCapabilities} from './capabilities.js';
import {actionContractPage} from './action-contracts.js';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport} from './transport.js';
import {ScopeGuard} from './scope.js';
import {validateState} from './write-review.js';
import {microsoftGateway,compileMicrosoft} from './microsoft-native.js';
import {audit,bad,field,fingerprint,noSecrets,obj,optional,read,tool,update,validate,writer,type ToolCall} from './workspace-core.js';
import type {Actor,CompiledRequest,JsonObject} from './types.js';
export const workspaceTool=tool('amcp_workspace','Account readiness, capability evidence, approved client defaults/templates, and campaign change history. contracts lists every local action and its read/write/media/blocked contract classification without network calls; filter by gateway/search and paginate with offset/limit. Profiles never grant account access. check performs only provider reads; unsupported/missing evidence stays explicit.', ['dashboard','contracts','check','profiles','save_profile','delete_profile','history','health','support_bundle','save_spend_policy','save_retention'],{gateway:field.id,search:{type:'string',maxLength:200},offset:{type:'integer',minimum:0},policy:field.object,scope:{type:'string',enum:['workspace']},days:field.integer,connection_id:field.id,account_id:field.id,requirements:field.object,live:field.bool,id:field.id,profile:field.object,revision:field.integer,confirmed:field.bool,limit:{type:'integer',minimum:1,maximum:100}});
export const accountPlan=(gateway:string,id:string):CompiledRequest=>{
 const p:CompiledRequest={gateway,accountId:id,action:'AMCP_READINESS',method:'GET',path:'',query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'AMCP exact account readiness read',warnings:[]};
 switch(gateway){
  case 'meta_native_action':p.path='/v25.0/act_'+id;p.query={fields:'id,name,account_status,currency,timezone_name'};break;
  case 'snapchat_native_action':p.path='/v1/adaccounts/'+id;break;
  case 'tiktok_native_action':p.path='/v1.3/advertiser/info/';p.query={advertiser_ids:[id]};break;
  case 'google_ads_native_action':p.method='POST';p.path='/v23/customers/'+id+'/googleAds:search';p.body={query:'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'};break;
  case 'linkedin_native_action':p.path='/rest/adAccounts/'+id;p.headers={'LinkedIn-Version':'202605','X-Restli-Protocol-Version':'2.0.0'};break;
  case 'x_ads_native_action':p.path='/12/accounts/'+id;break;
  case 'dv360_native_action':p.path='/v4/advertisers/'+id;break;
  case 'reddit_native_action':p.path='/api/v3/ad_accounts/'+id;break;
  case microsoftGateway:return compileMicrosoft({action:'GetAccount',account_id:id});
  default:bad('This provider uses resource-specific readiness checks.','READINESS_CONTRACT_UNAVAILABLE');
 }return p;
};
const writeScopes:Record<string,string[]>={meta_native_action:['ads_management'],linkedin_native_action:['rw_ads'],reddit_native_action:['adsread','adsedit'],microsoft_ads_native_action:['https://ads.microsoft.com/msads.manage']};
export class WorkspaceService{
 constructor(private store:Store,private registry:Registry,private transport:NativeTransport,private credentials:CredentialProvider,private call:ToolCall,private allowWrites:boolean){}
 async handle(input:JsonObject,actor:Actor):Promise<JsonObject>{
  validate(input,Object.keys(workspaceTool.inputSchema.properties));this.store.assertActorActive(actor);
  if(input.action==='contracts')return actionContractPage(this.registry,input);
  if(['health','support_bundle','save_spend_policy','save_retention'].includes(input.action))return ownerOperations(this.store,input,actor);
  if(input.action==='profiles')return {profiles:this.store.documents(actor.tenantId,'client_profile')};
  if(input.action==='save_profile'){
   writer(this.store,actor);if(input.confirmed!==true||!obj(input.profile))bad('Review and confirm the client profile.');const p=input.profile;noSecrets(p);validate(p,['name','naming','utm','bindings','defaults','templates','variables','conversion_mappings']);
   if(typeof p.name!=='string'||!p.name.trim()||p.name.length>100)bad('Profile name must be 1–100 characters.');
   if(p.bindings!==undefined&&!Array.isArray(p.bindings))bad('bindings must be an array.');for(const binding of p.bindings??[]){validate(binding,['gateway','connection_id','account_id']);this.store.resolveConnection(actor,binding.gateway,binding.account_id,binding.connection_id);}
   const id=input.id??randomUUID();if(!optional(this.store,actor.tenantId,'client_profile',id)&&this.store.documents(actor.tenantId,'client_profile').length>=100)bad('Limit reached: 100 client profiles.');
   const record=update(this.store,actor,'client_profile',id,{...p,approved_by:actor.userId,approved_at:Date.now()},input.revision);audit(this.store,actor,'client_profile_saved',{id,revision:record.revision});return record;
  }
  if(input.action==='delete_profile'){writer(this.store,actor);if(input.confirmed!==true)bad('Confirm profile deletion.');const p=read(this.store,actor,'client_profile',input.id);if(input.revision!==p.revision)bad('Reload the current profile.','REVISION_CONFLICT');this.store.db.prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=? AND revision=?').run(actor.tenantId,'client_profile',p.id,p.revision);audit(this.store,actor,'client_profile_deleted',{id:p.id});return {deleted:true};}
  if(input.action==='history'){
   const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)bad('History limit must be 1–100.');
   const events=(this.store.db.prepare('SELECT seq,created_at,event FROM audit WHERE tenant_id=? ORDER BY seq DESC LIMIT ?').all(actor.tenantId,limit) as any[]).map((r:any)=>({id:r.seq,at:r.created_at,...JSON.parse(r.event)})).filter((e:JsonObject)=>!input.connection_id||e.connection_id===input.connection_id||e.request?.connection_id===input.connection_id);
   return {events,source:'AMCP append-only audit',coverage:'AMCP observations and actions; external edits are detected by read-back differences, not a complete vendor history.'};
  }
  if(input.action==='dashboard'){
   const checks=this.store.documents(actor.tenantId,'readiness'),receipts=this.store.documents(actor.tenantId,'write_verification');
   return {capabilities:workspaceCapabilities(this.store,actor),at:Date.now(),writes_enabled:this.allowWrites,connections:this.store.listConnections(actor.tenantId).map(c=>({id:c.id,gateway:c.gateway,label:c.label,enabled:c.enabled,accounts:c.accounts,write_accounts:c.writeAccounts??[],accounts_status:c.accounts.map(account=>({account_id:account,check:checks.find(x=>x.connection_id===c.id&&x.account_id===account)??null,verified_writes:receipts.filter(r=>r.connection_id===c.id&&r.account_id===account).map(r=>({review_id:r.id,at:r.checked_at,status:r.status,action:r.action}))}))})),campaigns:this.store.documents(actor.tenantId,'campaign_run').map(r=>({id:r.id,name:r.name,state:r.state,updated_at:r.updated_at,steps:r.steps.map((s:JsonObject)=>({id:s.id,status:s.status,error:s.error}))})),levels:['implemented','locally_tested','provider_read_checked','provider_validated','write_verified'],limitations:'A connection check is not validation of every workflow. No live badge is inferred from catalog coverage.'};
  }
  if(input.action!=='check')bad('Unknown workspace action.');
  const c=this.store.listConnections(actor.tenantId).find(c=>c.id===input.connection_id);if(!c)bad('Select a connection in this workspace.','CONNECTION_NOT_FOUND');const id=input.account_id;
  if(typeof id!=='string'||!c.accounts.includes(id))bad('Select an account granted to this connection.','ACCOUNT_FORBIDDEN');
  const requirements=input.requirements??{};validate(requirements,['write','assets','destination_url','native_request']);
  const checks:JsonObject[]=[];const check=(key:string,pass:boolean|null,message:string,next?:string)=>checks.push({key,status:pass===null?'unknown':pass?'passed':'blocked',message,...(next?{next_step:next}:{})});
  check('connection',c.enabled,c.enabled?'Connection enabled.':'Connection disabled.','Reconnect or select assets in Connections.');
  if(requirements.write){check('deployment_writes',this.allowWrites,'Deployment write setting.','Enable reviewed writes in server configuration.');check('operator',actor.role!=='reader','MCP operator role.','Use an operator connector.');check('account_grant',c.writeAccounts?.includes(id)===true,'Account write grant.','Grant this account write access in Connections.');const required=writeScopes[c.gateway];check('provider_scopes',required?required.every(s=>c.scopes.includes(s)||s.endsWith('msads.manage')&&c.scopes.includes('msads.manage')):null,required?'Required recorded OAuth scopes.':'This provider requires live permission verification.','Reconnect with the required provider permissions.');}
  if(requirements.destination_url!==undefined){let valid=false;try{const u=new URL(requirements.destination_url);valid=['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{}check('destination_url',valid,'Destination URL syntax; reachability and tracking are not inferred.');}
  const assets=optional(this.store,actor.tenantId,'website_assets',c.id);if(requirements.assets!==undefined&&!Array.isArray(requirements.assets))bad('assets must be an array.');
  for(const a of requirements.assets??[]){validate(a,['kind','id']);const group=assets?.groups?.find((g:JsonObject)=>g.kind===a.kind),found=group?.assets?.some((r:JsonObject)=>r.id===a.id);check('asset:'+a.kind+':'+a.id,found&&group?.checkedAt&&Date.now()-group.checkedAt<86400000?true:group?.complete===true&&!found?false:null,found?'Found in inventory; only a sync within 24 hours passes this check.':'Required asset is not verified in this login.','Sync '+a.kind+' and select an accessible asset.');}
  if(requirements.native_request){const r=await this.call('amcp_write',{action:'inspect',gateway:c.gateway,connection_id:c.id,arguments:requirements.native_request},actor);check('write_contract',r.success&&r.data?.review_contract_supported===true,r.data?.error?.message??r.error?.message??'Local execution contract checked.');}
  if(input.live===true&&c.enabled){try{const p=accountPlan(c.gateway,id);new ScopeGuard(this.registry,this.store).authorize(p,c);const auth=await this.credentials.get(c);this.store.assertActorActive(actor);const current=this.store.resolveConnection(actor,c.gateway,id,c.id),r=await this.transport.request(p,current,auth);validateState(p,r);this.store.resolveConnection(actor,c.gateway,id,c.id);check('provider_read',true,'Provider confirmed the exact selected account.');}catch(e){check('provider_read',false,e instanceof MirrorError?e.message:'Provider account read failed.','Reconnect or resolve the provider account permission.');}}
  else check('provider_read',null,'No provider request was made.');
  this.store.assertActorActive(actor);const result={connection_id:c.id,account_id:id,checked_at:Date.now(),requirements,checks,ready:checks.every(c=>c.status==='passed'),blocked:checks.some(c=>c.status==='blocked'),live_read:checks.some(c=>c.key==='provider_read'&&c.status==='passed'),coverage:'Exact requested prerequisites only; unknown checks are not passed.'};
  this.store.putDocument(actor.tenantId,'readiness',fingerprint([c.id,id]),result);return result;
 }
}
