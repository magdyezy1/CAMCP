import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {metricSources,metricDefinitions,reportPlatforms} from '../dist/src/report-metrics.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {reportEvidence} from '../dist/src/report-quality.js';

const put=(row,path,value)=>{const keys=path.split('.');let o=row;for(const k of keys.slice(0,-1))o=o[k]??={};o[keys.at(-1)]=value;};
// Rows that fill every declared field with a distinct number; objectives select the rule-based conversions.
const objective={meta:'OUTCOME_LEADS',snapchat:'LEAD_GENERATION'};
// Each platform's campaign identity, which normalizeNativeRow requires.
const identity={google:{campaign:{id:'1',name:'C'}},meta:{campaign_id:'1',campaign_name:'C'},tiktok:{dimensions:{campaign_id:'1'},metrics:{campaign_name:'C'}},snapchat:{id:'1',name:'C'},linkedin:{pivotValues:['urn:li:sponsoredCampaign:1'],name:'C'},microsoft:{CampaignId:'1',CampaignName:'C'},apple:{metadata:{id:1,name:'C'},totalMetrics:{}},reddit:{campaign_id:'1',campaign_name:'C'},ga4:{campaign_id:'1',campaign_name:'C'},gsc:{keys:['https://example.com/']}};
const base=platform=>({...structuredClone(identity[platform]),...(objective[platform]?{objective:objective[platform]}:{})});

test('every declared native field is the field the metric is read from, with its divisor',()=>{
 assert.deepEqual(Object.keys(metricSources).sort(),Object.keys(reportPlatforms).sort(),'every report platform explains its metrics');
 for(const [platform,sources] of Object.entries(metricSources)){
  if(platform==='x')continue; // X metrics come from xCampaignReport, checked below
  const row=base(platform),expected={};let n=11;
  for(const [metric,s] of Object.entries(sources))if(s.path){
   // Two metrics may read one field (Apple installs and conversions); both then expect its value.
   const existing=s.path.split('.').reduce((o,k)=>o?.[k],row);
   const value=existing??n++;if(existing===undefined)put(row,s.path,String(value));
   expected[metric]=Number(value)/(s.divisor??1);
  }
  const out=normalizeNativeRow(platform,row).metrics;
  for(const [metric,value] of Object.entries(expected))assert.equal(out[metric],value,platform+' '+metric+' from '+sources[metric].from);
 }
});

test('no platform reports a shared metric the table leaves out',()=>{
 for(const [platform,sources] of Object.entries(metricSources)){
  if(platform==='x')continue;
  const row=base(platform);let n=11;
  for(const s of Object.values(sources))if(s.path&&s.path.split('.').reduce((o,k)=>o?.[k],row)===undefined)put(row,s.path,String(n++));
  if(platform==='meta')row.actions=[{action_type:'lead',value:'5'},{action_type:'purchase',value:'6'},{action_type:'app_install',value:'7'},{action_type:'video_view',value:'8'},{action_type:'post_engagement',value:'9'}],row.action_values=[{action_type:'purchase',value:'10'}];
  const reported=Object.entries(normalizeNativeRow(platform,row).metrics).filter(([k,v])=>!k.startsWith('native_')&&v!==null&&v!==undefined).map(([k])=>k); // native_* fields are kept as returned
  assert.deepEqual(reported.filter(k=>!sources[k]),[],platform+' reports metrics the table does not explain');
  for(const k of Object.keys(sources))assert.ok(metricDefinitions[k]||['sessions','users','position'].includes(k),platform+' '+k+' has no label');
 }
});

test('rule-based conversions follow the campaign objective',()=>{
 const meta=o=>normalizeNativeRow('meta',{...identity.meta,objective:o,actions:[{action_type:'onsite_conversion.lead_grouped',value:'3'},{action_type:'omni_purchase',value:'4'},{action_type:'mobile_app_install',value:'5'}]}).metrics.conversions;
 assert.equal(meta('OUTCOME_LEADS'),3);assert.equal(meta('OUTCOME_SALES'),4);assert.equal(meta('OUTCOME_APP_PROMOTION'),5);assert.equal(meta('OUTCOME_TRAFFIC'),null);
 const snap=o=>normalizeNativeRow('snapchat',{...identity.snapchat,objective:o,stats:{conversion_sign_ups:'3',conversion_purchases:'4',total_installs:'5'}}).metrics.conversions;
 assert.equal(snap('LEAD_GENERATION'),3);assert.equal(snap('WEBSITE_CONVERSIONS'),4);assert.equal(snap('APP_INSTALLS'),5);assert.equal(snap('AWARENESS'),null);
});

test('X metric sources match the X report mapping',()=>{
 const src=fs.readFileSync('src/x-campaign-report.ts','utf8');
 const mapped=Object.fromEntries([...src.matchAll(/(\w+):\s*n\(r\.native_metrics\.(\w+)(,\s*1e6)?\)/g)].map(m=>[m[1],m[2]+(m[3]?' ÷ 1,000,000':'')]));
 assert.deepEqual(Object.fromEntries(Object.entries(metricSources.x).map(([k,s])=>[k,s.from])),mapped);
});

test('report evidence explains the metrics of the platforms it contains',()=>{
 const evidence=reportEvidence({id:'r1',config:{sources:[{platform:'google'},{platform:'linkedin'},{platform:'google'}]},sources:[]});
 assert.deepEqual(Object.keys(evidence.metric_sources),['google','linkedin']);
 assert.equal(evidence.metric_sources.linkedin.conversions.from,'externalWebsiteConversions');
});
