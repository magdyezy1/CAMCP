import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Advertiser-owned inventory source groups on Display & Video 360 API v4, per the pinned Discovery document
 * (inventorySourceGroups create, patch and delete; inventorySourceGroups.assignedInventorySources create, delete and
 * bulkEdit; InventorySourceGroup, AssignedInventorySource and BulkEditAssignedInventorySourcesRequest; checked 2026-09-27).
 * - A group gathers inventory sources (deals and auction packages); line items that target the group buy from them.
 * - The advertiser named in advertiserId owns the group (bulkEdit names it in the body). A partner-owned group shared with
 *   the advertiser can be read, but only its partner writes it. The group resource carries no owner field, so DV360
 *   refuses advertiser writes to a shared partner group; AMCP never uses partner access.
 * - Only displayName can change. bulkEdit deletes the listed assignments first and then creates the new ones.
 */
type Kind='group_create'|'group_patch'|'group_delete'|'source_create'|'source_delete'|'source_bulk';
type State={groupId?:string;sources?:string[];optional?:boolean;view?:'group'|'sources'};
type Read=CompiledRequest&{dv360InventoryGroupState?:State};
type Assignment={assignedInventorySourceId:string;inventorySourceId:string};
const gateway='dv360_native_action',origin='https://displayvideo.googleapis.com',oauthScope='https://www.googleapis.com/auth/display-video';
const maxChanges=1000,maxAssignmentPages=50,maxSourcePages=25,maxReads=2+maxAssignmentPages+maxSourcePages;
const groups='/v4/inventorySourceGroups';
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_DV360_INVENTORY_GROUP',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function mismatch(message:string):never{return fail('STATE_TARGET_MISMATCH',message,{},409);}
function denied(message:string):never{return fail('RESOURCE_SCOPE_REQUIRED',message,{},403);}

