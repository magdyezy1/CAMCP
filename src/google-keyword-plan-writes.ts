import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {stable,sha256} from './security.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type PlanningResource={resource:string;fields:string[];parent?:{field:string;collection:string}};
export const keywordPlanResources:Record<string,PlanningResource>={
 keywordPlans:{resource:'keyword_plan',fields:['name','forecast_period']},
 keywordPlanCampaigns:{resource:'keyword_plan_campaign',fields:['name','keyword_plan','cpc_bid_micros','keyword_plan_network','geo_targets','language_constants'],parent:{field:'keywordPlan',collection:'keywordPlans'}},
 keywordPlanAdGroups:{resource:'keyword_plan_ad_group',fields:['name','keyword_plan_campaign','cpc_bid_micros'],parent:{field:'keywordPlanCampaign',collection:'keywordPlanCampaigns'}},
 keywordPlanAdGroupKeywords:{resource:'keyword_plan_ad_group_keyword',fields:['keyword_plan_ad_group','text','match_type','negative','cpc_bid_micros'],parent:{field:'keywordPlanAdGroup',collection:'keywordPlanAdGroups'}},
 keywordPlanCampaignKeywords:{resource:'keyword_plan_campaign_keyword',fields:['keyword_plan_campaign','text','match_type','negative'],parent:{field:'keywordPlanCampaign',collection:'keywordPlanCampaigns'}}
};
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const invalid=(message:string):never=>{throw new MirrorError('INVALID_CONFIGURATION_MUTATION',message);};
const failed=(message:string):never=>{throw new MirrorError('STATE_READ_FAILED',message,{},502);};
const camel=(s:string)=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
const keys=(value:JsonObject,allowed:string[])=>{if(Object.keys(value).some(k=>!allowed.includes(k)))invalid('Unqualified keyword-planning field.');};
export function keywordPlanKind(p:CompiledRequest):string|undefined{const k=p.path.match(/^\/v23\/customers\/\d+\/([^/]+):mutate$/)?.[1];return p.gateway==='google_ads_native_action'&&p.method==='POST'&&(!p.origin||p.origin==='https://googleads.googleapis.com')&&k&&Object.hasOwn(keywordPlanResources,k)?k:undefined;}
function bid(v:unknown){if(!(typeof v==='string'&&/^[1-9][0-9]*$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>0)||BigInt(v as string)>(1n<<63n)-1n)invalid('Planning CPC bids must be positive native micros, as decimal strings or safe integers.');}
export function keywordPlanClear(kind:string,field:string,value:unknown):boolean{return value===null&&(field==='forecastPeriod'&&kind==='keywordPlans'||field==='cpcBidMicros'&&['keywordPlanAdGroups','keywordPlanAdGroupKeywords'].includes(kind));}
export function assertKeywordPlanRecord(kind:string,r:JsonObject,creating:boolean):void{
 if(!keywordPlanResources[kind])return;
 if(r.forecastPeriod!==undefined&&r.forecastPeriod!==null){
  const f=r.forecastPeriod;if(!object(f))invalid('forecastPeriod must be a native object or explicit null to clear it.');keys(f,['dateInterval','dateRange']);
  if(Object.keys(f).length!==1)invalid('Select one forecast dateInterval or dateRange.');
  if(f.dateInterval!==undefined&&!['NEXT_WEEK','NEXT_MONTH','NEXT_QUARTER'].includes(f.dateInterval))invalid('Use a documented relative forecast interval.');
  if(f.dateRange!==undefined){const range=f.dateRange;if(!object(range))invalid('dateRange must be an object.');keys(range,['startDate','endDate']);
   const valid=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
   if(!valid(range.startDate)||!valid(range.endDate)||range.endDate<range.startDate)invalid('Use real inclusive YYYY-MM-DD dates in ascending order.');
   const anniversary=new Date(range.startDate+'T00:00:00Z');anniversary.setUTCFullYear(anniversary.getUTCFullYear()+1);
   if(Date.parse(range.endDate+'T00:00:00Z')>=anniversary.getTime())invalid('An inclusive forecast date range cannot exceed one year.');
   // Google validates future dates when forecasting, not when editing a saved plan.
   // An expired plan remains editable; no local UTC date is substituted for its locale.
  }
 }
 if(r.cpcBidMicros!==undefined&&r.cpcBidMicros!==null)bid(r.cpcBidMicros);
 if(r.cpcBidMicros===null&&(creating||kind==='keywordPlanCampaigns'))invalid('Only updates can clear an optional group or keyword CPC override.');
 if(r.keywordPlanNetwork!==undefined&&!['GOOGLE_SEARCH','GOOGLE_SEARCH_AND_PARTNERS'].includes(r.keywordPlanNetwork))invalid('Choose Google Search or Google Search and partners.');
 if(r.geoTargets!==undefined){if(!Array.isArray(r.geoTargets)||r.geoTargets.length>20)invalid('Use at most 20 planning geo targets.');for(const target of r.geoTargets){if(!object(target))invalid('geoTargets requires native objects.');keys(target,['geoTargetConstant']);if(typeof target.geoTargetConstant!=='string'||!/^geoTargetConstants\/[1-9][0-9]*$/.test(target.geoTargetConstant))invalid('Use exact geoTargetConstants resources.');}if(new Set(r.geoTargets.map((v:JsonObject)=>v.geoTargetConstant)).size!==r.geoTargets.length)invalid('Planning geo targets must be unique.');}
 if(r.languageConstants!==undefined&&(!Array.isArray(r.languageConstants)||r.languageConstants.length>1||r.languageConstants.some((v:unknown)=>typeof v!=='string'||!/^languageConstants\/[1-9][0-9]*$/.test(v))))invalid('Use at most one exact languageConstants resource.');
 if(r.matchType!==undefined&&!['BROAD','PHRASE','EXACT'].includes(r.matchType))invalid('Use BROAD, PHRASE or EXACT for planning keywords.');
 if(r.text!==undefined&&(typeof r.text!=='string'||!r.text.trim()||/[\u0000\r\n]/.test(r.text)||[...r.text].length>80))invalid('Keyword text must contain 1–80 characters without line breaks.');
 if(r.negative!==undefined&&typeof r.negative!=='boolean')invalid('negative must be a boolean.');
 if(creating&&kind==='keywordPlanCampaignKeywords'&&r.negative!==true)invalid('Campaign-level planning keywords must be negative=true.');
 if(kind==='keywordPlanAdGroupKeywords'&&r.negative===true&&r.cpcBidMicros!==undefined)invalid('Negative planning keywords cannot specify a CPC override.');
}
/** Membership arrays have set semantics; other arrays retain their order. */
export function keywordPlanCanonical(value:unknown,key=''):any{
 if(Array.isArray(value)){const items=value.map(v=>keywordPlanCanonical(v));return ['geoTargets','languageConstants'].includes(key)?items.sort((a,b)=>stable(a).localeCompare(stable(b),'en')):items;}
 if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='cpcBidMicros'&&v!==null?String(v):keywordPlanCanonical(v,k)]));return value;
}
export function keywordPlanObserved(resource:string,value:JsonObject):JsonObject{
 if(!object(value)||!resource.startsWith('keyword_plan'))return value;
 const out=keywordPlanCanonical(value);
 if(resource==='keyword_plan')out.forecastPeriod??=null;
 if(resource==='keyword_plan_campaign'){out.geoTargets??=[];out.languageConstants??=[];}
 if(['keyword_plan_ad_group','keyword_plan_ad_group_keyword'].includes(resource))out.cpcBidMicros??=null;
 if(resource.endsWith('_keyword'))out.negative??=false;
 return out;
}
export const keywordPlanFieldHashes=(value:JsonObject,fields:string[])=>Object.fromEntries(fields.map(field=>[field,sha256(stable(value[field]??null))]));
function name(p:CompiledRequest,value:unknown,collection?:string):string{
 const account=p.accountId!.replaceAll('-',''),match=typeof value==='string'?new RegExp('^customers/'+account+'/([^/]+)/[1-9][0-9]*$').exec(value):null;
 if(!match||!keywordPlanResources[match[1]!]||collection&&match[1]!==collection)failed('Keyword planning returned a malformed or foreign resource identity.');return value as string;
}
function search(p:CompiledRequest,collection:string,field:string,values:string[]):CompiledRequest{
 const c=keywordPlanResources[collection]!,query='SELECT '+['resource_name',...c.fields].map(f=>c.resource+'.'+f).join(', ')+' FROM '+c.resource+' WHERE '+c.resource+'.'+field+' IN ('+values.map(n=>"'"+n+"'").join(', ')+')';
 return {...p,action:'AMCP_KEYWORD_PLAN_READ',path:'/v23/customers/'+p.accountId!.replaceAll('-','')+'/googleAds:search',method:'POST',body:{query},query:{},headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,googleState:undefined,googleKeywordPlanState:undefined};
}
export function keywordPlanSnapshots(p:CompiledRequest):CompiledRequest[]{
 const kind=keywordPlanKind(p);if(!kind)return [];const c=keywordPlanResources[kind]!,seeds=new Set<string>();
 for(const op of googleJson(p.body).operations){const r=op.create??op.update;if(op.remove??op.update?.resourceName)seeds.add(op.remove??op.update.resourceName);if(c.parent&&r?.[c.parent.field])seeds.add(r[c.parent.field]);}
 const names=[...seeds].sort();if(!names.length)return [];
 return [{...search(p,kind,'resource_name',names),googleKeywordPlanState:{names}}];
}
export async function readKeywordPlanTree(read:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 if(!read.googleKeywordPlanState)return request(read);
 let requests=0,bytes=0;
 const query=async(collection:string,field:string,ids:string[]):Promise<JsonObject[]>=>{
  const c=keywordPlanResources[collection]!,rows:JsonObject[]=[],seen=new Set<string>();
  for(let start=0;start<ids.length;start+=100){const chunk=ids.slice(start,start+100),tokens=new Set<string>();let token:string|undefined;
   for(let page=0;page<100;page++){
    if(++requests>300)failed('The planning snapshot exceeds 300 provider requests.');
    const p=search(read,collection,field,chunk);if(token)(p.body as JsonObject).pageToken=token;
    const result=await request(p),d=result.data as JsonObject;
    if(result.status!==200||!object(d)||Object.keys(d).some(k=>/error|fail/i.test(k)&&d[k]!=null)||d.success===false||d.hasMore===true||d.has_more===true||d.results!==undefined&&!Array.isArray(d.results)||d.nextPageToken!==undefined&&typeof d.nextPageToken!=='string')failed('Keyword planning returned an incomplete or failed response.');
    bytes+=Buffer.byteLength(JSON.stringify(d));if(bytes>32*1024*1024)failed('The planning snapshot exceeds 32 MiB of provider responses.');
    for(const row of d.results??[]){const v=row?.[camel(c.resource)];if(!object(v))failed('The planning response omitted its native resource.');name(read,v.resourceName,collection);
     if(seen.has(v.resourceName)||!chunk.includes(v[camel(field)]))failed('Planning rows must have unique identities and exactly requested parent bindings.');
     if(c.parent)name(read,v[c.parent.field],c.parent.collection);
     if(c.fields.includes('name')&&(typeof v.name!=='string'||!v.name.trim()))failed('The planning response omitted the resource name.');
     if(collection.endsWith('Keywords')&&(typeof v.text!=='string'||!v.text||!['BROAD','PHRASE','EXACT'].includes(v.matchType)||v.negative!==undefined&&typeof v.negative!=='boolean'))failed('The planning response omitted keyword configuration.');
     if(collection==='keywordPlanCampaignKeywords'&&v.negative!==true)failed('A campaign planning keyword must be negative.');
     if(collection==='keywordPlanCampaigns'&&(!['GOOGLE_SEARCH','GOOGLE_SEARCH_AND_PARTNERS'].includes(v.keywordPlanNetwork)||v.cpcBidMicros===undefined))failed('The planning response omitted required campaign configuration.');
     try{assertKeywordPlanRecord(collection,v,false);}catch{failed('The planning response contains malformed native configuration.');}
     seen.add(v.resourceName);rows.push(keywordPlanObserved(c.resource,v));if(rows.length>15000)failed('The planning snapshot exceeds 15,000 resources.');
    }
    if(!d.nextPageToken)break;
    if(tokens.has(d.nextPageToken)||page===99)failed('Planning pagination repeats a cursor or exceeds 100 pages.');tokens.add(d.nextPageToken);token=d.nextPageToken;
   }
  }
  return rows.sort((a,b)=>a.resourceName.localeCompare(b.resourceName,'en'));
 };
 const initial=new Map<string,JsonObject>(),roots=new Set<string>();
 const load=async(id:string)=>{name(read,id);if(initial.has(id))return initial.get(id)!;const collection=id.split('/')[2]!,rows=await query(collection,'resource_name',[id]);if(rows.length!==1)failed('An exact keyword-planning prerequisite is missing.');initial.set(id,rows[0]!);return rows[0]!;};
 for(const seed of read.googleKeywordPlanState.names){let id=seed;
  for(let depth=0;depth<4;depth++){const value=await load(id),collection=id.split('/')[2]!,parent=keywordPlanResources[collection]!.parent;if(!parent){roots.add(id);break;}id=name(read,value[parent.field],parent.collection);}
 }
 const snapshot=async()=>{
  const plans=await query('keywordPlans','resource_name',[...roots]);if(plans.length!==roots.size)failed('A keyword plan disappeared during review.');
  const campaigns=await query('keywordPlanCampaigns','keyword_plan',plans.map(v=>v.resourceName));
  const groups=await query('keywordPlanAdGroups','keyword_plan_campaign',campaigns.map(v=>v.resourceName));
  const negatives=await query('keywordPlanCampaignKeywords','keyword_plan_campaign',campaigns.map(v=>v.resourceName));
  const keywords=await query('keywordPlanAdGroupKeywords','keyword_plan_ad_group',groups.map(v=>v.resourceName));
  const resources=[...plans,...campaigns,...groups,...negatives,...keywords].sort((a,b)=>a.resourceName.localeCompare(b.resourceName,'en'));
  if(resources.length>15000)failed('The planning snapshot exceeds 15,000 resources.');
  return {roots:[...roots].sort(),resources};
 };
 const first=await snapshot();for(const [id,value]of initial)if(stable(first.resources.find(v=>v.resourceName===id))!==stable(value))throw new MirrorError('STATE_CHANGED','The planning hierarchy changed while prerequisites were read. Prepare again.');
 if(stable(first)!==stable(await snapshot()))throw new MirrorError('STATE_CHANGED','The keyword plan changed while its complete hierarchy was read. Prepare again.');
 const data={amcpKeywordPlanTree:first};if(Buffer.byteLength(JSON.stringify(data))>16*1024*1024)failed('The retained planning snapshot exceeds 16 MiB.');
 return {status:200,headers:{},data};
}
export function validateKeywordPlanTree(read:CompiledRequest,result:TransportResult):void{
 const tree=(result.data as JsonObject)?.amcpKeywordPlanTree;
 if(result.status!==200||!read.googleKeywordPlanState||!object(tree)||!Array.isArray(tree.roots)||!Array.isArray(tree.resources)||read.googleKeywordPlanState.names.some(n=>!tree.resources.some((v:JsonObject)=>v.resourceName===n)))failed('The full reviewed keyword-planning hierarchy is missing.');
}
export function validateKeywordPlanPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=keywordPlanKind(p);if(!kind)return;const ops=googleJson(p.body).operations as JsonObject[],tree=(states as JsonObject[]).find(s=>s?.amcpKeywordPlanTree)?.amcpKeywordPlanTree,resources:JsonObject[]=tree?.resources??[];
 const old=(id:string)=>resources.find(v=>v.resourceName===id);
 for(const state of states as JsonObject[])for(const row of state?.results??[])for(const value of Object.values(row) as JsonObject[]){const collection=value?.resourceName?.split('/')[2],c=keywordPlanResources[collection];if(c&&stable(keywordPlanObserved(c.resource,value))!==stable(old(value.resourceName)))throw new MirrorError('STATE_CHANGED','Planning prerequisites changed between the target and full hierarchy reads. Prepare again.');}
 for(const op of ops){const value=op.create??op.update??{},prior=old(op.update?.resourceName??op.remove);
  if(kind==='keywordPlanAdGroupKeywords'&&(prior?.negative===true||value.negative===true)&&value.cpcBidMicros!==undefined)invalid('Negative planning keywords cannot set or clear a CPC override.');
 }
 if(kind==='keywordPlanCampaigns'){
  const counts=new Map<string,number>();for(const v of resources)if(v.resourceName.split('/')[2]==='keywordPlanCampaigns')counts.set(v.keywordPlan,(counts.get(v.keywordPlan)??0)+1);
  for(const op of ops){const prior=old(op.remove??op.update?.resourceName),next=op.create??op.update;if(prior&&(op.remove||next?.keywordPlan)){counts.set(prior.keywordPlan,(counts.get(prior.keywordPlan)??0)-1);}if(op.create||op.update?.keywordPlan)counts.set(next.keywordPlan,(counts.get(next.keywordPlan)??0)+1);}
  if([...counts.values()].some(n=>n>1))invalid('A saved keyword plan can contain only one campaign. Review its existing campaign or an atomic replacement.');
 }
}
