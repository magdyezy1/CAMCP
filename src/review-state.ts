import {sha256,stable} from './security.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

// Response envelopes are validated before this projection. Keep unknown fields:
// a new provider configuration field must remain protected by default.
const volatile = new Set([
 'delivery_status','effective_status','secondary_status','updated_at','updated_time','last_modified_time',
 'last_modified_at','last_modified','update_time','modification_time','modify_time','modified_at','modified_time','last_updated_at','last_update_time',
 'request_id','request_time','trace_id','sub_request_status','request_status',
 'stats','statistics','metrics','insights','reporting','pacing_stats','pacing_metrics','total_stats','timeseries_stats',
 'delivery_metrics','delivery_stats','delivery_pacing','spend_to_date','last_synced_at'
]);
const fieldName=(key:string)=>key.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
const scalar=(value:unknown)=>value===null||['string','number','boolean'].includes(typeof value);
// Only fields whose provider contracts define membership, rather than sequence.
// Unknown scalar arrays stay ordered until a contract explicitly qualifies them.
const unorderedFields=new Set(['country_codes','countries','genders','age_groups','age_ranges','locales','device_platforms','publisher_platforms','facebook_positions','instagram_positions','messenger_positions','audience_network_positions','placements','included_languages','excluded_languages']);

/** Configuration projection only; never use this to canonicalize a mutation payload. */
export function normalizeReviewState(value:unknown,key=''):unknown {
 if(Array.isArray(value)){
  const values=value.map(item=>normalizeReviewState(item));
  // Preserve duplicates and types. Arrays of objects may have meaningful order.
  return unorderedFields.has(fieldName(key))&&values.every(scalar)?values.sort((a,b)=>{const x=stable(a),y=stable(b);return x<y?-1:x>y?1:0;}):values;
 }
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .filter(([key])=>!volatile.has(fieldName(key))).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([key,item])=>[key,normalizeReviewState(item,key)]));
 return value;
}
/** Google GAQL snapshot rows are an unordered resource set. Configuration within
 * each resource remains governed by the normal projection, including ordered arrays. */
export function normalizeSnapshot(read:CompiledRequest,data:unknown):unknown{
 if(read.gateway!=='google_ads_native_action'||!data||Array.isArray(data)||typeof data!=='object')return normalizeReviewState(data);
 const query=String((read.body as JsonObject)?.query??''),resource=/\bFROM\s+([a-z_]+)/i.exec(query)?.[1];
 const rows=(data as JsonObject).results;if(!resource||!query.includes(resource+'.resource_name')||!Array.isArray(rows))return normalizeReviewState(data);
 const key=resource.replace(/_([a-z])/g,(_m,c)=>c.toUpperCase()),seen=new Set<string>();
 const items=rows.map((row:JsonObject)=>{const value=row[resource]??row[key],id=value?.resourceName??value?.resource_name;if(typeof id!=='string'||!id||seen.has(id))throw new MirrorError('STATE_RESOURCE_INVALID','The state response contains missing or duplicate resource identities.',{},502);seen.add(id);return {id,row};});
 const expected=[...new Set([...query.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]!))];
 if(expected.length&&(expected.length!==seen.size||expected.some(id=>!seen.has(id))))throw new MirrorError('STATE_RESOURCE_MISMATCH','The state response does not cover exactly the requested resources.',{},409);
 items.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 return normalizeReviewState({...data,results:items.map(item=>item.row)});
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
