import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unwrap} from '../tools/catalog/core.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const toolData=read('.mirror/TOOLS.json');
const catalogs=fs.readdirSync('.mirror/CATALOG').filter(x=>x.endsWith('.json')).sort().map(f=>read('.mirror/CATALOG/'+f));
const descriptions={};
for(const c of catalogs){const dir='.mirror/RAW/'+c.gateway;for(const file of fs.readdirSync(dir).filter(f=>f.startsWith('describe-'))){
 const evidence=read(dir+'/'+file),raw=unwrap(evidence.response),d=raw.data??raw;
 if(raw.success===false)continue;
 const name=evidence.request?.args?.target_action??evidence.request?.args?.operation;
 if(name&&name!=='LIST_ACTIONS')descriptions[c.gateway+'/'+name]=d;
}}
const supplemental=[];
const vendorFile='.mirror/VENDOR/dv360-v4.json';
if(fs.existsSync(vendorFile)){
 const vendor=read(vendorFile);const doc=vendor.document;
 const snake=s=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toUpperCase();
 const allowed=new Set(catalogs.find(c=>c.gateway==='dv360_native_action')?.actions.map(a=>a.name));
 function visit(node,parts=[]){
  for(const [name,m] of Object.entries(node.methods??{})){
   const action='DV360_'+[...parts,name].map(snake).join('_');if(!allowed.has(action))continue;
   const raw={action,method:m.httpMethod,path:'/'+m.path,resource:parts.join('.'),rpc:name,parameters:m.parameters??{},request:m.request??null,response:m.response??null,scopes:m.scopes??[],mediaUpload:m.mediaUpload??null,source:vendor.source};
   supplemental.push({gateway:'dv360_native_action',name:action,canonical_name:action,aliases:[action.replace(/^DV360_/,'')],method:m.httpMethod,path:'/'+m.path,read_only:['GET','HEAD'].includes(m.httpMethod),destructive:m.httpMethod==='DELETE',required:Object.entries(m.parameters??{}).filter(([,v])=>v.required).map(([k])=>k),path_parameters:Object.entries(m.parameters??{}).filter(([,v])=>v.location==='path').map(([k])=>k),evidence:'VENDOR_DOCUMENTED_NOT_WHATHEAD_VERIFIED',raw});
  }
  for(const [name,res] of Object.entries(node.resources??{}))visit(res,[...parts,name]);
 }visit(doc);
}
const data={surface:toolData.surface,discovery:toolData.discovery,tools:toolData.tools,catalogs,descriptions,supplemental,provenance:{source_hashes:read('.mirror/REPORTS/evidence-hashes.json'),generator_version:1}};
const outputs=new Map();
outputs.set('generated/registry.json',JSON.stringify(data,null,2)+'\n');
function typeOf(schema,root= schema,depth=0){
 if(!schema||depth>8)return 'unknown';
 if(schema.$ref?.startsWith('#/')){const target=schema.$ref.slice(2).split('/').reduce((v,k)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],root);return typeOf(target,root,depth+1);}
 if(schema.enum)return schema.enum.map(v=>JSON.stringify(v)).join(' | ');
 if(schema.const!==undefined)return JSON.stringify(schema.const);
 if(schema.anyOf||schema.oneOf)return (schema.anyOf??schema.oneOf).map(v=>'('+typeOf(v,root,depth+1)+')').join(' | ');
 if(Array.isArray(schema.type))return schema.type.map(t=>typeOf({...schema,type:t},root,depth+1)).join(' | ');
 if(schema.type==='array')return 'Array<'+typeOf(schema.items,root,depth+1)+'>';
 if(schema.type==='object'){
  const fields=Object.entries(schema.properties??{}).map(([k,v])=>JSON.stringify(k)+(schema.required?.includes(k)?'':'?')+': '+typeOf(v,root,depth+1)+';');
  if(schema.additionalProperties!==false)fields.push('[key: string]: unknown;');
  return '{ '+fields.join(' ')+' }';
 }
 return ({string:'string',number:'number',integer:'number',boolean:'boolean',null:'null'})[schema.type]??'unknown';
}
const ts=['// GENERATED from captured schemas/catalogs. Do not hand edit.','export interface GatewayArguments {'];
for(const tool of toolData.tools)ts.push('  '+JSON.stringify(tool.name)+': '+typeOf(tool.inputSchema)+';');
ts.push('}','export interface DelegatedArguments {');
for(const tool of toolData.tools)for(const op of tool.operations??[])ts.push('  '+JSON.stringify(tool.name+'/'+op.operation)+': '+typeOf(op.argumentsSchema)+';');
ts.push('}','export interface ActionNames {');
for(const c of catalogs)ts.push('  '+JSON.stringify(c.gateway)+': '+(c.actions.length?c.actions.map(a=>JSON.stringify(a.name)).join(' | '):'string')+';');
ts.push('}','export type GatewayName = keyof GatewayArguments;');
outputs.set('generated/types.ts',ts.join('\n')+'\n');
outputs.set('generated/manifest.json',JSON.stringify({generator_version:1,gateways:catalogs.length,tools:toolData.tools.length,catalog_actions:catalogs.reduce((n,c)=>n+c.actions.length,0),supplemental_routes:supplemental.length,registry_sha256:createHash('sha256').update(outputs.get('generated/registry.json')).digest('hex')},null,2)+'\n');
let changed=false;
for(const [file,content]of outputs){
 if(process.argv.includes('--check')){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content){console.error('Generated output is stale: '+file);changed=true;}}
 else {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
}
if(changed)process.exitCode=1;else console.log('Generated '+catalogs.length+' gateways, '+toolData.tools.length+' tools, '+catalogs.reduce((n,c)=>n+c.actions.length,0)+' catalog entries and '+supplemental.length+' vendor-backed DV360 routes.');
