import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {MirrorError} from '../src/errors.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {assertWriteShape} from '../src/write-review.js';
const compiler=new DelegatedNativeCompiler();
const compile=(gateway:string,operation:string,args:Record<string,unknown>)=>compiler.compile(gateway,{operation,arguments:args});
const code=(expected:string)=>(e:unknown)=>e instanceof MirrorError&&e.code===expected;

test('all generated delegated routes retain their official discovery method and exact origin',()=>{
 const cache=new Map<string,any>();let covered=0;
 for(const r of compiler.data.routes){
  if(!cache.has(r.sourceFile))cache.set(r.sourceFile,JSON.parse(fs.readFileSync('.mirror/VENDOR/'+r.sourceFile+'.json','utf8')).document);
  const d=cache.get(r.sourceFile);let found:any;
  if(d.paths){const server=d.servers.find((s:any)=>new URL(s.url).origin===r.origin);assert.ok(server);const prefix=new URL(server.url).pathname.replace(/\/$/,'');found=d.paths[r.path.slice(prefix.length)]?.[r.method.toLowerCase()];assert.equal(found?.operationId,r.vendorMethod);}
  else {function visit(x:any){for(const m of Object.values(x.methods??{}) as any[])if(m.id===r.vendorMethod)found=m;for(const child of Object.values(x.resources??{}))visit(child);}visit(d);assert.equal(found?.httpMethod,r.method);assert.equal('/'+(d.servicePath??'')+found?.path,r.path);assert.equal(new URL(d.rootUrl).origin,r.origin);}
  assert.equal(r.evidence,'VENDOR_DOCUMENTED_INDEPENDENT_MAPPING');covered++;
 }
 assert.equal(covered,342); // Three exact 2026.01 Criteo DSP report mappings.
 const names=new Set(compiler.data.routes.map(r=>r.gateway+'/'+r.operation+'/'+r.action));assert.equal(names.size,covered);
});

test('every JSON-capable route compiles an official path fixture without a network request',()=>{
 let count=0;
 for(const r of compiler.data.routes){
  if(r.unsupportedMedia)continue;
  const params:Record<string,unknown>={};
  for(const [name,schema] of Object.entries(r.parameters)){
   if(schema.location==='path')params[name]=r.gateway==='reddit_native_action'&&schema.pattern?'t2_123':schema.pattern?schema.pattern.replace(/^\^|\$$/g,'').replaceAll('[^/]+','123'):name==='siteUrl'||name==='feedpath'?'https://example.com/':'123';
   else if(schema.required)params[name]=schema.enum?.[0]??(schema.type==='boolean'?false:schema.type==='integer'||schema.type==='number'?1:'en');
  }
  const payload=r.gateway==='reddit_native_action'&&r.requestSchema?vendorFixture(r.requestSchema,compiler.data.schemaComponents?.[r.sourceFile]):{};
  if(r.gateway==='reddit_native_action'&&r.action==='GET_INSIGHTS')Object.assign(payload.data,{starts_at:'2026-08-01T00:00:00Z',ends_at:'2026-08-02T00:00:00Z',fields:['IMPRESSIONS']});
  let p;try{p=compile(r.gateway,r.operation,{action:r.action,params,...(r.requestSchema?{payload,request:{}}:{})});}catch(e){assert.fail(r.action+' '+JSON.stringify({payload,errors:(e as MirrorError).details}));}
  assert.equal(p.path,r.path.replace(/\{(\+?)([^}]+)\}/g,(_,plus,key)=>plus?String(params[key]).split('/').map(encodeURIComponent).join('/'):encodeURIComponent(String(params[key]))));
  assert.equal(p.method,r.method);assert.equal(p.origin,r.origin);assert.equal(p.readOnly,r.readOnly);count++;
 }
 assert.equal(count,341);
});

