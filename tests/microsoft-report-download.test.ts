import {reportDns,microsoftReportPage} from '../src/microsoft-report-download.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateRawSync} from 'node:zlib';
import {parseMicrosoftReport,unzipReport,publicReportAddress,reportUrl,downloadReportArchive} from '../src/microsoft-report-download.js';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {microsoftScope} from '../src/microsoft-native.js';

function zip(data:string|Buffer,name='report.csv',deflate=true){
 const raw=Buffer.isBuffer(data)?data:Buffer.from(data),content=deflate?deflateRawSync(raw):raw,filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(crc32(raw),14);local.writeUInt32LE(content.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(deflate?8:0,10);central.writeUInt32LE(crc32(raw),16);central.writeUInt32LE(content.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(filename.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+content.length,16);
 return Buffer.concat([local,filename,content,central,filename,end]);
}
const request={Type:'CampaignPerformanceReportRequest',Scope:{AccountIds:['123']},Columns:['AccountId','CampaignId','CampaignName','Spend'],Aggregation:'Summary',Time:{PredefinedTime:'Yesterday'},Format:'Csv'};
test('Microsoft ZIP CSV preserves exact values, quoted delimiters/newlines, metadata and completeness',()=>{
 const csv='"Report Name: Example"\r\n"Potential Incomplete Data: true"\r\n"Rows: 2"\r\n\r\n"AccountId","CampaignId","CampaignName","Spend"\r\n"123","9007199254740993","Name, with ""quotes""\nand newline","1,234.50"\r\n"123","002","=1+1","0"\r\n"@2026 Microsoft Corporation. All rights reserved. "\r\n';
 const r=parseMicrosoftReport(zip(csv),request,'123');assert.equal(r.row_count,2);assert.equal(r.rows[0]!.CampaignId,'9007199254740993');assert.equal(r.rows[0]!.Spend,'1,234.50');assert.equal(r.rows[0]!.CampaignName,'Name, with "quotes"\nand newline');assert.equal(r.rows[1]!.CampaignName,'=1+1');assert.equal(r.potentially_incomplete,true);
 const tsv=Buffer.concat([Buffer.from([255,254]),Buffer.from('AccountId\tSpend\r\n123\t0.00\r\n','utf16le')]);assert.equal(parseMicrosoftReport(zip(tsv,'report.tsv',false),{...request,Format:'Tsv',Columns:['AccountId','Spend']},'123').rows[0]!.Spend,'0.00');
 const plain=parseMicrosoftReport(zip('123,42\n'),{...request,Columns:['AccountId','Spend'],ExcludeReportHeader:true,ExcludeColumnHeaders:true,ReturnOnlyCompleteData:true},'123');assert.equal(plain.potentially_incomplete,false);
});
test('Microsoft report parsing rejects wrong account, malformed rows, counts, archives and oversized decompression',()=>{
 for(const text of ['AccountId,Spend\n999,5\n','AccountId,Spend\n123\n','"Rows: 9"\nAccountId,Spend\n123,1\n','Different,Columns\n123,1\n','AccountId,Spend\n123,"unclosed','AccountId,Spend\n123,"a"bad\n'])assert.throws(()=>parseMicrosoftReport(zip(text),{...request,Columns:['AccountId','Spend']},'123'));
 for(const b of [Buffer.from('not a ZIP'),zip('abc','../report.csv'),zip('abc','report.xml'),zip('x'.repeat(33*1024*1024))])assert.throws(()=>unzipReport(b));
 const corrupt=zip('hello', 'report.csv',false);corrupt[40]=corrupt[40]!^1;assert.throws(()=>unzipReport(corrupt));
 const encrypted=zip('x');encrypted.writeUInt16LE(1,6);assert.throws(()=>unzipReport(encrypted));
 assert.throws(()=>parseMicrosoftReport(zip('AccountId\n123\n'),{...request,Format:'Xml'},'123'),/Csv and Tsv/);
});
test('Report download rejects nonpublic destinations and forwards no account credentials or cookies',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicReportAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888'])assert.equal(publicReportAddress(ip),true,ip);
 for(const url of ['http://example.com/file','https://u:p@example.com/file','https://127.0.0.1/file','https://example.com:444/file','https://example.com/file#fragment'])assert.throws(()=>reportUrl(url));
 let calls=0;await downloadReportArchive('https://reports.example.invalid/report?sig=synthetic',async(_url,init)=>{calls++;assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');assert.deepEqual(Object.keys(init?.headers??{}),['Accept']);return new Response(zip('AccountId\n123\n'));});assert.equal(calls,1);
 await assert.rejects(()=>downloadReportArchive('https://reports.example.invalid/file',async()=>new Response(null,{status:302,headers:{Location:'https://127.0.0.1'}})));
});
test('Microsoft submit → poll/download returns account-bound paged rows without client downloads',async()=>{
 const actor={tenantId:'reports',userId:'u',role:'reader' as const},store=new Store(':memory:',Buffer.alloc(32,73).toString('base64')),gateway='microsoft_ads_native_action';let status='Pending',downloads=0,providerCalls=0;
 const c={id:'ms',tenantId:actor.tenantId,gateway,accounts:['123'],writeAccounts:[],accountCustomers:{'123':'456'},enabled:true,label:'Synthetic',scopes:[microsoftScope]};store.putConnection({...actor,role:'admin'},c,{accessToken:'synthetic',developerToken:'synthetic'});
 const service=new MirrorService(new Registry(),store,new NativeTransport(async url=>{providerCalls++;return Response.json(String(url).endsWith('/Submit')?{ReportRequestId:'r1'}:{ReportRequestStatus:{Status:status,ReportDownloadUrl:'https://reports.example.invalid/file?sig=synthetic'}});}),undefined,undefined,async()=>{downloads++;return new Response(zip('AccountId,CampaignId,CampaignName,Spend\n123,1,First,1.25\n123,2,Second,0.00\n'));});
 const poll={action:'PollGenerateReport',account_id:'123',payload:{ReportRequestId:'r1'},download_report:true,limit:1};
 try{
  assert.equal((await service.call(gateway,{...poll,dry_run:true},actor)).success,true);assert.equal(providerCalls,0);assert.equal(downloads,0);
  assert.equal((await service.call(gateway,poll,actor)).error.code,'RESOURCE_SCOPE_REQUIRED');
  assert.equal((await service.call(gateway,{action:'SubmitGenerateReport',account_id:'123',payload:{ReportRequest:request}},actor)).success,true);
  const receipt=store.documents(actor.tenantId,'microsoft_report')[0]!;assert.ok(receipt.expires_at>Date.now()+23*3600000);store.db.exec('UPDATE resource_ownership SET expires_at=0');
  let r=await service.call(gateway,poll,actor);assert.equal(r.data.data.status,'Pending');assert.equal(downloads,0);
  status='Success';r=await service.call(gateway,poll,actor);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.data.data.rows.length,1);assert.equal(r.data.data.row_count,2);assert.equal(r.data.data.has_more,true);assert.equal(downloads,1);
  const next=r.data.data.next_call;r=await service.call(next.tool,next.arguments,actor);assert.equal(r.data.data.rows[0].CampaignName,'Second');assert.equal(r.data.data.has_more,false);assert.equal(downloads,1);
  store.putConnection({...actor,role:'admin'},{...c,id:'other'},{accessToken:'synthetic',developerToken:'synthetic'});assert.equal((await service.call(gateway,{...poll,connection_id:'other'},actor)).error.code,'RESOURCE_SCOPE_REQUIRED');
 }finally{store.close();}
});
test('Microsoft download rechecks revoked account access and handles successful empty results',async()=>{
 for(const mode of ['revoked','empty']){
  const actor={tenantId:'t',userId:'u',role:'reader' as const},store=new Store(':memory:',Buffer.alloc(32,73).toString('base64')),gateway='microsoft_ads_native_action',c={id:'ms',tenantId:'t',gateway,accounts:['123'],accountCustomers:{'123':'456'},enabled:true,label:'Synthetic',scopes:[]};store.putConnection({...actor,role:'admin'},c,{accessToken:'synthetic',developerToken:'synthetic'});
  const service=new MirrorService(new Registry(),store,new NativeTransport(async url=>Response.json(String(url).endsWith('/Submit')?{ReportRequestId:'r1'}:{ReportRequestStatus:{Status:'Success',ReportDownloadUrl:mode==='empty'?null:'https://reports.example.invalid/file'}})),undefined,undefined,async()=>{store.putConnection({...actor,role:'admin'},{...c,enabled:false},{accessToken:'synthetic',developerToken:'synthetic'});return new Response(zip('AccountId,Spend\n123,1\n'));});
  try{await service.call(gateway,{action:'SubmitGenerateReport',account_id:'123',payload:{ReportRequest:{...request,Columns:['AccountId','Spend']}}},actor);const result=await service.call(gateway,{action:'PollGenerateReport',account_id:'123',payload:{ReportRequestId:'r1'},download_report:true},actor);assert.equal(result.success,mode==='empty',JSON.stringify(result));if(mode==='empty')assert.equal(result.data.data.row_count,0);}finally{store.close();}
 }
});

test('Microsoft download DNS respects cancellation and response pages have a byte bound',async()=>{
 const controller=new AbortController(),pending=reportDns('synthetic.invalid',controller.signal,(()=>new Promise(()=>{})) as any);controller.abort(new Error('Synthetic timeout'));await assert.rejects(pending,/Synthetic timeout/);
 const rows=Array.from({length:10},()=>({a:'x'.repeat(60000),b:'x'.repeat(60000)}));const first=microsoftReportPage(rows,0,100);assert.ok(first.length>0&&first.length<rows.length);assert.ok(Buffer.byteLength(JSON.stringify(first))<512*1024);assert.equal(microsoftReportPage(rows,first.length,100).length,first.length);
 assert.throws(()=>microsoftReportPage([{a:'x'.repeat(300000)}],0,100),/256 KiB/);
});
