import {placeActionKind} from './google-place-action-links.js';
import {businessNotificationKind,businessNotificationDisables} from './google-business-notifications.js';
import {assertBusinessAccessPolicy} from './google-business-access.js';
import {redditCreativeServing} from './reddit-creative-writes.js';
import {criteoTargetingKind} from './criteo-targeting-writes.js';
import {googleBidKind} from './google-bid-modifiers.js';
import {googleConversionGoalKind,googleConversionGoalServing} from './google-conversion-goals.js';
import {googleBiddingEventKind} from './google-bidding-events.js';
import {linkedinConversionKind} from './linkedin-conversion-links.js';
import {linkedinRuleServing} from './linkedin-conversion-rules.js';
import {dv360ListAffectsServing} from './dv360-list-writes.js';
import {googleConfigurationServing} from './google-configuration-writes.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {appleSharedAccounts,appleBudgetState,appleEntityServing} from './apple-entity-writes.js';
import {Store} from './store.js';
import {xPromotion} from './x-creative-writes.js';
import {microsoftAssociationActivates} from './microsoft-associations.js';
import {googleAssetLinkActivates} from './google-asset-links.js';
import {applyExecutionRisk} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {normalizeAccount} from './scope.js';
import type {Actor,CompiledRequest,JsonObject} from './types.js';
export const spendPolicyKey=(gateway:string,account:string)=>sha256(gateway+':'+normalizeAccount(gateway,account));
/**
 * Reviewer test sessions are minted `role:'admin'` inside a disposable tenant and carry no
 * ownerUserId, so the membership clause below — which is conditional on ownerUserId — used to
 * short-circuit and let them through. They are rejected explicitly rather than by role, so the
 * guard survives any future change to the role the test door issues.
 */
export function ownerAccess(store:Store,actor:Actor){store.assertActorActive(actor);if(actor.testAccount===true)throw new MirrorError('OWNER_REQUIRED','Reviewer test accounts cannot change safety, spending or retention policies.',{},403);if(actor.role!=='admin'||actor.ownerUserId&&actor.membershipRole!=='owner'&&!(store.db.prepare("SELECT 1 FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND active=1").get(actor.tenantId,actor.ownerUserId)))throw new MirrorError('OWNER_REQUIRED','Only the workspace owner can change safety and spending policies.',{},403);}
/**
 * The account-specific policy is the precise control, but it only protects accounts somebody
 * remembered to configure — so an unconfigured account had no financial ceiling at all. A
 * workspace default closes that gap: it applies to every (gateway, account) pair with no policy
 * of its own, which makes the safeguard the standing case rather than an opt-in one.
 */