// Minimal schema fixtures exercise template expansion only; focused tests below
// and reddit.test.ts cover operational behavior and intentionally invalid bodies.
function vendorFixture(schema:any,components:any):any{
 if(schema.$ref){const target=schema.$ref.slice(2).split('/').reduce((v:any,k:string)=>v[k],{components});return vendorFixture({...target,...schema,$ref:undefined,required:[...new Set([...(target.required??[]),...(schema.required??[])])]},components);}
 if(schema.const!==undefined)return schema.const;
 if(schema.enum)return schema.enum.find((v:any)=>v!==null);
 if(schema.oneOf||schema.anyOf)return vendorFixture((schema.oneOf??schema.anyOf)[0],components);
 if(schema.allOf){const parts=[schema,...schema.allOf.map((s:any)=>s.$ref?s.$ref.slice(2).split('/').reduce((v:any,k:string)=>v[k],{components}):s)];return vendorFixture({type:'object',properties:Object.assign({},...parts.map((s:any)=>s.properties??{})),required:[...new Set(parts.flatMap((s:any)=>s.required??[]))]},components);}
 if(schema.type==='object'||schema.properties)return Object.fromEntries((schema.required??[]).map((key:string)=>[key,vendorFixture(schema.properties[key],components)]));
 const type=Array.isArray(schema.type)?schema.type.find((v:string)=>v!=='null'):schema.type;
 if(type==='array')return Array.from({length:schema.minItems??1},()=>vendorFixture(schema.items,components));
 if(type==='boolean')return false;
 if(type==='integer'||type==='number')return schema.minimum??1;
 if(schema.format==='date-time')return '2026-08-01T00:00:00Z';
 if(schema.format==='uuid')return '00000000-0000-4000-8000-000000000001';
 if(schema.format==='uri')return 'https://example.com/';
 return schema.examples?.[0]??schema.example??'fixture';
}

test('GTM friendly hierarchy builds correct paths including resource suffixes and special POST reads',()=>{
 const ids={account_id:'1',container_id:'2',workspace_id:'3',tag_id:'4'};
 let p=compile('gtm_native_action','gtm_ops',{action:'GET_TAG',...ids});assert.equal(p.path,'/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags/4');assert.equal(p.accountId,'1');assert.equal(p.readOnly,true);
 p=compile('gtm_native_action','gtm_ops',{action:'LIST_FOLDER_ENTITIES',...ids,folder_id:'5'});assert.equal(p.method,'POST');assert.equal(p.readOnly,true);assert.equal(p.path,'/tagmanager/v2/accounts/1/containers/2/workspaces/3/folders/5:entities');
 p=compile('gtm_native_action','gtm_ops',{action:'DELETE_BUILT_IN_VARIABLES',...ids,type:['clickId']});assert.equal(p.path,'/tagmanager/v2/accounts/1/containers/2/workspaces/3/built_in_variables');assert.equal(p.readOnly,false);assert.equal(p.destructive,true);assert.deepEqual(p.query.type,['clickId']);
 p=compile('gtm_native_action','gtm_ops',{action:'PUBLISH_CONTAINER_VERSION',account_id:'1',container_id:'2',version_id:'4'});assert.equal(p.path,'/tagmanager/v2/accounts/1/containers/2/versions/4:publish');assert.equal(p.readOnly,false);assert.equal(p.requiresConfirmation,true);
});

test('GA4 data reports keep JSON bodies, alpha-only methods and query paging explicit',()=>{
 const request={dateRanges:[{startDate:'2026-01-01',endDate:'2026-01-07'}],metrics:[{name:'sessions'}]};
 let p=compile('ga4_native_action','ga4_run_report',{property:'123',request});assert.equal(p.path,'/v1beta/properties/123:runReport');assert.equal(p.accountId,'123');assert.deepEqual(p.body,request);assert.equal(p.readOnly,true);
 p=compile('ga4_native_action','ga4_data_report',{action:'quota_snapshot',property:'properties/123'});assert.equal(p.path,'/v1alpha/properties/123/propertyQuotasSnapshot');assert.equal(p.body,undefined);
 p=compile('ga4_native_action','ga4_metadata_ops',{action:'get_metadata',property:'123'});assert.equal(p.path,'/v1beta/properties/123/metadata');
 p=compile('ga4_native_action','ga4_report_task_ops',{action:'list',property:'123',request:{pageSize:10,pageToken:'next'}});assert.equal(p.path,'/v1alpha/properties/123/reportTasks');assert.deepEqual(p.query,{pageSize:10,pageToken:'next'});assert.equal(p.body,undefined);
 p=compile('ga4_native_action','ga4_create_audience_export',{property:'123',request:{audience:'properties/123/audiences/4'}});assert.equal(p.readOnly,false);assert.equal(p.requiresConfirmation,true);
 p=compile('ga4_native_action','ga4_report_task_ops',{action:'query',name:'properties/123/reportTasks/7',request:{offset:'0',limit:'100'}});assert.equal(p.path,'/v1alpha/properties/123/reportTasks/7:query');assert.equal(applyExecutionRisk(p).readOnly,true);
 assert.equal(applyExecutionRisk({...p,path:p.path.replace(':query',':cancel')}).readOnly,false);
});

