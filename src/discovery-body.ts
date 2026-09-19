import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** Structural validation against an explicitly selected Google Discovery model.
 * Route permission, oneofs, scopes, field masks and business rules remain with
 * the provider contract. Schema ingestion alone never enables a mutation. */
export function validateDiscoveryBody(model:string,schemas:Record<string,JsonObject>,value:unknown,required=false):void{
 let nodes=0;
 function fail(field:string,reason:string):never{throw new MirrorError('INVALID_VENDOR_BODY','Request differs from the pinned provider model.',{model,field,reason});}
 function visit(raw:JsonObject,v:unknown,field:string,depth:number):void{
  if(++nodes>50000||depth>48)fail(field,'Request exceeds validation bounds');
  const s=raw.$ref?schemas[raw.$ref]:raw;if(!s)fail(field,'Unresolved vendor model');
  if(raw.readOnly===true||s.readOnly===true)fail(field,'Output-only field');
  // ProtoJSON null means unset, and cannot satisfy a required create field.
  if(v===null){if(required&&/^Required\./.test(raw.description??''))fail(field,'Required value is unset');return;}
  if(s.type==='object'){
   if(!v||typeof v!=='object'||Array.isArray(v))fail(field,'Expected object');const record=v as JsonObject;
   if(required)for(const [key,child]of Object.entries(s.properties??{}) as [string,JsonObject][])if(!child.readOnly&&/^Required\./.test(child.description??'')&&record[key]==null)fail(field+'/'+key,'Required field is missing');
   for(const [key,item]of Object.entries(record)){const child=s.properties?.[key]??s.additionalProperties;if(!child||typeof child!=='object')fail(field+'/'+key,'Unknown field');visit(child,item,field+'/'+key,depth+1);}return;
  }
  if(s.type==='array'){if(!Array.isArray(v)||v.length>10000)fail(field,'Expected bounded array');v.forEach((item,i)=>visit(s.items,item,field+'/'+i,depth+1));return;}
  if(s.enum){if(typeof v!=='string'||!s.enum.includes(v))fail(field,'Unknown enum value');return;}
  if(s.format==='int64'||s.format==='uint64'){
   if(!(typeof v==='string'&&/^-?\d+$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)))fail(field,'Expected decimal string or safe integer');
   const n=BigInt(v as string),unsigned=s.format==='uint64';if(n<(unsigned?0n:-(1n<<63n))||n>(unsigned?(1n<<64n)-1n:(1n<<63n)-1n))fail(field,'Outside native integer range');return;
  }
  if(s.type==='integer'){if(!Number.isSafeInteger(v))fail(field,'Expected safe integer');}
  else if(s.type==='number'){if(typeof v!=='number'||!Number.isFinite(v))fail(field,'Expected finite number');}
  else if(s.type&&typeof v!==s.type)fail(field,'Expected '+s.type);
 }
 visit({$ref:model},value,'',0);
}
