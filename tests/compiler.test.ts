import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler,expandPath} from '../src/compiler.js';
import {strictOptions} from '../src/service.js';
const registry=new Registry(),compiler=new Compiler(registry);
test('Google resource-name templates preserve path structure without traversal',()=>{
 const p=expandPath('/v23/{resource_name=customers/*/adGroups/*}',{resource_name:'customers/123/adGroups/456'});assert.equal(p.path,'/v23/customers/123/adGroups/456');
 assert.throws(()=>expandPath('/{id}',{id:'../secret'}),/Unsafe/);assert.throws(()=>expandPath('/{id}',{id:'%2fsecret'}),/Unsafe/);
 assert.throws(()=>expandPath('/v23/{r=customers/*/adGroups/*}',{r:'customers/123/campaigns/456'}),/does not match/);
});
test('Google customer alias and GAQL body route correctly',()=>{
 const p=compiler.compile('google_ads_native_action',{action:'google_ads_v23_google_ads_search',account_id:'1234567890',payload:{query:'SELECT campaign.id FROM campaign LIMIT 1'}},strictOptions);
 assert.equal(p.method,'POST');assert.equal(p.path,'/v23/customers/1234567890/googleAds:search');assert.equal((p.body as any).query,'SELECT campaign.id FROM campaign LIMIT 1');assert.deepEqual(p.query,{});assert.equal(p.readOnly,true);
});
test('Meta act_ alias and query precedence retain exact string identifiers',()=>{
 const p=compiler.compile('meta_native_action',{action:'meta_ad_account_id_campaigns_get',account_id:'act_111111111111111',params:{limit:20},query:{limit:1}},strictOptions);
 assert.equal(p.path,'/v25.0/act_111111111111111/campaigns');assert.equal(p.query.limit,1);
});
test('LinkedIn keeps write params in query and payload in body',()=>{
 const p=compiler.compile('linkedin_native_action',{action:'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',path_params:{ad_account_id:'123'},params:{q:'search'},query:{q:'override'},payload:{name:'Draft',status:'PAUSED'}},strictOptions);
 assert.equal(p.query.q,'override');assert.deepEqual(p.body,{name:'Draft',status:'PAUSED'});assert.equal(p.headers['X-Restli-Protocol-Version'],'2.0.0');
});
test('TikTok large advertiser ID stays a string',()=>{
 const p=compiler.compile('tiktok_native_action',{action:'tiktok_campaign_get',advertiser_id:'7999999999999999999',params:{page_size:1}},strictOptions);assert.equal(p.query.advertiser_id,'7999999999999999999');
});
test('every method/path record expands deterministically from its declared template',()=>{
 let count=0;
 for(const c of registry.data.catalogs){for(const a of c.actions){if(!a.method||!a.path)continue;const params:Record<string,unknown>={};
  for(const required of a.required)if(typeof required==='string')params[required]='test';
  for(const match of a.path.matchAll(/\{(\+?)([^{}=]+)(?:=([^{}]+))?\}/g)){params[match[2]!]=match[3]&&match[3]!=='*'?match[3].replaceAll('**','test').replaceAll('*','test'):'test';}
  for(const k of a.raw.required_path_params??[])params[k]='test';
  const input={action:a.name,params,path_params:params,payload:a.method==='GET'?undefined:params};
  const p=compiler.compile(c.gateway,input,strictOptions);assert.equal(p.method,a.method);
  // One independently documented account prefix correction; all other captured
  // templates retain the original deterministic conformance assertion.
  const template=c.gateway==='meta_native_action'&&a.name==='meta_ad_account_id_adlabels_get'?'/v25.0/act_{ad_account_id}/adlabels':a.path.startsWith('https://')?new URL(a.path).pathname:a.path.split('?')[0]!;
  assert.equal(p.path,expandPath(template,params).path);count++;
 }}
 assert.equal(count,2208);
});
