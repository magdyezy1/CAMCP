import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {unwrap,pageInfo,normalizeAction} from './core.mjs';
const root='.mirror';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');};
const discovery=unwrap(read(root+'/RAW/help.json').response);
const tools=[]; const summaries=[]; const hashes={};
function hash(file){hashes[file.replaceAll('\\','/')]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
hash(root+'/RAW/help.json');
for(const gateway of discovery.gateways){
 const dir=root+'/RAW/'+gateway; const h=read(dir+'/help.json'); const help=unwrap(h.response);
 for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort())hash(path.join(dir,file));
 const pages=fs.readdirSync(dir).filter(f=>/^catalog-\d{4}\.json$/.test(f)).sort().map(f=>({file:f,...read(dir+'/'+f)}));
 const records=[];const operations=[];const gaps=[];let total=null;let apiVersion=null;
 if(pages.length){
  const names=new Set();let expectedOffset=0;
  for(const p of pages){
   const info=pageInfo(p.response);apiVersion=info.data.api_version??apiVersion;
   if(total===null)total=info.total;
   if(total!==info.total)throw Error(gateway+': changing denominator');
   const args=p.request.args;const offset=args.cursor??args.offset??0;
   if(Number(offset)!==expectedOffset)throw Error(gateway+': missing or out-of-order page');
   for(const raw of info.actions){const item=normalizeAction(raw);if(names.has(item.name))throw Error(gateway+': duplicate '+item.name);names.add(item.name);records.push(item);}
   expectedOffset+=info.actions.length;
  }
  const last=pageInfo(pages.at(-1).response).data;
  if(records.length!==total||last.has_more===true||(last.next_cursor!==undefined&&last.next_cursor!==null&&last.next_cursor!==''))throw Error(gateway+': incomplete capture');
 }else if(help.mode==='delegated'){
  total=help.operation_count;
  for(const operation of help.operations){
   const file=dir+'/operation-'+operation+'.json';
   if(!fs.existsSync(file)){gaps.push('Missing operation schema: '+operation);continue;}
   const op=unwrap(read(file).response);
   if(!op.argumentsSchema)throw Error('No nested schema: '+file);
   operations.push(op);
   records.push({name:operation,canonical_name:operation,aliases:[],method:null,path:null,read_only:null,destructive:null,required:op.argumentsSchema.required??[],path_parameters:[],evidence:'OBSERVED',raw:op});
  }
 }else if(help.inputSchema.properties?.action?.enum){
  const names=help.inputSchema.properties.action.enum;
  const canonical=gateway==='dv360_native_action'?names.filter(x=>x.startsWith('DV360_')):names;
  total=canonical.length;
  for(const name of canonical)records.push({name,canonical_name:name,aliases:names.includes(name.replace(/^DV360_/,''))?[name.replace(/^DV360_/,'')]:[],method:null,path:null,read_only:null,destructive:null,required:[],path_parameters:[],evidence:'OBSERVED',raw:{action:name}});
  gaps.push('Action enum captured; method/path/required-field catalog not exposed by WhatHead help.');
 }else gaps.push('LIST_ACTIONS unsupported; full action denominator unknown.');
 const inputSchema=help.inputSchema??{
  type:'object',properties:{operation:{type:'string',enum:help.operations,description:'Validated internal operation to execute.'},arguments:{type:'object',additionalProperties:{},description:"Exact arguments for the selected operation. The original operation schema is validated before execution."}},required:['operation'],additionalProperties:false,
  $schema:'http://json-schema.org/draft-07/schema#'
 };
 const catalog={gateway,mode:help.mode,api_version:apiVersion,reported_total:total,captured:records.length,denominator_kind:pages.length?'LIST_ACTIONS':help.mode==='delegated'?'operation_count':total!==null?'action_enum':'unknown',complete:total!==null&&total===records.length,actions:records,gaps};
 write(root+'/CATALOG/'+gateway+'.json',catalog);
 tools.push({name:gateway,description:help.description,inputSchema,schema_evidence:help.inputSchema?'OBSERVED':'INFERRED_OUTER_ENVELOPE',mode:help.mode,operations,help});
 summaries.push({gateway,mode:help.mode,actions:records.length,total,schemas:operations.length,gaps:gaps.length});
}
const helpTool={name:'whathead_tool_help',description:'Discover compact Whathead MCP gateways and inspect the exact nested schema for an operation. This is read-only metadata and does not call an advertising platform.',inputSchema:{type:'object',properties:{gateway:{type:'string',enum:discovery.gateways},operation:{type:'string'}},additionalProperties:false},schema_evidence:'INFERRED_OUTER_ENVELOPE',mode:'help',help:discovery};
tools.push(helpTool);
write(root+'/TOOLS.json',{surface:discovery.surface,tools,discovery});
write(root+'/REPORTS/capture-summary.json',{gateways:summaries,known_actions:summaries.reduce((n,g)=>n+g.actions,0),unknown_denominators:summaries.filter(g=>g.total===null).map(g=>g.gateway)});
write(root+'/REPORTS/evidence-hashes.json',hashes);
console.table(summaries);
