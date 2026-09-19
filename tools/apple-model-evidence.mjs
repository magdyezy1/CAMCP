import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const appleSdkRevision='f90ac18b616e0ba2bbf2d17d73f54deeb2dd7af1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value.replace(/\r\n/g,'\n').trimEnd()+'\n';
/** Extract type facts from the pinned public SDK, not executable vendor code.
 * Fail on unfamiliar syntax rather than silently broadening a write schema. */
export function extractAppleModels(directory,apiFile){
 const models={},sources={};
 for(const file of fs.readdirSync(directory).filter(f=>f.endsWith('.ts')).sort()){
  const source=canonical(fs.readFileSync(path.join(directory,file),'utf8'));
  const declaration=/export (interface|enum) (\w+) \{([\s\S]*?)\n\}/.exec(source);
  if(!declaration)throw Error('No model declaration: '+file);
  const [,kind,name,body]=declaration;
  if(kind==='enum'){
   const values=[...body.matchAll(/^\s*\w+ = '([^']+)'[,]?\s*$/gm)].map(m=>m[1]);
   if(!values.length)throw Error('Empty enum '+name);models[name]={enum:values};
  }else{
   const fields={};for(const [,key,optional,type]of body.matchAll(/^\s*'([^']+)'(\?)?: ([^;\n]+);/gm)){
    if(!/^(?:Array<\w+>|\w+)(?: \| null)?$/.test(type))throw Error('Unqualified type '+name+'.'+key+': '+type);
    fields[key]={type,required:optional!=='?'};
   }
   if(!Object.keys(fields).length)throw Error('Empty interface '+name);models[name]={fields};
  }
  sources[name]={source:`https://github.com/apple/apple-ads-platform-api-node/blob/${appleSdkRevision}/src/model/${file}`,canonical_sha256:hash(source)};
 }
 for(const [name,model]of Object.entries(models))for(const f of Object.values(model.fields??{})){
  const type=f.type.replace(' | null','').replace(/^Array<(.+)>$/,'$1');
  if(!['string','number','boolean','object'].includes(type)&&!models[type])throw Error('Missing dependency '+name+': '+type);
 }
 const api=canonical(fs.readFileSync(apiFile,'utf8')),methods={};
 for(const match of api.matchAll(/^        (\w+): async \(([^\n]+?)\): Promise<RequestArgs> => \{([\s\S]*?)^        \},/gm)){
  const [,name,args,body]=match,route=/const localVarPath = `([^`]+)`/.exec(body)?.[1],method=/method: '([A-Z]+)'/.exec(body)?.[1];
  if(!route||!method)throw Error('Incomplete method '+name);
  methods[name]={method,path:'/v1'+route,account_context:args.includes('xApContext:')?'required':args.includes('xApContext?')?'optional':'none'};
 }
 if(!methods.adgroupsPost||!methods.sharedBudgetsPost)throw Error('SDK request methods not found');
 return {format_version:1,revision:appleSdkRevision,normalization:'LF line endings and one final newline before SHA-256',api_source:`https://github.com/apple/apple-ads-platform-api-node/blob/${appleSdkRevision}/src/api/apple-ads-api.ts`,api_canonical_sha256:hash(api),sources,models,methods};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [directory,apiFile,output='generated/apple-platform-v1-models.json']=process.argv.slice(2);
 if(!directory||!apiFile)throw Error('Usage: node tools/apple-model-evidence.mjs <public SDK model directory> <public SDK API source> [output]');
 const data=extractAppleModels(directory,apiFile);fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({models:Object.keys(data.models).length,methods:Object.keys(data.methods).length,revision:data.revision,output}));
}
