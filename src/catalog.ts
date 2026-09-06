import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Ajv} from 'ajv';
import addFormatsModule from 'ajv-formats';
import type {Action,CallOptions,Catalog,RegistryData,ToolDefinition,JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {guardInput} from './security.js';
const addFormats=addFormatsModule as unknown as (ajv:Ajv)=>void;
export class Registry {
 readonly data:RegistryData; readonly tools=new Map<string,ToolDefinition>(); readonly catalogs=new Map<string,Catalog>();
 private validators=new Map<string,ReturnType<Ajv['compile']>>(); private routes=new Map<string,Action>();
 private ajv=new Ajv({strict:false,allErrors:true,useDefaults:false,coerceTypes:false,removeAdditional:false,validateFormats:true});
 constructor(data?:RegistryData){
  this.data=data??JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../generated/registry.json',import.meta.url)),'utf8'));
  addFormats(this.ajv);
  for(const tool of this.data.tools){this.tools.set(tool.name,tool);this.validators.set(tool.name,this.ajv.compile(tool.inputSchema));for(const op of tool.operations??[])this.validators.set(tool.name+'/'+op.operation,this.ajv.compile(op.argumentsSchema));}
  for(const catalog of this.data.catalogs){this.catalogs.set(catalog.gateway,catalog);for(const action of catalog.actions)this.register(catalog.gateway,action);}
  for(const action of this.data.supplemental)this.register(action.gateway!,action,false);
 }
 private register(gateway:string,action:Action,strict=true){
  const names=new Set([action.name,action.canonical_name,...action.aliases]);
  for(const name of names){const key=gateway+'/'+name;if(!strict&&this.routes.has(key))continue;this.routes.set(key,action);}
 }
 action(gateway:string,name:string):Action|undefined{return this.routes.get(gateway+'/'+name)??this.routes.get(gateway+'/'+name.toLowerCase());}
 validate(tool:string,input:JsonObject,options:CallOptions){
  guardInput(input);const definition=this.tools.get(tool);if(!definition)throw new MirrorError('UNKNOWN_TOOL','Unknown MCP tool: '+tool);
  const checkInput=structuredClone(input);
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
  if(input.operation&&tool.mode==='delegated'){
   const op=tool.operations?.find(x=>x.operation===input.operation);if(!op)throw new MirrorError('UNKNOWN_OPERATION','Unknown operation.');return structuredClone(op);
  }
  if(input.operation){const desc=this.data.descriptions[input.gateway+'/'+input.operation];if(desc)return structuredClone(desc);}
  const out=structuredClone(tool.help);if(out.inputSchema)out.inputSchema=this.schema(tool,options);return out;
 }
}
