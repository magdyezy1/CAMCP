import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Rule-based Google Ads user lists (website and app visitors), per the v23 UserList, RuleBasedUserListInfo,
 * FlexibleRuleUserListInfo, FlexibleRuleOperandInfo, UserListRuleInfo and rule item references, the user_list GAQL
 * field reference and the "Visitors to your website" guide (checked 2026-09-26). membership_life_span is ignored for
 * rule-based lists, so each rule states its lookback window; flexible rules support only OR of ANDs; a date rule's
 * value overrides offset_in_days. Customer Match, lookalike, logical and basic lists, and removal, stay outside.
 */
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const order=(a:unknown,b:unknown)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;};
function invalid(message:string):never{throw new MirrorError('INVALID_GOOGLE_USER_LIST',message);}
const stringOps=['CONTAINS','EQUALS','STARTS_WITH','ENDS_WITH','NOT_CONTAINS','NOT_EQUALS','NOT_STARTS_WITH','NOT_ENDS_WITH'];
const numberOps=['EQUALS','NOT_EQUALS','GREATER_THAN','GREATER_THAN_OR_EQUAL','LESS_THAN','LESS_THAN_OR_EQUAL'];
const dateOps=['EQUALS','NOT_EQUALS','BEFORE','AFTER'];
/** AMCP bounds on rule size; Google documents none. */
const maxOperands=10,maxGroups=10,maxItems=10;
/** Rule variable names begin with an ASCII letter, underscore or non-ASCII character; built-ins are url__ and ref_url__. */
const ruleName=/^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]{0,99}$/;
const integer=(v:unknown,min:number,max:number)=>{const n=typeof v==='string'&&/^-?\d+$/.test(v)?Number(v):v;return typeof n==='number'&&Number.isInteger(n)&&n>=min&&n<=max;};
function keys(v:JsonObject,allowed:string[],at:string){const extra=Object.keys(v).find(k=>!allowed.includes(k));if(extra)invalid('"'+at+'.'+extra+'" is outside the rule-based user list contract.');}