export const workspaceDefaultPolicyId='workspace_default';
const policyKeys=['allow_activation','allow_deletion','max_budget_increase_percent','max_budget_native','max_daily_increase_native'];
const moneyUnits='native API budget units for this account; daily cap is cumulative requested positive budget increases, not billed spend; the daily window is the UTC calendar day, so it resets at 00:00 UTC rather than in the account timezone';
function validatePolicy(p:JsonObject){
 if(Object.keys(p).some(k=>!policyKeys.includes(k))||policyKeys.slice(0,2).some(k=>p[k]!==undefined&&typeof p[k]!=='boolean')||policyKeys.slice(2).some(k=>p[k]!==undefined&&(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0||p[k]>Number.MAX_SAFE_INTEGER)))throw new MirrorError('INVALID_POLICY','Use explicit activation/deletion permissions and non-negative numeric limits.');
}
export function saveSpendPolicy(store:Store,actor:Actor,input:JsonObject){ownerAccess(store,actor);
 if(input.scope==='workspace'){
  if(input.confirmed!==true||!input.policy||typeof input.policy!=='object')throw new MirrorError('INVALID_POLICY','Confirm a workspace default spending policy.');
  if(input.gateway!==undefined||input.account_id!==undefined)throw new MirrorError('INVALID_POLICY','A workspace default applies to every account; omit gateway and account_id.');
  const p=input.policy as JsonObject;validatePolicy(p);
  const data={...p,scope:'workspace',updated_at:Date.now(),updated_by:actor.userId,money_units:moneyUnits,applies_to:'Every gateway and account in this workspace that has no policy of its own.'};
  store.putDocument(actor.tenantId,'spend_policy',workspaceDefaultPolicyId,data);store.appendAudit(actor.tenantId,'policy/'+workspaceDefaultPolicyId,{event:'spend_policy_saved',policy:data});return {id:workspaceDefaultPolicyId,...data};
 }
 if(input.confirmed!==true||typeof input.gateway!=='string'||typeof input.account_id!=='string'||!input.policy||typeof input.policy!=='object')throw new MirrorError('INVALID_POLICY','Confirm an account-specific spending policy.');const p=input.policy;validatePolicy(p as JsonObject);store.resolveConnection(actor,input.gateway,input.account_id,input.connection_id);const id=spendPolicyKey(input.gateway,input.account_id),data={...p,gateway:input.gateway,account_id:normalizeAccount(input.gateway,input.account_id),updated_at:Date.now(),updated_by:actor.userId,money_units:moneyUnits};store.putDocument(actor.tenantId,'spend_policy',id,data);store.appendAudit(actor.tenantId,'policy/'+id,{event:'spend_policy_saved',policy:data});return {id,...data};}
/**
 * Accounts with no policy of their own and no workspace default are financially unprotected.
 * Read the policy ids once and test membership in memory: a query per account turned an owner's
 * health check into hundreds of round trips for a workspace with many accounts, which is the
 * same per-row shape this module removed from the reservation lookup.
 */
export function unprotectedAccounts(store:Store,actor:Actor){
 const ids=new Set((store.db.prepare("SELECT id FROM documents WHERE tenant_id=? AND kind='spend_policy'").all(actor.tenantId) as {id:string}[]).map(r=>r.id));
 if(ids.has(workspaceDefaultPolicyId))return [];
 const rows:JsonObject[]=[];
 for(const c of store.listConnections(actor.tenantId))for(const account of c.accounts)
  if(!ids.has(spendPolicyKey(c.gateway,account)))rows.push({gateway:c.gateway,account_id:account,connection_id:c.id});
 return rows;
}
type Amount={path:string;key:string;amount:number};
/**
 * Both walks below recurse over a caller-supplied body. Without a cap, a deeply nested payload
 * inside the request size limit exhausts the stack and surfaces as an internal error rather than
 * a policy decision. report-native.ts already caps its own walk; these now match it. Exceeding
 * the cap is a refusal, not a skip: quietly stopping the descent would let a budget or an
 * activation hide below it.
 */
const maxPayloadDepth=64;
/**
 * Snapchat mutates through JSON Patch, so a budget or a status can arrive as an operation
 * rather than as a field. An operation is recognised by carrying a string `path` and a `value`,
 * in either key order — both the budget extractor and the activation check need the same rule,
 * and they must agree, or one control would see an operation the other does not.
 */
