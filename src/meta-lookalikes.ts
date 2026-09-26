import {MirrorError} from './errors.js';
import type {CompiledRequest,JsonObject} from './types.js';

/**
 * Meta lookalike audiences, per the Marketing API Lookalike Audiences guide (checked 2026-09-26): a LOOKALIKE
 * custom audience derived from an owned seed custom audience in the same ad account. It starts no delivery,
 * spends nothing and uploads no customer data. Customer-file, website, engagement and other subtypes, campaign or
 * Page conversion lookalikes, country groups and value-based seeds stay outside this contract.
 */
const obj=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown)=>typeof v==='string'&&/^\d{1,32}$/.test(v);
const country=(v:unknown)=>typeof v==='string'&&/^[A-Z]{2}$/.test(v);
const account=(v:unknown)=>String(v).replace(/^act_/,'');
// 1%–20% in whole-percent steps, compared in hundredths to avoid binary-fraction drift.
const percent=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v*100-Math.round(v*100))<1e-9?Math.round(v*100):undefined;

export const metaLookalikeKind=(p:CompiledRequest)=>p.gateway==='meta_native_action'&&p.method==='POST'&&/^\/v[^/]+\/act_[^/]+\/customaudiences$/.test(p.path);

function invalid(field:string,message:string):never{
 throw new MirrorError('INVALID_META_LOOKALIKE',message,{field});
}
function only(v:JsonObject,keys:string[],path:string){
 const extra=Object.keys(v).find(k=>!keys.includes(k));
 if(extra)invalid(path+extra,'"'+path+extra+'" is outside the qualified lookalike contract.');
}

/** Validates the request before review; nothing here reads or contacts Meta. */
export function assertMetaLookalike(body:JsonObject):void{
 only(body,['name','description','subtype','origin_audience_id','lookalike_spec'],'');
 if(body.subtype!=='LOOKALIKE')invalid('subtype','Only subtype LOOKALIKE is qualified; customer-file, website and engagement audiences need their own contracts.');
 if(typeof body.name!=='string'||!body.name.trim()||[...body.name].length>255)invalid('name','name must be text of 1 to 255 characters.');
 if(body.description!==undefined&&typeof body.description!=='string')invalid('description','description must be text.');
 if(!numeric(body.origin_audience_id))invalid('origin_audience_id','origin_audience_id must be the numeric ID of a seed custom audience.');
 const spec=body.lookalike_spec;
 if(!obj(spec))invalid('lookalike_spec','lookalike_spec must be an object.');
 only(spec,['type','ratio','starting_ratio','country','location_spec','allow_international_seeds'],'lookalike_spec/');
 if((spec.type===undefined)===(spec.ratio===undefined))invalid('lookalike_spec/ratio','Give exactly one of type (similarity or reach) and ratio.');
 if(spec.type!==undefined&&!['similarity','reach'].includes(spec.type))invalid('lookalike_spec/type','type must be similarity or reach.');
 if(spec.ratio!==undefined){const r=percent(spec.ratio);if(r===undefined||r<1||r>20)invalid('lookalike_spec/ratio','ratio must be 0.01 to 0.20 in 0.01 steps.');}
 if(spec.starting_ratio!==undefined){
  const s=percent(spec.starting_ratio);
  if(spec.ratio===undefined||s===undefined||s<0||s>=percent(spec.ratio)!)invalid('lookalike_spec/starting_ratio','starting_ratio needs a ratio, uses 0.01 steps and must be below ratio.');
 }
 if((spec.country===undefined)===(spec.location_spec===undefined))invalid('lookalike_spec/country','Give exactly one of country and location_spec.');
 if(spec.country!==undefined&&!country(spec.country))invalid('lookalike_spec/country','country must be a two-letter code.');
 if(spec.location_spec!==undefined){
  const l=spec.location_spec;if(!obj(l))invalid('lookalike_spec/location_spec','location_spec must be an object.');
  only(l,['geo_locations','excluded_geo_locations'],'lookalike_spec/location_spec/');
  for(const key of ['geo_locations','excluded_geo_locations']){
   const g=l[key];if(g===undefined&&key==='excluded_geo_locations')continue;
   if(!obj(g))invalid('lookalike_spec/location_spec/'+key,key+' must be an object.');
   only(g,['countries'],'lookalike_spec/location_spec/'+key+'/');
   if(!Array.isArray(g.countries)||!g.countries.length||!g.countries.every(country)||new Set(g.countries).size!==g.countries.length)invalid('lookalike_spec/location_spec/'+key+'/countries',key+'.countries must list unique two-letter codes; country groups are not qualified.');
  }
 }
 if(spec.allow_international_seeds!==undefined&&typeof spec.allow_international_seeds!=='boolean')invalid('lookalike_spec/allow_international_seeds','allow_international_seeds must be true or false.');
}