/** Operation-level checks, before the generic configuration field checks, so each refusal says why. */
export function assertGoogleUserListOperation(kind:string,op:JsonObject):void{
 if(kind!=='userLists')return;
 if(op.remove!==undefined)invalid('User list removal is not qualified: a removed list stops the campaigns and ad groups that target it.');
 const r=op.create??op.update;if(!obj(r))return;
 const other=['crmBasedUserList','logicalUserList','basicUserList','lookalikeUserList','similarUserList'].find(k=>r[k]!==undefined);
 if(other)invalid(other==='crmBasedUserList'?'Customer Match lists upload customer data and are not qualified here; create a rule-based list.':'"'+other+'" lists are not qualified; create a rule-based list.');
 if(r.membershipLifeSpan!==undefined)invalid('membershipLifeSpan is ignored for rule-based lists; set lookbackWindowDays on each rule instead.');
}
function ruleItem(item:unknown,at:string){
 if(!obj(item))invalid(at+' must be a rule item object.');
 keys(item,['name','stringRuleItem','numberRuleItem','dateRuleItem'],at);
 if(typeof item.name!=='string'||!ruleName.test(item.name))invalid(at+'.name must be a tag parameter name such as url__ or ref_url__ (letters, digits and underscores, not starting with a digit).');
 const kinds=['stringRuleItem','numberRuleItem','dateRuleItem'].filter(k=>item[k]!==undefined);
 if(kinds.length!==1)invalid(at+' needs exactly one of stringRuleItem, numberRuleItem and dateRuleItem.');
 const kind=kinds[0]!,v=item[kind];
 if(!obj(v))invalid(at+'.'+kind+' must be an object.');
 if(kind==='stringRuleItem'){
  keys(v,['operator','value'],at+'.'+kind);
  if(!stringOps.includes(v.operator))invalid(at+'.stringRuleItem.operator must be one of '+stringOps.join(', ')+'.');
  if(typeof v.value!=='string'||!v.value||[...v.value].length>1024||/[\u0000-\u001f]/.test(v.value))invalid(at+'.stringRuleItem.value must be nonempty text of at most 1024 characters.');
  if(['url__','ref_url__'].includes(item.name)&&/["'()\t\n\r]/.test(v.value))invalid(at+'.stringRuleItem.value: URL rules cannot contain quotes, parentheses, tabs or newlines.');
 }else if(kind==='numberRuleItem'){
  keys(v,['operator','value'],at+'.'+kind);
  if(!numberOps.includes(v.operator))invalid(at+'.numberRuleItem.operator must be one of '+numberOps.join(', ')+'.');
  if(typeof v.value!=='number'||!Number.isFinite(v.value))invalid(at+'.numberRuleItem.value must be a number.');
 }else{
  keys(v,['operator','value','offsetInDays'],at+'.'+kind);
  if(!dateOps.includes(v.operator))invalid(at+'.dateRuleItem.operator must be one of '+dateOps.join(', ')+'.');
  if((v.value===undefined)===(v.offsetInDays===undefined))invalid(at+'.dateRuleItem needs value or offsetInDays, not both; Google lets value override offsetInDays.');
  if(v.value!==undefined&&(typeof v.value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.value)))invalid(at+'.dateRuleItem.value must be YYYY-MM-DD, in the customer time zone.');
  if(v.offsetInDays!==undefined&&!integer(v.offsetInDays,-3650,3650))invalid(at+'.dateRuleItem.offsetInDays must be a whole number of days.');
 }
}
function operand(o:unknown,at:string){
 if(!obj(o))invalid(at+' must be an operand object.');
 keys(o,['rule','lookbackWindowDays'],at);
 if(!integer(o.lookbackWindowDays,1,540))invalid(at+'.lookbackWindowDays must be 1-540 days: rule-based lists ignore membershipLifeSpan, so each rule states how far back visits count.');
 const r=o.rule;
 if(!obj(r))invalid(at+'.rule must be an object.');
 keys(r,['ruleType','ruleItemGroups'],at+'.rule');
 if(r.ruleType!==undefined&&r.ruleType!=='OR_OF_ANDS')invalid(at+'.rule.ruleType: flexible rule lists support only OR_OF_ANDS.');
 const groups=r.ruleItemGroups;
 if(!Array.isArray(groups)||!groups.length||groups.length>maxGroups)invalid(at+'.rule.ruleItemGroups must hold 1-'+maxGroups+' groups.');
 groups.forEach((g:unknown,i:number)=>{
  const gat=at+'.rule.ruleItemGroups['+i+']';
  if(!obj(g))invalid(gat+' must be an object.');keys(g,['ruleItems'],gat);
  if(!Array.isArray(g.ruleItems)||!g.ruleItems.length||g.ruleItems.length>maxItems)invalid(gat+'.ruleItems must hold 1-'+maxItems+' items.');
  g.ruleItems.forEach((item:unknown,j:number)=>ruleItem(item,gat+'.ruleItems['+j+']'));
 });
}
/** Record checks after the generic field checks: an open rule-based list with explicit operators and lookback windows. */
export function assertGoogleUserListRecord(kind:string,r:JsonObject,creating:boolean):void{
 if(kind!=='userLists')return;
 if(r.description!==undefined&&(typeof r.description!=='string'||[...r.description].length>1024||/[\u0000\r\n]/.test(r.description)))invalid('description must be at most 1024 characters without line breaks.');
 if(r.membershipStatus!==undefined&&!(creating?['OPEN']:['OPEN','CLOSED']).includes(r.membershipStatus))invalid(creating?'Create the list OPEN; a CLOSED list collects no one.':'membershipStatus must be OPEN or CLOSED.');
 if(!creating)return;
 const rb=r.ruleBasedUserList;
 if(!obj(rb))invalid('ruleBasedUserList must be an object.');
 keys(rb,['prepopulationStatus','flexibleRuleUserList'],'ruleBasedUserList');
 if(rb.prepopulationStatus!==undefined&&rb.prepopulationStatus!=='REQUESTED')invalid('prepopulationStatus is REQUESTED (include matching visitors from the last 30 days, Display only) or omitted.');
 const f=rb.flexibleRuleUserList;
 if(!obj(f))invalid('ruleBasedUserList.flexibleRuleUserList is required.');
 keys(f,['inclusiveRuleOperator','inclusiveOperands','exclusiveOperands'],'flexibleRuleUserList');
 if(f.inclusiveRuleOperator!=='AND'&&f.inclusiveRuleOperator!=='OR')invalid('flexibleRuleUserList.inclusiveRuleOperator must be AND or OR.');
 if(!Array.isArray(f.inclusiveOperands)||!f.inclusiveOperands.length||f.inclusiveOperands.length>maxOperands)invalid('flexibleRuleUserList.inclusiveOperands must hold 1-'+maxOperands+' operands.');
 if(f.exclusiveOperands!==undefined&&(!Array.isArray(f.exclusiveOperands)||f.exclusiveOperands.length>maxOperands))invalid('flexibleRuleUserList.exclusiveOperands holds at most '+maxOperands+' operands.');
 f.inclusiveOperands.forEach((o:unknown,i:number)=>operand(o,'inclusiveOperands['+i+']'));
 (f.exclusiveOperands??[]).forEach((o:unknown,i:number)=>operand(o,'exclusiveOperands['+i+']'));
}
/** For updates: the existing list is a rule-based list this account can edit. */
export function validateGoogleUserListState(found:JsonObject):void{
 if(found.readOnly===true)throw new MirrorError('INVALID_GOOGLE_USER_LIST','This user list is read-only for the account (shared or external).');
 if(found.type!==undefined&&found.type!=='RULE_BASED')throw new MirrorError('INVALID_GOOGLE_USER_LIST','Only rule-based user lists are edited under this contract; this list is '+found.type+'.');
}
function item(v:JsonObject):JsonObject{
 const out:JsonObject={name:v.name};
 if(obj(v.stringRuleItem))out.stringRuleItem={operator:v.stringRuleItem.operator,value:v.stringRuleItem.value};
 if(obj(v.numberRuleItem))out.numberRuleItem={operator:v.numberRuleItem.operator,value:Number(v.numberRuleItem.value)};
 if(obj(v.dateRuleItem))out.dateRuleItem={operator:v.dateRuleItem.operator,...(v.dateRuleItem.value!==undefined?{value:v.dateRuleItem.value}:{}),...(v.dateRuleItem.offsetInDays!==undefined?{offsetInDays:String(v.dateRuleItem.offsetInDays)}:{})};
 return out;
}
function operandCanonical(o:JsonObject):JsonObject{
 const r=obj(o.rule)?o.rule:{};
 return {lookbackWindowDays:o.lookbackWindowDays===undefined?null:String(o.lookbackWindowDays),rule:{ruleType:r.ruleType??'OR_OF_ANDS',ruleItemGroups:(Array.isArray(r.ruleItemGroups)?r.ruleItemGroups:[]).map((g:JsonObject)=>({ruleItems:(Array.isArray(g?.ruleItems)?g.ruleItems:[]).map(item).sort(order)})).sort(order)}};
}
/**
 * The list in comparable form, for sent and read values alike: operands, groups and items as sets (AND and OR do not
 * depend on order), 64-bit numbers as strings, the documented OR_OF_ANDS default, empty exclusions as absent, and any
 * prepopulation outcome as the request that caused it. Only fields present are changed. Idempotent.
 */
export function googleUserListCanonical(value:unknown):any{
 if(!obj(value))return value;
 const out:JsonObject={...value},rb=out.ruleBasedUserList;
 if(obj(rb)){
  const c:JsonObject={...rb};
  if(['REQUESTED','FINISHED','FAILED'].includes(c.prepopulationStatus))c.prepopulationStatus='REQUESTED';
  if(obj(c.flexibleRuleUserList)){
   const f:JsonObject={...c.flexibleRuleUserList};
   for(const k of ['inclusiveOperands','exclusiveOperands']){if(Array.isArray(f[k])&&f[k].length)f[k]=f[k].map(operandCanonical).sort(order);else delete f[k];}
   c.flexibleRuleUserList=f;
  }
  out.ruleBasedUserList=c;
 }
 return out;
}
export function googleUserListImpact(body:JsonObject):JsonObject{
 const ops=(Array.isArray(body.operations)?body.operations:[]) as JsonObject[];
 const lists=ops.map(op=>{const r=op.create??op.update??{},f=r.ruleBasedUserList?.flexibleRuleUserList;return {operation:op.create?'create':'update',name:r.name??null,...(f?{inclusive_rules:f.inclusiveOperands?.length??0,inclusive_rule_operator:f.inclusiveRuleOperator,exclusive_rules:f.exclusiveOperands?.length??0,lookback_window_days:(f.inclusiveOperands??[]).map((o:JsonObject)=>Number(o.lookbackWindowDays))}:{}),...(r.ruleBasedUserList?.prepopulationStatus==='REQUESTED'?{prepopulation:'Matching visitors from the last 30 days are added (Display Network only).'}:{}),...(r.membershipStatus!==undefined?{membership_status:r.membershipStatus}:{})};});
 return {provider:'google',scope:'userLists',may_affect_serving:ops.some(op=>op.update?.membershipStatus==='CLOSED'),
  effect:'Creates or edits rule-based remarketing lists. Lists collect visitors through the Google tag; nothing is targeted until a campaign or ad group criterion uses the list. Closing a list stops it collecting and it can no longer be targeted.',
  lists,verification:'Exact selected-customer user list read-back; list size, tag installation and eligibility are not claimed.',source:'https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/website-visitors'};
}
