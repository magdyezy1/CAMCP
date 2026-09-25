import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {GoogleSheetsExports,sheetsGateway} from '../dist/src/google-sheets.js';
import {MirrorError} from '../dist/src/errors.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';

function fixture({change='none',at='metadata',lost=false,reply,database=':memory:'}={}){
 const store=new Store(database,Buffer.alloc(32,53).toString('base64')),actor={tenantId:'t',userId:'u',role:'admin'};
 const connection={id:'sheets',tenantId:'t',gateway:sheetsGateway,enabled:true,accounts:['sheet123'],scopes:['https://www.googleapis.com/auth/spreadsheets'],label:'Synthetic'};
 const destination={connection_id:'sheets',spreadsheet_id:'sheet123',sheet_id:7,tab_name:'Client report'};
 store.putConnection(actor,connection,{accessToken:'synthetic'});store.putDocument('t','sheets_destination','dest',destination);
 const report={id:'r1',state:'complete',captured_at:100,config:{metrics:['spend'],custom_metrics:[]},sources:[],rows:[{platform:'meta',account_id:'123',campaign_id:'9',campaign_name:'Synthetic',currency:'USD',timezone:'UTC',date_from:'2026-09-01',date_to:'2026-09-02',metrics:{spend:5},recommendation:{decision:'observe',reason:'Synthetic'},complete:true,captured_at:100}]};
 let revoked=false,reads=0,writes=0;const metadata=[{metadataKey:'amcp_destination',metadataValue:'dest'}];
 const sourceAccess=()=>{if(revoked)throw new MirrorError('REPORT_SOURCE_REVOKED','Synthetic source withdrawal.',{},403);};
 const mutate=()=>{
  if(change==='login')store.putConnection(actor,connection,{accessToken:'replacement'});
  if(change==='source')revoked=true;
  if(change==='actor')store.bindActorCheck(actor,()=>{throw new MirrorError('UNAUTHORIZED','Synthetic actor withdrawal.',{},401);});
  if(change==='lease')store.db.prepare('UPDATE service_locks SET owner=? WHERE key=?').run('another-worker','sheets-export:t:dest');
  if(change==='destination')store.putDocument('t','sheets_destination','dest',{...destination,spreadsheet_id:'other123'});
 };
 const sheets=new GoogleSheetsExports(store,async(url,init)=>{
  if(init.method==='POST'){
   writes++;if(at==='write')mutate();const body=JSON.parse(init.body);
   if(lost!=='unapplied')for(const request of body.requests){
    if(request.createDeveloperMetadata)metadata.push({...request.createDeveloperMetadata.developerMetadata,metadataId:13});
    if(request.updateDeveloperMetadata)Object.assign(metadata.find(m=>m.metadataId===13),request.updateDeveloperMetadata.developerMetadata);
   }
   if(lost)throw Error('Synthetic lost delivery response');return Response.json(reply===undefined?{spreadsheetId:'sheet123',replies:body.requests.map(()=>({}))}:reply);
  }
  reads++;if(at==='metadata')mutate();
  return Response.json({sheets:[{properties:{sheetId:7,gridProperties:{rowCount:100,columnCount:30}},developerMetadata:metadata}]});
 });
 return {store,actor,sheets,report,sourceAccess,counts:()=>({reads,writes})};
}
for(const change of ['login','source','lease','destination','actor'])test('Sheets '+change+' withdrawal after metadata prevents delivery',async()=>{
 const f=fixture({change});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess));
  assert.equal(f.counts().writes,0);
  assert.equal(f.store.document('t','sheets_destination','dest').last_report_id,undefined);
 }finally{f.store.close();}
});
test('Sheets unresolved delivery blocks a newer report from overtaking it',async()=>{
 const f=fixture({lost:'unapplied'});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_OUTCOME_UNKNOWN');
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',{...f.report,id:'r2',captured_at:101},f.sourceAccess),error=>error.code==='SHEETS_DELIVERY_UNRESOLVED'&&error.details.report_id==='r1');
  assert.deepEqual(f.counts(),{reads:1,writes:1});
 }finally{f.store.close();}
});
for(const change of ['source','schedule'])test('Sheets worker stops a queued export after '+change+' withdrawal during metadata',async()=>{
 const f=fixture();try{
  const native={id:'meta',tenantId:'t',gateway:'meta_native_action',accounts:['123'],enabled:true,label:'Synthetic Meta',scopes:['ads_read']};
  f.store.putConnection(f.actor,native,{accessToken:'synthetic-source'});
  const report={...f.report,schedule_id:'schedule',schedule_version:1,config:{...f.report.config,sources:[{platform:'meta',account_id:'123',connection_id:'meta'}]}};
  f.store.putDocument('t','overview_report','r1',report);f.store.putDocument('t','overview_schedule','schedule',{is_active:true,definition_version:1});
  f.store.putDocument('t','overview_export','export1',{destination_id:'dest',actor_binding:f.store.bindJobActor(f.actor,'export1')});
  const overview=new ReportingOverview(new MirrorService(new Registry(),f.store),async(url,init)=>{
   const response=await f.sheets.fetcher(url,init);
   if(init.method==='GET'){
    if(change==='source')f.store.putConnection(f.actor,{...native,accounts:[]},{accessToken:'synthetic-source'});
    else f.store.putDocument('t','overview_schedule','schedule',{is_active:false,definition_version:1});
   }
   return response;
  });
  await assert.rejects(()=>overview.work('t','sheets_export',{report_id:'r1',export_id:'export1'}));
  assert.equal(f.counts().writes,0);
 }finally{f.store.close();}
});
test('Sheets lost-response reconciliation survives closing and reopening SQLite',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'amcp-sheets-recovery-')),database=join(directory,'store.sqlite'),f=fixture({lost:true,database});let reopened;
 try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_OUTCOME_UNKNOWN');
  f.store.close();reopened=new Store(database,Buffer.alloc(32,53).toString('base64'));
  const sheets=new GoogleSheetsExports(reopened,f.sheets.fetcher),result=await sheets.write(f.actor,'dest',f.report,f.sourceAccess);
  assert.equal(result.reconciled,true);assert.equal(f.counts().writes,1);assert.equal(reopened.documents('t','sheets_delivery')[0].state,'complete');
 }finally{
  if(reopened)reopened.close();else f.store.close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('amcp-sheets-recovery-'));
  rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
