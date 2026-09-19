import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {googleFeedAssetFields} from './google-asset-set-fields.js';
import {stable,sha256} from './security.js';
import type {CompiledRequest,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

export const googleAssetSetFields=['name','type','status','location_group_parent_asset_set_id','merchant_center_feed.merchant_id','merchant_center_feed.feed_label','business_profile_location_group.dynamic_business_profile_location_group_filter.business_name_filter.business_name','business_profile_location_group.dynamic_business_profile_location_group_filter.business_name_filter.filter_type','business_profile_location_group.dynamic_business_profile_location_group_filter.label_filters','business_profile_location_group.dynamic_business_profile_location_group_filter.listing_id_filters','location_set.business_profile_location_set.business_name_filter','location_set.business_profile_location_set.label_filters','location_set.business_profile_location_set.listing_id_filters','location_set.chain_location_set.relationship_type','location_set.location_ownership_type','hotel_property_data.hotel_center_id','hotel_property_data.partner_name'];
export const googleFeedFields=['type','source','name','final_urls','final_mobile_urls','tracking_url_template','final_url_suffix','url_custom_parameters',...Object.values(googleFeedAssetFields).flat()];
const plainTypes=Object.keys(googleFeedAssetFields).filter(t=>!['LOCATION','HOTEL_PROPERTY'].includes(t));
const locationTypes=['LOCATION_SYNC','STATIC_LOCATION_GROUP','BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP','CHAIN_DYNAMIC_LOCATION_GROUP'];
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const invalid=(message:string):never=>{throw new MirrorError('INVALID_CONFIGURATION_MUTATION',message);};
const stateError=(message:string):never=>{throw new MirrorError('STATE_READ_FAILED',message,{},502);};
const camel=(s:string)=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const kinds=new Set(['assetSets','assetSetAssets','campaignAssetSets','adGroupAssetSets','customerAssetSets']);
function kind(p:CompiledRequest){const k=p.path.match(/\/([^/]+):mutate$/)?.[1];return p.gateway==='google_ads_native_action'&&k&&kinds.has(k)?k:undefined;}
function nativeName(p:CompiledRequest,value:unknown,collection:string,parts=1):string{
 if(typeof value!=='string'||!new RegExp('^customers/'+p.accountId!.replaceAll('-','')+'/'+collection+'/[1-9][0-9]*(?:~[1-9][0-9]*){'+(parts-1)+'}$').test(value))stateError('A feed read returned a foreign or malformed resource identity.');return value as string;
}
const keys=(r:JsonObject,allowed:string[])=>{if(Object.keys(r).some(k=>!allowed.includes(k)))invalid('Unqualified asset-set configuration field.');};
function members(v:unknown,label:string,numeric=false){const signedId=(x:unknown)=>typeof x==='string'&&/^-?[1-9][0-9]*$/.test(x)&&BigInt(x)>=-(1n<<63n)&&BigInt(x)<(1n<<63n);if(!Array.isArray(v)||v.length>1000||v.some(x=>numeric?!signedId(x):typeof x!=='string'||!x||x.length>1024)||new Set(v).size!==v.length)invalid(label+' must be a bounded set of unique '+(numeric?'nonzero signed int64 IDs; preserve the provider conversion of unsigned location IDs.':'nonempty strings.'));}
export function assertAssetSetRecord(r:JsonObject,creating:boolean){
 if(creating&&!plainTypes.includes(r.type)&&!['MERCHANT_CENTER_FEED','STATIC_LOCATION_GROUP','BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP'].includes(r.type))throw new MirrorError('ASSET_SET_VARIANT_UNQUALIFIED','This asset-set creation variant has no complete read-back contract. Location sync credentials and nonselectable chain/map filters require a separate qualified workflow; use an existing set for links, or a supported explicit feed type.');
 const locationGroup=creating&&['STATIC_LOCATION_GROUP','BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP'].includes(r.type);
 if(creating&&(locationGroup?!id(r.locationGroupParentAssetSetId):r.locationGroupParentAssetSetId!==undefined))invalid('Location groups require an existing positive parent asset-set ID; other feed types cannot set it.');
 if(creating&&(r.type==='MERCHANT_CENTER_FEED'?!r.merchantCenterFeed:r.merchantCenterFeed!==undefined))invalid('merchantCenterFeed must be supplied only for a MERCHANT_CENTER_FEED set.');
 if(r.merchantCenterFeed!==undefined){if(!object(r.merchantCenterFeed))invalid('merchantCenterFeed must be a native object.');keys(r.merchantCenterFeed,['merchantId','feedLabel']);if(r.merchantCenterFeed.merchantId!==undefined&&!id(String(r.merchantCenterFeed.merchantId)))invalid('merchantId must be a positive decimal ID.');if(creating&&!id(String(r.merchantCenterFeed.merchantId)))invalid('The Merchant Center feed requires merchantId.');if(r.merchantCenterFeed.feedLabel!==undefined&&(typeof r.merchantCenterFeed.feedLabel!=='string'||r.merchantCenterFeed.feedLabel.length>20||!/^[A-Z0-9-]*$/.test(r.merchantCenterFeed.feedLabel)))invalid('Use the native Merchant Center feed label (at most 20 uppercase letters, digits or hyphens).');}
 if(creating&&(r.type==='BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP'?!r.businessProfileLocationGroup:r.businessProfileLocationGroup!==undefined))invalid('Business Profile location-group filters must match the asset-set type.');
 if(r.businessProfileLocationGroup!==undefined){
  if(!object(r.businessProfileLocationGroup))invalid('businessProfileLocationGroup must be an object.');keys(r.businessProfileLocationGroup,['dynamicBusinessProfileLocationGroupFilter']);
  const f=r.businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter;if(!object(f))invalid('Supply explicit dynamicBusinessProfileLocationGroupFilter, including an empty object for all parent locations.');keys(f,['businessNameFilter','labelFilters','listingIdFilters']);
  if(f.businessNameFilter!==undefined){if(!object(f.businessNameFilter)||f.businessNameFilter.filterType!=='EXACT'||typeof f.businessNameFilter.businessName!=='string'||!f.businessNameFilter.businessName)invalid('Business-name filtering requires an explicit EXACT name.');keys(f.businessNameFilter,['businessName','filterType']);}
  if(f.labelFilters!==undefined)members(f.labelFilters,'labelFilters');if(f.listingIdFilters!==undefined)members(f.listingIdFilters,'listingIdFilters',true);
 }
}
function setNames(p:CompiledRequest){
 const k=kind(p),names=new Set<string>(),root='customers/'+p.accountId!.replaceAll('-','')+'/assetSets/';
 for(const op of googleJson(p.body).operations){const r=op.create??op.update??{},name=op.remove??op.update?.resourceName;
  if(k==='assetSets'){if(name)names.add(name);if(op.create?.locationGroupParentAssetSetId)names.add(root+op.create.locationGroupParentAssetSetId);}
  else if(r.assetSet)names.add(r.assetSet);
  else if(name){const parts=name.split('/').at(-1).split('~');names.add(root+(k==='assetSetAssets'?parts[0]:parts.at(-1)));}
 }
 return [...names].sort();
}
function search(p:CompiledRequest,entity:string,fields:string[],where:string):CompiledRequest{
 return {...p,action:'AMCP_FEED_READ',method:'POST',path:'/v23/customers/'+p.accountId!.replaceAll('-','')+'/googleAds:search',headers:{},query:{},body:{query:'SELECT '+[...new Set(['resource_name',...fields])].map(f=>entity+'.'+f).join(', ')+' FROM '+entity+' WHERE '+where},readOnly:true,destructive:false,requiresConfirmation:false,googleState:undefined,googleAssetSetState:undefined,responseControls:undefined,specialTransport:undefined};
}
const namesQuery=(entity:string,names:string[])=>entity+'.resource_name IN ('+names.map(n=>"'"+n+"'").join(', ')+')';
export function assetSetExtraSnapshots(p:CompiledRequest):CompiledRequest[]{
 if(!kind(p))return [];const names=setNames(p);if(!names.length)return [];
 return [{...search(p,'asset_set',googleAssetSetFields,namesQuery('asset_set',names)),googleAssetSetState:{names}}];
}
/** Only qualified membership arrays are sets; unknown ordered arrays stay ordered. */
export function assetSetCanonical(value:unknown,key=''):any{
 if(Array.isArray(value)){const items=value.map(v=>assetSetCanonical(v));return ['labels','labelFilters','listingIdFilters','contextualKeywords','similarIds','similarProgramIds','similarDestinationIds','similarPropertyIds','similarJobIds','similarDealIds','similarListingIds','businessProfileLocations'].includes(key)&&items.every(v=>['string','number'].includes(typeof v))?items.sort((a,b)=>stable(a).localeCompare(stable(b),'en')):items;}
 if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,assetSetCanonical(v,k)]));return value;
}
export function assetSetObserved(resource:string,value:JsonObject):JsonObject{
 if(!value||!['asset_set','asset_set_asset','campaign_asset_set','ad_group_asset_set','customer_asset_set'].includes(resource))return value;
 const out=assetSetCanonical(value);
 if(out.merchantCenterFeed)out.merchantCenterFeed={feedLabel:'',...out.merchantCenterFeed};
 const group=out.businessProfileLocationGroup??(out.type==='BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP'?(out.businessProfileLocationGroup={}):undefined);if(group)group.dynamicBusinessProfileLocationGroupFilter={labelFilters:[],listingIdFilters:[],...group.dynamicBusinessProfileLocationGroupFilter};
 return out;
}
export function assetSetExactFields(value:JsonObject,fields:string[]):JsonObject{
 return Object.fromEntries(fields.map(field=>[field,sha256(stable(field.split('.').reduce((v,k)=>v?.[k],value)??null))]));
}
export async function readAssetSetContents(read:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 if(!read.googleAssetSetState)return request(read);
 let count=0,bytes=0;const account='customers/'+read.accountId!.replaceAll('-',''),initialNames=read.googleAssetSetState.names;
 const query=async(entity:string,fields:string[],where:string,validate:(r:JsonObject)=>void):Promise<JsonObject[]>=>{
  const rows:JsonObject[]=[],seen=new Set<string>(),tokens=new Set<string>();let pageToken:string|undefined;
  for(let page=0;page<100;page++){
   const p=search(read,entity,fields,where);if(pageToken)(p.body as JsonObject).pageToken=pageToken;
   const result=await request(p),d=result.data as JsonObject;
   if(++count>300||result.status!==200||!object(d)||Object.keys(d).some(k=>/error|fail/i.test(k)&&d[k]!=null)||d.success===false||d.hasMore===true||d.has_more===true||d.results!==undefined&&!Array.isArray(d.results)||d.nextPageToken!==undefined&&typeof d.nextPageToken!=='string')stateError('A feed snapshot returned a failed, malformed or unbounded response.');
   bytes+=Buffer.byteLength(JSON.stringify(d));if(bytes>16*1024*1024)stateError('Feed snapshot exceeds the 16 MiB read budget.');
   for(const row of d.results??[]){const r=row?.[camel(entity)];if(!object(r)||typeof r.resourceName!=='string'||seen.has(r.resourceName))stateError('Feed snapshot contains a missing or duplicate identity.');validate(r);seen.add(r.resourceName);rows.push(r);if(rows.length>1000)stateError('Feed snapshot exceeds 1,000 resources.');}
   if(!d.nextPageToken)return rows.sort((a,b)=>a.resourceName.localeCompare(b.resourceName,'en'));
   if(tokens.has(d.nextPageToken))stateError('Feed snapshot repeated a pagination cursor.');tokens.add(d.nextPageToken);pageToken=d.nextPageToken;
  }
  return stateError('Feed snapshot exceeded its pagination bound.');
 };
 const loadSet=async(name:string)=>{nativeName(read,name,'assetSets');const rows=await query('asset_set',googleAssetSetFields,namesQuery('asset_set',[name]),r=>{if(r.resourceName!==name||r.status!=='ENABLED'||typeof r.name!=='string'||!r.name||typeof r.type!=='string')stateError('The exact feed must exist and be enabled.');});if(rows.length!==1)stateError('The exact feed was not returned.');return assetSetObserved('asset_set',rows[0]!);};
 const loadLinks=(name:string)=>query('asset_set_asset',['asset_set','asset','status'],"asset_set_asset.asset_set = '"+name+"' AND asset_set_asset.status = 'ENABLED'",r=>{const asset=nativeName(read,r.asset,'assets');if(r.assetSet!==name||r.status!=='ENABLED'||r.resourceName!==account+'/assetSetAssets/'+name.split('/').at(-1)+'~'+asset.split('/').at(-1))stateError('Feed membership returned a foreign association.');});
 const snapshots:JsonObject[]=[],pending=[...initialNames],seenSets=new Set<string>();
 for(const name of pending){
  if(seenSets.has(name))continue;seenSets.add(name);if(seenSets.size>100)stateError('Feed snapshot exceeds 100 related sets.');
  const set=await loadSet(name),links=await loadLinks(name),assets:JsonObject[]=[],expectedType=locationTypes.includes(set.type)?'LOCATION':set.type;
  if(!googleFeedAssetFields[expectedType]&&links.length)stateError('This feed contains assets without a qualified content read.');
  const names=links.map(l=>l.asset);
  for(let i=0;i<names.length;i+=100){const batch=names.slice(i,i+100),got=await query('asset',googleFeedFields,namesQuery('asset',batch),r=>{nativeName(read,r.resourceName,'assets');if(!batch.includes(r.resourceName)||r.type!==expectedType)stateError('Feed content has an unexpected identity or asset type.');});if(got.length!==batch.length)stateError('The provider omitted feed asset content.');assets.push(...got.map(a=>assetSetCanonical(a)));}
  const parent=set.locationGroupParentAssetSetId;if(parent!==undefined){if(!id(parent)||parent===name.split('/').at(-1))stateError('A location group has an invalid parent.');pending.push(account+'/assetSets/'+parent);}
  // A stable second membership/config read detects edits during fan-out too.
  if(stable(set)!==stable(await loadSet(name))||stable(links)!==stable(await loadLinks(name)))throw new MirrorError('STATE_CHANGED','The feed changed while its complete snapshot was being read. Prepare again.');
  snapshots.push({assetSet:set,links,assets:assets.sort((a,b)=>a.resourceName.localeCompare(b.resourceName,'en'))});
 }
 const data={amcpAssetSetContents:snapshots.sort((a,b)=>a.assetSet.resourceName.localeCompare(b.assetSet.resourceName,'en'))};
 if(Buffer.byteLength(JSON.stringify(data))>8*1024*1024)stateError('Feed snapshot exceeds the 8 MiB retained-state bound.');
 return {status:200,headers:{},data};
}
export function validateAssetSetContents(read:CompiledRequest,result:TransportResult):void{
 const data=result.data as JsonObject;if(result.status!==200||!Array.isArray(data?.amcpAssetSetContents)||read.googleAssetSetState!.names.some(n=>!data.amcpAssetSetContents.some((s:JsonObject)=>s.assetSet?.resourceName===n)))stateError('The complete feed snapshot is unavailable.');
}
export function validateAssetSetPrerequisites(p:CompiledRequest,states:unknown[]):void{
 const k=kind(p);if(!k)return;
 const snapshots=states.flatMap(s=>(s as JsonObject)?.amcpAssetSetContents??[]) as JsonObject[],find=(name:string)=>snapshots.find(s=>s.assetSet.resourceName===name),ops=googleJson(p.body).operations;
 const baseRows=states.flatMap(s=>(s as JsonObject)?.results??[]);
 for(const s of snapshots){
  const first=baseRows.map(row=>row.assetSet).find(row=>row?.resourceName===s.assetSet.resourceName);
  if(first&&stable(assetSetObserved('asset_set',first))!==stable(s.assetSet))throw new MirrorError('STATE_CHANGED','Feed configuration changed between the scoped reference and complete-content reads. Prepare again.');
  const parent=s.assetSet.locationGroupParentAssetSetId;
  if(locationTypes.includes(s.assetSet.type)&&s.assetSet.type!=='LOCATION_SYNC'&&(!parent||find('customers/'+p.accountId+'/assetSets/'+parent)?.assetSet.type!=='LOCATION_SYNC'))invalid('A location group must have one existing LOCATION_SYNC parent.');
 }
 for(const op of ops){const r=op.create??op.update??{};
  if(k==='assetSets'){
   const target=op.update?find(op.update.resourceName)?.assetSet:op.create;
   if(op.update?.merchantCenterFeed&&target?.type!=='MERCHANT_CENTER_FEED'||op.update?.businessProfileLocationGroup&&target?.type!=='BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP')invalid('The changed feed settings do not match the existing asset-set type.');
   if(op.update?.merchantCenterFeed&&op.updateMask.split(',').includes('merchantCenterFeed')&&!id(String(op.update.merchantCenterFeed.merchantId)))invalid('Replacing merchantCenterFeed requires its merchantId.');
   if(op.create?.locationGroupParentAssetSetId){const parent=find('customers/'+p.accountId+'/assetSets/'+r.locationGroupParentAssetSetId);if(parent?.assetSet.type!=='LOCATION_SYNC')invalid('A location group requires an existing LOCATION_SYNC parent.');if(r.type==='BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP'&&parent!.assetSet.locationSet?.locationOwnershipType!=='BUSINESS_OWNER')invalid('A Business Profile group requires an owned-location parent.');}
  }else{
   const setName=op.create?.assetSet??'customers/'+p.accountId+'/assetSets/'+(op.remove.split('/').at(-1).split('~')[k==='assetSetAssets'?0:k==='customerAssetSets'?0:1]),snapshot=find(setName),type=snapshot?.assetSet.type;
   if(!snapshot)stateError('The referenced feed snapshot is unavailable.');
   if(op.create&&k==='customerAssetSets'&&type!=='LOCATION_SYNC')invalid('CustomerAssetSet accepts a LOCATION_SYNC set.');
   if(op.create&&k==='adGroupAssetSets'&&!locationTypes.includes(type))invalid('AdGroupAssetSet requires a location feed/group; page and dynamic feeds attach to campaigns.');
   if(k==='assetSetAssets'){
    if(!plainTypes.includes(type)&&type!=='STATIC_LOCATION_GROUP')invalid('Only advertiser-managed page/dynamic feeds and static location groups accept manual asset membership.');
    if(op.create){const assets=states.flatMap(s=>(s as JsonObject)?.results??[]).map(row=>row.asset).filter(Boolean),asset=assets.find(a=>a.resourceName===r.asset),expected=type==='STATIC_LOCATION_GROUP'?'LOCATION':type;
     if(asset?.type!==expected)invalid('The asset type must match the feed type.');
     if(type==='STATIC_LOCATION_GROUP'){const parent=find('customers/'+p.accountId+'/assetSets/'+snapshot!.assetSet.locationGroupParentAssetSetId);if(!parent?.links.some((l:JsonObject)=>l.asset===r.asset))invalid('The location must already belong to the exact sync parent of this static group.');}
    }
   }
  }
 }
}
