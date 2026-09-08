import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {Action,CallOptions,Catalog,RegistryData,ToolDefinition,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput} from './security.js';
import {appleActions} from './apple-native.js';
import {microsoftActions,microsoftGateway,microsoftTool} from './microsoft-native.js';
import {extendRedditTool} from './reddit-extensions.js';
const addFormats=addFormatsModule as unknown as (ajv:Ajv)=>void;
export class Registry {
 readonly data:RegistryData; readonly tools=new Map<string,ToolDefinition>(); readonly catalogs=new Map<string,Catalog>();
 private validators=new Map<string,ReturnType<Ajv['compile']>>(); private routes=new Map<string,Action>();
 private ajv=new Ajv({strict:false,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false,validateFormats:true});
 constructor(data?:RegistryData){
  this.data=data??JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../generated/registry.json',import.meta.url)),'utf8'));
  addFormats(this.ajv);
  for(const original of this.data.tools){const tool=original.name==='reddit_native_action'?extendRedditTool(original):original;this.tools.set(tool.name,tool);this.validators.set(tool.name,this.ajv.compile(tool.inputSchema));for(const op of tool.operations??[])this.validators.set(tool.name+'/'+op.operation,this.ajv.compile(op.argumentsSchema));}
  for(const catalog of this.data.catalogs){this.catalogs.set(catalog.gateway,catalog);for(const action of catalog.actions)this.register(catalog.gateway,action);}
  for(const action of this.data.supplemental)this.register(action.gateway!,action,false);
  if(this.tools.has('apple_ads_native_action'))for(const action of appleActions)this.register('apple_ads_native_action',action,false);
  if(this.tools.has('amcp_tool_help')){
   this.tools.set(microsoftGateway,microsoftTool);this.validators.set(microsoftGateway,this.ajv.compile(microsoftTool.inputSchema));
   this.catalogs.set(microsoftGateway,{gateway:microsoftGateway,mode:'direct',api_version:'v13',reported_total:null,captured:0,complete:false,denominator_kind:'LIST_ACTIONS',actions:microsoftActions,gaps:['Independent extension; not part of the captured AMCP denominator.']});
   for(const a of microsoftActions)this.register(microsoftGateway,a);
  }
 }
 private register(gateway:string,action:Action,strict=true){
  const names=new Set([action.name,action.canonical_name,...action.aliases]);
  for(const name of names){const key=gateway+'/'+name;if(!strict&&this.routes.has(key))continue;this.routes.set(key,action);}
 }
 action(gateway:string,name:string):Action|undefined{return this.routes.get(gateway+'/'+name)??this.routes.get(gateway+'/'+name.toLowerCase());}
 validate(tool:string,input:JsonObject,options:CallOptions){
  guardInput(input);const definition=this.tools.get(tool);if(!definition)throw new MirrorError('UNKNOWN_TOOL','Unknown MCP tool: '+tool);
  const checkInput=structuredClone(input);
  if(tool==='amcp_tool_help'&&input.gateway===microsoftGateway){if(Object.keys(input).some(k=>!['gateway','operation'].includes(k))||input.operation!==undefined&&typeof input.operation!=='string')throw new MirrorError('INVALID_ARGUMENT','Invalid Microsoft help arguments.');return;}
  if(options.mode==='enhanced')for(const key of ['native_request',...(options.flags.uniformIdempotency?['idempotency_key']:[])])delete checkInput[key];
  const validator=this.validators.get(tool)!;
  if(!validator(checkInput))throw new MirrorError('INVALID_ARGUMENT','Arguments do not satisfy the captured gateway schema.',{errors:validator.errors});
  if(definition.mode==='delegated'){
   const nested=this.validators.get(tool+'/'+input.operation);
   if(!nested||!nested(input.arguments??{}))throw new MirrorError('INVALID_ARGUMENT','Arguments do not satisfy the captured operation schema.',{errors:nested?.errors});
  }
 }
 listTools(options:CallOptions){return [...this.tools.values()].map(t=>({name:t.name,description:t.description,inputSchema:this.schema(t,options)}));}
 schema(tool:ToolDefinition,options:CallOptions):JsonObject{
  const schema=structuredClone(tool.inputSchema);
  if(options.mode==='enhanced'&&tool.mode==='direct'){
   if(options.flags.dryRunSchemaDefault&&schema.properties.dry_run)schema.properties.dry_run.default=true;
   if(options.flags.uniformIdempotency)schema.properties.idempotency_key={type:'string',minLength:1,maxLength:256,description:'Tenant-scoped persistent idempotency key.'};
   if(options.flags.nativeRequests)schema.properties.native_request={type:'object',required:['method','path'],properties:{method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},path:{type:'string'},query:{type:'object'},body:{}},additionalProperties:false};
  }
  return schema;
 }
 help(input:JsonObject,options:CallOptions):JsonObject{
  if(!input.gateway)return structuredClone(this.data.discovery);
  const tool=this.tools.get(input.gateway);if(!tool)throw new MirrorError('UNKNOWN_GATEWAY','Unknown gateway.');
  if(input.gateway===microsoftGateway){
   if(input.operation){const action=microsoftActions.find(a=>a.name===input.operation);if(!action)throw new MirrorError('UNKNOWN_OPERATION','Unknown Microsoft operation. Use LIST_ACTIONS.');return structuredClone(action);}
   return {...structuredClone(tool.help),inputSchema:this.schema(tool,options),amcp_actions:microsoftActions.map(a=>({action:a.name,method:a.method,path:a.path,read_only:a.read_only}))};
  }
  if(input.gateway==='apple_ads_native_action'){
   const action=appleActions.find(a=>a.name===input.operation);
   if(action)return {...structuredClone(action),qualification:'Independent AMCP implementation; no live parity claim.'};
   if(!input.operation)return {...structuredClone(tool.help),amcp_actions:appleActions.map(a=>({action:a.name,method:a.method,path:a.path,read_only:a.read_only})),qualification:'Independent AMCP v1 extensions. Captured catalog counts are unchanged. Legacy v5 routes are unavailable.'};
  }
  if(input.operation&&tool.mode==='delegated'){
   const op=tool.operations?.find(x=>x.operation===input.operation);if(!op)throw new MirrorError('UNKNOWN_OPERATION','Unknown operation.');return structuredClone(op);
  }
  if(input.operation){const desc=this.data.descriptions[input.gateway+'/'+input.operation];if(desc)return structuredClone(desc);}
  const out=structuredClone(tool.help);if(out.inputSchema)out.inputSchema=this.schema(tool,options);return out;
 }
}
