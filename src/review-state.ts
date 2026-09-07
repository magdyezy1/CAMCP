import {sha256,stable} from './security.js';

// Response envelopes are validated before this projection. Keep unknown fields:
// a new provider configuration field must remain protected by default.
const volatile = new Set([
 'delivery_status','effective_status','secondary_status','updated_at','updated_time','last_modified_time',
 'last_modified_at','last_modified','update_time','modification_time','modify_time','last_updated_at','last_update_time',
 'request_id','request_time','trace_id','sub_request_status','request_status',
 'stats','statistics','metrics','insights','reporting','pacing_stats','pacing_metrics','total_stats','timeseries_stats',
 'delivery_metrics','delivery_stats','delivery_pacing','spend_to_date','last_synced_at'
]);
const fieldName=(key:string)=>key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const scalar=(value:unknown)=>value===null||['string','number','boolean'].includes(typeof value);

/** Configuration projection only; never use this to canonicalize a mutation payload. */
export function normalizeReviewState(value:unknown):unknown {
 if(Array.isArray(value)){
  const values=value.map(normalizeReviewState);
  // Preserve duplicates and types. Arrays of objects may have meaningful order.
  return values.every(scalar)?values.sort((a,b)=>{const x=stable(a),y=stable(b);return x<y?-1:x>y?1:0;}):values;
 }
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([key])=>!volatile.has(fieldName(key))).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([key,item])=>[key,normalizeReviewState(item)]));
 return value;
}
export const reviewStateHash=(value:unknown)=>sha256(stable(normalizeReviewState(value)));

/** JSON paths only: diagnostics must not disclose provider values or credentials. */
export function changedStateFields(expected:unknown,actual:unknown):string[]{
 const paths:string[]=[];
 const walk=(a:unknown,b:unknown,path:string)=>{
  if(stable(a)===stable(b))return;
  if(Array.isArray(a)&&Array.isArray(b)){
   for(let i=0;i<Math.max(a.length,b.length);i++){const child=path+'['+i+']';if(i>=a.length||i>=b.length)paths.push(child);else walk(a[i],b[i],child);}return;
  }
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
   for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){const child=path+'['+JSON.stringify(key)+']';if(!Object.hasOwn(a,key)||!Object.hasOwn(b,key))paths.push(child);else walk((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],child);}return;
  }
  paths.push(path);
 };
 walk(normalizeReviewState(expected),normalizeReviewState(actual),'$');return paths;
}