export const metaLookalikeSeed=(p:CompiledRequest)=>String((p.body as JsonObject).origin_audience_id);
const readFields='id,name,subtype,lookalike_spec';
/** The verification read of a created lookalike, recognised by its exact field list. */
export const metaLookalikeRead=(p:CompiledRequest)=>p.gateway==='meta_native_action'&&p.method==='GET'&&p.query.fields===readFields;
export const metaSeedFields='id,account_id,subtype,operation_status';

/** Against the normalized review state: the seed must be a normal custom audience in the selected account. */
export function metaLookalikeImpact(plan:CompiledRequest,state:unknown[]):JsonObject{
 const seed=metaLookalikeSeed(plan),row=state.map(s=>obj(s)?s:undefined).find(s=>s&&String(s.id)===seed);
 if(!row||account(row.account_id)!==account(plan.accountId))throw new MirrorError('STATE_TARGET_MISMATCH','The seed audience must belong to the selected ad account.',{origin_audience_id:seed});
 const status=obj(row.operation_status)?row.operation_status.code:row.operation_status;
 if(Number(status)===471)invalid('origin_audience_id','Meta has flagged this seed audience (operation status 471); it cannot seed a lookalike.');
 const spec=(plan.body as JsonObject).lookalike_spec as JsonObject;
 return {provider:'meta',effect:'Creates a lookalike audience from an owned seed. It starts no delivery; ad sets use it only when it is added to their targeting. Meta takes 1 to 6 hours to populate it.',seed:{id:seed,subtype:row.subtype??null},size:spec.ratio??spec.type,countries:spec.country?[spec.country]:spec.location_spec?.geo_locations?.countries,source:'https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences'};
}

/** Read-back shape of the configuration AMCP sent: the seed as origin IDs, ratios in hundredths. */
export function metaLookalikeProjection(row:unknown,expected=false):unknown{
 if(!obj(row))return row;
 const spec=obj(row.lookalike_spec)?row.lookalike_spec:{},out:JsonObject={};
 for(const k of ['id','name','subtype'])if(row[k]!==undefined)out[k]=row[k];
 const s:JsonObject={};
 if(expected){s.origin_ids=[String(row.origin_audience_id)];}
 else if(Array.isArray(spec.origin))s.origin_ids=spec.origin.map((o:JsonObject)=>String(o?.id)).sort();
 for(const k of ['type','country'])if(spec[k]!==undefined)s[k]=spec[k];
 for(const k of ['ratio','starting_ratio'])if(spec[k]!==undefined)s[k]=percent(spec[k])??spec[k];
 out.lookalike_spec=s;
 return out;
}

/** Name, subtype and the seed/ratio/country Meta reads back; location_spec and the seed override are not echoed. */
export function metaLookalikeVerification(plan:CompiledRequest,result:JsonObject):{path:string;query:JsonObject;expected:JsonObject;id:string;unobservable?:string[]}[]{
 const id=obj(result.data)?result.data.id:undefined;if(!numeric(id))return [];
 const b=plan.body as JsonObject,spec=b.lookalike_spec as JsonObject;
 const expected=metaLookalikeProjection({id,name:b.name,subtype:'LOOKALIKE',origin_audience_id:b.origin_audience_id,lookalike_spec:{type:spec.type,ratio:spec.ratio,starting_ratio:spec.starting_ratio,country:spec.country}},true) as JsonObject;
 const unobservable=['location_spec','allow_international_seeds'].filter(k=>spec[k]!==undefined).map(k=>'lookalike_spec.'+k);
 return [{path:'/'+plan.path.split('/')[1]+'/'+id,query:{fields:readFields},expected,id:id as string,...(unobservable.length?{unobservable}:{})}];
}