const patchOperation=(v:JsonObject)=>typeof v.path==='string'&&Object.hasOwn(v,'value')?{path:v.path,value:v.value}:undefined;
function budgets(v:unknown,path='',out:Amount[]=[],strict=false,depth=0):Amount[]{if(depth>maxPayloadDepth)throw new MirrorError('POLICY_PAYLOAD_TOO_DEEP','This request nests more deeply than the spending policy can inspect, so its budgets cannot be verified.',{limit:maxPayloadDepth},400);if(Array.isArray(v)){v.forEach((x,i)=>budgets(x,path+'/'+i,out,strict,depth+1));return out;}if(!v||typeof v!=='object')return out;const op=patchOperation(v as JsonObject);if(op&&/budget/i.test(op.path))return budgets({[op.path.split('/').at(-1)!]:op.value},path+'/budget',out,strict,depth+1);for(const [k,x]of Object.entries(v)){const name=k.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase(),next=path+'/'+name;if(/budget|campaign_budgets/.test(next)&&/^(daily_budget|daily_budget_micro|daily_budget_micros|daily_budget_amount_local_micro|total_budget_amount_local_micro|lifetime_budget|budget|amount|amount_micros|budget_amount_micros|budget_amount|amount_micro|daily_cap|total_cap|total_budget)$/.test(name)&&x!==null&&x!==''&&['string','number'].includes(typeof x)){const n=Number(x);if(!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER)throw new MirrorError('POLICY_AMOUNT_INVALID','Budget is outside the policy’s supported numeric range.');out.push({path:next,key:name,amount:n});}else{if(strict&&/budget/.test(next)&&!/(?:_id|_ids)$/.test(name)&&(typeof x==='number'||typeof x==='string'&&/^\d+(\.\d+)?$/.test(x)))throw new MirrorError('POLICY_AMOUNT_UNSUPPORTED','This budget field needs an explicit native unit mapping before it can be used under the owner policy.',{field:next});budgets(x,next,out,strict,depth+1);}}return out;}
/**
 * Activation is a per-provider fact, so it is declared per gateway and matched against the
 * payload structure. Matching a serialized string cannot see a field name the pattern was not
 * written for (Reddit names it configured_status) and depends on JSON key order (a Snapchat
 * JSON Patch operation written {op,value,path} serializes value first); both cases passed the
 * previous text match while the owner policy forbade activation.
 *
 * `null` marks a gateway with no serving-activation surface: measurement writes configure
 * tracking and never start ad delivery, so the activation control does not apply to them.
 *
 * A gateway absent from this table is refused while activation is forbidden. Adding a provider
 * without declaring how it spells activation therefore fails closed instead of passing silently.
 */
type Activation={field:string;active:string[]};
export const activationFields:Record<string,Activation|null>={
 // Place links have no paused state; the exact family below treats create/edit
 // as public activation even though no advertising budget is changed.
 google_business_native_action:{field:'public_link',active:[]},
 meta_native_action:{field:'status',active:['ACTIVE']},
 google_ads_native_action:{field:'status',active:['ENABLED']},
 tiktok_native_action:{field:'operation_status',active:['ENABLE']},
 snapchat_native_action:{field:'status',active:['ACTIVE']},
 linkedin_native_action:{field:'status',active:['ACTIVE']},
 x_ads_native_action:{field:'entity_status',active:['ACTIVE']},
 dv360_native_action:{field:'entityStatus',active:['ENTITY_STATUS_ACTIVE']},
 reddit_native_action:{field:'configured_status',active:['ACTIVE']},
 microsoft_ads_native_action:{field:'Status',active:['Active']},
 apple_ads_native_action:{field:'status',active:['ENABLED']},
 criteo_native_action:{field:'status',active:['active','scheduled']},
 ga4_native_action:null,
 gtm_native_action:null,
 google_search_console_native_action:null,
};
/** Field names are compared without underscores or case so entity_status and entityStatus agree. */
const activationKey=(name:string)=>name.replace(/_/g,'').toLowerCase();
export function activatesEntity(payload:unknown,rule:Activation):boolean{
 const field=activationKey(rule.field),active=rule.active.map(v=>v.toUpperCase());
 /**
  * A provider sends the status as a bare string, but a value that arrives wrapped — padded with
  * whitespace, as a one-element array, or under a `value` key — still says ACTIVE. None of these
  * is a documented provider shape, so this is hardening rather than a fix; the cost of reading
  * them is two comparisons and the cost of missing one would be an unenforced policy.
  */
 const matches=(value:unknown):boolean=>{
  if(typeof value==='string')return active.includes(value.trim().toUpperCase());
  if(Array.isArray(value))return value.length===1&&matches(value[0]);
  if(value&&typeof value==='object'&&Object.hasOwn(value,'value'))return matches((value as JsonObject).value);
  return false;
 };
 const walk=(v:unknown,depth=0):boolean=>{
  if(depth>maxPayloadDepth)throw new MirrorError('POLICY_PAYLOAD_TOO_DEEP','This request nests more deeply than the spending policy can inspect, so it cannot be shown to leave entities paused.',{limit:maxPayloadDepth},400);
  if(Array.isArray(v))return v.some(x=>walk(x,depth+1));
  if(!v||typeof v!=='object')return false;
  const o=v as JsonObject;
  // A JSON Patch operation addresses its target by path, and the keys may appear in any order.
  const op=patchOperation(o);
  if(op){
   if(activationKey(op.path.split('/').at(-1)??'')===field&&matches(op.value))return true;
   return walk(op.value,depth+1);
  }
  return Object.entries(o).some(([k,x])=>(activationKey(k)===field&&matches(x))||walk(x,depth+1));
 };
 return walk(payload);
}
/**
 * A create has no prior budget, so percentage and baseline rules cannot apply to it. REST.li POSTs
 * create only against a collection: a resource-scoped POST (…_{id}_post, the PARTIAL_UPDATE contract)
 * changes an existing budget and must stay under the percentage and baseline rules.
 */
