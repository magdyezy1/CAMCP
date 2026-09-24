import fs from 'node:fs';
import {createHash} from 'node:crypto';
const hash=document=>createHash('sha256').update(JSON.stringify(document)).digest('hex');
const google=(name,version)=>'https://www.googleapis.com/discovery/v1/apis/'+name+'/'+version+'/rest';
const service=(name,version)=>'https://'+name+'.googleapis.com/$discovery/rest?version='+version;
const sources={
 'google-ads-v23':service('googleads','v23'),
 'gtm-v2':google('tagmanager','v2'),
 'ga4-data-v1beta':service('analyticsdata','v1beta'),
 'ga4-data-v1alpha':service('analyticsdata','v1alpha'),
 'ga4-admin-v1beta':service('analyticsadmin','v1beta'),
 'search-console-v1':google('searchconsole','v1'),
 'business-accounts-v1':service('mybusinessaccountmanagement','v1'),
 'business-info-v1':service('mybusinessbusinessinformation','v1'),
 'business-performance-v1':service('businessprofileperformance','v1'),
 'business-verifications-v1':service('mybusinessverifications','v1'),
 'business-notifications-v1':service('mybusinessnotifications','v1'),
 'business-lodging-v1':service('mybusinesslodging','v1'),
 'business-place-actions-v1':service('mybusinessplaceactions','v1'),
 'criteo-retail-2026-01':'https://api.criteo.com/2026-01/retailmedia/open-api-specifications.json',
 'reddit-v3':'https://ads-api.reddit.com/api/v3/openapi.json'
};
fs.mkdirSync('.mirror/VENDOR',{recursive:true});
const results=process.argv.includes('--generate-only')?[]:await Promise.allSettled(Object.entries(sources).map(async([name,url])=>{
 const file='.mirror/VENDOR/'+name+'.json';if(fs.existsSync(file)&&!process.argv.includes('--refresh'))return {name,cached:true};
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(name+' HTTP '+response.status);
 const document=await response.json();if(!document.resources&&!document.paths)throw Error(name+' unexpected schema');
 fs.writeFileSync(file,JSON.stringify({source:url,captured_at:new Date().toISOString(),evidence:'VENDOR_DOCUMENTED_NOT_AMCP_OBSERVED',document_sha256:hash(document),document},null,2)+'\n');return {name,version:document.version??document.info?.version};
}));
for(const r of results)console.log(r.status==='fulfilled'?r.value:String(r.reason));
if(results.some(r=>r.status==='rejected'))process.exitCode=1;