export function dv360InventoryGroupKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!==gateway||p.origin!==undefined&&p.origin!==origin||p.specialTransport)return;
 const group='\\/v4\\/inventorySourceGroups\\/[1-9]\\d{0,18}',test=(suffix:string)=>new RegExp('^'+group+suffix+'$').test(p.path);
 if(p.path===groups)return p.method==='POST'?'group_create':undefined;
 if(test(''))return p.method==='PATCH'?'group_patch':p.method==='DELETE'?'group_delete':undefined;
 if(test('\\/assignedInventorySources'))return p.method==='POST'?'source_create':undefined;
 if(test('\\/assignedInventorySources\\/[1-9]\\d{0,18}'))return p.method==='DELETE'?'source_delete':undefined;
 if(test('\\/assignedInventorySources:bulkEdit'))return p.method==='POST'?'source_bulk':undefined;
 return;
}
const groupOf=(p:CompiledRequest)=>p.path.split('/')[3]!;
const assignmentOf=(p:CompiledRequest)=>p.path.split('/')[5]!;
function changes(p:CompiledRequest):{adds:string[];removes:string[]}{
 const kind=dv360InventoryGroupKind(p),b=obj(p.body)?p.body:{};
 if(kind==='source_create')return {adds:[String(b.inventorySourceId)],removes:[]};
 if(kind==='source_delete')return {adds:[],removes:[assignmentOf(p)]};
 if(kind==='source_bulk')return {adds:((b.createdAssignedInventorySources??[]) as JsonObject[]).map(c=>String(c.inventorySourceId)),removes:((b.deletedAssignedInventorySources??[]) as unknown[]).map(String)};
 return {adds:[],removes:[]};
}
function name(v:unknown):void{
 if(typeof v!=='string'||!v.trim()||v!==v.trim()||Buffer.byteLength(v,'utf8')>240||/[\u0000-\u001f\u007f]/.test(v))invalid('displayName is 1–240 UTF-8 bytes without surrounding spaces or control characters.');
}
export function assertDV360InventoryGroup(p:CompiledRequest):void{
 const kind=dv360InventoryGroupKind(p);if(!kind)return;
 if(!id(p.accountId))fail('ACCOUNT_REQUIRED','Select the DV360 advertiser that owns the inventory source group.',{},403);
 if(Object.keys(p.headers).length)invalid('Inventory source group requests take no header overrides.');
 const allowed=kind==='source_bulk'?[]:kind==='group_patch'?['advertiserId','updateMask']:['advertiserId'],keys=Object.keys(p.query);
 if(keys.some(k=>!allowed.includes(k))||allowed.some(k=>p.query[k]===undefined))invalid(kind==='source_bulk'?'bulkEdit names the advertiser in the body (advertiserId) and takes no query parameters.':'Name the owning advertiser in advertiserId'+(kind==='group_patch'?' with updateMask=displayName':'')+' and nothing else; partnerId would act with partner access, which this connection is not bound to.');
 if(kind!=='source_bulk'&&p.query.advertiserId!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser.',{},403);
 if(kind==='group_delete'||kind==='source_delete'){if(p.body!==undefined&&!(obj(p.body)&&!Object.keys(p.body).length))invalid('Deletion takes no body.');return;}
 const b=p.body;if(!obj(b))invalid('Provide the native request object.');
 if(kind==='group_create'||kind==='group_patch'){
  if(Object.keys(b).some(k=>k!=='displayName'))invalid('An inventory source group sets only displayName; DV360 assigns its ID and name.');
  name(b.displayName);
  if(kind==='group_patch'&&p.query.updateMask!=='displayName')invalid('updateMask is displayName, the only field that can change.');
  return;
 }
 if(kind==='source_create'){if(Object.keys(b).some(k=>k!=='inventorySourceId')||!id(b.inventorySourceId))invalid('An assignment is {inventorySourceId} with the numeric ID of an inventory source the advertiser can use, as a string.');return;}
 const extra=Object.keys(b).filter(k=>!['advertiserId','createdAssignedInventorySources','deletedAssignedInventorySources'].includes(k));
 if(extra.length)invalid('Unqualified fields: '+extra.join(', ')+(extra.includes('partnerId')?' (partner-owned groups need partner access, which this connection is not bound to)':'')+'.');
 if(b.advertiserId!==p.accountId)fail('ACCOUNT_SCOPE_MISMATCH','bulkEdit names the selected advertiser, the owner of the group, in body.advertiserId.',{},403);
 const created=b.createdAssignedInventorySources??[],deleted=b.deletedAssignedInventorySources??[];
 if(!Array.isArray(created)||!Array.isArray(deleted)||!created.length&&!deleted.length||created.length+deleted.length>maxChanges)invalid('bulkEdit lists 1–'+maxChanges+' changes in createdAssignedInventorySources and deletedAssignedInventorySources.');
 for(const c of created)if(!obj(c)||Object.keys(c).some(k=>k!=='inventorySourceId')||!id(c.inventorySourceId))invalid('Each created assignment is {inventorySourceId} with a numeric ID as a string.');
 for(const d of deleted)if(!id(d))invalid('deletedAssignedInventorySources lists assignedInventorySourceId values as strings.');
 const {adds,removes}=changes(p);
 if(new Set(adds).size!==adds.length||new Set(removes).size!==removes.length)invalid('Each inventory source and each assignment appears once.');
}
export function assertDV360InventoryGroupScope(c:Connection):void{
 if(!c.scopes.includes(oauthScope))fail('PROVIDER_WRITE_SCOPE_REQUIRED','Reconnect DV360 with the display-video OAuth scope.',{},403);
}
/**
 * Writes above, and reads of groups, their assignments and inventory sources that name the selected advertiser in
 * advertiserId: DV360 then returns only what that advertiser can access. The scope guard has compared advertiserId with
 * the account already.
 */
export function authorizeDV360InventoryGroup(p:CompiledRequest,c:Connection,account:string):boolean{
 if(p.gateway!==gateway||p.origin!==undefined&&p.origin!==origin||p.specialTransport)return false;
 if(dv360InventoryGroupKind(p)){assertDV360InventoryGroup(p);if(p.accountId!==account)fail('ACCOUNT_SCOPE_MISMATCH','advertiserId must be the selected advertiser.',{},403);assertDV360InventoryGroupScope(c);return true;}
 if(p.method!=='GET'||!p.readOnly||p.body!==undefined)return false;
 const m=/^\/v4\/(inventorySourceGroups|inventorySources)(?:\/([1-9]\d{0,18})(\/assignedInventorySources)?)?$/.exec(p.path);
 if(!m||m[3]&&m[1]!=='inventorySourceGroups')return false;
 const list=!m[2]||!!m[3],allowed=list?['advertiserId','pageSize','pageToken','orderBy','filter']:['advertiserId'];
 if(p.query.advertiserId!==account)denied('DV360 inventory source and group reads name the selected advertiser in advertiserId; DV360 then returns only what it can access.');
 const extra=Object.keys(p.query).filter(k=>!allowed.includes(k));
 if(extra.length)denied('This DV360 read takes only '+allowed.join(', ')+'; partnerId would use partner access, which this connection is not bound to.');
 if(Object.keys(p.headers??{}).length)denied('DV360 inventory reads take no header overrides.');
 if(!c.scopes.includes(oauthScope))fail('INSUFFICIENT_SCOPE','Reconnect the selected DV360 connection with display-video scope.',{},403);
 return true;
}

const read=(p:CompiledRequest,path:string,query:JsonObject={}):Read=>({...p,action:'AMCP_DV360_INVENTORY_GROUP_READ',method:'GET',path,query,body:undefined,headers:{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined,queryArrayEncoding:undefined,dv360InventoryGroupState:undefined});
/** One marked read of the advertiser; the reader adds the group, its assignments and the inventory sources to assign. */
const stateRead=(p:CompiledRequest,s:State):Read=>({...read(p,'/v4/advertisers/'+p.accountId),dv360InventoryGroupState:s});
export function dv360InventoryGroupSnapshots(p:CompiledRequest):Read[]{
 const kind=dv360InventoryGroupKind(p)!,{adds}=changes(p);
 return [stateRead(p,kind==='group_create'?{}:{groupId:groupOf(p),...(adds.length?{sources:adds}:{})})];
}
export function isDV360InventoryGroupRead(p:CompiledRequest):p is Read{return p.gateway===gateway&&!!(p as Read).dv360InventoryGroupState;}
function body(r:TransportResult,what:string):JsonObject{
 if(r.status!==200||!obj(r.data)||r.data.error)unverified('DV360 did not return the '+what+'.');
 return r.data;
}
const byId=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
/**
 * Reads the advertiser; the group when one is named (absent after a verified deletion) with every assignment, page by
 * page; and, when sources are to be assigned, the advertiser's inventory sources until each is found. DV360 lists only
 * sources the advertiser can use, without archived ones.
 */
export async function readDV360InventoryGroup(p:CompiledRequest,fetch:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).dv360InventoryGroupState;if(!s)return fetch(p);
 const advertiser=p.accountId!;let reads=0;
 const get=async(q:Read)=>{if(++reads>maxReads)unverified('Inventory source group reads exceeded their bound.');return fetch(q);};
 const a=body(await get({...(p as Read),dv360InventoryGroupState:undefined}),'advertiser');
 if(String(a.advertiserId)!==advertiser||a.name!=='advertisers/'+advertiser)mismatch('DV360 returned a different advertiser.');
 let group:JsonObject|null=null,assigned:Assignment[]|null=null;
 if(s.groupId){
  let r:TransportResult|undefined;
  try{r=await get(read(p,groups+'/'+s.groupId,{advertiserId:advertiser}));}
  catch(e){if(!(s.optional&&e instanceof MirrorError&&(e.status===404||e.code==='NOT_FOUND')))throw e;}
  if(r){
   const g=body(r,'inventory source group');
   if(String(g.inventorySourceGroupId)!==s.groupId||g.name!=='inventorySourceGroups/'+s.groupId)mismatch('DV360 returned a different inventory source group.');
   group={inventorySourceGroupId:s.groupId,displayName:typeof g.displayName==='string'?g.displayName:null};
   assigned=[];const tokens=new Set<string>(),seen=new Set<string>();let token:string|undefined;
   for(let page=0;;page++){
    if(page>=maxAssignmentPages)unverified('Inventory source group '+s.groupId+' has more assignments than one review reads ('+maxAssignmentPages*100+').');
    const d=body(await get(read(p,groups+'/'+s.groupId+'/assignedInventorySources',{advertiserId:advertiser,pageSize:100,...(token?{pageToken:token}:{})})),'group assignments');
    const rows=d.assignedInventorySources??[];if(!Array.isArray(rows))unverified('DV360 returned malformed assignments.');
    for(const row of rows){
     if(!obj(row)||!id(row.assignedInventorySourceId)||!id(row.inventorySourceId)||row.name!=='inventorySourceGroups/'+s.groupId+'/assignedInventorySources/'+row.assignedInventorySourceId||seen.has(row.assignedInventorySourceId))mismatch('An assignment does not belong to inventory source group '+s.groupId+'.');
     seen.add(row.assignedInventorySourceId);assigned.push({assignedInventorySourceId:row.assignedInventorySourceId,inventorySourceId:row.inventorySourceId});
    }
    token=d.nextPageToken as string|undefined;if(!token)break;
    if(typeof token!=='string'||tokens.has(token))unverified('DV360 repeated an assignment page.');tokens.add(token);
   }
   assigned.sort((x,y)=>byId(x.assignedInventorySourceId,y.assignedInventorySourceId));
  }
 }
 let sources:JsonObject[]|null=null,sourcesComplete=true;
 if(s.sources?.length&&group){
  const wanted=new Set(s.sources),found=new Map<string,JsonObject>(),tokens=new Set<string>();let token:string|undefined,page=0;
  for(;found.size<wanted.size;page++){
   if(page>=maxSourcePages){sourcesComplete=false;break;}
   const d=body(await get(read(p,'/v4/inventorySources',{advertiserId:advertiser,pageSize:200,...(token?{pageToken:token}:{})})),'inventory sources');
   const rows=d.inventorySources??[];if(!Array.isArray(rows))unverified('DV360 returned malformed inventory sources.');
   for(const row of rows){
    if(!obj(row)||!id(row.inventorySourceId)||!wanted.has(row.inventorySourceId))continue;
    if(row.name!=='inventorySources/'+row.inventorySourceId)mismatch('DV360 returned a malformed inventory source.');
    found.set(row.inventorySourceId,{inventorySourceId:row.inventorySourceId,displayName:row.displayName??null,inventorySourceType:row.inventorySourceType??null,exchange:row.exchange??null,dealId:row.dealId??null,entityStatus:obj(row.status)?row.status.entityStatus??null:null});
   }
   token=d.nextPageToken as string|undefined;if(!token)break;
   if(typeof token!=='string'||tokens.has(token))unverified('DV360 repeated an inventory source page.');tokens.add(token);
  }
  sources=[...found.values()].sort((x,y)=>byId(String(x.inventorySourceId),String(y.inventorySourceId)));
 }
 return {status:200,headers:{},data:{advertiserId:advertiser,group,assigned,sources,sourcesComplete}};
}
export function validateDV360InventoryGroupState(p:CompiledRequest,r:TransportResult):void{
 const d=r.data,s=(p as Read).dv360InventoryGroupState;
 if(!s||r.status!==200||!obj(d)||d.advertiserId!==p.accountId)unverified('Missing verified inventory source group state.');
 // A group is absent only in a read that allows it, after a deletion.
 if(s.groupId&&!s.optional&&(!obj(d.group)||!Array.isArray(d.assigned))||s.sources?.length&&obj(d.group)&&!Array.isArray(d.sources))unverified('Missing verified inventory source group state.');
}
export function dv360InventoryGroupPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=dv360InventoryGroupKind(p);if(!kind||kind==='group_create')return;
 const s=states[0],g=groupOf(p);
 if(!obj(s)||!obj(s.group)||!Array.isArray(s.assigned))unverified('Missing verified inventory source group state.');
 if(kind==='group_patch'){if(s.group.displayName===(p.body as JsonObject).displayName)invalid('Inventory source group '+g+' already has this name.');return;}
 if(kind==='group_delete')return;
 const assigned=s.assigned as Assignment[],{adds,removes}=changes(p);
 for(const r of removes)if(!assigned.some(a=>a.assignedInventorySourceId===r))fail('STATE_NOT_FOUND','Assignment '+r+' is not in inventory source group '+g+'.');
 const removed=new Set(assigned.filter(a=>removes.includes(a.assignedInventorySourceId)).map(a=>a.inventorySourceId));
 for(const a of adds){
  if(removed.has(a))invalid('Inventory source '+a+' would be removed and assigned again in one request; leave its assignment as it is.');
  if(assigned.some(x=>x.inventorySourceId===a))fail('CONFIGURATION_EXISTS','Inventory source '+a+' is already in inventory source group '+g+'.');
 }
 const sources=Array.isArray(s.sources)?s.sources as JsonObject[]:[],missing=adds.filter(a=>!sources.some(x=>x.inventorySourceId===a));
 if(missing.length)fail('STATE_NOT_FOUND',s.sourcesComplete===false?'Inventory sources '+missing.join(', ')+' are not among the first '+maxSourcePages*200+' inventory sources advertiser '+p.accountId+' can use; no change was sent.':'Advertiser '+p.accountId+' cannot use inventory sources '+missing.join(', ')+' (or they are archived).');
}
/** Membership decides what line items targeting the group can buy; so does deleting the group. */
export function dv360InventoryGroupServing(p:CompiledRequest):boolean{const kind=dv360InventoryGroupKind(p);return !!kind&&kind!=='group_create'&&kind!=='group_patch';}
export function dv360InventoryGroupRemoves(p:CompiledRequest):boolean{const kind=dv360InventoryGroupKind(p);return kind==='group_delete'||!!kind&&changes(p).removes.length>0;}
export function dv360InventoryGroupImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=dv360InventoryGroupKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=obj(first)?first:{},group=obj(s.group)?s.group:null,assigned=Array.isArray(s.assigned)?s.assigned as Assignment[]:[];
 const {adds,removes}=changes(p),sources=Array.isArray(s.sources)?s.sources as JsonObject[]:[];
 const members=kind==='group_delete'?[]:[...assigned.filter(a=>!removes.includes(a.assignedInventorySourceId)).map(a=>a.inventorySourceId),...adds].sort(byId);
 const serving=dv360InventoryGroupServing(p);
 return {provider:'dv360',scope:'inventory_source_group',operation:kind,advertiser:p.accountId??null,group,
  before:group?{displayName:group.displayName,inventorySources:assigned.map(a=>a.inventorySourceId).sort(byId)}:null,
  after:kind==='group_delete'?null:{displayName:kind==='group_create'||kind==='group_patch'?(p.body as JsonObject).displayName:group?.displayName??null,inventorySources:members},
  adding:adds.map(a=>sources.find(x=>x.inventorySourceId===a)??{inventorySourceId:a}),removing:assigned.filter(a=>removes.includes(a.assignedInventorySourceId)),
  may_affect_serving:serving,
  effect:kind==='group_create'?'Creates an empty inventory source group owned by the advertiser; nothing serves from it until sources are assigned and a line item targets it.':kind==='group_patch'?'Renames the group; what it holds does not change.':kind==='group_delete'?'Deletes the group and its assignments; line items that target it lose these inventory sources.':'Changes the inventory sources in the group; line items that target it buy from the new set.',
  units:'Inventory sources are deals and auction packages, named by numeric ID.',
  verification:kind==='group_delete'?'Reads the group again and expects it to be gone.':kind==='group_create'||kind==='group_patch'?'Reads the group again and compares its name.':'Reads every assignment of the group again and compares the inventory sources.',
  source:'https://developers.google.com/display-video/api/reference/rest/v4/inventorySourceGroups'};
}
export function dv360InventoryGroupOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=dv360InventoryGroupKind(p)!,d=r.data,b=obj(p.body)?p.body:{};
 if(r.status!==200)return false;
 if(kind==='group_delete'||kind==='source_delete')return d==null||obj(d)&&!Object.keys(d).length;
 if(!obj(d)||d.error)return false;
 if(kind==='group_create'||kind==='group_patch')return id(d.inventorySourceGroupId)&&d.name==='inventorySourceGroups/'+d.inventorySourceGroupId&&d.displayName===b.displayName&&(kind==='group_create'||d.inventorySourceGroupId===groupOf(p));
 const prefix='inventorySourceGroups/'+groupOf(p)+'/assignedInventorySources/';
 const row=(x:unknown,wanted:string[])=>obj(x)&&id(x.assignedInventorySourceId)&&typeof x.inventorySourceId==='string'&&wanted.includes(x.inventorySourceId)&&x.name===prefix+x.assignedInventorySourceId;
 if(kind==='source_create')return row(d,[String(b.inventorySourceId)]);
 const rows=d.assignedInventorySources??[],{adds}=changes(p);
 return Object.keys(d).every(k=>k==='assignedInventorySources')&&Array.isArray(rows)&&rows.length===adds.length&&rows.every(x=>row(x,adds))&&new Set(rows.map((x:JsonObject)=>x.inventorySourceId)).size===rows.length;
}
export function dv360InventoryGroupVerification(p:CompiledRequest,result:JsonObject,before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=dv360InventoryGroupKind(p)!,g=kind==='group_create'?String(result.data?.inventorySourceGroupId??''):groupOf(p);
 if(!id(g))fail('VERIFICATION_UNSUPPORTED','The receipt names no inventory source group to verify.');
 const label='inventory source group '+g;
 if(kind==='group_delete')return [{read:stateRead(p,{groupId:g,optional:true,view:'group'}),expected:{group:null},id:label}];
 if(kind==='group_create'||kind==='group_patch')return [{read:stateRead(p,{groupId:g,view:'group'}),expected:{group:{inventorySourceGroupId:g,displayName:(p.body as JsonObject).displayName}},id:label}];
 const first=before[0],assigned=obj(first)&&Array.isArray(first.assigned)?first.assigned as Assignment[]:[],{adds,removes}=changes(p);
 const expected=[...assigned.filter(a=>!removes.includes(a.assignedInventorySourceId)).map(a=>a.inventorySourceId),...adds].sort(byId);
 return [{read:stateRead(p,{groupId:g,view:'sources'}),expected:{inventorySources:expected},id:label}];
}
export function dv360InventoryGroupObserved(p:CompiledRequest,data:JsonObject):JsonObject{
 const s=(p as Read).dv360InventoryGroupState;
 if(s?.view==='sources')return {inventorySources:Array.isArray(data.assigned)?(data.assigned as Assignment[]).map(a=>a.inventorySourceId).sort(byId):null};
 return {group:obj(data.group)?data.group:null};
}