export function checkSpendPolicy(store:Store,actor:Actor,plan:CompiledRequest,before:unknown,reserveId?:string):JsonObject{
 const accounts=appleSharedAccounts(plan);
 if(accounts.length)return store.transaction(()=>({scope:'shared_budget',affected_accounts:accounts.map(account=>({account_id:account,...checkAccountSpendPolicy(store,actor,{...plan,accountId:account},before,reserveId?reserveId+':'+account:undefined)})),allocation:'Each account reserves the complete positive increase; no allocation among campaigns is inferred.'}));
 return checkAccountSpendPolicy(store,actor,plan,before,reserveId);
}
function checkAccountSpendPolicy(store:Store,actor:Actor,plan:CompiledRequest,before:unknown,reserveId?:string):JsonObject{return store.transaction(()=>{store.assertActorActive(actor);const read=(key:string)=>store.db.prepare("SELECT data,revision FROM documents WHERE tenant_id=? AND kind='spend_policy' AND id=?").get(actor.tenantId,key) as JsonObject|undefined;
  // An account-specific policy wins; otherwise the workspace default applies, so an account
  // nobody configured is still covered.
  const accountKey=spendPolicyKey(plan.gateway,plan.accountId!),accountRow=read(accountKey);
  const id=accountRow?accountKey:workspaceDefaultPolicyId,row=accountRow??read(workspaceDefaultPolicyId);
  if(row)assertBusinessAccessPolicy(plan,before,JSON.parse(row.data));
  if(!row)return {configured:false,unprotected:true,advice:'No spending policy protects this account. An owner can set one for this account, or a workspace default that covers every account, with amcp_workspace save_spend_policy.'};const policy=JSON.parse(row.data);if(policy.allow_deletion===false&&applyExecutionRisk(plan).destructive)throw new MirrorError('POLICY_DELETION_FORBIDDEN','The owner policy forbids resource deletion.',{policy_id:id},403);if(policy.allow_activation===false){if(!Object.hasOwn(activationFields,plan.gateway))throw new MirrorError('POLICY_ACTIVATION_FORBIDDEN','The owner policy forbids activation and this platform has no declared activation contract, so the request cannot be shown to leave entities paused.',{policy_id:id,gateway:plan.gateway},403);const rule=plan.gateway==='linkedin_native_action'&&/^\/rest\/adAccounts\/[^/]+\/creatives(?:\/[^/]+)?$/.test(plan.path)?{field:'intendedStatus',active:['ACTIVE']}:activationFields[plan.gateway];if(rule&&(businessNotificationKind(plan)&&!businessNotificationDisables(plan)||placeActionKind(plan)&&placeActionKind(plan)!=='delete'||linkedinConversionKind(plan)||linkedinRuleServing(plan)||googleBidKind(plan)||googleBiddingEventKind(plan)||googleConversionGoalServing(plan)||!!criteoTargetingKind(plan)||xPromotion(plan)||redditCreativeServing(plan)||googleAssetLinkActivates(plan)||googleConfigurationServing(plan)||appleEntityServing(plan)||dv360ListAffectsServing(plan)||microsoftAssociationActivates(plan)||!googleSegmentKind(plan)&&!googleConversionGoalKind(plan)&&activatesEntity({query:plan.query,body:plan.body},rule)))throw new MirrorError('POLICY_ACTIVATION_FORBIDDEN','The owner policy forbids activation.',{policy_id:id,field:rule.field},403);}const amounts=budgets({body:plan.body,query:plan.query},/budget/i.test(plan.path)?'/budget':'',[],['max_budget_native','max_budget_increase_percent','max_daily_increase_native'].some(k=>policy[k]!==undefined)),old=budgets(appleBudgetState(plan,before));let increase=0;const restli=(plan.headers['X-RestLi-Method']??'').toUpperCase(),updatesExisting=['UPDATE','BATCH_UPDATE','PARTIAL_UPDATE','BATCH_PARTIAL_UPDATE'].includes(restli)||/_(?:id|urn)_post$/.test(plan.action);for(const b of amounts){if(policy.max_budget_native!==undefined&&b.amount>policy.max_budget_native)throw new MirrorError('POLICY_BUDGET_LIMIT','Requested budget exceeds the account policy.',{field:b.path,requested:b.amount,limit:policy.max_budget_native,units:'native'},403);const creating=!updatesExisting&&(/\/create\//.test(b.path)||/create|_post$|^Add/.test(plan.action));const candidates=[...new Set(old.filter(o=>o.key===b.key).map(o=>o.amount))];if(!creating&&candidates.length!==1&&(policy.max_budget_increase_percent!==undefined||policy.max_daily_increase_native!==undefined))throw new MirrorError('POLICY_BASELINE_REQUIRED','This budget policy requires one unambiguous current budget. Narrow the mutation to one resource.',{field:b.path},409);const prior=creating?0:candidates[0]??b.amount,delta=Math.max(0,b.amount-prior);if(!creating&&delta>0&&policy.max_budget_increase_percent!==undefined&&(prior===0||delta/prior*100>policy.max_budget_increase_percent))throw new MirrorError('POLICY_INCREASE_LIMIT','The budget increase exceeds the owner’s percentage limit.',{field:b.path,before:prior,after:b.amount,maximum_percent:policy.max_budget_increase_percent},403);increase+=delta;}
 // Sum the day's reservations in SQL. Reading every reservation the workspace has ever written
 // and filtering in JS made the cost of this safeguard grow with lifetime write count, and this
 // runs twice per reviewed write, inside a transaction.
 const day=new Date().toISOString().slice(0,10);
 const used=Number((store.db.prepare("SELECT coalesce(sum(json_extract(data,'$.increase_native')),0) AS total FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND json_extract(data,'$.policy_id')=? AND json_extract(data,'$.day')=? AND id<>coalesce(?,'')").get(actor.tenantId,accountKey,day,reserveId??null) as JsonObject).total);if(policy.max_daily_increase_native!==undefined&&used+increase>policy.max_daily_increase_native)throw new MirrorError('POLICY_DAILY_INCREASE_LIMIT','Cumulative budget increases would exceed the owner’s daily policy.',{day,already_reserved:used,requested_increase:increase,limit:policy.max_daily_increase_native,units:'native'},403);if(reserveId)store.putDocument(actor.tenantId,'spend_reservation',reserveId,{policy_id:accountKey,day,increase_native:increase,created_at:Date.now()});return {configured:true,policy_id:id,scope:accountRow?'account':'workspace_default',policy_revision:row.revision,requested_increase_native:increase,reserved_today_native:used,units:'native'};});}
