import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Settings of the selected DV360 advertiser, Display & Video 360 API v4 (pinned Discovery document: advertisers.patch and
 * Advertiser; checked 2026-09-27).
 */
const gateway='dv360_native_action',registry=new Registry(),action='DV360_ADVERTISERS_PATCH';
const actor={tenantId:'dv360-advertiser-settings',userId:'operator',role:'operator'},owner={...actor,role:'admin'};
function fixture(mode=''){
 const store=new Store(':memory:',Buffer.alloc(32,72).toString('base64')),calls=[];let writes=0;
 store.putConnection(owner,{id:'dv360',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic DV360',scopes:['https://www.googleapis.com/auth/display-video']},{accessToken:'synthetic'});
 const advertiser={name:'advertisers/123',advertiserId:'123',partnerId:'1',displayName:'Advertiser',entityStatus:'ENTITY_STATUS_PAUSED',generalConfig:{domainUrl:'https://example.com',currencyCode:'USD',timeZone:'America/New_York'},adServerConfig:{thirdPartyOnlyConfig:{}},creativeConfig:{},billingConfig:{billingProfileId:'9'},servingConfig:{exemptTvFromViewabilityTargeting:false},integrationDetails:{integrationCode:'OLD'},containsEuPoliticalAds:'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'};
 const assets={'501':{adAssetType:'AD_ASSET_TYPE_IMAGE',entityStatus:'ENTITY_STATUS_ACTIVE'},'502':{adAssetType:'AD_ASSET_TYPE_YOUTUBE_VIDEO',entityStatus:'ENTITY_STATUS_ACTIVE'}};
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method,body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,method,query:u.search});
  if(method==='GET'){
   if(path==='/v4/advertisers/123')return Response.json(structuredClone(advertiser));
   const m=/^\/v4\/advertisers\/123\/adAssets\/(\d+)$/.exec(path);
   if(m&&assets[m[1]])return Response.json({name:'advertisers/123/adAssets/'+m[1],adAssetId:m[1],...assets[m[1]]});
   return Response.json({error:{code:404,message:'Not found',status:'NOT_FOUND'}},{status:404});
  }
  if(method==='PATCH'&&path==='/v4/advertisers/123'){
   writes++;
   if(mode!=='ignore')for(const f of u.searchParams.get('updateMask').split(',')){const [a,b]=f.split('.');if(b){advertiser[a]??={};advertiser[a][b]=body[a][b];}else advertiser[a]=body[a];}
   return Response.json(mode==='other'?{...structuredClone(advertiser),advertiserId:'124',name:'advertisers/124'}:structuredClone(advertiser));
  }
  throw new Error('Unexpected '+method+' '+path);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,maxBudgetChange:0,requireBeforeState:true});
 const patch=(updateMask,body)=>service.call('amcp_write',{action:'prepare',gateway,arguments:{action,params:{advertiserId:'123',updateMask},body}},actor);
 const execute=(p,extra={})=>service.call('amcp_write',{action:'execute',review_id:p.data.review_id,idempotency_key:p.data.idempotency_key,confirmed:true,...extra},actor);
 const verify=p=>service.call('amcp_campaign',{action:'verify',review_id:p.data.review_id},actor);
 return {store,calls,advertiser,patch,execute,verify,writes:()=>writes};
}
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r).slice(0,900));return r;};

test('the name, domain, default business name, logo and integration code change and verify; a replay sends nothing',async()=>{
 const f=fixture();try{
  const p=ok(await f.patch('displayName,generalConfig.domainUrl,defaultBusinessName,defaultLogoAssetId,integrationDetails.integrationCode',{displayName:'Advertiser EU',generalConfig:{domainUrl:'https://shop.example.com'},defaultBusinessName:'Example Shop',defaultLogoAssetId:'501',integrationDetails:{integrationCode:'CRM-42'}}));
  assert.equal(p.data.creative_impact.scope,'advertiser_settings');assert.deepEqual(p.data.creative_impact.changes['generalConfig.domainUrl'],{from:'https://example.com',to:'https://shop.example.com'});
  ok(await f.execute(p));assert.equal(ok(await f.verify(p)).data.status,'verified');assert.equal((await f.execute(p)).data.replayed,true);assert.equal(f.writes(),1);
  assert.equal(f.advertiser.generalConfig.domainUrl,'https://shop.example.com');assert.equal(f.advertiser.generalConfig.currencyCode,'USD');
 }finally{f.store.close();}
});

