import {MirrorError} from './errors.js';
import type {Action,JsonObject} from './types.js';
import {nativeFields,assertSameAlias} from './parameters.js';
export interface ResponseControls {fields?:string[];maxItems?:number;compact?:boolean}
const metadata=/^(?:.*[Ee]rror.*|.*[Ff]ail.*|warnings?|paging|pagination|page_info|pageInfo|page|page_size|pageSize|total_pages|links|metadata|meta|summary|request_id|requestId|request_status|status|code|message|success|truncated|total|total_count|totalCount|totalResults|has_more|hasMore|count|offset|limit|start|cursor|next.*|previous.*)$/;
const containers=new Set(['data','results','result','rows','list','items','elements','campaigns','campaign','adaccounts','adaccount','adsets','adset','ads','ad','creatives','creative','organizations','stats','timeseries_stats','total_stats']);
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function responseControls(gateway:string,action:Action,input:JsonObject):ResponseControls|undefined {
 const alias=!nativeFields(gateway,action)?input.fields:undefined;
 assertSameAlias(input.result_fields,alias,'result_fields/fields');
 const fields=input.result_fields??alias;
 if(fields!==undefined&&(!Array.isArray(fields)||fields.some(f=>typeof f!=='string'||!f||f.split('.').some((p:string)=>!p||['__proto__','prototype','constructor'].includes(p)))))throw new MirrorError('INVALID_PARAMETER','result_fields must contain nonempty field paths.');
 if(input.max_items!==undefined&&(!Number.isInteger(input.max_items)||input.max_items<1||input.max_items>10000))throw new MirrorError('INVALID_PARAMETER','max_items must be an integer from 1 to 10000.');
 if(input.compact!==undefined&&typeof input.compact!=='boolean')throw new MirrorError('INVALID_PARAMETER','compact must be boolean.');
 return fields?.length||input.max_items!==undefined||input.compact?{...(fields?.length?{fields}:{}),...(input.max_items!==undefined?{maxItems:input.max_items}:{}),compact:input.compact===true}:undefined;
}
function failure(value:unknown):boolean {
 if(Array.isArray(value))return value.some(failure);
 if(!object(value))return false;
 return Object.entries(value).some(([k,v])=>/error|fail/i.test(k)&&v!==null&&v!==false&&v!==''&&(!Array.isArray(v)||v.length>0)||/^(?:is_)?success$/.test(k)&&v===false||/status$/i.test(k)&&typeof v==='string'&&/error|fail|partial/i.test(v)||typeof v==='object'&&failure(v));
}
function select(value:JsonObject,fields:string[]):JsonObject {
 const out:JsonObject={};
 for(const path of fields){const parts=path.split('.');let source:any=value,target=out;
  for(let i=0;i<parts.length;i++){const key=parts[i]!;if(!object(source)||!Object.hasOwn(source,key))break;if(i===parts.length-1){target[key]=source[key];break;}source=source[key];if(!object(source))break;target=target[key]??=( {} );}
 }
 for(const [key,v]of Object.entries(value))if(metadata.test(key)||failure(v))out[key]=v;
 return out;
}
/** Shapes successful records after pagination/ownership checks. Diagnostic subtrees are immutable. */
export function projectResponse(data:unknown,controls?:ResponseControls):{data:unknown;truncated:boolean} {
 if(!controls)return {data,truncated:false};
 let truncated=false;
 function visit(value:unknown,record=false,projectRecords=true):unknown {
  if(Array.isArray(value)){
   const rows=value.filter((v,i)=>{if(controls!.maxItems===undefined||i<controls!.maxItems||failure(v))return true;truncated=true;return false;});
   return rows.map(v=>failure(v)?v:visit(v,true,projectRecords));
  }
  if(!object(value))return value;
  // A container with some failed children still allows shaping its successful siblings.
  const envelope=Object.keys(value).some(k=>containers.has(k)&&typeof value[k]==='object');
  if(!envelope&&failure(value))return value;
  const didProject=projectRecords&&!!controls!.fields&&record&&!envelope;
  const selected=didProject?select(value,controls!.fields!):value;
  const out:JsonObject={};
  for(const [key,v]of Object.entries(selected)){
   if(metadata.test(key)||failure(v)&&!containers.has(key)){out[key]=v;continue;}
   const shaped=visit(v,containers.has(key),projectRecords&&!didProject);
   if(controls!.compact&&(shaped===null||shaped===''||object(shaped)&&!Object.keys(shaped).length))continue;
   out[key]=shaped;
  }
  return out;
 }
 return {data:visit(data,true),truncated};
}