for(const [label,reply] of [['wrong spreadsheet',{spreadsheetId:'other123',replies:[]}],['empty envelope',{}],['embedded error',{error:{code:403,message:'Synthetic'}}],['missing replies',{spreadsheetId:'sheet123'}],['incomplete replies',{spreadsheetId:'sheet123',replies:[]}]])test('Sheets rejects '+label+' in HTTP 200 instead of claiming delivery',async()=>{
 const f=fixture({reply});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_RESPONSE_INVALID');
  assert.equal(f.store.document('t','sheets_destination','dest').last_report_id,undefined);
  assert.equal(f.store.documents('t','sheets_delivery')[0].state,'uncertain');
 }finally{f.store.close();}
});
test('Sheets creation retains an accepted file ID before late actor withdrawal without granting it',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,54).toString('base64')),actor={tenantId:'t',userId:'u',role:'admin'},connection={id:'sheets',tenantId:'t',gateway:sheetsGateway,enabled:false,accounts:[],scopes:['https://www.googleapis.com/auth/drive.file'],label:'Synthetic'};
 try{
  store.putConnection(actor,connection,{accessToken:'synthetic'});
  const sheets=new GoogleSheetsExports(store,async()=>{store.bindActorCheck(actor,()=>{throw new MirrorError('UNAUTHORIZED','Synthetic withdrawal.',{},401);});return Response.json({id:'created123',name:'Client',mimeType:'application/vnd.google-apps.spreadsheet'});});
  await assert.rejects(()=>sheets.create(actor,{connection_id:'sheets',name:'Client',idempotency_key:'creation-key',confirmed:true}),error=>error.code==='UNAUTHORIZED');
  assert.equal(store.documents('t','sheets_creation')[0].spreadsheet_id,'created123');
  assert.deepEqual(store.listConnections('t')[0].accounts,[]);
 }finally{store.close();}
});
test('Sheets pasted-URL selection rejects login replacement between read and local grant commit',async()=>{
 const store=new Store(':memory:',Buffer.alloc(32,55).toString('base64')),actor={tenantId:'t',userId:'u',role:'admin'},connection={id:'sheets',tenantId:'t',gateway:sheetsGateway,enabled:false,accounts:[],scopes:['https://www.googleapis.com/auth/spreadsheets'],label:'Synthetic'};
 try{
  store.putConnection(actor,connection,{accessToken:'synthetic'});let responseReturned=false,queued=false;
  store.bindActorCheck(actor,()=>{if(responseReturned&&!queued){queued=true;queueMicrotask(()=>store.putConnection(actor,connection,{accessToken:'replacement'}));}});
  const sheets=new GoogleSheetsExports(store,async()=>{responseReturned=true;return Response.json({spreadsheetId:'sheet123',properties:{title:'Client'}});});
  await assert.rejects(()=>sheets.bind(actor,{connection_id:'sheets',spreadsheet_url:'https://docs.google.com/spreadsheets/d/sheet123/edit',confirmed:true}),error=>error.code==='REAUTHORIZATION_REQUIRED');
  assert.deepEqual(store.listConnections('t')[0].accounts,[]);assert.equal(store.documents('t','sheets_destination').length,0);
 }finally{store.close();}
});
test('Sheets reconciles an accepted lost response using its atomic provider marker',async()=>{
 const f=fixture({lost:true});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_OUTCOME_UNKNOWN');
  const result=await f.sheets.write(f.actor,'dest',f.report,f.sourceAccess);
  assert.equal(result.reconciled,true);assert.equal(result.replayed,true);assert.equal(f.counts().writes,1);
  assert.equal(f.store.documents('t','sheets_delivery')[0].state,'complete');
 }finally{f.store.close();}
});
test('Sheets leaves an unconfirmed delivery uncertain and polls without resending',async()=>{
 const f=fixture({lost:'unapplied'});try{
  for(let i=0;i<3;i++)await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_OUTCOME_UNKNOWN');
  assert.deepEqual(f.counts(),{reads:3,writes:1});assert.equal(f.store.documents('t','sheets_delivery')[0].state,'uncertain');
 }finally{f.store.close();}
});
test('Sheets refreshes the same destination delivery marker for a new report',async()=>{
 const f=fixture();try{
  await f.sheets.write(f.actor,'dest',f.report,f.sourceAccess);
  const next={...f.report,id:'r2',captured_at:101};await f.sheets.write(f.actor,'dest',next,f.sourceAccess);
  assert.deepEqual(f.counts(),{reads:2,writes:2});assert.equal(f.store.document('t','sheets_destination','dest').last_report_id,'r2');
 }finally{f.store.close();}
});
for(const change of ['login','source','actor'])test('Sheets retains accepted delivery before late '+change+' denial',async()=>{
 const f=fixture({change,at:'write'});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess));
  assert.equal(f.counts().writes,1);
  assert.equal(f.store.document('t','sheets_destination','dest').last_report_id,'r1');
  const deliveries=f.store.documents('t','sheets_delivery');assert.equal(deliveries.length,1);assert.equal(deliveries[0].state,'complete');
 }finally{f.store.close();}
});
test('Sheets completed delivery replays locally but rejects a changed report under its original ID',async()=>{
 const f=fixture();try{
  assert.equal((await f.sheets.write(f.actor,'dest',f.report,f.sourceAccess)).state,'complete');
  assert.equal((await f.sheets.write(f.actor,'dest',f.report,f.sourceAccess)).replayed,true);
  const changed=structuredClone(f.report);changed.rows[0].metrics.spend=99;
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',changed,f.sourceAccess),error=>error.code==='IDEMPOTENCY_CONFLICT');
  assert.deepEqual(f.counts(),{reads:1,writes:1});
 }finally{f.store.close();}
});
test('Sheets lost delivery response remains explicit and has no automatic HTTP retry',async()=>{
 const f=fixture({lost:true});try{
  await assert.rejects(()=>f.sheets.write(f.actor,'dest',f.report,f.sourceAccess),error=>error.code==='SHEETS_OUTCOME_UNKNOWN');
  assert.equal(f.counts().writes,1);assert.equal(f.store.document('t','sheets_destination','dest').last_report_id,undefined);
 }finally{f.store.close();}
});
