import {MirrorError} from './errors.js';
import {parseLinkedInValue} from './linkedin-restli.js';
import {linkedinConversionConfiguration} from './linkedin-conversion-state.js';
import {assertLinkedInConversionScope} from './linkedin-conversion-links.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type RuleRead=CompiledRequest&{linkedinRuleState?:{all:boolean;ids:string[];parents:boolean;tag:boolean};linkedinRulePage?:true};
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v:unknown,keys:string[]):v is JsonObject=>object(v)&&Object.keys(v).every(k=>keys.includes(k));
const fail=(message:string,code='INVALID_CONVERSION_RULE'):never=>{throw new MirrorError(code,message);};
const stateFail=(message:string):never=>fail(message,'CONVERSION_RULE_STATE_UNVERIFIED');
const id=(v:unknown):string=>{if(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)v=String(v);if(typeof v!=='string'||!/^[1-9][0-9]{0,19}$/.test(v))fail('Use exact positive conversion/account IDs; unsafe numbers are not accepted.');return v as string;};
const account=(p:CompiledRequest)=>id(p.accountId),accountUrn=(p:CompiledRequest)=>'urn:li:sponsoredAccount:'+account(p);
const single=(p:CompiledRequest)=>p.path!=='/rest/conversions';
const mode=(p:CompiledRequest)=>p.headers['X-RestLi-Method']??'CREATE';
const creating=(p:CompiledRequest)=>['CREATE','BATCH_CREATE'].includes(mode(p));
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&[...v].length<=max&&!/[\u0000-\u001f]/.test(v);
const fields=['name','type','enabled','postClickAttributionWindowSize','viewThroughAttributionWindowSize','attributionType','value','valueType','urlMatchRuleExpression'];
export function linkedinRuleKind(p:CompiledRequest):boolean{return p.gateway==='linkedin_native_action'&&!p.specialTransport&&(!p.origin||p.origin==='https://api.linkedin.com')&&p.method==='POST'&&/^\/rest\/conversions(?:\/[1-9][0-9]{0,19})?$/.test(p.path);}
function dataFields(value:unknown,create=false):JsonObject{
 if(!only(value,create?[...fields,'account']:fields)||!Object.keys(value).length)fail('Use documented conversion fields; account, campaign membership, callback data and nested patch operations are not mutable through this contract.');const v=value as JsonObject;
 if((create||v.name!==undefined)&&!text(v.name,256))fail('Conversion name must contain 1–256 characters.');
 if((create||v.type!==undefined)&&!['ADD_TO_CART','DOWNLOAD','INSTALL','KEY_PAGE_VIEW','LEAD','PURCHASE','SIGN_UP','OTHER'].includes(v.type))fail('Choose a documented Insight Tag conversion type.');
 if(v.enabled!==undefined&&typeof v.enabled!=='boolean')fail('enabled must be a boolean.');
 for(const field of ['postClickAttributionWindowSize','viewThroughAttributionWindowSize'])if(v[field]!==undefined&&![1,7,30].includes(v[field]))fail('Attribution windows must be 1, 7 or 30 days.');
 if(v.attributionType!==undefined&&!['LAST_TOUCH_BY_CAMPAIGN','LAST_TOUCH_BY_CONVERSION'].includes(v.attributionType))fail('Choose the documented attribution model.');
 if(v.valueType!==undefined&&!['DYNAMIC','FIXED','NO_VALUE'].includes(v.valueType))fail('Choose DYNAMIC, FIXED or NO_VALUE.');
 if(v.value!==undefined&&(!only(v.value,['amount','currencyCode'])||typeof v.value.amount!=='string'||!/^\d{1,20}(?:\.\d{1,9})?$/.test(v.value.amount)||typeof v.value.currencyCode!=='string'||!/^[A-Z]{3}$/.test(v.value.currencyCode)))fail('Conversion value requires a nonnegative decimal string and ISO currency code. This is reported value, not a budget.');
 if(v.urlMatchRuleExpression!==undefined){let terms=0;const expression=v.urlMatchRuleExpression;if(!Array.isArray(expression)||expression.length>25||expression.some(group=>!Array.isArray(group)||!group.length||group.some(rule=>{terms++;return !only(rule,['matchType','matchValue'])||!['EXACT','STARTS_WITH','CONTAINS'].includes(rule.matchType)||!text(rule.matchValue,2048);} ))||terms>100)fail('URL expressions have at most 25 OR groups/100 AND terms with exact native match types and literal text. Arrays replace the complete expression.');}
 return v;
}
function patch(v:unknown):JsonObject{if(!only(v,['patch'])||!only(v.patch,['$set']))fail('Partial updates require patch.$set with full replacement values.');return dataFields((v as JsonObject).patch.$set);}
export function ruleInputs(p:CompiledRequest):{ids:string[];values:JsonObject[]}{
 if(creating(p)){const rows=mode(p)==='BATCH_CREATE'?(only(p.body,['elements'])?p.body.elements:undefined):[p.body];if(!Array.isArray(rows)||!rows.length||rows.length>25)fail('Create 1–25 conversion rules per reviewed batch.');return {ids:[],values:(rows as unknown[]).map(v=>dataFields(v,true))};}
 if(single(p))return {ids:[id(p.path.split('/').at(-1))],values:[patch(p.body)]};
 let ids:unknown=p.query.ids;if(typeof ids==='string')ids=parseLinkedInValue(ids);if(!Array.isArray(ids)||!ids.length||ids.length>25)fail('Update 1–25 distinct conversion IDs.');const keys=(ids as unknown[]).map(id);
 if(new Set(keys).size!==keys.length||!only(p.body,['entities'])||!object(p.body.entities)||Object.keys(p.body.entities).length!==keys.length||Object.keys(p.body.entities).some(k=>!keys.includes(k)))fail('Batch query IDs and patch entity keys must match exactly.');return {ids:keys,values:keys.map(k=>patch((p.body as JsonObject).entities[k]))};
}
export function assertLinkedInRule(p:CompiledRequest){
 if(!linkedinRuleKind(p))return;const selected=accountUrn(p),m=mode(p);if(!['CREATE','BATCH_CREATE','PARTIAL_UPDATE','BATCH_PARTIAL_UPDATE'].includes(m)||single(p)!==(m==='PARTIAL_UPDATE'))fail('Use CREATE/BATCH_CREATE on the collection or explicit PARTIAL_UPDATE/BATCH_PARTIAL_UPDATE on the corresponding route.');
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))fail('Use versioned REST.li 2.0 without method tunneling.');
 if(Object.keys(p.query).some(k=>!['account',...(!creating(p)&&!single(p)?['ids']:[])].includes(k))||p.query.account!==undefined&&p.query.account!==selected||!creating(p)&&p.query.account!==selected)fail('Bind the request to its exact account. Automatic campaign association is a separate unqualified workflow.');
 const inputs=ruleInputs(p);if(creating(p))for(const row of inputs.values)if(row.account!==undefined&&row.account!==selected||row.account===undefined&&p.query.account!==selected)fail('Every created conversion needs the exact account in body or query.');
}
export function linkedinRuleServing(p:CompiledRequest):boolean{return linkedinRuleKind(p)&&(!creating(p)||ruleInputs(p).values.some(v=>v.enabled!==false));}
function read(p:CompiledRequest,path:string,query:JsonObject={}):RuleRead{return {...p,action:'AMCP_LINKEDIN_RULE_READ',method:'GET',path,query,body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0'},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,linkedinRuleState:undefined,linkedinRulePage:true};}
export function linkedinRuleSnapshots(p:CompiledRequest):RuleRead[]{return [{...read(p,'/rest/adAccounts/'+account(p)),linkedinRuleState:{all:creating(p),ids:ruleInputs(p).ids,parents:!creating(p),tag:creating(p)}}];}
export const isLinkedInRuleRead=(p:CompiledRequest):p is RuleRead=>!!(p as RuleRead).linkedinRuleState;
export function authorizeLinkedInRule(p:CompiledRequest,c:Connection,selected:string):boolean{
 if(linkedinRuleKind(p)){assertLinkedInRule(p);assertLinkedInConversionScope(c,true);return true;}
 if(!(p as RuleRead).linkedinRulePage||p.gateway!=='linkedin_native_action'||p.action!=='AMCP_LINKEDIN_RULE_READ'||p.method!=='GET'||!p.readOnly||p.body!==undefined)return false;
 assertLinkedInConversionScope(c);if(p.path==='/rest/adAccounts/'+selected||new RegExp('^/rest/adAccounts/'+selected+'/adCampaigns/[1-9][0-9]*$').test(p.path))return true;
 if(p.query.account!=='urn:li:sponsoredAccount:'+selected)fail('Internal rule reads require the exact sponsored account.','RESOURCE_SCOPE_REQUIRED');
 if(/^\/rest\/conversions\/[1-9][0-9]*$/.test(p.path)&&Object.keys(p.query).length===1)return true;
 if(['/rest/conversions','/rest/insightTags'].includes(p.path)&&p.query.q==='account'&&Object.keys(p.query).every(k=>['account','q','start','count'].includes(k)))return true;
 return fail('Unqualified internal conversion-rule read.','RESOURCE_SCOPE_REQUIRED');
}
function resource(row:JsonObject,p:CompiledRequest,want?:string):JsonObject{
 if(id(row.id)!==(want??id(row.id))||row.account!==accountUrn(p)||typeof row.name!=='string'||typeof row.enabled!=='boolean'||typeof row.type!=='string'||row.key!==undefined&&(!object(row.key)||id(row.key.id)!==id(row.id)||row.key.account!==row.account))stateFail('Conversion identity or account is missing, foreign or ambiguous.');
 // REST.li may omit a field with its documented default. Unlike omitted
 // identities or membership, absent valueType means DYNAMIC in this API version.
 return linkedinConversionConfiguration({valueType:'DYNAMIC',...row,id:id(row.id)});
}
export async function readLinkedInRules(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const shape=(p as RuleRead).linkedinRuleState;if(!shape)return request(p);const began=performance.now();let requests=0,bytes=0;
 const fetch=async(path:string,query:JsonObject={})=>{if(++requests>80||performance.now()-began>60000)stateFail('Conversion-rule state exceeded its request/time bound.');const r=await request(read(p,path,query)),v=r.data;if(r.status!==200||!object(v)||v.error!==undefined||v.errors!==undefined||v.warnings!==undefined||v.serviceErrorCode!==undefined||typeof v.status==='number')stateFail('A required rule read failed or returned an error.');const size=Buffer.byteLength(JSON.stringify(v));bytes+=size;if(size>4*1024*1024||bytes>8*1024*1024||performance.now()-began>60000)stateFail('Conversion-rule state exceeded its byte/time bound.');return v as JsonObject;};
 const list=async(path:string)=>{const rows:JsonObject[]=[];let start=0,total:number|undefined;for(let page=0;;page++){
  if(page>=25)stateFail('Complete conversion membership exceeded 25 pages.');const d=await fetch(path,{q:'account',account:accountUrn(p),start,count:100}),paging=d.paging;
  if(!only(d,['elements','paging','metadata'])||!Array.isArray(d.elements)||!only(paging,['start','count','total','links'])||paging.start!==start||!Number.isSafeInteger(paging.count)||paging.count<1||paging.count>100||d.elements.length>paging.count||!Array.isArray(paging.links)||paging.links.some((v:unknown)=>!object(v)||!['next','prev'].includes(v.rel)||typeof v.href!=='string')||d.metadata!==undefined&&(!object(d.metadata)||Object.keys(d.metadata).length))stateFail('Collection pagination is incomplete or unrecognized.');
  if(paging.total!==undefined){if(!Number.isSafeInteger(paging.total)||paging.total<0||total!==undefined&&total!==paging.total)stateFail('Collection total is invalid or changed.');total=paging.total;}
  for(const row of d.elements){if(!object(row)||row.error!==undefined||row.errors!==undefined||row.serviceErrorCode!==undefined)stateFail('A collection contains a failed resource.');rows.push(row);}if(rows.length>1000)stateFail('Complete conversion reads support at most 1000 records.');
  const next=paging.links.some((v:JsonObject)=>v.rel==='next');if(!d.elements.length&&next)stateFail('A next page cannot follow an empty page.');if(total!==undefined){if(start+d.elements.length>total||start+d.elements.length===total&&next)stateFail('Collection pagination disagrees with its count.');if(start+d.elements.length===total)break;if(!d.elements.length)stateFail('Collection ended before its declared total.');}else if(!next&&d.elements.length<paging.count)break;start+=paging.count;
 }if(total!==undefined&&rows.length!==total)stateFail('The required collection is incomplete.');return rows;};
 const selected=await fetch('/rest/adAccounts/'+account(p));if(id(selected.id)!==account(p)||typeof selected.currency!=='string'||typeof selected.status!=='string')stateFail('Account identity, currency and status are required.');
 const tags=shape.tag?await list('/rest/insightTags'):[];if(shape.tag){const tag=tags[0];if(tags.length!==1||!tag||!Array.isArray(tag.sponsoredAccounts)||!tag.sponsoredAccounts.includes(accountUrn(p))||tag.sponsoredAccounts.some((v:unknown)=>typeof v!=='string'||!/^urn:li:sponsoredAccount:[1-9][0-9]{0,19}$/.test(v))||new Set(tag.sponsoredAccounts).size!==tag.sponsoredAccounts.length)stateFail('Creation requires one existing Insight Tag associated with this account. Installing or sharing a tag is a separate workflow.');id(tag!.id);tag!.sponsoredAccounts=[...tag!.sponsoredAccounts].sort();}
 const rules:JsonObject={},campaigns:JsonObject={};
 const rows=shape.all?await list('/rest/conversions'):[];if(!shape.all)for(const target of shape.ids)rows.push(resource(await fetch('/rest/conversions/'+target,{account:accountUrn(p)}),p,target));
 for(const row of rows){const config=resource(row,p);if(Object.hasOwn(rules,config.id))stateFail('Duplicate conversion identity.');rules[config.id]=config;}
 if(shape.parents){const ids=new Set<string>();for(const row of Object.values(rules)){if(!Array.isArray(row.campaigns)||!Array.isArray(row.associatedCampaigns))stateFail('Update review requires explicit complete campaign membership.');for(const c of row.campaigns)ids.add(c);}if(ids.size>50)stateFail('Rule updates affect more than 50 campaigns. Full account impact cannot fit this review.');for(const c of [...ids].sort()){const row=await fetch('/rest/adAccounts/'+account(p)+'/adCampaigns/'+c.split(':').at(-1));if(id(row.id)!==c.split(':').at(-1)||row.account!==accountUrn(p)||typeof row.status!=='string'||typeof row.name!=='string')stateFail('An affected campaign is foreign or incomplete.');campaigns[c]=row;}}
 return {status:200,headers:{},data:{account:selected,tags,rules,campaigns}};
}
export function validateLinkedInRuleState(p:CompiledRequest,r:TransportResult){if(!isLinkedInRuleRead(p)||r.status!==200||!object(r.data)||id(r.data.account?.id)!==account(p)||!object(r.data.rules)||!object(r.data.campaigns)||!Array.isArray(r.data.tags))stateFail('Complete conversion-rule state is missing.');}
export function linkedinRulePrerequisites(p:CompiledRequest,states:unknown[]){if(!linkedinRuleKind(p))return;const s=states[0] as JsonObject,inputs=ruleInputs(p);if(creating(p)&&Object.keys(s.rules).length+inputs.values.length>1000)fail('Creation would exceed complete conversion read-back capacity.');for(const [i,v]of inputs.values.entries()){const proposed={...(!creating(p)?s.rules[inputs.ids[i]!]:{}),...v};if(proposed.value?.currencyCode!==undefined&&proposed.value.currencyCode!==s.account.currency)fail('Conversion value currency must match the selected account.');if(proposed.valueType==='FIXED'&&!proposed.value)fail('FIXED conversions require a stated monetary value.');}}
function receiptIds(p:CompiledRequest,r:TransportResult):string[]{
 const inputs=ruleInputs(p);if(!creating(p)){
  if(single(p)){if(r.status!==204||r.data!=null&&(!object(r.data)||Object.keys(r.data).length))fail('Partial update requires its native empty 204 receipt.');return inputs.ids;}
  if(r.status!==200||!only(r.data,['results','errors'])||!object(r.data.results)||r.data.errors!==undefined&&(!object(r.data.errors)||Object.keys(r.data.errors).length)||Object.keys(r.data.results).length!==inputs.ids.length||Object.entries(r.data.results).some(([k,v])=>!inputs.ids.includes(k)||!only(v,['status'])||v.status!==204))fail('Batch update returned incomplete or failed per-ID receipts.');return inputs.ids;
 }
 if(mode(p)==='CREATE'){const created=id(r.headers['x-restli-id']);if(r.status!==201||r.data!=null&&(!object(r.data)||Object.keys(r.data).length&&(id(r.data.id)!==created||r.data.account!==accountUrn(p))||r.data.error!==undefined||r.data.errors!==undefined))fail('Creation returned an invalid identity receipt.');return [created];}
 if(r.status!==200||!only(r.data,['elements'])||!Array.isArray(r.data.elements)||r.data.elements.length!==inputs.values.length)fail('Batch creation returned an incomplete receipt.');const result=(r.data as JsonObject).elements.map((v:unknown)=>{if(!only(v,['id','status','location','entity'])||v.status!==201)fail('A batch creation entry failed.');const entry=v as JsonObject,created=id(entry.id);if(entry.entity!==undefined&&(!object(entry.entity)||id(entry.entity.id)!==created||entry.entity.account!==accountUrn(p)||entry.entity.error!==undefined||entry.entity.errors!==undefined||entry.entity.serviceErrorCode!==undefined))fail('A batch receipt contains a foreign or failed entity.');if(entry.location!==undefined&&entry.location!=='/conversions/'+created&&entry.location!=='/rest/conversions/'+created)fail('Unexpected created conversion location.');return created;});if(new Set(result).size!==result.length)fail('Batch creation returned duplicate IDs.');return result;
}
export function linkedinRuleOutcome(p:CompiledRequest,r:TransportResult):boolean{try{receiptIds(p,r);return true;}catch{return false;}}
export function linkedinRuleVerification(p:CompiledRequest,result:JsonObject,before:unknown[]){
 const ids=receiptIds(p,result as TransportResult),inputs=ruleInputs(p),old=before[0] as JsonObject;if(creating(p)&&ids.some(key=>Object.hasOwn(old.rules,key)))fail('The creation receipt points at a pre-existing conversion.','VERIFICATION_UNSUPPORTED');
 return ids.map((target,index)=>{const v=inputs.values[index]!,defaults=creating(p)?{enabled:true,attributionType:'LAST_TOUCH_BY_CAMPAIGN',postClickAttributionWindowSize:30,viewThroughAttributionWindowSize:7,valueType:'DYNAMIC',campaigns:[],associatedCampaigns:[]}:{};return {read:{...read(p,'/rest/adAccounts/'+account(p)),linkedinRuleState:{all:false,ids:[target],parents:false,tag:false}},expected:{rules:{[target]:linkedinConversionConfiguration({...defaults,...v,id:target,account:accountUrn(p)})}},id:target};});
}
export const linkedinRuleImpact={provider:'linkedin',scope:'conversion_rules',may_affect_serving:true,effect:'Creates Insight Tag conversion rules or changes attribution windows, matching, value and enablement for existing rules. Updates affect all associated campaigns; conversion value is reporting value, not spend.',verification:'Account-scoped rule reads verify every requested field and new identity. Verification cannot establish website tag installation or actual event collection.',recovery:'Preserve the original claim after timeout or partial receipt; reconcile each conversion ID without resubmitting uncertain creation. Campaign links are a separate reviewed operation.'};
