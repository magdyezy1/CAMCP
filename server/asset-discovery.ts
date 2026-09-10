import {NativeTransport,buildUrl} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import {CredentialProvider} from '../src/auth.js';
import type {Connection,Credentials,CompiledRequest,JsonObject} from '../src/types.js';
import {Store} from '../src/store.js';
import {platforms,selectionKind} from './platform-oauth.js';
import {microsoftCustomerOrigin} from '../src/microsoft-native.js';

export interface WorkspaceAsset {id:string;kind:string;name:string;parentId?:string;currency?:string;timezone?:string;status?:string;source:'vendor'|'configured_binding'}
export interface AssetGroup {checkedAt?:number;kind:string;assets:WorkspaceAsset[];complete:boolean;error?:string}
export class AssetDiscovery {
 private transport:NativeTransport;private credentials:CredentialProvider;
 constructor(private store:Store,fetcher:typeof fetch=fetch){this.transport=new NativeTransport(fetcher);if(fetcher===fetch)this.transport.coordination=store;this.credentials=new CredentialProvider(store,fetcher);}
 private plan(c:Connection,path:string,query:JsonObject={},method='GET',body?:unknown):CompiledRequest{return {gateway:c.gateway,action:'AMCP_ASSET_DISCOVERY',path,query,method,body,headers:c.gateway==='linkedin_native_action'?{'LinkedIn-Version':process.env.AMCP_LINKEDIN_API_VERSION??'202605','X-Restli-Protocol-Version':'2.0.0'}:{},readOnly:true,destructive:false,requiresConfirmation:false,evidence:'INDEPENDENT_ACCOUNT_DISCOVERY',warnings:[]};}
 private async pages(c:Connection,credentials:Credentials,path:string,query:JsonObject,extract:(data:JsonObject)=>unknown[],origin?:string):Promise<JsonObject[]>{
  const plan={...this.plan(c,path,query),...(origin?{origin}:{})},original=buildUrl(plan,c),items:JsonObject[]=[],seen=new Set<string>();
  for(let page=0;page<25;page++){
   const response=await this.transport.request(plan,c,credentials),data=response.data as JsonObject,rows=extract(data);
   if(!Array.isArray(rows))throw new MirrorError('ASSET_RESPONSE_INVALID','The provider returned an unexpected asset list.',{},502);
   if(rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw new MirrorError('ASSET_RESPONSE_INVALID','The provider returned an invalid asset record.',{},502);
   items.push(...rows as JsonObject[]);if(items.length>10000)throw new MirrorError('ASSET_SYNC_LIMIT','Too many assets for one sync; narrow the provider login.',{},409);
   const next=data.paging?.next??data.paging?.next_link??data.paging?.links?.find((l:JsonObject)=>l.rel==='next')?.href;
   const cursor=data.next_cursor??data.cursor?.next??null;
   if(data.nextPageToken!==undefined&&data.nextPageToken!==''){
    if(typeof data.nextPageToken!=='string'||seen.has('pageToken'+data.nextPageToken))throw new MirrorError('PAGINATION_LOOP','Provider returned an invalid or repeated page token.',{},502);
    seen.add('pageToken'+data.nextPageToken);plan.query.pageToken=data.nextPageToken;
   }else if(next){
    const nextUrl=new URL(next,original);if(nextUrl.origin!==original.origin||nextUrl.pathname!==original.pathname||nextUrl.username||nextUrl.password||nextUrl.hash)throw new MirrorError('UNSAFE_PAGINATION','Provider pagination changed the asset endpoint.',{},502);
    const cursorKey=['after','cursor','start','offset'].find(k=>nextUrl.searchParams.has(k));if(!cursorKey)throw new MirrorError('ASSET_SYNC_LIMIT','Provider paging does not expose a supported cursor.',{},409);
    const value=nextUrl.searchParams.get(cursorKey)!;if(seen.has(cursorKey+value))throw new MirrorError('PAGINATION_LOOP','Provider repeated its pagination cursor.',{},502);seen.add(cursorKey+value);plan.query[cursorKey]=value;
   }else if(cursor!==null&&cursor!==''&&cursor!==0&&cursor!=='0'){
    if(seen.has(String(cursor)))throw new MirrorError('PAGINATION_LOOP','Provider repeated its pagination cursor.',{},502);seen.add(String(cursor));plan.query.cursor=String(cursor);
   }else if(c.gateway==='linkedin_native_action'&&Number.isInteger(data.paging?.start)&&Number.isInteger(data.paging?.count)&&(typeof data.paging?.total==='number'?data.paging.start+rows.length<data.paging.total:rows.length===data.paging.count&&rows.length>0)){
    if(!rows.length||data.paging.count<1)throw new MirrorError('ASSET_RESPONSE_INVALID','LinkedIn returned inconsistent pagination.',{},502);
    const start=data.paging.start+data.paging.count;if(seen.has('start'+start))throw new MirrorError('PAGINATION_LOOP','Provider repeated its page offset.',{},502);seen.add('start'+start);plan.query.start=start;
   }else return items;
  }
  throw new MirrorError('ASSET_SYNC_LIMIT','Asset sync reached its page limit before completing.',{},409);
 }
 private asset(row:JsonObject,kind:string,parentId?:string):WorkspaceAsset{
  const raw=row.account_id??row.advertiser_id??row.id;if(raw===undefined||typeof raw==='number'&&!Number.isSafeInteger(raw))throw new MirrorError('ASSET_ID_INVALID','The provider returned an invalid asset identifier.',{},502);
  const id=String(raw).replace(kind==='ad_accounts'?/^act_/:/$^/,'');
  if(!id||id.length>300)throw new MirrorError('ASSET_ID_INVALID','The provider returned an invalid asset identifier.',{},502);
  return {id,kind,name:String(row.name??row.advertiser_name??row.username??id),parentId,currency:row.currency,timezone:row.timezone_name??row.timezone,status:row.account_status===undefined?row.status===undefined?undefined:String(row.status):String(row.account_status),source:'vendor'};
 }
 async sync(connection:Connection,kinds?:string[]):Promise<{groups:AssetGroup[];label?:string}>{
  const p=platforms.find(p=>p.gateway===connection.gateway);if(!p)throw new MirrorError('PLATFORM_NOT_FOUND','This connection is not supported by the website.',{},404);
  const selected=kinds??[selectionKind(connection.gateway)];if(selected.some(k=>!p.assetKinds.includes(k)))throw new MirrorError('ASSET_KIND_INVALID','This asset type is not available for the platform.');
  const credentials=await this.credentials.get(connection),groups:AssetGroup[]=[];let label:string|undefined;
  for(const kind of selected){
   try{
    let assets:WorkspaceAsset[]=[];
    if(p.id==='sheets'){const rows=await this.pages(connection,credentials,'/drive/v3/files',{q:"trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",pageSize:100,fields:'nextPageToken,incompleteSearch,files(id,name,capabilities(canEdit))'},d=>{if(d.incompleteSearch)throw new MirrorError('ASSET_SYNC_INCOMPLETE','Spreadsheet discovery is incomplete.');return d.files??[];});assets=rows.filter(r=>r.capabilities?.canEdit===true).map(r=>this.asset(r,kind));}else if(p.id==='drive'){
     const rows=await this.pages(connection,credentials,'/drive/v3/files',{q:"trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg' or mimeType = 'video/mp4' or mimeType = 'video/quicktime')",pageSize:100,fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,size,capabilities(canDownload))',supportsAllDrives:true,includeItemsFromAllDrives:true},d=>{if(d.incompleteSearch===true)throw new MirrorError('ASSET_SYNC_INCOMPLETE','Drive search was incomplete. Narrow the connected login.');return d.files??[];});
     assets=rows.filter(r=>r.capabilities?.canDownload===true).map(r=>this.asset(r,kind));
    }else if(p.id==='microsoft'){
     const read=async(path:string,body:JsonObject)=>{
      const plan={...this.plan(connection,path,{},'POST',body),action:'AMCP_MICROSOFT_DISCOVERY',origin:microsoftCustomerOrigin};
      const {data}=await this.transport.request(plan,connection,credentials);const d=data as JsonObject;
      if(d.Errors?.length||d.OperationErrors?.length)throw new MirrorError('ASSET_RESPONSE_INVALID','Microsoft account discovery failed.',{},502);return d;
     };
     const user=(await read('/CustomerManagement/v13/User/Query',{UserId:null})).User;
     if(typeof user?.Id!=='string'||! /^[1-9][0-9]*$/.test(user.Id))throw new MirrorError('ASSET_RESPONSE_INVALID','Microsoft did not return an authenticated user ID.',{},502);
     const seen=new Set<string>();let complete=false;
     for(let page=0;page<25;page++){
      const rows=(await read('/CustomerManagement/v13/Accounts/Search',{Predicates:[{Field:'UserId',Operator:'Equals',Value:user.Id}],Ordering:[{Field:'Id',Order:'Ascending'}],PageInfo:{Index:page,Size:100}})).Accounts;
      if(!Array.isArray(rows))throw new MirrorError('ASSET_RESPONSE_INVALID','Microsoft did not return Accounts.',{},502);
      for(const r of rows){if(typeof r?.Id!=='string'||! /^[1-9][0-9]*$/.test(r.Id)||typeof r.ParentCustomerId!=='string'||! /^[1-9][0-9]*$/.test(r.ParentCustomerId)||seen.has(r.Id))throw new MirrorError('ASSET_RESPONSE_INVALID','Microsoft returned an invalid or repeated account.',{},502);seen.add(r.Id);assets.push(this.asset({id:r.Id,name:r.Name,currency:r.CurrencyCode,timezone:r.TimeZone,status:r.AccountLifeCycleStatus},kind,r.ParentCustomerId));}
      if(rows.length<100){complete=true;break;}
     }
     if(!complete)throw new MirrorError('ASSET_SYNC_LIMIT','Microsoft account discovery reached its page limit; narrow the login.',{},409);
    }else if(p.id==='meta'){
     if(kind==='ad_accounts'){
      assets=(await this.pages(connection,credentials,'/v25.0/me/adaccounts',{fields:'id,account_id,name,account_status,currency,timezone_name',limit:100},d=>d.data)).map(r=>this.asset(r,kind));
      try{const identity=await this.transport.request(this.plan(connection,'/v25.0/me',{fields:'id,name'}),connection,credentials);if(typeof (identity.data as JsonObject).name==='string')label=(identity.data as JsonObject).name;}catch{/* Account discovery remains valid when identity profile access is unavailable. */}
     }else if(kind==='pages'||kind==='instagram'){
      const rows=await this.pages(connection,credentials,'/v25.0/me/accounts',{fields:'id,name,instagram_business_account{id,username}',limit:100},d=>d.data);
      assets=kind==='pages'?rows.map(r=>this.asset(r,kind)):rows.filter(r=>r.instagram_business_account).map(r=>this.asset(r.instagram_business_account,kind,String(r.id)));
     }else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select an ad account before syncing its assets.',{},409);
      const edge={pixels:'adspixels',catalogs:'product_catalogs',mobile_apps:'advertisable_applications',custom_conversions:'customconversions'}[kind];
      for(const id of connection.accounts){const rows=await this.pages(connection,credentials,'/v25.0/act_'+encodeURIComponent(id)+'/'+edge,{fields:'id,name',limit:100},d=>d.data);assets.push(...rows.map(r=>this.asset(r,kind,id)));}
     }
    }else if(p.id==='google'){
     const response=await this.transport.request(this.plan(connection,'/v23/customers:listAccessibleCustomers'),connection,credentials),names=(response.data as JsonObject).resourceNames;
     if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!/^customers\/\d+$/.test(n)))throw new MirrorError('ASSET_RESPONSE_INVALID','Google did not return a customer list.',{},502);
     assets=names.map((name:string)=>this.asset({id:name.split('/')[1],name:'Google Ads '+name.split('/')[1]},kind));
    }else if(p.id==='ga4'){
     if(kind==='properties'){
      const accounts=await this.pages(connection,credentials,'/v1beta/accountSummaries',{pageSize:200},d=>d.accountSummaries??[],'https://analyticsadmin.googleapis.com');
      for(const account of accounts){
       if(typeof account.account!=='string'||!/^accounts\/\d+$/.test(account.account)||account.propertySummaries!==undefined&&!Array.isArray(account.propertySummaries))throw new MirrorError('ASSET_RESPONSE_INVALID','GA4 returned an invalid account summary.',{},502);
       for(const row of account.propertySummaries??[]){if(typeof row?.property!=='string'||!/^properties\/\d+$/.test(row.property))throw new MirrorError('ASSET_ID_INVALID','GA4 returned an invalid property identifier.',{},502);assets.push(this.asset({id:row.property.slice(11),name:row.displayName},kind,account.account));}
      }
     }else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select GA4 properties before syncing their data streams.',{},409);
      for(const id of connection.accounts){if(!/^\d+$/.test(id))throw new MirrorError('ASSET_ID_INVALID','GA4 property identifiers must be numeric.',{},400);
       const rows=await this.pages(connection,credentials,'/v1beta/properties/'+id+'/dataStreams',{pageSize:200},d=>d.dataStreams??[],'https://analyticsadmin.googleapis.com');
       for(const row of rows){if(typeof row.name!=='string'||!new RegExp('^properties/'+id+'/dataStreams/\\d+$').test(row.name))throw new MirrorError('ASSET_ID_INVALID','GA4 returned a data stream outside the selected property.',{},502);assets.push(this.asset({id:row.name,name:row.displayName},kind,id));}
      }
     }
    }else if(p.id==='gtm'){
     if(kind==='tag_accounts'){
      const rows=await this.pages(connection,credentials,'/tagmanager/v2/accounts',{includeGoogleTags:true},d=>d.account??[]);
      assets=rows.map(row=>{if(typeof row.accountId!=='string'||!/^\d+$/.test(row.accountId))throw new MirrorError('ASSET_ID_INVALID','Tag Manager returned an invalid account identifier.',{},502);return this.asset({id:row.accountId,name:row.name},kind);});
     }else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select Tag Manager accounts before syncing their containers.',{},409);
      for(const id of connection.accounts){if(!/^\d+$/.test(id))throw new MirrorError('ASSET_ID_INVALID','Tag Manager account identifiers must be numeric.',{},400);
       const rows=await this.pages(connection,credentials,'/tagmanager/v2/accounts/'+id+'/containers',{},d=>d.container??[]);
       for(const row of rows){if(row.accountId!==id||typeof row.containerId!=='string'||!/^\d+$/.test(row.containerId))throw new MirrorError('ASSET_ID_INVALID','Tag Manager returned a container outside the selected account.',{},502);assets.push(this.asset({id:'accounts/'+id+'/containers/'+row.containerId,name:row.name??row.publicId},kind,id));}
      }
     }
    }else if(p.id==='gsc'){
     if(kind==='sites'){
      const rows=await this.pages(connection,credentials,'/webmasters/v3/sites',{},d=>d.siteEntry??[],'https://www.googleapis.com');
      assets=rows.filter(row=>row.permissionLevel!=='siteUnverifiedUser').map(row=>{if(typeof row.siteUrl!=='string'||!validSearchConsoleSite(row.siteUrl)||!['siteOwner','siteFullUser','siteRestrictedUser'].includes(row.permissionLevel))throw new MirrorError('ASSET_ID_INVALID','Search Console returned an invalid site or permission level.',{},502);return this.asset({id:row.siteUrl,name:row.siteUrl,status:row.permissionLevel},kind);});
     }else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select Search Console sites before syncing their sitemaps.',{},409);
      for(const id of connection.accounts){if(!validSearchConsoleSite(id))throw new MirrorError('ASSET_ID_INVALID','Search Console site identifier is invalid.',{},400);
       const rows=await this.pages(connection,credentials,'/webmasters/v3/sites/'+encodeURIComponent(id)+'/sitemaps',{},d=>d.sitemap??[],'https://www.googleapis.com');
       for(const row of rows){if(typeof row.path!=='string'||!/^https?:\/\//.test(row.path))throw new MirrorError('ASSET_ID_INVALID','Search Console returned an invalid sitemap path.',{},502);assets.push(this.asset({id:row.path,name:row.path},kind,id));}
      }
     }
    }else if(p.id==='apple'){
     const rows=await this.pages(connection,credentials,'/v1/acls',{},d=>d.result?.acls,'https://api.ads.apple.com');
     assets=rows.map(row=>{const account=row.adAccount,id=account?.id;if((typeof id!=='string'&&typeof id!=='number')||!/^\d+$/.test(String(id))||!Array.isArray(row.roles)||row.roles.some((role:unknown)=>typeof role!=='string'))throw new MirrorError('ASSET_ID_INVALID','Apple Ads returned an invalid ad-account ACL.',{},502);return this.asset({id,name:account.name,status:row.roles.join(', ')},kind,account.orgId===undefined?undefined:String(account.orgId));});
    }else if(p.id==='tiktok'){
     if(kind==='ad_accounts'){
      if(!credentials.clientId||!credentials.clientSecret)throw new MirrorError('PROVIDER_SETUP_REQUIRED','TikTok account discovery requires its app credentials.',{},409);
      const result=await this.transport.request(this.plan(connection,'/v1.3/oauth2/advertiser/get/',{app_id:credentials.clientId,secret:credentials.clientSecret}),connection,credentials),rows=(result.data as JsonObject).data?.list;
      if(!Array.isArray(rows))throw new MirrorError('ASSET_RESPONSE_INVALID','TikTok did not return an advertiser list.',{},502);assets=rows.map((r:JsonObject)=>this.asset(r,kind));
     }else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select an advertiser before syncing its assets.',{},409);
      for(const id of connection.accounts){const result=await this.transport.request(this.plan(connection,kind==='pixels'?'/v1.3/pixel/list/':'/v1.3/identity/get/',{advertiser_id:id,page:1,page_size:100}),connection,credentials),data=(result.data as JsonObject).data,rows=data?.pixels??data?.identity_list??data?.list;
       if(!Array.isArray(rows))throw new MirrorError('ASSET_RESPONSE_INVALID','TikTok did not return the requested assets.',{},502);if(data.page_info?.total_page>1)throw new MirrorError('ASSET_SYNC_LIMIT','This TikTok asset list requires further pagination.',{},409);
       assets.push(...rows.map((r:JsonObject)=>this.asset({...r,id:r.pixel_id??r.identity_id??r.id,name:r.pixel_name??r.display_name??r.name},kind,id)));}
     }
    }else if(p.id==='snapchat'){
     const organizations=await this.pages(connection,credentials,'/v1/me/organizations',{},d=>d.organizations.map((r:JsonObject)=>r.organization));
     for(const org of organizations){
      const edge=kind==='ad_accounts'?'adaccounts':kind==='profiles'?'public_profiles':kind;
      const rows=await this.pages(connection,credentials,'/v1/organizations/'+encodeURIComponent(String(org.id))+'/'+edge,{},d=>d[edge].map((r:JsonObject)=>r[edge==='adaccounts'?'adaccount':edge==='public_profiles'?'public_profile':edge==='mobile_apps'?'mobile_app':edge.replace(/s$/,'')]));
      assets.push(...rows.map(r=>this.asset(r,kind,String(org.id))));
     }
    }else if(p.id==='linkedin'){
     const rows=await this.pages(connection,credentials,'/rest/adAccountUsers',{q:'authenticatedUser',count:100,start:0},d=>d.elements);
     assets=rows.map(r=>{const id=String(r.account??'').replace(/^urn:li:sponsoredAccount:/,'');if(!/^\d+$/.test(id))throw new MirrorError('ASSET_ID_INVALID','LinkedIn returned an invalid account URN.',{},502);return this.asset({id,name:'LinkedIn Ads '+id,status:r.role},kind);});
    }else if(p.id==='x'){
     if(kind==='ad_accounts')assets=(await this.pages(connection,credentials,'/12/accounts',{count:200},d=>d.data)).map(r=>this.asset(r,kind));
     else{
      if(!connection.accounts.length)throw new MirrorError('SELECT_ACCOUNT_FIRST','Select an ad account before syncing its assets.',{},409);
      const edge=kind==='profiles'?'promotable_users':kind==='pixels'?'website_tags':'app_lists';
      for(const id of connection.accounts){const rows=await this.pages(connection,credentials,'/12/accounts/'+encodeURIComponent(id)+'/'+edge,{count:200},d=>d.data);assets.push(...rows.map(r=>this.asset({...r,id:r.id??r.user_id,name:r.name??r.screen_name},kind,id)));}
     }
    }else throw new MirrorError('ASSET_DISCOVERY_UNAVAILABLE','Asset discovery has not been implemented for this provider.',{},501);
    const unique=new Map(assets.map(a=>[a.kind+':'+a.id,a]));groups.push({kind,assets:[...unique.values()],complete:true});
   }catch(e){groups.push({kind,assets:[],complete:false,error:e instanceof MirrorError?e.message:'Asset sync failed. Reconnect or check the provider permissions.'});}
  }
  return {groups,label};
 }
}
function validSearchConsoleSite(value:string):boolean{
 if(value.startsWith('sc-domain:')){const domain=value.slice(10);return domain.length>0&&domain.length<=253&&/^[a-z0-9.-]+$/i.test(domain)&&!domain.includes('..');}
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}
}