test('activating the advertiser needs spending confirmation and counts as activation; pausing and TV viewability need neither',async()=>{
 const f=fixture();try{
  const active=ok(await f.patch('entityStatus',{entityStatus:'ENTITY_STATUS_ACTIVE'}));assert.match(active.data.creative_impact.effect,/may spend and bid again/);
  assert.equal((await f.execute(active)).error?.code,'SPEND_CONFIRMATION_REQUIRED');ok(await f.execute(active,{spend_change_confirmed:true}));assert.equal(ok(await f.verify(active)).data.status,'verified');
  const tv=ok(await f.patch('servingConfig.exemptTvFromViewabilityTargeting',{servingConfig:{exemptTvFromViewabilityTargeting:true}}));ok(await f.execute(tv));assert.equal(ok(await f.verify(tv)).data.status,'verified');
  const paused=ok(await f.patch('entityStatus',{entityStatus:'ENTITY_STATUS_PAUSED'}));ok(await f.execute(paused));assert.equal(ok(await f.verify(paused)).data.status,'verified');
  saveSpendPolicy(f.store,owner,{gateway,account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await f.patch('entityStatus',{entityStatus:'ENTITY_STATUS_ACTIVE'})).error?.code,'POLICY_ACTIVATION_FORBIDDEN');
  ok(await f.patch('displayName',{displayName:'Still allowed'}));
 }finally{f.store.close();}
});

test('malformed updates are refused before any request',async()=>{
 const cases=[
  ['deletion',['entityStatus',{entityStatus:'ENTITY_STATUS_SCHEDULED_FOR_DELETION'}]],
  ['billing',['billingConfig.billingProfileId',{billingConfig:{billingProfileId:'10'}}]],
  ['consent flag',['creativeConfig.videoCreativeDataSharingAuthorized',{creativeConfig:{videoCreativeDataSharingAuthorized:true}}]],
  ['domain with a path',['generalConfig.domainUrl',{generalConfig:{domainUrl:'https://example.com/shop'}}]],
  ['currency',['generalConfig.currencyCode',{generalConfig:{currencyCode:'EUR'}}]],
  ['unmasked field',['displayName',{displayName:'A',defaultBusinessName:'B'}]],
  ['unmasked nested field',['generalConfig.domainUrl',{generalConfig:{domainUrl:'https://a.example.com',currencyCode:'USD'}}]],
  ['unknown declaration',['containsEuPoliticalAds',{containsEuPoliticalAds:'EU_POLITICAL_ADVERTISING_STATUS_UNKNOWN'}]],
  ['logo name',['defaultLogoAssetId',{defaultLogoAssetId:'logo.png'}]],
  ['long name',['displayName',{displayName:'é'.repeat(121)}]]
 ];
 for(const [label,[mask,body]] of cases){const f=fixture();try{const r=await f.patch(mask,body);assert.equal(r.success,false,label);assert.equal(f.calls.length,0,label+': '+JSON.stringify(r).slice(0,300));}finally{f.store.close();}}
});

test('unchanged settings and unusable logos are refused without writes; a receipt for another advertiser is never resubmitted; an ignored update is not verified; the model and ledger match',async()=>{
 const f=fixture();try{
  assert.equal((await f.patch('displayName',{displayName:'Advertiser'})).error?.code,'INVALID_DV360_ADVERTISER_SETTING');
  assert.equal((await f.patch('defaultLogoAssetId',{defaultLogoAssetId:'502'})).error?.code,'INVALID_DV360_ADVERTISER_SETTING');
  assert.equal((await f.patch('defaultLogoAssetId',{defaultLogoAssetId:'599'})).error?.code,'STATE_NOT_FOUND');
  assert.equal(f.writes(),0);
 }finally{f.store.close();}
 const other=fixture('other');try{const p=ok(await other.patch('displayName',{displayName:'New'}));assert.equal((await other.execute(p)).success,false);assert.equal((await other.execute(p)).success,false);assert.equal(other.writes(),1);}finally{other.store.close();}
 const ignored=fixture('ignore');try{const p=ok(await ignored.patch('displayName',{displayName:'New'}));ok(await ignored.execute(p));assert.notEqual(ok(await ignored.verify(p)).data.status,'verified');}finally{ignored.store.close();}
 const d=JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json','utf8')),S=(d.document??d).schemas;
 assert.match(S.Advertiser.properties.entityStatus.description,/can spend their budgets/);assert.match(S.AdvertiserGeneralConfig.properties.domainUrl.description,/no path or query string/);
 const rows=actionContracts(registry).filter(r=>r.gateway===gateway&&r.action===action);assert.equal(rows.length,1);assert.equal(rows[0].status,'reviewed_write_family');assert.equal(rows[0].family,'dv360_advertiser_settings');
});