test('Search Console encodes complete property and sitemap URLs as single path components',()=>{
 let p=compile('google_search_console_native_action','gsc_site_ops',{action:'GET_SITEMAP',site_url:'https://example.com/',sitemap_url:'https://example.com/sitemap.xml?lang=en'});
 assert.equal(p.path,'/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml%3Flang%3Den');assert.equal(p.accountId,'https://example.com/');
 assert.equal(applyExecutionRisk(p).readOnly,true);
 assert.equal(applyExecutionRisk({...p,path:p.path+'?method=DELETE'}).readOnly,false);
 assert.equal(applyExecutionRisk({...p,query:{method:'DELETE'}}).readOnly,false);
 p=compile('google_search_console_native_action','gsc_analytics_ops',{action:'QUERY_SEARCH_ANALYTICS',site:'sc-domain:example.com',payload:{startDate:'2026-01-01',endDate:'2026-01-07'}});assert.equal(p.path,'/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');assert.equal(p.readOnly,true);
 p=compile('google_search_console_native_action','gsc_site_ops',{action:'INSPECT_URL',property_url:'sc-domain:example.com',inspection_url:'https://example.com/page',language_code:'en-US'});assert.deepEqual(p.body,{siteUrl:'sc-domain:example.com',inspectionUrl:'https://example.com/page',languageCode:'en-US'});assert.equal(p.readOnly,true);
});

test('Business Profile routes preserve separate service origins and suffix resource names',()=>{
 let p=compile('google_business_native_action','gmb_account_ops',{action:'LIST_ACCOUNT_ADMINS',account_id:'123'});assert.equal(p.origin,'https://mybusinessaccountmanagement.googleapis.com');assert.equal(p.path,'/v1/accounts/123/admins');
 p=compile('google_business_native_action','gmb_lodging_ops',{action:'GET_LODGING',location_id:'locations/456'});assert.equal(p.path,'/v1/locations/456/lodging');assert.equal(p.accountId,'locations/456');
 p=compile('google_business_native_action','gmb_engagement_ops',{action:'PATCH_PLACE_ACTION_LINK',location_id:'456',place_action_link_id:'7',payload:{uri:'https://example.com/'},query:{updateMask:'uri'}});assert.equal(p.origin,'https://mybusinessplaceactions.googleapis.com');assert.equal(p.path,'/v1/locations/456/placeActionLinks/7');assert.equal(p.readOnly,false);
 p=compile('google_business_native_action','gmb_location_ops',{action:'SEARCH_GOOGLE_LOCATIONS',payload:{query:'Example'}});assert.equal(p.method,'POST');assert.equal(p.readOnly,true);
 assert.equal(applyExecutionRisk(p).readOnly,true);assert.equal(applyExecutionRisk({...p,origin:'https://mybusinessaccountmanagement.googleapis.com'}).readOnly,false);
 p=compile('google_business_native_action','gmb_verification_ops',{action:'FETCH_VERIFICATION_OPTIONS',location_id:'456',payload:{languageCode:'en'}});assert.equal(applyExecutionRisk(p).readOnly,true);
 assert.equal(applyExecutionRisk({...p,path:'/v1/locations/456:verify'}).readOnly,false);
});

