import {Registry} from './catalog.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {appleActions} from './apple-native.js';
import {businessWorkflowOperations} from './workflows.js';
import {reportingOperations} from './reporting.js';
import {independentlyReadOnly} from './execution-risk.js';
import {qualifiedProviderRead} from './provider-read-contracts.js';
import {googleGenerationKind} from './google-generation.js';
import {dv360TargetingSearchRoute} from './dv360-targeting-search.js';
import {reviewedWriteFamily} from './reviewed-routes.js';
import {mediaRoute} from './media-routing.js';
import {providerContracts} from './provider-contracts.js';
import {redditAudienceRoutes} from './reddit-extensions.js';
import {MirrorError} from './errors.js';
import {googleLegacyCoverage} from './google-legacy.js';
import {retiredProviderAction} from './retired-provider-actions.js';
import {gtmDiagnosticOperations} from './gtm-diagnostics.js';
import legacy from './google-legacy-mapping.json' with {type:'json'};
import type {Action,CompiledRequest,JsonObject} from './types.js';

export type ContractStatus='native_read'|'reviewed_write_family'|'media_workflow'|'local_workflow'|'adapter_requires_input'|'blocked_write'|'unmapped'|'unqualified_read'|'provider_unsupported';
export interface ActionContract {gateway:string;operation?:string;action:string;aliases:string[];method:string|null;path:string|null;origin?:string;status:ContractStatus;family?:string;implementation:string;reason:string;source:string;tests:string[];live_qualification:'unverified';}
const familyFiles:Record<string,[string,string[]]>={
 google_conversion_goals:['src/google-conversion-goals.ts',['tests/google-conversion-goals.test.ts']],
 x_drafts:['src/x-draft-writes.ts',['tests/x-draft-writes.test.ts']],
 linkedin_conversion_rules:['src/linkedin-conversion-rules.ts',['tests/linkedin-conversion-rules.test.ts']],
 linkedin_conversion_links:['src/linkedin-conversion-links.ts',['tests/linkedin-conversion-links.test.ts']],
 google_bid_modifiers:['src/google-bid-modifiers.ts',['tests/google-bid-modifiers.test.ts']],
 google_bidding_events:['src/google-bidding-events.ts',['tests/google-bidding-events.test.ts']],
 meta_labels:['src/meta-label-writes.ts',['tests/meta-label-writes.test.ts']],
 criteo_targeting:['src/criteo-targeting-writes.ts',['tests/criteo-targeting-writes.test.ts']],
 reddit_creatives:['src/reddit-creative-writes.ts / src/reddit-post-creation.ts',['tests/reddit-creative-writes.test.ts','tests/reddit-post-creation.test.ts']],
 gtm_workspace:['src/gtm-workspace-writes.ts',['tests/gtm-workspace-writes.test.ts']],
 gtm_workflows:['src/gtm-workflow-writes.ts',['tests/gtm-workflow-writes.test.ts']],
 apple_entities:['src/apple-entity-writes.ts',['tests/apple-entity-writes.test.ts']],
 dv360_lists:['src/dv360-list-writes.ts',['tests/dv360-list-writes.test.ts']],
 google_configuration:['src/google-configuration-writes.ts',['tests/google-configuration-writes.test.ts','tests/google-custom-segments.test.ts']],
 google_asset_links:['src/google-asset-links.ts',['tests/google-asset-links.test.ts']],google_targeting:['src/google-targeting-writes.ts',['tests/google-targeting-writes.test.ts']],google_entities:['src/write-review.ts',['tests/write-review.test.ts','tests/review-envelopes.test.ts']],
 meta_entities:['src/write-review.ts',['tests/meta-provision.test.ts']],tiktok_entities:['src/write-review.ts',['tests/write-platforms.test.ts','tests/tiktok-verification.test.ts']],snapchat_entities:['src/write-review.ts',['tests/snapchat-writes.test.ts']],
 linkedin_entities:['src/write-review.ts',['tests/write-platforms.test.ts']],linkedin_dsc:['src/linkedin-posts.ts',['tests/linkedin-posts.test.ts']],x_creatives:['src/x-creative-writes.ts',['tests/x-creative-writes.test.ts']],x_entities:['src/write-review.ts',['tests/x-targeting-writes.test.ts','tests/write-platforms.test.ts']],
 microsoft_asset_links:['src/microsoft-associations.ts',['tests/microsoft-associations.test.ts']],microsoft_search:['src/microsoft-native.ts',['tests/microsoft.test.ts']],reddit_classic:['src/reddit-writes.ts',['tests/reddit-writes.test.ts']],dv360_entities:['src/write-review.ts',['tests/write-platforms.test.ts']],apple_campaigns:['src/measurement-writes.ts',['tests/measurement-writes.test.ts']],ga4_export_jobs:['src/measurement-writes.ts',['tests/measurement-writes.test.ts']],gtm_entities:['src/measurement-writes.ts',['tests/measurement-writes.test.ts']],search_console_sites:['src/measurement-writes.ts',['tests/measurement-writes.test.ts']]
};
const localReads=new Set(['get_workspace_context','list_accounts','list_workspace_assets','get_creative_generation_job','inspect_google_drive_media','search_ads_library']);
const cache=new WeakMap<Registry,ActionContract[]>();
function concrete(template:string,parameters:JsonObject={}):string{return template.replace(/\{\+?([^{}=]+)(?:=([^{}]+))?\}/g,(_m,key:string,pattern:string|undefined)=>{const shape=pattern??parameters[key]?.pattern;return shape&&shape!=='*'?shape.replace(/^\^|\$/g,'').replaceAll('[^/]+','123').replaceAll('[^/]*','123').replaceAll('**','123').replaceAll('*','123'):'123';});}
function classify(gateway:string,action:string,method:string|null,path:string|null,readOnly:boolean|null,source:string,aliases:string[]=[],operation?:string,origin?:string,specialTransport?:string,parameters:JsonObject={},executionAction=action):ActionContract{
 const provider=providerContracts.find(c=>c.gateway===gateway),result:ActionContract={gateway,...(operation?{operation}:{}),action,aliases,method,path,...(origin?{origin}:{}),status:'unmapped',implementation:'',reason:'No provider request mapping exists. The advertised name is not executable.',source,tests:[],live_qualification:'unverified'};
 if(!method||!path)return result;
 const absolute=path.startsWith('https://')?new URL(concrete(path,parameters)):undefined,relative=absolute?.pathname??concrete(path.split('?')[0]!,parameters);
 const p:CompiledRequest={gateway,action:operation?operation+(executionAction!==operation?'/'+executionAction:''):executionAction,method,path:relative,origin:origin??absolute?.origin,query:Object.fromEntries(new URLSearchParams((absolute?.search??path.split('?')[1]??'').replaceAll('{action}','initializeUpload'))),body:['GET','HEAD'].includes(method)?undefined:{},headers:{},readOnly:readOnly===true,destructive:method==='DELETE',requiresConfirmation:false,accountId:'123',evidence:source,warnings:[],specialTransport};
 result.origin=p.origin;
 const retired=retiredProviderAction(p);if(retired){return {...result,status:'provider_unsupported',implementation:'src/retired-provider-actions.ts',reason:'The provider documents this method as no longer supported. Retained in the denominator; no replacement API is invented.',source:retired.source,tests:['tests/retired-provider-actions.test.ts']};}
 if(independentlyReadOnly(p)){result.status='native_read';result.implementation='src/compiler.ts / src/delegated-native.ts / src/transport.ts';result.reason='A mapped route passes independent read classification. Exact scope, payload, pagination and account/provider access still require verification.';result.tests=provider?.tests??[];if(qualifiedProviderRead(p)){result.implementation+=' / src/provider-read-contracts.ts';result.tests=[...result.tests,'tests/provider-read-contracts.test.ts'];result.reason+=' Documented fixed GET semantics override ambiguous resource names; Business/Catalog/member resources still require exact administrator bindings.';}if(dv360TargetingSearchRoute(p)){result.implementation+=' / src/dv360-targeting-search.ts';result.tests=[...result.tests,'tests/dv360-targeting-search.test.ts'];result.reason+=' Native advertiser-scoped POST search for geo regions, POIs and business chains; exact body variants, current scopes, bounded pagination and explicit completeness. It creates no targeting assignments.';}if(googleGenerationKind(p)){result.implementation+=' / src/google-generation.ts';result.tests=[...result.tests,'tests/google-generation.test.ts'];result.reason+=' Fixed draft-generation RPC: native required inputs and oneofs, selected Ads scope, one attempt and explicit no-output semantics. It does not save assets or apply recommendations. Text/image generation requires provider closed-beta access.';}return result;}
 const family=reviewedWriteFamily({...p,readOnly:false});
 if(family){result.status='reviewed_write_family';result.family=family;[result.implementation,result.tests]=familyFiles[family]!;result.reason='Route belongs to a reviewed family. Only amcp_write inspect with the exact payload can establish request support; family fixtures do not test every field or variant.';return result;}
 const media=mediaRoute(p);
 if(media){result.status='media_workflow';result.implementation='src/media-upload.ts';result.tests=['tests/media-upload.test.ts'];result.reason='Use amcp_media or the native Drive import bridge. Raw native upload variants are not thereby enabled.';return result;}
 result.status=readOnly===true?'unqualified_read':'blocked_write';result.implementation='src/reviewed-routes.ts';
 result.reason=readOnly===true?'Captured read metadata did not pass independent read-only classification. This route cannot execute without a specific risk contract.':'Mapping exists, but there is no reviewed write family. Add exact scope, prerequisites, state projection, spending rules, receipt, recovery and negative tests before execution.';
 return result;
}
/** Enumerates every captured action AND every delegated action enum. Unknown
 * provider denominators remain unknown. No catalog row grants permission. */
