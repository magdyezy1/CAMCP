import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Meta split tests, Marketing API v25.0 ("Ad Study" reference, updated 2026-03-24; "Split Testing" guide, updated
 * 2026-08-14; checked 2026-09-28). POST /{business_id}/ad_studies with type SPLIT_TEST, name, description, start_time and
 * end_time (Unix seconds) and cells [{name, treatment_percentage, adsets | campaigns}] creates a study that splits the
 * audience between the cells; "treatment_percentage for each cell should be at least 10", "the sum ... should be less or
 * equal to 100", "Each cell must have at least one object associated with it"; an advertiser runs at most 100 concurrent
 * studies. POST /{ad_study_id} updates a study: "Once the study runs, you cannot update start_time, treatment_percentage
 * for cells ... However, you can update end_time to the future time if the study is not yet ended." Lift studies need Meta,
 * and creative tests (SPLIT_TEST_V2 with a test budget) stay out: the reference allows 2–5 cells, the guide 2–7.
 */
type Kind='create'|'update';
type State={kind:'create';level:'adsets'|'campaigns';ids:string[]}|{kind:'update';study:string}|{kind:'verify';study:string};
type Read=CompiledRequest&{metaStudyState?:State;metaStudyPage?:true;metaStudyId?:string};
const gateway='meta_native_action',marker='AMCP_META_STUDY_READ',createAction='meta_business_id_ad_studies_create',updateAction='meta_ad_study_id_update';
// AMCP's review bounds: every named ad set or campaign is read with its studies, so a review reads at most 2×20 of them.
const maxCells=10,maxPerCell=10,maxEntities=20,minPercent=10,nameMax=255,descriptionMax=1000;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/.test(v);
const account=(v:unknown)=>String(v??'').replace(/^act_/,'');
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_META_SPLIT_TEST',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
const target=(p:CompiledRequest)=>/^\/v25\.0\/([1-9][0-9]{0,31})(?:\/ad_studies)?$/.exec(p.path)?.[1];
export function metaSplitTestKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.method!=='POST'||p.specialTransport)return;
 if(p.action===createAction&&/^\/v25\.0\/[1-9][0-9]{0,31}\/ad_studies$/.test(p.path))return 'create';
 if(p.action===updateAction&&/^\/v25\.0\/[1-9][0-9]{0,31}$/.test(p.path))return 'update';
 return;
}
const body=(p:CompiledRequest):JsonObject=>object(p.body)?p.body:{};
/** Unix seconds as sent (a number or digit string), or undefined. */
function seconds(v:unknown):number|undefined{const n=typeof v==='number'?v:typeof v==='string'&&/^[0-9]{9,11}$/.test(v)?Number(v):NaN;return Number.isSafeInteger(n)&&n>=1e9&&n<1e11?n:undefined;}
function text(v:unknown,label:string,max:number):void{if(typeof v!=='string'||!v.trim()||v!==v.trim()||[...v].length>max||/[\u0000-\u001f\u007f]/.test(v))invalid(label+' has 1–'+max+' characters without leading or trailing spaces.');}
const cellsOf=(p:CompiledRequest)=>body(p).cells as JsonObject[];
const levelOf=(p:CompiledRequest):'adsets'|'campaigns'=>Array.isArray(cellsOf(p)[0]?.adsets)?'adsets':'campaigns';
const idsOf=(p:CompiledRequest)=>cellsOf(p).flatMap(c=>(c[levelOf(p)] as unknown[]).map(String)).sort();
export function assertMetaSplitTest(p:CompiledRequest):void{
 const kind=metaSplitTestKind(p);if(!kind)return;
 if(!/^[1-9][0-9]{0,31}$/.test(account(p.accountId)))invalid('Select the ad account whose ad sets or campaigns the study splits.');
 if(Object.keys(p.query).length)invalid('A study request takes no query parameters.');
 const b=p.body;if(!object(b))invalid('Send the study as a native object body.');
 if(kind==='update'){
  const extra=Object.keys(b).filter(k=>!['name','description','end_time'].includes(k));
  if(!Object.keys(b).length||extra.length)invalid('A study update sets name, description and/or end_time'+(extra.length?'; not '+extra.join(', '):'')+'. Cells, percentages and start_time stay as they are.');
  if(b.name!==undefined)text(b.name,'name',nameMax);
  if(b.description!==undefined)text(b.description,'description',descriptionMax);
  if(b.end_time!==undefined&&seconds(b.end_time)===undefined)invalid('end_time is a Unix time in seconds.');
  return;
 }
 const extra=Object.keys(b).filter(k=>!['name','description','type','start_time','end_time','cells'].includes(k));
 if(extra.length)invalid('A split test takes name, description, type, start_time, end_time and cells, not '+extra.join(', ')+' (lift studies, creative tests, objectives and viewers stay out).');
 if(b.type!=='SPLIT_TEST')invalid('type is SPLIT_TEST: lift studies need Meta, and creative tests (SPLIT_TEST_V2) are documented inconsistently.');
 text(b.name,'name',nameMax);if(b.description!==undefined)text(b.description,'description',descriptionMax);
 const start=seconds(b.start_time),end=seconds(b.end_time);
 if(start===undefined||end===undefined)invalid('start_time and end_time are Unix times in seconds.');
 if(end<=start)invalid('end_time comes after start_time.');
 const cells=b.cells;
 if(!Array.isArray(cells)||cells.length<2||cells.length>maxCells)invalid('cells lists 2–'+maxCells+' cells (AMCP reads every object a cell names).');
 const names=new Set<string>(),seen=new Set<string>();let total=0,level:string|undefined;
 for(const [i,c] of cells.entries()){
  if(!object(c))invalid('Cell '+(i+1)+' is an object.');
  const keys=Object.keys(c).filter(k=>!['name','treatment_percentage','adsets','campaigns'].includes(k));
  if(keys.length)invalid('A cell has name, treatment_percentage and adsets or campaigns, not '+keys.join(', ')+' (whole ad accounts are not split here).');
  text(c.name,'Cell name',nameMax);if(names.has(String(c.name)))invalid('Cell names are distinct: '+String(c.name)+'.');names.add(String(c.name));
  const pct=c.treatment_percentage;
  if(typeof pct!=='number'||!Number.isInteger(pct)||pct<minPercent||pct>100)invalid('treatment_percentage is a whole number of at least '+minPercent+'.');
  total+=pct;
  const kinds=['adsets','campaigns'].filter(k=>c[k]!==undefined);
  if(kinds.length!==1)invalid('Each cell names adsets or campaigns, not both.');
  if(level!==undefined&&kinds[0]!==level)invalid('All cells split the same level: ad sets or campaigns.');
  level=kinds[0];
  const list=c[level!];
  if(!Array.isArray(list)||!list.length||list.length>maxPerCell||list.some(x=>!numeric(typeof x==='number'?String(x):x)))invalid('A cell names 1–'+maxPerCell+' '+(level==='adsets'?'ad set':'campaign')+' IDs.');
  for(const x of list as unknown[]){const id=String(x);if(seen.has(id))invalid('An object belongs to one cell only: '+id+'.');seen.add(id);}
 }
 if(total>100)invalid('The treatment percentages add up to '+total+'; at most 100.');
 if(seen.size>maxEntities)invalid('A study names at most '+maxEntities+' ad sets or campaigns here.');
}
export function assertMetaSplitTestScope(c:Connection,write=false):void{
 if(write?!c.scopes.includes('ads_management'):!c.scopes.some(s=>s==='ads_management'||s==='ads_read'))fail('INSUFFICIENT_SCOPE','Reconnect Meta with ads_management to create or change split tests.',{},403);
}
/** Starting, stopping or reshaping a split test decides how the named ad sets or campaigns deliver. */
export function metaSplitTestNeedsConfirmation(p:CompiledRequest):boolean{const k=metaSplitTestKind(p);return k==='create'||k==='update'&&body(p).end_time!==undefined;}
const read=(p:CompiledRequest,path:string,query:JsonObject,extra:Partial<Read>={}):Read=>({...p,action:marker,method:'GET',path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,metaStudyState:undefined,metaStudyPage:true,metaStudyId:undefined,...extra});
const accountRead=(p:CompiledRequest,s:State)=>read(p,'/v25.0/act_'+account(p.accountId),{fields:'id,business'},{metaStudyState:s});
const studyFields='id,name,description,type,start_time,end_time,canceled_time,business';
const cellFields='name,treatment_percentage,adsets.limit(100){id},campaigns.limit(100){id}';
export function metaSplitTestSnapshots(p:CompiledRequest):Read[]{
 const kind=metaSplitTestKind(p)!;
 return [accountRead(p,kind==='create'?{kind,level:levelOf(p),ids:idsOf(p)}:{kind,study:target(p)!})];
}
export function isMetaSplitTestRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).metaStudyState;}
/** Writes after validation; server-built reads of the selected account and of the study the request or receipt names. Ad sets and campaigns are read by ID under the usual ownership rule. */
export function authorizeMetaSplitTest(p:CompiledRequest,c:Connection,selected:string):boolean{
 if(metaSplitTestKind(p)){assertMetaSplitTest(p);assertMetaSplitTestScope(c,true);if(account(p.accountId)!==selected)fail('ACCOUNT_SCOPE_MISMATCH','Select the ad account whose ad sets or campaigns the study splits.',{},403);return true;}
 const r=p as Read;if(p.gateway!==gateway||!r.metaStudyPage||p.action!==marker||p.method!=='GET'||!p.readOnly||p.body!==undefined||account(p.accountId)!==selected)return false;
 assertMetaSplitTestScope(c);
 if(p.path==='/v25.0/act_'+selected&&p.query.fields==='id,business'&&Object.keys(p.query).length===1)return true;
 if(r.metaStudyId&&numeric(r.metaStudyId)){
  if(p.path==='/v25.0/'+r.metaStudyId&&p.query.fields===studyFields&&Object.keys(p.query).length===1)return true;
  if(p.path==='/v25.0/'+r.metaStudyId+'/cells'&&p.query.fields===cellFields&&String(p.query.limit)==='25'&&['fields,limit','after,fields,limit'].includes(Object.keys(p.query).sort().join()))return true;
 }
 return false;
}
const notFound=(e:unknown)=>{
 if(!(e instanceof MirrorError))return false;
 if(e.status===404||e.code==='NOT_FOUND')return true;
 const up=object(e.details?.upstream)?e.details.upstream as JsonObject:{},err=object(up.error)?up.error:{};
 return e.code==='UPSTREAM_ERROR'&&e.status===400&&err.code===100&&err.error_subcode===33;
};
/** Meta datetimes (2026-10-01T00:00:00+0000) as Unix seconds. */
function unix(v:unknown):number|null{if(typeof v==='number')return v;if(typeof v!=='string')return null;const t=Date.parse(v.replace(/([+-]\d{2})(\d{2})$/,'$1:$2'));return Number.isFinite(t)?Math.round(t/1000):null;}
const studyView=(d:JsonObject)=>({id:String(d.id),name:d.name??null,description:d.description??null,type:d.type??null,start_time:unix(d.start_time),end_time:unix(d.end_time),canceled:d.canceled_time!==undefined&&d.canceled_time!==null,business:object(d.business)&&d.business.id!==undefined?String(d.business.id):null});
async function studyAndCells(p:CompiledRequest,id:string,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<JsonObject|null>{
 let d:unknown;try{const r=await request(read(p,'/v25.0/'+id,{fields:studyFields},{metaStudyId:id}));if(r.status!==200)unverified('Meta did not return study '+id+'.');d=r.data;}catch(e){if(notFound(e))return null;throw e;}
 if(!object(d)||d.error||String(d.id)!==id)unverified('Meta did not return study '+id+'.');
 const cells:JsonObject[]=[];let after:string|undefined;
 for(let page=0;;page++){
  if(page>=Math.ceil(150/25))unverified('Study '+id+' has more cells than one read covers.');
  const r=await request(read(p,'/v25.0/'+id+'/cells',{fields:cellFields,limit:25,...(after?{after}:{})},{metaStudyId:id})),c=r.data;
  if(r.status!==200||!object(c)||!Array.isArray(c.data))unverified('Meta did not list the cells of study '+id+'.');
  for(const cell of c.data as unknown[]){
   if(!object(cell))unverified('A cell of study '+id+' is malformed.');
   const ids=(k:string)=>object(cell[k])&&Array.isArray((cell[k] as JsonObject).data)?((cell[k] as JsonObject).data as JsonObject[]).map(x=>String(x.id)).sort():[];
   cells.push({name:cell.name??null,treatment_percentage:cell.treatment_percentage??null,adsets:ids('adsets'),campaigns:ids('campaigns')});
  }
  const next=object(c.paging)&&typeof c.paging.next==='string'&&object(c.paging.cursors)&&typeof c.paging.cursors.after==='string'?c.paging.cursors.after:undefined;
  if(!next)break;after=next;
 }
 cells.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
 return {...studyView(d),cells};
}
/** The account's business and, for a new study, every named ad set or campaign with its studies; for an update, the study. */
export async function readMetaSplitTests(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).metaStudyState;if(!s)return request(p);
 const a=await request({...(p as Read),metaStudyState:undefined} as Read),ad=a.data;
 if(a.status!==200||!object(ad)||ad.error||account(ad.id)!==account(p.accountId))unverified('Meta did not return the selected ad account.');
 const business=object(ad.business)&&numeric(String(ad.business.id))?String(ad.business.id):null;
 if(s.kind!=='create'){const study=await studyAndCells(p,s.study,request);return {status:200,headers:{},data:{business,study:study??{id:s.study,present:false}}};}
 const objects:JsonObject={};
 for(const id of s.ids){
  const r=await request({...read(p,'/v25.0/'+id,{fields:'id,account_id,name,status'}),action:s.level==='adsets'?'meta_ad_set_id_get':'meta_campaign_id_get',metaStudyPage:undefined} as Read),d=r.data;
  if(r.status!==200||!object(d)||d.error||String(d.id)!==id)unverified('Meta did not return '+(s.level==='adsets'?'ad set ':'campaign ')+id+'.');
  if(account(d.account_id)!==account(p.accountId))fail('STATE_TARGET_MISMATCH',(s.level==='adsets'?'Ad set ':'Campaign ')+id+' belongs to another ad account.',{id},409);
  const st=await request({...read(p,'/v25.0/'+id+'/ad_studies',{fields:'id,type,start_time,end_time,canceled_time',limit:25}),action:s.level==='adsets'?'meta_ad_set_id_ad_studies_get':'meta_campaign_id_ad_studies_get',metaStudyPage:undefined} as Read),sd=st.data;
  if(st.status!==200||!object(sd)||!Array.isArray(sd.data))unverified('Meta did not list the studies of '+id+'.');
  if(object(sd.paging)&&typeof sd.paging.next==='string')unverified(id+' is in more studies than one read covers.');
  objects['o'+id]={id,name:d.name??null,status:d.status??null,studies:(sd.data as JsonObject[]).map(x=>({id:String(x.id),type:x.type??null,start_time:unix(x.start_time),end_time:unix(x.end_time),canceled:x.canceled_time!==undefined&&x.canceled_time!==null})).sort((x,y)=>x.id.localeCompare(y.id))};
 }
 return {status:200,headers:{},data:{business,level:s.level,objects}};
}
export function validateMetaSplitTestState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).metaStudyState,d=r.data;
 if(!s||r.status!==200||!object(d)||!('business' in d)||(s.kind==='create'?!object(d.objects)||s.ids.some(id=>!object((d.objects as JsonObject)['o'+id])):!object(d.study)))unverified('Missing verified split test state.');
}
export function metaSplitTestPrerequisites(p:CompiledRequest,states:unknown[],now=Date.now()):void{
 const kind=metaSplitTestKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!('business' in s))unverified('Missing verified split test state.');
 const t=Math.floor(now/1000);
 if(kind==='create'){
  if(s.business!==target(p))fail('RESOURCE_SCOPE_REQUIRED','The selected ad account belongs to business '+String(s.business??'none')+'; create the study on that business.',{business_id:target(p)!},403);
  for(const id of idsOf(p)){
   const o=object(s.objects)?(s.objects as JsonObject)['o'+id]:undefined;if(!object(o))unverified('Missing verified split test state.');
   if(['DELETED','ARCHIVED'].includes(String(o.status)))invalid(String(o.name??id)+' ('+id+') is '+String(o.status)+'; a study needs objects that can deliver.');
   const running=(o.studies as JsonObject[]).find(x=>x.type==='SPLIT_TEST'&&!x.canceled&&typeof x.end_time==='number'&&x.end_time>t);
   if(running)invalid(String(o.name??id)+' ('+id+') is already in split test '+String(running.id)+' until '+new Date(Number(running.end_time)*1000).toISOString()+'; one object is in one running split test.');
  }
  return;
 }
 const st=object(s.study)?s.study:unverified('Missing verified split test state.');
 if(st.present===false)fail('STATE_NOT_FOUND','Study '+target(p)+' was not found.',{ad_study_id:target(p)!},404);
 if(st.business!==s.business||s.business===null)fail('RESOURCE_SCOPE_REQUIRED','Study '+target(p)+' belongs to another business than the selected ad account.',{ad_study_id:target(p)!},403);
 if(st.type!=='SPLIT_TEST')invalid('Study '+target(p)+' is a '+String(st.type)+'; only split tests change here.');
 if(st.canceled)invalid('Study '+target(p)+' was canceled.');
 const b=body(p),end=b.end_time===undefined?undefined:seconds(b.end_time)!;
 if(typeof st.end_time==='number'&&st.end_time<=t&&end!==undefined)invalid('Study '+target(p)+' has ended; its end_time no longer changes.');
 if(end!==undefined&&(end<=t||typeof st.start_time==='number'&&end<=st.start_time))invalid('The new end_time must be in the future and after the start.');
 if(['name','description'].every(k=>b[k]===undefined||b[k]===st[k])&&(end===undefined||end===st.end_time))invalid('Study '+target(p)+' already has these values.');
}
export function metaSplitTestImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=metaSplitTestKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{},b=body(p);
 if(kind==='create')return {provider:'meta',scope:'split_test',operation:'create',business:s.business??null,level:levelOf(p),cells:cellsOf(p).map(c=>({name:c.name,treatment_percentage:c.treatment_percentage,[levelOf(p)]:(c[levelOf(p)] as unknown[]).map(String)})),
  window:{start_time:seconds(b.start_time),end_time:seconds(b.end_time)},objects:object(s.objects)?Object.values(s.objects).map(o=>object(o)?{id:o.id,name:o.name,status:o.status}:o):[],may_affect_serving:true,
  effect:'From start_time Meta splits the audience between the cells, so each ad set or campaign delivers only to its share of people until end_time. Budgets are unchanged.',
  verification:'Reads the study and its cells and compares name, type, times, business, percentages and objects.',source:'https://developers.facebook.com/docs/marketing-api/guides/split-testing'};
 const st=object(s.study)?s.study:{};
 return {provider:'meta',scope:'split_test',operation:'update',study:{id:target(p),name:st.name??null,start_time:st.start_time??null,end_time:st.end_time??null},changes:b,may_affect_serving:b.end_time!==undefined,
  effect:b.end_time!==undefined?'Moves the end of the split test, which decides until when the audience stays split.':'Renames or re-describes the study; delivery is unchanged.',
  verification:'Reads the study again and compares the changed fields.',source:'https://developers.facebook.com/docs/marketing-api/reference/ad-study'};
}
export function metaSplitTestOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const d=r.data;if(r.status!==200||!object(d)||d.error)return false;
 return metaSplitTestKind(p)==='create'?numeric(String(d.id??'')):d.success===true;
}
export function metaSplitTestVerification(p:CompiledRequest,result:JsonObject):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=metaSplitTestKind(p)!,b=body(p);
 const id=kind==='create'?String(result.data?.id??''):target(p)!;if(!numeric(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no study to verify.');
 const expected:JsonObject=kind==='create'?{name:b.name,type:'SPLIT_TEST',start_time:seconds(b.start_time),end_time:seconds(b.end_time),...(b.description!==undefined?{description:b.description}:{}),
   cells:cellsOf(p).map(c=>({name:c.name,treatment_percentage:c.treatment_percentage,adsets:levelOf(p)==='adsets'?(c.adsets as unknown[]).map(String).sort():[],campaigns:levelOf(p)==='campaigns'?(c.campaigns as unknown[]).map(String).sort():[]})).sort((x,y)=>String(x.name).localeCompare(String(y.name)))}
  :{...(b.name!==undefined?{name:b.name}:{}),...(b.description!==undefined?{description:b.description}:{}),...(b.end_time!==undefined?{end_time:seconds(b.end_time)}:{})};
 return [{read:accountRead(p,{kind:'verify',study:id}),expected:{study:{present:true,...expected},business_matches:true},id:'study '+id}];
}
export function metaSplitTestObserved(_read:CompiledRequest,data:JsonObject):JsonObject{
 const st=object(data.study)?data.study:{};
 if(st.present===false)return {study:{present:false}};
 return {study:{present:true,...st},business_matches:st.business!==null&&st.business===data.business};
}
