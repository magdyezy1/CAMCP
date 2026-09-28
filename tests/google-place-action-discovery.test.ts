import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {ScopeGuard} from '../src/scope.js';
import {actionContracts} from '../src/action-contracts.js';
import {placeActionReadKind,placeActionReadResult,runPlaceActionDiscovery} from '../src/google-place-action-discovery.js';
import {placeActionTypes} from '../src/google-place-action-links.js';
import type {Actor,Connection,JsonObject,CompiledRequest} from '../src/types.js';

const gateway='google_business_native_action',operation='gmb_engagement_ops',id='336ecb51-2df8-4967-8bd3-cba64d552296',other='b9a767a2-e9a5-4863-9806-05a459367597',location='locations/456';
const actor:Actor={tenantId:'place-read',userId:'reader',role:'reader'},owner:Actor={...actor,role:'admin'},registry=new Registry(),compiler=new DelegatedNativeCompiler();
const type=(name='APPOINTMENT')=>({placeActionType:name,displayName:'Book appointment'});
const link=(n='100')=>({name:location+'/placeActionLinks/'+n,uri:'https://example.com/book/'+n,placeActionType:'APPOINTMENT',providerType:'MERCHANT',isEditable:true,isPreferred:false});
const args=(action='LIST_PLACE_ACTION_TYPE_METADATA',extra:JsonObject={})=>({action,location_id:'456',connection_id:id,...extra});
const plan=(action='LIST_PLACE_ACTION_TYPE_METADATA',extra:JsonObject={})=>compiler.compile(gateway,{operation,arguments:args(action,extra)});
function fixture(){
 const store=new Store(':memory:',Buffer.alloc(32,51).toString('base64')),calls:JsonObject[]=[];
 const c:Connection={id,tenantId:actor.tenantId,gateway,label:'Synthetic location identity',enabled:true,accounts:[location],writeAccounts:[],scopes:['https://www.googleapis.com/auth/business.manage']};
 const provision=(change:Partial<Connection>={},token='selected-synthetic')=>store.putConnection(owner,{...c,...change},{accessToken:token});provision();let mode='success';
 const transport=new NativeTransport(async(url,init)=>{
  const u=new URL(String(url)),headers=new Headers(init?.headers);calls.push({origin:u.origin,path:u.pathname,query:Object.fromEntries(u.searchParams),authorization:headers.get('authorization')});assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);assert.equal(u.origin,'https://mybusinessplaceactions.googleapis.com');
  if(mode==='scope_revoke')provision({scopes:[]});if(mode==='grant_revoke')provision({accounts:['locations/999']});if(mode==='disconnect')store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(actor.tenantId,id);
  if(mode==='error'||mode==='embedded_error')return Response.json({error:{code:403,message:'Synthetic denied'}},{status:mode==='error'?403:200});
  if(mode==='private_error')return Response.json({error:{code:400,message:'Invalid destination https://example.com/?X-Goog-Credential=private-read-secret'}},{status:400});
  if(mode==='retry'&&calls.length===1)return Response.json({error:{code:503,message:'Synthetic retry'}},{status:503});
  if(mode==='unknown')return Response.json({unexpected:'result'});if(mode==='empty')return Response.json({});if(mode==='partial')return Response.json({placeActionTypeMetadata:[type()],partialFailure:true});
  if(u.pathname==='/v1/placeActionTypeMetadata')return Response.json({placeActionTypeMetadata:[type(u.searchParams.has('pageToken')?'ONLINE_APPOINTMENT':'APPOINTMENT')],...(mode==='pages'&&!u.searchParams.has('pageToken')?{nextPageToken:'next'}:{})});
  const value={...link(),...(mode==='wrong_link'?{name:location+'/placeActionLinks/999'}:{}),...(mode==='foreign'?{name:'locations/999/placeActionLinks/100'}:{}),...(mode==='private'?{uri:'https://example.com/book?X-Goog-Credential=private-read-secret'}:{})};
  return Response.json(u.pathname.endsWith('/placeActionLinks')?{placeActionLinks:[value]}:value);
 },async()=>{},30000,8*1024*1024,10000);
 const service=new MirrorService(registry,store,transport,undefined,{allowWrites:false,requireBeforeState:true,maxBudgetChange:0});
 return {store,c,calls,provision,service,mode:(v:string)=>{mode=v;},call:(input:JsonObject=args(),who=actor)=>service.call(gateway,{operation,arguments:input},who)};
}