// These are vendor-documented request routes, not observed AMCP execution envelopes.
const registry=JSON.parse(fs.readFileSync('generated/registry.json','utf8'));
const docs=new Map(Object.keys(sources).filter(n=>fs.existsSync('.mirror/VENDOR/'+n+'.json')).map(n=>[n,JSON.parse(fs.readFileSync('.mirror/VENDOR/'+n+'.json','utf8'))]));
for(const [name,envelope] of docs){
 if(envelope.source!==sources[name])throw Error('Unexpected vendor source URL: '+name);
 if(envelope.document_sha256&&envelope.document_sha256!==hash(envelope.document))throw Error('Vendor snapshot integrity mismatch: '+name);
}
const methods=new Map();
for(const [file,envelope] of docs){
 const d=envelope.document,found=[];
 function visit(r){for(const m of Object.values(r.methods??{}))found.push(m);for(const nested of Object.values(r.resources??{}))visit(nested);}
 visit(d);methods.set(file,new Map(found.map(m=>[m.id,m])));
}
const routes=[],gaps=[];
function add(gateway,operation,action,file,id,readOnly){
 const envelope=docs.get(file),d=envelope?.document,m=methods.get(file)?.get(id);
 if(!m){gaps.push({gateway,operation,action,reason:'Vendor discovery method unavailable',vendorMethod:id});return;}
 const ref=m.request?.$ref,requestSchema=ref?d.schemas?.[ref]:undefined;
 routes.push({gateway,operation,action,vendorMethod:id,source:envelope.source,sourceFile:file,origin:new URL(d.rootUrl).origin,path:'/'+(d.servicePath??'')+m.path,...(gateway==='google_ads_native_action'?{routeKind:'native',flatPath:'/'+(m.flatPath??m.path)}:{}),method:m.httpMethod,readOnly:readOnly??['GET','HEAD'].includes(m.httpMethod),parameters:{...d.parameters,...m.parameters},requestSchema,requestRef:ref,bodyRequired:!!m.request,scopes:m.scopes??[],evidence:'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING'});
}
// Bind only existing native RPC routes with an exact verb and normalized path.
// Discovery does not automatically expose new methods or grant reviewed writes.
const ads=docs.get('google-ads-v23');
if(!ads||ads.document.name!=='googleads'||ads.document.version!=='v23')throw Error('Fetch the official Google Ads v23 Discovery document before generation.');
const routeKey=(method,path)=>method.toUpperCase()+' /'+path.replace(/^\//,'').replace(/\{[^}=]+=([^}]+)\}/g,(_match,pattern)=>pattern.replaceAll('*','{}')).replace(/\{[^}]+\}/g,'{}');
for(const action of registry.catalogs.find(c=>c.gateway==='google_ads_native_action').actions.filter(a=>a.raw.surface==='rpc')){
 const found=[...methods.get('google-ads-v23').values()].filter(m=>routeKey(m.httpMethod,m.flatPath??m.path)===routeKey(action.method,action.path));
 if(found.length!==1)throw Error('Google Ads native RPC must map to exactly one official method: '+action.name);
 add('google_ads_native_action','',action.name,'google-ads-v23',found[0].id,action.read_only);
}
const gtm='gtm_native_action',gtmPrefix='tagmanager.accounts';
const nounResources={ACCOUNT:'accounts',USER_PERMISSION:'accounts.user_permissions',CONTAINER:'accounts.containers',DESTINATION:'accounts.containers.destinations',WORKSPACE:'accounts.containers.workspaces',VARIABLE:'accounts.containers.workspaces.variables',TRIGGER:'accounts.containers.workspaces.triggers',TAG:'accounts.containers.workspaces.tags',GTAG_CONFIG:'accounts.containers.workspaces.gtag_config',TEMPLATE:'accounts.containers.workspaces.templates',FOLDER:'accounts.containers.workspaces.folders',ZONE:'accounts.containers.workspaces.zones',CLIENT:'accounts.containers.workspaces.clients',TRANSFORMATION:'accounts.containers.workspaces.transformations',CONTAINER_VERSION:'accounts.containers.versions',ENVIRONMENT:'accounts.containers.environments'};
const gtmMap={};
for(const [noun,resource] of Object.entries(nounResources))for(const verb of ['GET','CREATE','UPDATE','DELETE','REVERT','LIST'])gtmMap[verb+'_'+noun+(verb==='LIST'?'S':'')]='tagmanager.'+resource+'.'+verb.toLowerCase();
Object.assign(gtmMap,{
 GET_CONTAINER_SNIPPET:gtmPrefix+'.containers.snippet',LOOKUP_CONTAINER:gtmPrefix+'.containers.lookup',COMBINE_CONTAINERS:gtmPrefix+'.containers.combine',MOVE_TAG_ID:gtmPrefix+'.containers.move_tag_id',LINK_DESTINATION:gtmPrefix+'.containers.destinations.link',
 SYNC_WORKSPACE:gtmPrefix+'.containers.workspaces.sync',GET_WORKSPACE_STATUS:gtmPrefix+'.containers.workspaces.getStatus',BULK_UPDATE_WORKSPACE:gtmPrefix+'.containers.workspaces.bulk_update',RESOLVE_WORKSPACE_CONFLICT:gtmPrefix+'.containers.workspaces.resolve_conflict',QUICK_PREVIEW:gtmPrefix+'.containers.workspaces.quick_preview',CREATE_CONTAINER_VERSION:gtmPrefix+'.containers.workspaces.create_version',
 CREATE_BUILT_IN_VARIABLES:gtmPrefix+'.containers.workspaces.built_in_variables.create',DELETE_BUILT_IN_VARIABLES:gtmPrefix+'.containers.workspaces.built_in_variables.delete',LIST_BUILT_IN_VARIABLES:gtmPrefix+'.containers.workspaces.built_in_variables.list',REVERT_BUILT_IN_VARIABLE:gtmPrefix+'.containers.workspaces.built_in_variables.revert',
 IMPORT_TEMPLATE_FROM_GALLERY:gtmPrefix+'.containers.workspaces.templates.import_from_gallery',LIST_FOLDER_ENTITIES:gtmPrefix+'.containers.workspaces.folders.entities',MOVE_ENTITIES_TO_FOLDER:gtmPrefix+'.containers.workspaces.folders.move_entities_to_folder',
 UNDELETE_CONTAINER_VERSION:gtmPrefix+'.containers.versions.undelete',PUBLISH_CONTAINER_VERSION:gtmPrefix+'.containers.versions.publish',SET_LATEST_CONTAINER_VERSION:gtmPrefix+'.containers.versions.set_latest',GET_LIVE_VERSION:gtmPrefix+'.containers.versions.live',LIST_VERSION_HEADERS:gtmPrefix+'.containers.version_headers.list',GET_LATEST_VERSION_HEADER:gtmPrefix+'.containers.version_headers.latest',REAUTHORIZE_ENVIRONMENT:gtmPrefix+'.containers.environments.reauthorize'
});
for(const action of registry.tools.find(t=>t.name===gtm).operations.find(o=>o.operation==='gtm_ops').argumentsSchema.properties.action.enum)add(gtm,'gtm_ops',action,'gtm-v2',gtmMap[action]??'UNMAPPED',action==='LIST_FOLDER_ENTITIES'?true:undefined);

const ga4='ga4_native_action',data='analyticsdata.properties.';
for(const [operation,action,file,method,readOnly] of [
 ['ga4_run_report','', 'ga4-data-v1beta','runReport',true],
 ['ga4_data_report','batch_run_reports','ga4-data-v1beta','batchRunReports',true],['ga4_data_report','realtime','ga4-data-v1beta','runRealtimeReport',true],['ga4_data_report','pivot','ga4-data-v1beta','runPivotReport',true],['ga4_data_report','batch_pivot','ga4-data-v1beta','batchRunPivotReports',true],['ga4_data_report','funnel','ga4-data-v1alpha','runFunnelReport',true],['ga4_data_report','quota_snapshot','ga4-data-v1alpha','getPropertyQuotasSnapshot',true],
 ['ga4_metadata_ops','get_metadata','ga4-data-v1beta','getMetadata',true],['ga4_metadata_ops','check_compatibility','ga4-data-v1beta','checkCompatibility',true],
 ['ga4_create_audience_export','','ga4-data-v1beta','audienceExports.create',false],['ga4_create_report_task','','ga4-data-v1alpha','reportTasks.create',false],
 ...['get','list','query'].map(v=>['ga4_audience_export_ops',v,'ga4-data-v1beta','audienceExports.'+v,true]),...['get','list','query'].map(v=>['ga4_report_task_ops',v,'ga4-data-v1alpha','reportTasks.'+v,true])
])add(ga4,operation,action,file,data+method,readOnly);
add(ga4,'ga4_list_properties','','ga4-admin-v1beta','analyticsadmin.accountSummaries.list',true);

const gsc='google_search_console_native_action';
for(const [action,method] of Object.entries({LIST_SITES:'sites.list',GET_SITE:'sites.get',ADD_SITE:'sites.add',DELETE_SITE:'sites.delete',LIST_SITEMAPS:'sitemaps.list',GET_SITEMAP:'sitemaps.get',SUBMIT_SITEMAP:'sitemaps.submit',DELETE_SITEMAP:'sitemaps.delete'}))add(gsc,'gsc_site_ops',action,'search-console-v1','webmasters.'+method);
add(gsc,'gsc_site_ops','INSPECT_URL','search-console-v1','searchconsole.urlInspection.index.inspect',true);
add(gsc,'gsc_analytics_ops','QUERY_SEARCH_ANALYTICS','search-console-v1','webmasters.searchanalytics.query',true);

const gmb='google_business_native_action';
const businessMappings={
 'business-accounts-v1':{gmb_account_ops:{LIST_ACCOUNTS:'accounts.list',CREATE_ACCOUNT:'accounts.create',GET_ACCOUNT:'accounts.get',PATCH_ACCOUNT:'accounts.patch',LIST_ACCOUNT_INVITATIONS:'accounts.invitations.list',ACCEPT_ACCOUNT_INVITATION:'accounts.invitations.accept',DECLINE_ACCOUNT_INVITATION:'accounts.invitations.decline',LIST_ACCOUNT_ADMINS:'accounts.admins.list',CREATE_ACCOUNT_ADMIN:'accounts.admins.create',PATCH_ACCOUNT_ADMIN:'accounts.admins.patch',DELETE_ACCOUNT_ADMIN:'accounts.admins.delete',LIST_LOCATION_ADMINS:'locations.admins.list',CREATE_LOCATION_ADMIN:'locations.admins.create',PATCH_LOCATION_ADMIN:'locations.admins.patch',DELETE_LOCATION_ADMIN:'locations.admins.delete',TRANSFER_LOCATION:'locations.transfer'}},
 'business-info-v1':{gmb_catalog_ops:{LIST_ATTRIBUTES:'attributes.list',LIST_CATEGORIES:'categories.list',BATCH_GET_CATEGORIES:'categories.batchGet',GET_CHAIN:'chains.get',SEARCH_CHAINS:'chains.search'},gmb_location_ops:{LIST_ACCOUNT_LOCATIONS:'accounts.locations.list',CREATE_ACCOUNT_LOCATION:'accounts.locations.create',GET_LOCATION:'locations.get',PATCH_LOCATION:'locations.patch',DELETE_LOCATION:'locations.delete',GET_GOOGLE_UPDATED_LOCATION:'locations.getGoogleUpdated',GET_LOCATION_ATTRIBUTES:'locations.getAttributes',UPDATE_LOCATION_ATTRIBUTES:'locations.updateAttributes',GET_GOOGLE_UPDATED_LOCATION_ATTRIBUTES:'locations.attributes.getGoogleUpdated',SEARCH_GOOGLE_LOCATIONS:'googleLocations.search'}},
 'business-performance-v1':{gmb_performance_ops:{GET_DAILY_METRICS_TIME_SERIES:'locations.getDailyMetricsTimeSeries',FETCH_MULTI_DAILY_METRICS_TIME_SERIES:'locations.fetchMultiDailyMetricsTimeSeries',LIST_SEARCH_KEYWORD_IMPRESSIONS_MONTHLY:'locations.searchkeywords.impressions.monthly.list'}},
 'business-verifications-v1':{gmb_verification_ops:{GET_VOICE_OF_MERCHANT_STATE:'locations.getVoiceOfMerchantState',FETCH_VERIFICATION_OPTIONS:'locations.fetchVerificationOptions',VERIFY_LOCATION:'locations.verify',LIST_VERIFICATIONS:'locations.verifications.list',COMPLETE_VERIFICATION:'locations.verifications.complete',GENERATE_VERIFICATION_TOKEN:'verificationTokens.generate'}},
 'business-notifications-v1':{gmb_notification_ops:{GET_NOTIFICATION_SETTING:'accounts.getNotificationSetting',UPDATE_NOTIFICATION_SETTING:'accounts.updateNotificationSetting'}},
 'business-lodging-v1':{gmb_lodging_ops:{GET_LODGING:'locations.getLodging',UPDATE_LODGING:'locations.updateLodging',GET_GOOGLE_UPDATED_LODGING:'locations.lodging.getGoogleUpdated'}},
 'business-place-actions-v1':{gmb_engagement_ops:{LIST_PLACE_ACTION_TYPE_METADATA:'placeActionTypeMetadata.list',LIST_PLACE_ACTION_LINKS:'locations.placeActionLinks.list',GET_PLACE_ACTION_LINK:'locations.placeActionLinks.get',CREATE_PLACE_ACTION_LINK:'locations.placeActionLinks.create',PATCH_PLACE_ACTION_LINK:'locations.placeActionLinks.patch',DELETE_PLACE_ACTION_LINK:'locations.placeActionLinks.delete'}}
};
for(const [file,ops] of Object.entries(businessMappings))for(const [operation,actions] of Object.entries(ops))for(const [action,suffix] of Object.entries(actions))add(gmb,operation,action,file,docs.get(file)?.document.name+'.'+suffix,['SEARCH_GOOGLE_LOCATIONS','FETCH_VERIFICATION_OPTIONS'].includes(action)?true:undefined);

const criteo=docs.get('criteo-retail-2026-01'),normal=x=>x.replace(/[^a-z0-9]/gi,'').toLowerCase();
const criteoMethods=Object.entries(criteo.document.paths).flatMap(([path,item])=>Object.entries(item).filter(([method,op])=>op.operationId&&['get','post','put','patch','delete','head'].includes(method)).map(([method,op])=>({path,method:method.toUpperCase(),op,parameters:[...(item.parameters??[]),...(op.parameters??[])]})));
const readPost=new Set(['AccountFeesSearch','SearchSellers','SearchBrands','searchAudienceSegments','searchAudiences','SearchAccountRetailers','GetCpcMinBidsBySkuIdsV1','GetRecommendedCategories','SearchCategory','RecommendedKeywords','SearchAccountCreatives']);
// Captured legacy names bind to these exact 2026.01 operation IDs. Never strip
// arbitrary version suffixes or classify report submission as a retryable read.
const criteoCampaignResponses=new Set(['CreateCampaignsByAccountId','UpdateCampaignByCampaignId']);
const criteoReportAliases={GENERATE_ASYNC_ACCOUNTS_REPORT:'GenerateAsyncAccountsReportV2',GENERATE_ASYNC_CAMPAIGNS_REPORT:'GenerateAsyncCampaignsReportV2',GENERATE_ASYNC_LINE_ITEMS_REPORT:'GenerateAsyncLineItemsReportV2'};
for(const op of registry.tools.find(t=>t.name==='criteo_native_action').operations)for(const action of op.argumentsSchema.properties.action.enum){
 const found=criteoMethods.filter(m=>normal(m.op.operationId)===normal(criteoReportAliases[action]??action));
 if(found.length!==1){gaps.push({gateway:'criteo_native_action',operation:op.operation,action,reason:found.length?'Ambiguous vendor operation IDs':'No exact vendor operation ID; request shape is not inferred'});continue;}
 const m=found[0],content=m.op.requestBody?.content??{},json=content['application/json'];
 const responseSchemas=criteoCampaignResponses.has(m.op.operationId)?Object.fromEntries(Object.entries(m.op.responses??{}).filter(([status])=>/^2\d\d$/.test(status)).map(([status,response])=>[status,response.content?.['application/json']?.schema]).filter(([,schema])=>schema)):undefined;
 routes.push({gateway:'criteo_native_action',operation:op.operation,action,vendorMethod:m.op.operationId,source:criteo.source,sourceFile:'criteo-retail-2026-01',origin:'https://api.criteo.com',path:m.path,method:m.method,readOnly:['GET','HEAD'].includes(m.method)||readPost.has(m.op.operationId),parameters:Object.fromEntries(m.parameters.map(p=>[p.name,{...p,...p.schema,location:p.in}])),requestSchema:json?.schema,...(responseSchemas?{responseSchemas}:{}),bodyRequired:m.op.requestBody?.required===true,scopes:[],...(Object.keys(content).length&&!json?{unsupportedMedia:Object.keys(content)}:{}),evidence:'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING'});
}
const reddit=docs.get('reddit-v3');
if(!reddit)throw Error('Fetch the official Reddit OpenAPI document before generation.');
const redditAliases={FETCH_CAMPAIGNS:'List Campaigns',FETCH_AD_GROUPS:'List Ad Groups',FETCH_ADGROUPS:'List Ad Groups',FETCH_ADS:'List Ads',LIST_PIXELS:'List Pixels By Ad Account',LIST_CUSTOM_AUDIENCES:'List User Custom Audiences',FETCH_POSTS:'List Posts',FETCH_POSTS_BY_PROFILE:'List Posts',LIST_POSTS_BY_PROFILE:'List Posts',CREATE_STRUCTURED_POST_JOB:'Create Structured Post Creation Job',GET_STRUCTURED_POST_JOB:'Get Structured Post Creation Job',GET_INSIGHTS:'Get A Report'};
const resolveReddit=value=>value?.$ref?value.$ref.slice(2).split('/').reduce((o,key)=>o[key.replaceAll('~1','/').replaceAll('~0','~')],reddit.document):value;
const redditMethods=Object.entries(reddit.document.paths).flatMap(([path,item])=>Object.entries(item).filter(([,op])=>op.operationId).map(([method,op])=>({path,method:method.toUpperCase(),op,parameters:[...(item.parameters??[]),...(op.parameters??[])].map(resolveReddit)})));
for(const op of registry.tools.find(t=>t.name==='reddit_native_action').operations)for(const action of op.argumentsSchema.properties.action.enum){
 const found=redditMethods.filter(m=>normal(m.op.operationId)===normal(redditAliases[action]??action));
 if(found.length!==1)throw Error('Reddit mapping must resolve exactly once: '+action);
 const m=found[0],server=new URL(reddit.document.servers[0].url),request=resolveReddit(m.op.requestBody),json=request?.content?.['application/json'];
 const responseSchemas=Object.fromEntries(Object.entries(m.op.responses??{}).filter(([status])=>/^2\d\d$/.test(status)).map(([status,response])=>[status,resolveReddit(response)?.content?.['application/json']?.schema]).filter(([,schema])=>schema));
 routes.push({gateway:'reddit_native_action',operation:op.operation,action,vendorMethod:m.op.operationId,source:reddit.source,sourceFile:'reddit-v3',origin:server.origin,path:server.pathname+m.path,method:m.method,readOnly:m.method==='GET'||m.op.operationId==='Get A Report',parameters:Object.fromEntries(m.parameters.map(p=>[p.name,{...p,...resolveReddit(p.schema),location:p.in}])),requestSchema:json?.schema,responseSchemas,bodyRequired:request?.required===true||!!json,scopes:m.op.security?.flatMap(s=>Object.values(s).flat())??[],evidence:'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING'});
}
// Retain only the transitive schema definitions used by the qualified campaign
// requests/responses. The source vendor capture remains the provenance anchor.
const criteoSchemas={},retainCriteoSchema=value=>{
 if(!value||typeof value!=='object')return;
 if(typeof value.$ref==='string'&&value.$ref.startsWith('#/components/schemas/')){
  const name=value.$ref.slice('#/components/schemas/'.length);
  if(!Object.hasOwn(criteoSchemas,name)){const schema=criteo.document.components.schemas[name];if(!schema)throw Error('Missing pinned Criteo schema: '+name);criteoSchemas[name]=schema;retainCriteoSchema(schema);}
 }
 for(const v of Object.values(value))retainCriteoSchema(v);
};
for(const route of routes)if(route.gateway==='criteo_native_action'&&route.responseSchemas){retainCriteoSchema(route.requestSchema);retainCriteoSchema(route.responseSchemas);}
routes.sort((a,b)=>(a.gateway+'/'+a.operation+'/'+a.action).localeCompare(b.gateway+'/'+b.operation+'/'+b.action));
const artifact=JSON.stringify({formatVersion:1,evidence:'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING',description:'Method/path mapping is independently designed from official vendor discovery; AMCP response or compiler parity has not been established.',sourceIntegrity:Object.fromEntries([...docs].map(([name,e])=>[name,{source:e.source,document_sha256:hash(e.document),revision:e.document.revision??null}])),routes,gaps,schemaComponents:{'criteo-retail-2026-01':{schemas:Object.fromEntries(Object.entries(criteoSchemas).sort(([a],[b])=>a.localeCompare(b,'en')))},'reddit-v3':reddit.document.components,'google-ads-v23':{schemas:ads.document.schemas}}},null,2)+'\n';
const output='generated/vendor-routes.json';
if(process.argv.includes('--check')){if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==artifact)throw Error('Vendor routes are stale; run node tools/fetch-vendor-specs.mjs --generate-only');}
else fs.writeFileSync(output,artifact);
console.log({routes:routes.length,gaps});