export function actionContracts(registry:Registry):ActionContract[]{
 const saved=cache.get(registry);if(saved)return saved;
 const records=new Map<string,ActionContract>(),vendor=new DelegatedNativeCompiler(),vendorRoutes=[...vendor.data.routes,...redditAudienceRoutes],legacyCoverage=googleLegacyCoverage();
 const put=(row:ActionContract)=>records.set([row.gateway,row.operation??'',row.action].join('/'),row);
 const direct=(gateway:string,a:Action)=>{
  let route=registry.action(gateway,a.name)??a,source=route.evidence;
  if(!route.path)route=registry.data.supplemental.find(s=>s.gateway===gateway&&s.name===a.name)??route;
  if(gateway==='google_ads_native_action'&&!route.path){
   const entry=legacy.entries.find(e=>e.name===a.name) as JsonObject|undefined;
   if(entry?.kind==='GAQL')route={...a,method:'POST',path:'/v23/customers/{customer_id}/googleAds:search',read_only:true};
   else {
    const hint=legacyCoverage.entries.find(e=>e.action===a.name)?.destination;
    const mapped=hint?registry.catalogs.get(gateway)?.actions.find(a=>a.path&&(a.name===hint||a.raw.service+'.'+a.raw.rpc===hint)):undefined;
    if(mapped)route=mapped;
    else if(hint&&/^[a-z_]+$/.test(hint))route={...a,method:'POST',path:'/v23/customers/{customer_id}/googleAds:search',read_only:true};
   }
   source=entry?'src/google-legacy-mapping.json':source;
  }
  // The compiler executes canonical names; classify that same identity while
  // retaining every advertised alias as its own denominator row.
  // Google legacy adapters deliberately retain the legacy name for immutable
  // operation restrictions even when they route to a general mutate RPC.
  const executionAction=gateway==='google_ads_native_action'&&!a.path?a.name:route.canonical_name||route.name;
  const row=classify(gateway,a.name,route.method,route.path,route.read_only,source,[...new Set([a.canonical_name,...a.aliases])].filter(n=>n!==a.name),undefined,undefined,route.raw.special_transport,{},executionAction);
  if(gateway==='google_ads_native_action'&&!route.path&&legacyCoverage.entries.some(e=>e.action===a.name))Object.assign(row,{status:'adapter_requires_input',implementation:'src/google-legacy.ts',reason:'An explicit legacy adapter exists, but its route depends on the requested scope/type. Inspect the exact payload; each selected destination retains its own reviewed contract.',tests:['tests/google-legacy.test.ts']});
  put(row);
 };
 for(const catalog of registry.catalogs.values())if(catalog.mode==='direct')for(const a of catalog.actions)direct(catalog.gateway,a);
 for(const a of registry.data.supplemental)if(registry.tools.get(a.gateway!)?.mode==='direct'&&!records.has(a.gateway+'//'+a.name))direct(a.gateway!,a);
 for(const a of appleActions)direct('apple_ads_native_action',a);
 for(const tool of registry.tools.values())if(tool.mode==='delegated')for(const op of tool.operations??[]){
  const choices=op.argumentsSchema.properties?.action?.enum??[op.operation];
  for(const action of choices){
   const route=vendorRoutes.find(r=>r.gateway===tool.name&&r.operation===op.operation&&(r.action===action||!r.action&&action===op.operation));
   let row=classify(tool.name,action,route?.method??null,route?.path??null,route?.readOnly??null,route?.source??tool.schema_evidence,[],op.operation,route?.origin,route?.unsupportedMedia?.length?'vendor_media':undefined,route?.parameters);
   if(!route&&(tool.name==='amcp_platform_workspace'||tool.name==='amcp_native_action'&&(localReads.has(op.operation)||reportingOperations.has(op.operation)||businessWorkflowOperations.has(op.operation)||op.operation==='platform_media_upload'))){row={...row,status:'local_workflow',implementation:'src/service.ts / src/workflows.ts / src/reporting.ts',reason:'Implemented AMCP workflow; platform and payload support depend on its underlying contracts. This row never enables native writes.',tests:['tests/workflows.test.ts']};}
   if(tool.name==='gtm_native_action'&&gtmDiagnosticOperations.has(op.operation))row={...row,status:'local_workflow',implementation:'src/gtm-diagnostics.ts',reason:'AMCP scoped read-only configuration audit or local reviewed-write verification job status. This workflow never publishes or resubmits a mutation.',tests:['tests/gtm-diagnostics.test.ts']};
   if(tool.name==='amcp_native_action'&&op.operation==='search_ads_library')row={...row,status:'local_workflow',implementation:'src/meta-ad-library.ts',reason:'Bounded public Meta Ad Library search through the sole/default connection. Media format is translated separately from provider ad category. Geographic API coverage and result limits are explicit; no performance inference or token-bearing URLs are returned.',source:'https://www.facebook.com/ads/library/api/',tests:['tests/meta-ad-library.test.ts']};
   put(row);
  }
 }
 // Include independent delegated extensions and vendor mappings even when a
 // wrapper action enum is incomplete. They have their own provenance.
 for(const r of vendorRoutes)if(registry.tools.get(r.gateway)?.mode==='delegated'&&!records.has([r.gateway,r.operation,r.action||r.operation].join('/')))put(classify(r.gateway,r.action||r.operation,r.method,r.path,r.readOnly,r.source,[],r.operation,r.origin,r.unsupportedMedia?.length?'vendor_media':undefined,r.parameters));
 const rows=[...records.values()].sort((a,b)=>[a.gateway,a.operation??'',a.action].join('/').localeCompare([b.gateway,b.operation??'',b.action].join('/'),'en'));cache.set(registry,rows);return rows;
}
export function actionContractSummary(registry:Registry){const rows=actionContracts(registry);return [...new Set([...registry.catalogs.keys(),...rows.map(r=>r.gateway)])].sort().map(gateway=>({gateway,actions:rows.filter(r=>r.gateway===gateway).length,counts:Object.fromEntries([...new Set(rows.filter(r=>r.gateway===gateway).map(r=>r.status))].sort().map(status=>[status,rows.filter(r=>r.gateway===gateway&&r.status===status).length])),captured_catalog_complete:registry.catalogs.get(gateway)?.complete??false,provider_api_coverage:'unknown',live_qualification:'unverified'}));}
export function actionContractPage(registry:Registry,input:JsonObject){
 const offset=input.offset??0,limit=input.limit??50;
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||input.search!==undefined&&(typeof input.search!=='string'||input.search.length>200))throw new MirrorError('INVALID_ARGUMENT','Contract inventory uses offset >= 0, limit 1–100 and search up to 200 characters.');
 if(input.gateway!==undefined&&!registry.tools.has(input.gateway))throw new MirrorError('UNKNOWN_GATEWAY','Choose a gateway returned in the contract summary.');
 const needle=String(input.search??'').toLowerCase(),rows=actionContracts(registry).filter(r=>(!input.gateway||r.gateway===input.gateway)&&(!needle||[r.action,r.operation,r.path,r.status,...r.aliases].join(' ').toLowerCase().includes(needle)));
 return {network_requests:0,summary:actionContractSummary(registry),total:rows.length,offset,limit,has_more:offset+limit<rows.length,actions:rows.slice(offset,offset+limit),meaning:'Complete local action/enum inventory, not complete vendor API coverage or live qualification. Route membership is conditional on exact-payload inspect, permissions, server-read review and provider validation.',next_step:'amcp_write inspect for a native mutation; amcp_media for uploads. Blocked entries require implementation, not additional user confirmation.'};
}