test('public action-type discovery binds the friendly location to the native filter and read grant',async()=>{
 const f=fixture();try{const before=f.store.listConnections(actor.tenantId),out=await f.call();assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.discovery.complete,true);assert.equal(out.data.discovery.location_id,location);assert.equal(out.data.discovery.location_eligibility,'returned_by_location_filter');assert.deepEqual(out.data.data.placeActionTypeMetadata,[type()]);assert.equal(f.calls[0]!.query.filter,'location='+location);assert.deepEqual(f.store.listConnections(actor.tenantId),before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM idempotency').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM resource_ownership').get()!.n,0);}finally{f.store.close();}
});
test('explicit native location filter determines scope even with multiple stored location grants',async()=>{
 const f=fixture();try{f.provision({accounts:[location,'locations/999']});const out=await f.call(args(undefined,{location_id:undefined,query:{filter:'location='+location,languageCode:'ar-SA'}}));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.discovery.location_id,location);assert.equal(f.calls[0]!.query.languageCode,'ar-SA');}finally{f.store.close();}
});
test('global and regional metadata are public context, never proof of selected-location eligibility',async()=>{
 const f=fixture();try{f.provision({accounts:['123']});for(const query of [{},{filter:'region_code=SA'},{filter:'region_code=419'}]){const out=await f.call(args(undefined,{location_id:undefined,account_id:'123',query}));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.discovery.location_id,null);assert.equal(out.data.discovery.location_eligibility,'not_established');assert.equal(out.data.discovery.context_grant,'123');}assert.equal(f.calls.length,3);}finally{f.store.close();}
});
test('a sole implicit global context is frozen into continuation metadata without choosing another login',async()=>{
 const f=fixture();try{f.provision({accounts:['123']});const out=await f.call(args(undefined,{location_id:undefined}));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.discovery.context_grant,'123');assert.equal(out.data.discovery.connection_id,id);}finally{f.store.close();}
});
test('conflicting, ungranted, malformed or broader account filters fail before egress',async()=>{
 const f=fixture();try{for(const extra of [{query:{filter:'location=locations/999'}},{location_id:'locations/456/extra'},{account_id:'123'},{location_id:undefined,account_id:'123',query:{filter:'location='+location}},{location_id:undefined,query:{filter:'location=locations/999'}},{query:{filter:'location='+location+' OR location=locations/999'}},{query:{filter:'region_code=sa'}},{query:{filter:'region_code=SA',pageSize:101}},{query:{languageCode:'../private'}},{query:{fields:'placeActionTypeMetadata'}},{payload:{}}]){const out=await f.call(args(undefined,extra));assert.equal(out.success,false,JSON.stringify(extra));}assert.equal(f.calls.length,0);}finally{f.store.close();}
});
test('friendly and native metadata aliases agree or fail; caller input remains unchanged',async()=>{
 const f=fixture();try{const input=args(undefined,{params:{filter:'location='+location,pageSize:2},query:{filter:'location='+location,pageSize:2}}),saved=structuredClone(input);const out=await f.call(input);assert.equal(out.success,true,JSON.stringify(out));assert.deepEqual(input,saved);assert.equal(f.calls[0]!.query.pageSize,'2');assert.equal((await f.call(args(undefined,{params:{filter:'location='+location},query:{filter:'region_code=SA'}}))).error.code,'CONFLICTING_PARAMETER');assert.equal(f.calls.length,1);}finally{f.store.close();}
});
test('metadata pagination preserves the selected login, filter and locale and removes stale continuation',async()=>{
 const f=fixture();try{f.provision({id:other,isDefault:true,scopes:[]},'other-synthetic');f.mode('pages');const out=await f.call(args(undefined,{query:{languageCode:'en-US',pageSize:1}}));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.pages,2);assert.equal(out.data.truncated,false);assert.equal(out.data.data.nextPageToken,undefined);assert.equal(out.data.discovery.complete,true);assert.deepEqual(out.data.data.placeActionTypeMetadata.map((r:any)=>r.placeActionType),['APPOINTMENT','ONLINE_APPOINTMENT']);assert.ok(f.calls.every(c=>c.query.filter==='location='+location&&c.query.languageCode==='en-US'&&c.authorization==='Bearer selected-synthetic'));assert.equal(f.calls[1]!.query.pageToken,'next');}finally{f.store.close();}
});
for(const action of ['LIST_PLACE_ACTION_LINKS','GET_PLACE_ACTION_LINK'])test(action+' reads only exact location resources through a read-only deployment',async()=>{
 const f=fixture();try{const out=await f.call(args(action,action.startsWith('GET')?{place_action_link_id:'100'}:{}));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.discovery.complete,true);assert.deepEqual(action.startsWith('GET')?out.data.data:out.data.data.placeActionLinks[0],link());assert.equal(f.store.documents(actor.tenantId,'write_review').length,0);}finally{f.store.close();}
});
test('a single GET receipt and collection members must match their exact selected path and filter',async()=>{
 const f=fixture();try{for(const [action,mode]of [['GET_PLACE_ACTION_LINK','wrong_link'],['GET_PLACE_ACTION_LINK','foreign'],['LIST_PLACE_ACTION_LINKS','foreign']]){f.mode(mode!);const out=await f.call(args(action,{place_action_link_id:'100'}));assert.equal(out.success,false,JSON.stringify(out));assert.equal(out.error.code,'PLACE_ACTION_READ_INVALID');}f.mode('success');assert.equal((await f.call(args('LIST_PLACE_ACTION_LINKS',{query:{filter:'placeActionType=ONLINE_APPOINTMENT'}}))).error.code,'PLACE_ACTION_READ_INVALID');}finally{f.store.close();}
});
test('native empty collections, failed HTTP, embedded errors and unknown bodies remain distinct',async()=>{
 for(const mode of ['empty','error','embedded_error','unknown','partial','retry']){const f=fixture();try{f.mode(mode);const out=await f.call();assert.equal(out.success,['empty','retry'].includes(mode),JSON.stringify(out));if(mode==='empty'){assert.deepEqual(out.data.data.placeActionTypeMetadata,[]);assert.equal(out.data.discovery.complete,true);}if(mode==='unknown'||mode==='partial')assert.equal(out.error.code,'PLACE_ACTION_READ_INVALID');assert.equal(f.calls.length,mode==='retry'?2:1);}finally{f.store.close();}}
});
test('current OAuth scope, tenant, explicit identity and location access are required before and after reads',async()=>{
 for(const mode of ['scope','grant','scope_revoke','grant_revoke','disconnect','foreign_tenant','foreign_gateway','missing_identity']){const f=fixture();try{if(mode==='scope')f.provision({scopes:[]});if(mode==='grant')f.provision({accounts:['123']});if(mode==='foreign_gateway')f.provision({gateway:'ga4_native_action'});if(['scope_revoke','grant_revoke','disconnect'].includes(mode))f.mode(mode);const out=await f.call(args(undefined,mode==='missing_identity'?{connection_id:other}:{}),mode==='foreign_tenant'?{...actor,tenantId:'other'}:actor);assert.equal(out.success,false,JSON.stringify(out));assert.equal(f.calls.length,['scope_revoke','grant_revoke','disconnect'].includes(mode)?1:0);}finally{f.store.close();}}
});
test('revoked actor credentials cannot read discovery and an explicit login never falls back',async()=>{
 const f=fixture();try{const key=f.store.createKey(owner),who=f.store.authenticate(key);f.store.revokeKey(key);assert.equal((await f.call(args(),who)).success,false);f.provision({enabled:false});f.provision({id:other,isDefault:true},'other-synthetic');assert.equal((await f.call()).success,false);assert.equal(f.calls.length,0);}finally{f.store.close();}
});
test('read previews need no provider connection and cannot hide legacy method overrides',async()=>{
 const store=new Store(':memory:'),service=new MirrorService(registry,store,new NativeTransport(async()=>{throw Error('Unexpected egress');}));try{for(const action of ['LIST_PLACE_ACTION_TYPE_METADATA','LIST_PLACE_ACTION_LINKS','GET_PLACE_ACTION_LINK']){const out=await service.call(gateway,{operation,arguments:args(action,{place_action_link_id:'100',dry_run:true})},actor);assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.executed,false);assert.equal(out.data.request.readOnly,true);}for(const extra of [{method:'DELETE'},{legacy_path:'accounts/123/locations/456'},{allow_deprecated:true}])assert.equal((await service.call(gateway,{operation,arguments:args(undefined,{...extra,dry_run:true})},actor)).success,false);assert.equal(store.listConnections(actor.tenantId).length,0);}finally{store.close();}
});
test('wrong origin, method, headers, body and path cannot use the metadata scope exception',()=>{
 const f=fixture();try{const scope=new ScopeGuard(registry,f.store),p=plan();for(const change of [{origin:'https://mybusiness.googleapis.com'},{method:'POST'},{path:'/v1/accounts'},{headers:{'X-HTTP-Method-Override':'DELETE'}},{body:{}},{readOnly:false},{accountId:'locations/999'}])assert.throws(()=>scope.authorize({...p,...change} as CompiledRequest,f.c));assert.equal(placeActionReadKind({...p,action:'gmb_engagement_ops/CREATE_PLACE_ACTION_LINK'}),undefined);}finally{f.store.close();}
});
test('private or credential-bearing stored links are redacted from returned data and audit history',async()=>{
 const f=fixture();try{f.mode('private');const out=await f.call(args('LIST_PLACE_ACTION_LINKS'));assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.data.placeActionLinks[0].uri,'[PRIVATE_OR_INVALID_URL_REDACTED]');assert.equal(JSON.stringify(out).includes('private-read-secret'),false);assert.equal(JSON.stringify(f.store.audit(actor.tenantId)).includes('private-read-secret'),false);assert.ok(out.meta.untrusted_provider_content);}finally{f.store.close();}
});
test('provider errors cannot echo private URLs into the client or retained request audit',async()=>{
 const f=fixture();try{f.mode('private_error');const out=await f.call();assert.equal(out.success,false);assert.equal(JSON.stringify(out).includes('private-read-secret'),false);assert.equal(JSON.stringify(f.store.audit(actor.tenantId)).includes('private-read-secret'),false);assert.equal(f.calls.length,1);}finally{f.store.close();}
});
test('malformed native rows, status, timestamps, duplicate identities and filters fail loudly',()=>{
 const p=plan(),list=plan('LIST_PLACE_ACTION_LINKS'),get=plan('GET_PLACE_ACTION_LINK',{place_action_link_id:'100'});
 for(const v of [null,[],{data:[]},{nextPageToken:'next'},{placeActionTypeMetadata:{}},{placeActionTypeMetadata:[type('INVENTED')]},{placeActionTypeMetadata:[type(),type()]},{placeActionTypeMetadata:[{...type(),extra:true}]}])assert.throws(()=>placeActionReadResult(p,v),{code:'PLACE_ACTION_READ_INVALID'});
 for(const v of [{...link(),name:'locations/999/placeActionLinks/100'},{...link(),isEditable:'true'},{...link(),isPreferred:1},{...link(),providerType:'UNKNOWN'},{...link(),createTime:'not-time'},{...link(),uri:''},{...link(),unexpected:1}])assert.throws(()=>placeActionReadResult(list,{placeActionLinks:[v]}),{code:'PLACE_ACTION_READ_INVALID'});
 assert.throws(()=>placeActionReadResult(get,{}),{code:'PLACE_ACTION_READ_INVALID'});assert.throws(()=>placeActionReadResult(p,{},201),{code:'PLACE_ACTION_READ_INVALID'});assert.throws(()=>placeActionReadResult(plan(undefined,{query:{pageSize:1}}),{placeActionTypeMetadata:[type(),type('ONLINE_APPOINTMENT')]}),{code:'PLACE_ACTION_READ_INVALID'});
});
test('safe native default flags and timestamps stay visible without granting edit permission',()=>{
 const p=plan('GET_PLACE_ACTION_LINK',{place_action_link_id:'100'}),v={name:link().name,uri:link().uri,placeActionType:'APPOINTMENT',providerType:'PROVIDER_TYPE_UNSPECIFIED',createTime:'2026-09-20T12:01:02.123456789Z',updateTime:'2026-09-20T14:01:02+02:00'};assert.deepEqual(placeActionReadResult(p,v),v);assert.equal(placeActionReadResult(p,v).isEditable,undefined);
});
test('partial capped lists and resumed pages expose exact continuation and completeness',async()=>{
 const p=plan('LIST_PLACE_ACTION_LINKS',{query:{pageSize:1,filter:'placeActionType=APPOINTMENT'}});let n=0;const result=await runPlaceActionDiscovery(p,async next=>{assert.equal(next.query.filter,p.query.filter);return {placeActionLinks:[link(String(++n))],nextPageToken:'page'+n};},id);assert.equal(result.pages,25);assert.equal(result.truncated,true);assert.equal(result.discovery.complete,false);assert.equal(result.data.nextPageToken,'page25');const next=result.discovery.next_call;assert.equal(next.arguments.arguments.connection_id,id);assert.equal(next.arguments.arguments.query.filter,p.query.filter);assert.equal(next.arguments.arguments.query.pageToken,'page25');
 const resumed=compiler.compile(gateway,{operation,arguments:next.arguments.arguments});const final=await runPlaceActionDiscovery(resumed,async()=>({placeActionLinks:[link('26')]}),id);assert.equal(final.discovery.includes_prior_pages,false);assert.equal(final.discovery.complete,false);assert.equal(final.discovery.complete_from_requested_page,true);assert.equal(final.truncated,false);
});
test('1000-row cap preserves all rows and a native continuation; duplicate pages fail',async()=>{
 const p=plan('LIST_PLACE_ACTION_LINKS',{query:{pageSize:100}});let n=0;const result=await runPlaceActionDiscovery(p,async()=>({placeActionLinks:Array.from({length:100},()=>link(String(++n))),nextPageToken:String(n)}),id);assert.equal(result.data.placeActionLinks.length,1000);assert.equal(result.pages,10);assert.equal(result.discovery.next_call.arguments.arguments.query.pageToken,'1000');
 await assert.rejects(()=>runPlaceActionDiscovery(p,async()=>({placeActionLinks:[link()],nextPageToken:String(++n)}),id),{code:'PLACE_ACTION_READ_INVALID'});n=0;await assert.rejects(()=>runPlaceActionDiscovery(p,async()=>({placeActionLinks:[link(String(++n))],nextPageToken:'repeat'}),id),{code:'PAGINATION_LOOP'});
});
test('response bytes and monotonic deadline are bounded even when the provider returns HTTP 200',async t=>{
 await assert.rejects(()=>runPlaceActionDiscovery(plan(),async()=>({extra:'x'.repeat(2*1024*1024)}),id),{code:'PLACE_ACTION_READ_LIMIT'});
 let elapsed=0;t.mock.method(performance,'now',()=>elapsed);try{await assert.rejects(()=>runPlaceActionDiscovery(plan(),async()=>{elapsed=60001;return {};},id),{code:'PLACE_ACTION_READ_LIMIT'});}finally{t.mock.restoreAll();}
});
test('metadata field and enum contracts match the preserved Discovery artifact',()=>{
 const schemas=JSON.parse(readFileSync('.mirror/VENDOR/business-place-actions-v1.json','utf8')).document.schemas;assert.deepEqual(Object.keys(schemas.PlaceActionTypeMetadata.properties).sort(),['displayName','placeActionType']);assert.deepEqual(schemas.PlaceActionTypeMetadata.properties.placeActionType.enum.filter((v:string)=>!v.endsWith('_UNSPECIFIED')),placeActionTypes);assert.deepEqual(Object.keys(schemas.PlaceActionLink.properties).sort(),['createTime','isEditable','isPreferred','name','placeActionType','providerType','updateTime','uri']);
});
test('native read examples preview all three actions and help corrects the captured dry-run description',async()=>{
 const examples=JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json','utf8')).place_action_read_previews;assert.equal(examples.length,3);
 const store=new Store(':memory:'),service=new MirrorService(registry,store,new NativeTransport(async()=>{throw Error('Unexpected egress');}));try{for(const e of examples){const out=await service.call(e.gateway,{operation:e.operation,arguments:e.arguments},actor);assert.equal(out.success,true,JSON.stringify(out));assert.equal(out.data.executed,false);}const help=registry.help({gateway,operation},{mode:'strict',flags:{}});assert.match(help.argumentsSchema.properties.dry_run.description,/previews without provider calls/);assert.equal(help.amcp_discovery_contract.actions.length,3);const captured=registry.data.tools.find(t=>t.name===gateway)!.operations!.find(o=>o.operation===operation)!;assert.match(captured.argumentsSchema.properties.dry_run.description,/Read-only actions ignore/);assert.equal(captured.amcp_discovery_contract,undefined);}finally{store.close();}
 const reads=actionContracts(registry).filter(r=>r.implementation.includes('google-place-action-discovery'));assert.equal(reads.length,3);assert.ok(reads.every(r=>r.status==='native_read'));
});
