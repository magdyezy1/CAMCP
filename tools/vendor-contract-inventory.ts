import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {ActionContract} from '../src/action-contracts.js';
import type {JsonObject} from '../src/types.js';
import {appleModelEvidence} from '../src/apple-entity-writes.js';

const gateways:Record<string,string>={
 'google-ads':'google_ads','ga4-':'ga4','gtm-':'gtm','search-console':'google_search_console','business-':'google_business','dv360-':'dv360','criteo-':'criteo','reddit-':'reddit','microsoft-':'microsoft_ads'
};
const microsoftServices:Record<string,string>={'campaign-management':'CampaignManagement','customer-management':'CustomerManagement','customer-billing':'CustomerBilling','reporting':'Reporting','ad-insight':'AdInsight','bulk':'Bulk'};
type Method={id:string;method:string;path:string;origin?:string};
function methods(d:JsonObject):Method[]{
 if(d.paths){const server=new URL(d.servers[0].url),prefix=server.pathname.replace(/\/$/,'');return Object.entries(d.paths).flatMap(([path,verbs])=>Object.entries(verbs as JsonObject).filter(([method])=>['get','post','put','patch','delete','head','options'].includes(method)).map(([method,op])=>({id:op.operationId??method+' '+path,method:method.toUpperCase(),path:path.startsWith(prefix+'/')?path:prefix+path,origin:server.origin})));}
 const rows:Method[]=[];
 const visit=(resource:JsonObject)=>{for(const m of Object.values(resource.methods??{}) as JsonObject[])rows.push({id:m.id,method:m.httpMethod,path:d.wire_format?m.path:'/'+(d.servicePath??'')+m.path,...(d.rootUrl?{origin:new URL(d.rootUrl).origin}:{})});for(const child of Object.values(resource.resources??{}) as JsonObject[])visit(child);};visit(d);return rows;
}
const shape=(path:string)=>path.replace(/^https:\/\/[^/]+/,'').split('?')[0]!.replace(/\{[^}]+\}/g,'{}');
/** Every method in every pinned official spec, including uncatalogued methods.
 * A schema/WSDL match proves correspondence only, never execution readiness. */
export function vendorContractInventory(actions:ActionContract[]){
 const files=fs.readdirSync('.mirror/VENDOR').filter(f=>f.endsWith('.json')&&f!=='lifecycle-pages.json').sort(),summary:JsonObject[]=[],rows:JsonObject[]=[];
 for(const file of files){
  const gateway=Object.entries(gateways).find(([prefix])=>file.startsWith(prefix))?.[1];if(!gateway)throw Error('Unclassified vendor specification '+file);
  const raw=fs.readFileSync('.mirror/VENDOR/'+file),w=JSON.parse(raw.toString('utf8')),d=w.document,native=methods(d),local=actions.filter(a=>a.gateway===gateway+'_native_action');
  if(!native.length)throw Error('Vendor specification has no method inventory: '+file);
  const available=native.map(m=>{
   const service=Object.entries(microsoftServices).find(([key])=>file==='microsoft-'+key+'-v13.json')?.[1];
   const mapped=local.filter(a=>d.wire_format? a.action===m.id&&service&&a.path?.includes('/'+service+'/'):a.method===m.method&&a.path&&shape(a.path)===shape(m.path)&&(!a.origin||!m.origin||a.origin===m.origin));
   return {gateway:gateway+'_native_action',source_file:'.mirror/VENDOR/'+file,source_url:w.source,api_version:d.version??d.info?.version??null,...m,mapped_actions:mapped.map(a=>({operation:a.operation??null,action:a.action,status:a.status,family:a.family??null})),mapping_status:mapped.length?'mapped':'no_mapped_action',qualification:'unverified',...(d.wire_format?{wire_caveat:'WSDL is SOAP evidence; mapping names to JSON adapters does not establish wire parity.'}:{})};
  });
  summary.push({gateway:gateway+'_native_action',source_file:'.mirror/VENDOR/'+file,source_url:w.source,captured_at:w.captured_at,sha256:createHash('sha256').update(raw).digest('hex'),methods:native.length,mapped:available.filter(m=>m.mapped_actions.length).length,no_mapped_action:available.filter(m=>!m.mapped_actions.length).length,meaning:'Complete for this pinned document, not all provider APIs or account access.'});rows.push(...available);
 }
 const apple=appleModelEvidence(),appleRows=Object.entries(apple.methods).map(([id,m])=>{
  const method=m as JsonObject,mapped=actions.filter(a=>a.gateway==='apple_ads_native_action'&&a.method===method.method&&a.path&&shape(a.path)===shape(method.path));
  return {gateway:'apple_ads_native_action',source_file:'generated/apple-platform-v1-models.json',source_url:apple.api_source,api_version:'v1',id,...method,origin:'https://api.ads.apple.com',mapped_actions:mapped.map(a=>({operation:a.operation??null,action:a.action,status:a.status,family:a.family??null})),mapping_status:mapped.length?'mapped':'no_mapped_action',qualification:'unverified'};
 });
 summary.push({gateway:'apple_ads_native_action',source_file:'generated/apple-platform-v1-models.json',source_url:apple.api_source,revision:apple.revision,sha256:createHash('sha256').update(JSON.stringify(apple,null,2)+'\n').digest('hex'),methods:appleRows.length,mapped:appleRows.filter(m=>m.mapped_actions.length).length,no_mapped_action:appleRows.filter(m=>!m.mapped_actions.length).length,meaning:'All methods extracted from the pinned public SDK API source; selected model facts are separate from method coverage and live access.'});rows.push(...appleRows);
 return {format_version:1,scope:'All methods in the pinned public vendor Discovery, OpenAPI, WSDL and Apple SDK method evidence. Missing mappings remain explicit; no action is enabled by this inventory.',summary,methods:rows};
}
