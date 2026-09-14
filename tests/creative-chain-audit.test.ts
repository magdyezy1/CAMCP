import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {WriteVerifier} from '../src/write-verification.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {compileEntityMutation} from '../src/workflows.js';
import type {Actor,JsonObject} from '../src/types.js';

// Synthetic provider fixtures exercise ID handoff and read-back, not platform approval,
// asset dimensions, campaign eligibility, or acceptance with live credentials.
const actor:Actor={tenantId:'chain-audit',userId:'operator',role:'operator'},admin:Actor={...actor,role:'admin'},registry=new Registry();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const drive='https://drive.google.com/file/d/abcdefghijklmno/view';
function fixture(platform:string){
 const store=new Store(':memory:',Buffer.alloc(32,94).toString('base64')),gateway=platform+'_native_action';
 const connection={id:'selected-login',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:['123'],enabled:true,label:'Synthetic',scopes:platform==='meta'?['ads_management']:[]};store.putConnection(admin,connection,{accessToken:'synthetic'});
 // These parents represent previously observed account-scoped discovery, not guessed live IDs.
 store.rememberResource(connection,'123','200');store.rememberResource(connection,'123','adsquads/200');
 const records=new Map<string,JsonObject>(),calls:{path:string;method:string;body:any;query:JsonObject}[]=[];
 const snap=(kind:string,row:JsonObject)=>({request_status:'SUCCESS',[kind]:[{sub_request_status:'SUCCESS',[kind==='media'?'media':kind==='adsquads'?'adsquad':kind.slice(0,-1)]:row}]});
 const transport=new NativeTransport(async(input,init)=>{
  const url=new URL(String(input)),path=url.pathname.replace('/open_api',''),method=init?.method??'GET',raw=init?.body,type=new Headers(init?.headers).get('content-type');
  const b=raw instanceof FormData?Object.fromEntries(raw):raw?type==='application/json'?JSON.parse(String(raw)):Object.fromEntries(new URLSearchParams(String(raw))):{};
  calls.push({path,method,body:b,query:Object.fromEntries(url.searchParams)});
  if(platform==='meta'){
   if(method==='GET'){if(path==='/v25.0/act_123')return Response.json({id:'act_123',account_status:1,currency:'USD'});if(path.endsWith('/adimages'))return Response.json({data:[{hash:'imagehash123'}]});return Response.json(records.get(path.split('/').at(-1)!)??{id:'200',name:'Parent',status:'PAUSED'});}
   if(path.endsWith('/adimages')){assert.equal(b.bytes,png.toString('base64'));return Response.json({images:{image:{hash:'imagehash123'}}});}
   const creative=path.endsWith('/adcreatives'),id=creative?'300':'400',row:JsonObject={id,...Object.fromEntries(Object.entries(b).map(([k,v])=>[k,typeof v==='string'&&v.startsWith('{')?JSON.parse(v):v]))};
   if(creative)assert.equal(row.object_story_spec.link_data.image_hash,'imagehash123');else {assert.equal(row.creative.creative_id,'300');row.creative={id:'300'};}records.set(id,row);return Response.json({id});
  }
  if(platform==='google_ads'){
   if(path.endsWith('/googleAds:search')){const kind=/ FROM ([a-z_]+)/.exec(b.query)![1]!;
    const row=kind==='customer'?{id:'123',currencyCode:'USD',timeZone:'UTC'}:kind==='asset'?{resourceName:'customers/123/assets/456',type:'IMAGE'}:kind==='ad_group'?{resourceName:'customers/123/adGroups/200',status:'PAUSED',campaign:'customers/123/campaigns/100'}:records.get('ad')!;
    return Response.json({results:[{[kind.replace(/_([a-z])/g,(_m,c)=>c.toUpperCase())]:row}]});}
   if(path.endsWith('/assets:mutate')){assert.equal(b.operations[0].create.imageAsset.data,png.toString('base64'));return Response.json({results:[{resourceName:'customers/123/assets/456'}]});}
   assert.ok(path.endsWith('/adGroupAds:mutate'));const row=b.operations[0].create;assert.equal(row.ad.responsiveDisplayAd.marketingImages[0].asset,'customers/123/assets/456');records.set('ad',{...row,resourceName:'customers/123/adGroupAds/200~400'});return Response.json({results:[{resourceName:'customers/123/adGroupAds/200~400'}]});
  }
  if(platform==='snapchat'){
   if(method==='GET'){
    if(path==='/v1/adaccounts/123')return Response.json(snap('adaccounts',{id:'123'}));
    if(path==='/v1/adsquads/200')return Response.json(snap('adsquads',{id:'200',ad_account_id:'123',status:'PAUSED'}));
    if(path==='/v1/media/456')return Response.json(snap('media',{id:'456',ad_account_id:'123',media_status:'READY'}));
    const kind=path.split('/').at(-2)!;return Response.json(snap(kind,records.get(kind)!));
   }
   if(path.endsWith('/media'))return Response.json(snap('media',{id:'456',ad_account_id:'123'}));
   if(path.endsWith('/upload'))return Response.json({request_status:'SUCCESS',result:{id:'456',ad_account_id:'123',media_status:'READY'}});
   const kind=path.split('/').at(-1)!,row={...b[kind][0],id:kind==='creatives'?'300':'400'};
   if(kind==='creatives')assert.equal(row.top_snap_media_id,'456');else assert.equal(row.creative_id,'300');records.set(kind,row);return Response.json(snap(kind,row));
  }
  if(platform==='tiktok'){
   if(path==='/v1.3/advertiser/info/')return Response.json({code:0,data:{list:[{advertiser_id:'123',name:'Synthetic'}]}});
   if(path==='/v1.3/file/image/ad/upload/'){assert.ok(b.image_file instanceof Blob);return Response.json({code:0,data:{image_id:'ad-site/456'}});}
   if(path==='/v1.3/file/image/ad/info/')return Response.json({code:0,data:{list:[{image_id:'ad-site/456'}]}});
   if(path==='/v1.3/adgroup/get/')return Response.json({code:0,data:{list:[{adgroup_id:'200',advertiser_id:'123',operation_status:'DISABLE'}]}});
   if(path==='/v1.3/ad/get/')return Response.json({code:0,data:{list:[records.get('ad')]}});
   assert.equal(path,'/v1.3/ad/create/');assert.equal(b.creatives[0].image_ids[0],'ad-site/456');assert.equal(b.creatives[0].operation_status,'DISABLE');assert.equal(b.operation_status,undefined);records.set('ad',{...b.creatives[0],adgroup_id:b.adgroup_id,advertiser_id:'123',ad_id:'400'});return Response.json({code:0,data:{ad_ids:['400']}});
  }
  if(platform==='linkedin'){
   if(url.hostname==='www.linkedin.com'){assert.equal(method,'PUT');return new Response(null,{status:201});}
   if(path==='/rest/images'&&method==='POST')return Response.json({value:{image:'urn:li:image:456',uploadUrl:'https://www.linkedin.com/dms-uploads/synthetic/image'}});
   if(path.startsWith('/rest/images/'))return Response.json({id:'urn:li:image:456',owner:'urn:li:sponsoredAccount:123',status:'AVAILABLE'});
   if(method==='GET'){if(path==='/rest/adAccounts/123')return Response.json({id:123,name:'Synthetic'});assert.ok(path.includes('/creatives/'),'exact-ID verification avoids finders');return Response.json(records.get('creative'));}
   if(path==='/rest/adAccounts/123/creatives'){assert.equal(b.intendedStatus,'PAUSED');assert.equal(b.status,undefined);records.set('creative',{...b,id:'urn:li:sponsoredCreative:400'});return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:sponsoredCreative:400'}});}
   assert.ok(path.endsWith('/creatives/400'));assert.equal(b.patch.$set.intendedStatus,'ACTIVE');records.get('creative')!.intendedStatus='ACTIVE';return new Response(null,{status:204});
  }
  throw Error('Unexpected synthetic route '+platform+' '+path);
 });
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:true,requireBeforeState:true,maxBudgetChange:0},async()=>new Response(new Uint8Array(png)));
 const call=(tool:string,input:JsonObject)=>service.call(tool,input,actor);
 const prepare=(args:JsonObject)=>call('amcp_write',{action:'prepare',gateway,connection_id:connection.id,arguments:{account_id:'123',...args}});
 const execute=(r:JsonObject,extra:JsonObject={})=>call('amcp_write',{action:'execute',review_id:r.review_id,idempotency_key:r.review_id,confirmed:true,...extra});
 const verify=(r:JsonObject)=>new WriteVerifier(store,registry,transport,service.credentials).verify(actor,r.review_id);
 const media=async()=>{const r=ok(await call('amcp_media',{action:'prepare',platform,account_id:'123',connection_id:connection.id,drive_url:drive}));ok(await execute(r));return ok(await call('amcp_media',{action:'status',review_id:r.review_id}));};
 const mutate=async(action:string,payload:JsonObject,params:JsonObject={})=>{const r=ok(await prepare({action,payload,...params}));const result=ok(await execute(r));assert.equal(result.success,true,JSON.stringify(result));const v=await verify(r);assert.equal(v.status,'verified',JSON.stringify(v));return {r,result};};
 return {store,service,connection,calls,prepare,execute,verify,media,mutate};
}
function ok(r:JsonObject):JsonObject{assert.equal(r.success,true,JSON.stringify(r));return r.data;}

