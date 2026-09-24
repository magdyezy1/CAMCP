import {calculateMetrics,metricDefinitions} from './report-metrics.js';
import type {JsonObject} from './types.js';

/** Sum only additive columns within one account, currency and result definition. */
export function reportSummary(rows:JsonObject[],custom:JsonObject[]=[]):JsonObject[] {
 const groups=new Map<string,JsonObject[]>();
 for(const row of rows){
  const key=JSON.stringify([row.platform,row.account_id,row.currency,row.timezone,row.objective_group,row.result_definition,row.attribution,row.date_from,row.date_to]);
  const group=groups.get(key)??[];group.push(row);groups.set(key,group);
 }
 return [...groups.values()].map(group=>{
  const first=group[0]!,values:JsonObject={};
  for(const [key,definition]of Object.entries(metricDefinitions)){
   if(definition.formula)continue;
   values[key]=definition.aggregation==='sum'&&group.every(r=>typeof r.metrics[key]==='number')?group.reduce((n,r)=>n+r.metrics[key],0):null;
  }
  return {platform:first.platform,account_id:first.account_id,currency:first.currency,timezone:first.timezone,objective_group:first.objective_group,date_from:first.date_from,date_to:first.date_to,
   result_definition:first.result_definition,attribution:first.attribution,campaign_count:group.length,complete:group.every(r=>r.complete),
   metrics:calculateMetrics(values,custom),decisions:group.reduce((counts:JsonObject,r)=>{const k=r.recommendation.decision;counts[k]=(counts[k]??0)+1;return counts;},{})};
 });
}