test('Criteo request bodies and documented POST searches retain effective method semantics',()=>{
 const payload={data:[{id:'brand-1'}]};
 let p=compile('criteo_native_action','criteo_campaign_ops',{action:'GET_CAMPAIGNS_BY_ACCOUNT_ID',account_id:'123',params:{pageSize:5}});assert.equal(p.path,'/2026-01/retail-media/accounts/123/campaigns');assert.deepEqual(p.query,{pageSize:5});
 p=compile('criteo_native_action','criteo_account_ops',{action:'ADD_BRANDS',account_id:'123',payload});assert.deepEqual(p.body,payload);assert.equal(p.readOnly,false);
 p=compile('criteo_native_action','criteo_account_ops',{action:'SEARCH_BRANDS',payload});assert.deepEqual(p.body,payload);assert.equal(p.readOnly,true);
 p=compile('criteo_native_action','criteo_reporting_ops',{action:'GENERATE_ASYNC_REVENUE_REPORT',payload:{data:{attributes:{startDate:'2026-01-01'}}}});assert.equal(p.readOnly,false);assert.equal(p.requiresConfirmation,true);
 p=compile('criteo_native_action','criteo_line_item_ops',{action:'GET_LINE_ITEMS_BY_CAMPAIGN_ID',account_id:'123',params:{'line-item-id':'456'}});assert.equal(p.path,'/2026-01/retail-media/line-items/456');
 for(const [operation,action]of [['criteo_campaign_ops','GET_CPC_MIN_BIDS_BY_SKU_IDS_V1'],['criteo_campaign_ops','GET_RECOMMENDED_CATEGORIES'],['criteo_catalog_ops','RECOMMENDED_KEYWORDS']]){
  p=compile('criteo_native_action',operation!,{action,params:{retailerId:'123'},payload:{}});assert.equal(applyExecutionRisk(p).readOnly,true);assert.equal(applyExecutionRisk({...p,query:{method:'DELETE'}}).readOnly,false);
 }
 assert.throws(()=>compile('criteo_native_action','criteo_campaign_ops',{action:'GET_LINE_ITEMS_BY_CAMPAIGN_ID',params:{'line-item-id':'456'}}),code('DELEGATED_ROUTE_UNAVAILABLE'));
});

test('delegated path, account and property conflicts fail closed',()=>{
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'GET_TAG',account_id:'1',path:'accounts/2/containers/3/workspaces/4/tags/5'}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'GET_ACCOUNT',path:'accounts/../secret'}),code('INVALID_RESOURCE_NAME'));
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'GET_ACCOUNT',account_id:'%2e%2e'}),code('INVALID_PATH_PARAMETER'));
 assert.throws(()=>compile('ga4_native_action','ga4_audience_export_ops',{action:'get',property:'123',audience_export_name:'properties/999/audienceExports/4'}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.throws(()=>compile('ga4_native_action','ga4_data_report',{action:'batch_run_reports',property:'123',request:{requests:[{property:'properties/999'}]}}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.throws(()=>compile('google_business_native_action','gmb_location_ops',{action:'GET_LOCATION',location_id:'1',path_params:{name:'locations/2'}}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.throws(()=>compile('google_search_console_native_action','gsc_site_ops',{action:'INSPECT_URL',site_url:'sc-domain:one.example',payload:{siteUrl:'sc-domain:two.example'}}),code('ACCOUNT_SCOPE_MISMATCH'));
 assert.throws(()=>compile('criteo_native_action','criteo_campaign_ops',{action:'GET_CAMPAIGNS_BY_ACCOUNT_ID',account_id:'123',params:{accountId:'456'}}),code('CONFLICTING_PARAMETER'));
});

test('unsupported contracts and upload media give actionable failures without false previews',()=>{
 // A report route is now mapped, but an empty definition is not executable.
 assert.throws(()=>assertWriteShape(compile('criteo_native_action','criteo_reporting_ops',{action:'GENERATE_ASYNC_ACCOUNTS_REPORT'})),code('CRITEO_REPORT_INVALID'));
 assert.throws(()=>compile('criteo_native_action','criteo_creative_ops',{action:'CREATE_ASSET',payload:{}}),code('SPECIAL_TRANSPORT_REQUIRED'));
 assert.throws(()=>compile('ga4_native_action','ga4_connection_ops',{action:'exchange'}),(e:unknown)=>code('DELEGATED_ROUTE_UNAVAILABLE')(e)&&!!(e as MirrorError).details.next_step);
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'GET_ACCOUNT',account_id:'123',params:{access_token:'untrusted'}}),code('CREDENTIAL_PARAMETER_FORBIDDEN'));
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'GET_ACCOUNT',account_id:'123',params:{x_http_method_override:'DELETE'}}),code('UNKNOWN_VENDOR_PARAMETER'));
 assert.throws(()=>compile('gtm_native_action','gtm_ops',{action:'LIST_CONTAINERS',account_id:'123',params:{pageToken:{bad:true}}}),code('INVALID_PARAMETER'));
});