test('Meta Drive image -> native creative -> paused ad -> exact creative and ad read-back',async()=>{
 const f=fixture('meta');try{
  const image=await f.media();assert.equal(image.ready,true);
  const {result}=await f.mutate('meta_creative_create',{name:'Synthetic creative',object_story_spec:{page_id:'500',link_data:{image_hash:image.media_id,link:'https://example.test/',message:'Synthetic text'}}});
  await f.mutate('meta_ad_create',{name:'Synthetic ad',adset_id:'200',creative:{creative_id:result.data.id},status:'PAUSED'});
 }finally{f.store.close();}
});
test('Google Drive image asset -> responsive display ad -> exact GAQL read-back',async()=>{
 const f=fixture('google_ads');try{
  const image=await f.media();assert.equal(image.ready,true);
  await f.mutate('google_ads_v23_ad_group_ad_mutate_ad_group_ads',{operations:[{create:{ad_group:'customers/123/adGroups/200',status:'PAUSED',ad:{name:'Synthetic display ad',final_urls:['https://example.test/'],responsive_display_ad:{marketing_images:[{asset:image.media_id}],square_marketing_images:[{asset:image.media_id}],headlines:[{text:'Synthetic headline'}],long_headline:{text:'Synthetic long headline'},descriptions:[{text:'Synthetic description'}],business_name:'Synthetic business'}}}}]});
 }finally{f.store.close();}
});
test('Snapchat Drive image -> web-view creative -> paused ad -> exact read-back',async()=>{
 const f=fixture('snapchat');try{
  const image=await f.media();assert.equal(image.ready,true);
  const {result}=await f.mutate('snapchat_creative_create',{creatives:[{name:'Synthetic creative',ad_account_id:'123',type:'WEB_VIEW',top_snap_media_id:image.media_id,web_view_properties:{url:'https://example.test/'}}]});
  await f.mutate('snapchat_ad_create',{ads:[{name:'Synthetic ad',ad_squad_id:'200',creative_id:result.data.creatives[0].creative.id,type:'SNAP_AD',status:'PAUSED'}]},{params:{ad_squad_id:'200'}});
 }finally{f.store.close();}
});
test('TikTok existing-identity image handoff and exact ad read-back; identity provisioning remains an explicit contract gap',async()=>{
 const f=fixture('tiktok');try{
  const image=await f.media();assert.equal(image.ready,true);
  // The official SDK's AdCreateBody has one creatives array; this is not Smart+.
  const creative={ad_name:'Synthetic ad',operation_status:'DISABLE',ad_format:'SINGLE_IMAGE',image_ids:[image.media_id],identity_type:'CUSTOMIZED_USER',identity_id:'9000000000000000011',ad_text:'Synthetic text',landing_page_url:'https://example.test/',call_to_action:'LEARN_MORE'};
  await f.mutate('tiktok_ad_create',{advertiser_id:'123',adgroup_id:'200',creatives:[creative]});
  const before=f.calls.length;
  for(const payload of [{advertiser_id:'123',adgroup_id:'200',operation_status:'DISABLE',creatives:[{...creative,operation_status:'ENABLE'}]},{advertiser_id:'123',adgroup_id:'200',creatives:[{...creative,operation_status:'ENABLE'}]},{advertiser_id:'123',adgroup_id:'200',creatives:[{...creative,operation_status:undefined}]}]){
   const blocked=await f.prepare({action:'tiktok_ad_create',payload});assert.equal(blocked.success,false);assert.ok(['INVALID_ARGUMENT','PAUSED_CREATION_REQUIRED'].includes(blocked.error.code));
  }
  assert.equal(f.calls.length,before,'no provider reads or writes for unsafe creative status');
  const denied=await f.prepare({action:'tiktok_identity_create',payload:{advertiser_id:'123',identity_name:'Synthetic'}});assert.equal(denied.error.code,'WRITE_CONTRACT_UNAVAILABLE');
 }finally{f.store.close();}
});
test('LinkedIn image upload is separate from the missing Posts contract; existing-post creatives use intendedStatus and header IDs',async()=>{
 const f=fixture('linkedin');try{
  const media=await f.media();assert.equal(media.ready,true);assert.equal(media.media_id,'urn:li:image:456');
  const denied=await f.prepare({action:'linkedin_rest_posts_post',payload:{author:'urn:li:organization:500',commentary:'Synthetic',lifecycleState:'PUBLISHED',content:{media:{id:media.media_id}},adContext:{dscAdAccount:'urn:li:sponsoredAccount:123'}}});assert.equal(denied.error.code,'WRITE_CONTRACT_UNAVAILABLE');
  const {result}=await f.mutate('linkedin_rest_ad_accounts_ad_account_id_creatives_post',{account:'urn:li:sponsoredAccount:123',campaign:'urn:li:sponsoredCampaign:200',intendedStatus:'PAUSED',content:{reference:'urn:li:ugcPost:600'}});assert.equal(result.created_id,'urn:li:sponsoredCreative:400');
  assert.equal((await f.prepare({action:'linkedin_rest_ad_accounts_ad_account_id_creatives_post',payload:{status:'PAUSED'}})).error.code,'INVALID_ARGUMENT');
  const args={action:'linkedin_rest_ad_accounts_ad_account_id_creatives_creative_id_post',path_params:{creative_id:'400'},restli_method:'PARTIAL_UPDATE',payload:{patch:{$set:{intendedStatus:'ACTIVE'}}}},r=ok(await f.prepare(args));
  assert.equal((await f.execute(r)).error.code,'SPEND_CONFIRMATION_REQUIRED');
  saveSpendPolicy(f.store,admin,{gateway:'linkedin_native_action',account_id:'123',confirmed:true,policy:{allow_activation:false}});
  assert.equal((await f.execute(r,{spend_change_confirmed:true})).error.code,'POLICY_ACTIVATION_FORBIDDEN');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/creatives/400')&&c.method==='POST').length,0);
  const step=compileEntityMutation('create_ad',{platform:'linkedin',account_id:'123',parent_id:'200',payload:{content:{reference:'urn:li:ugcPost:600'}}});assert.equal(step.input.body.intendedStatus,'PAUSED');assert.equal(step.input.body.status,undefined);
 }finally{f.store.close();}
});
