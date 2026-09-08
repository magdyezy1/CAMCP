import {crc32,inflateRawSync} from 'node:zlib';
import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import {request} from 'node:https';
import {Readable} from 'node:stream';
import {MirrorError} from './errors.js';
import {sha256,scopeKey} from './security.js';
import type {JsonObject} from './types.js';

const MAX_ARCHIVE=8*1024*1024,MAX_TEXT=32*1024*1024,MAX_ROWS=10000;
const forbidden=new BlockList();
for(const [net,bits]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)forbidden.addSubnet(net,bits,'ipv4');
for(const [net,bits]of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)forbidden.addSubnet(net,bits,'ipv6');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
export function publicReportAddress(address:string){const family=isIP(address);return family===4?!forbidden.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!forbidden.check(address,'ipv6');}
function invalid(message:string):never{throw new MirrorError('INVALID_REPORT_ARCHIVE',message,{},502);}
export const microsoftReportKey=(connection:string,account:string,id:string)=>sha256(scopeKey(connection,account,id));
export function reportUrl(value:unknown):URL{
 let url:URL;try{url=new URL(String(value));}catch{throw new MirrorError('UNAPPROVED_REPORT_URL','Microsoft did not return a usable report URL.',{},502);}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.href.length>16384||isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicReportAddress(url.hostname.replace(/^\[|\]$/g,'')))throw new MirrorError('UNAPPROVED_REPORT_URL','Report downloads require public HTTPS with no embedded credentials.',{},502);
 return url;
}
/** Microsoft explicitly permits changing download domains. Pin validated public DNS
 * results into the TLS request instead of forwarding advertising credentials. */
async function publicGet(url:URL,signal:AbortSignal):Promise<Response>{
 const records=await reportDns(url.hostname.replace(/^\[|\]$/g,''),signal);
 if(!records.length||records.some(r=>!publicReportAddress(r.address)))throw new MirrorError('UNAPPROVED_REPORT_URL','Report DNS resolved to a nonpublic address.',{},502);
 return new Promise((resolve,reject)=>{
  const chosen=records[0]!;
  const req=request(url,{method:'GET',signal,agent:false,headers:{Accept:'application/zip'},lookup:((_hostname:any,options:any,callback:any)=>options?.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)) as any},res=>{
   resolve(new Response(Readable.toWeb(res) as ReadableStream,{status:res.statusCode!,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(','):String(v)]))}));
  });req.once('error',reject);req.end();
 });
}
export async function reportDns(host:string,signal:AbortSignal,resolver=lookup){
 signal.throwIfAborted();let aborted:()=>void=()=>{};
 try{return await Promise.race([resolver(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();})]);}
 finally{signal.removeEventListener('abort',aborted);}
}
export function microsoftReportPage(rows:Record<string,string>[],offset:number,limit:number){
 const page:Record<string,string>[]=[];let size=2;
 for(const row of rows.slice(offset,offset+limit)){const bytes=Buffer.byteLength(JSON.stringify(row))+1;if(bytes>256*1024)invalid('One report row exceeds 256 KiB; narrow the selected columns.');if(size+bytes>512*1024)break;page.push(row);size+=bytes;}
 return page;
}
export async function downloadReportArchive(value:unknown,fetcher?:typeof fetch):Promise<Buffer>{
 const url=reportUrl(value),signal=AbortSignal.timeout(30000);let response:Response;
 try{response=fetcher?await fetcher(url,{redirect:'error',signal,credentials:'omit',headers:{Accept:'application/zip'}}):await publicGet(url,signal);}catch(e){if(e instanceof MirrorError)throw e;throw new MirrorError('REPORT_DOWNLOAD_FAILED','Microsoft report download failed or timed out. Poll again for a fresh download URL.',{},502);}
 if(response.status!==200||Number(response.headers.get('content-length'))>MAX_ARCHIVE){await response.body?.cancel();throw new MirrorError('REPORT_DOWNLOAD_FAILED','Report download failed or exceeds the 8 MiB compressed limit.',{http_status:response.status},502);}
 const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_ARCHIVE){await reader.cancel();invalid('Compressed report exceeds 8 MiB; narrow the report.');}chunks.push(value);}}
 catch(e){if(e instanceof MirrorError)throw e;throw new MirrorError('REPORT_DOWNLOAD_FAILED','The report download did not complete.',{},502);}finally{reader?.releaseLock();}
 return Buffer.concat(chunks);
}
/** Read one normal ZIP member in memory. Never extract paths to the filesystem. */
export function unzipReport(bytes:Buffer):{name:string;bytes:Buffer}{
 if(bytes.length<22||bytes.length>MAX_ARCHIVE)invalid('Invalid ZIP size.');let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==1||bytes.readUInt16LE(end+10)!==1)invalid('Expected a single-file, single-disk report ZIP.');
 const central=bytes.readUInt32LE(end+16),centralSize=bytes.readUInt32LE(end+12);
 if(central+centralSize!==end||centralSize<46||central+46>end||bytes.readUInt32LE(central)!==0x02014b50)invalid('Invalid ZIP directory.');
 const flags=bytes.readUInt16LE(central+8),method=bytes.readUInt16LE(central+10),checksum=bytes.readUInt32LE(central+16),compressed=bytes.readUInt32LE(central+20),expanded=bytes.readUInt32LE(central+24),nameSize=bytes.readUInt16LE(central+28),extra=bytes.readUInt16LE(central+30),comment=bytes.readUInt16LE(central+32),local=bytes.readUInt32LE(central+42);
 if(flags&~0x80e||![0,8].includes(method)||expanded>MAX_TEXT||compressed>MAX_ARCHIVE||central+46+nameSize+extra+comment!==end||bytes.readUInt16LE(central+34)||local+30>central)invalid('Unsupported or oversized ZIP member.');
 const name=bytes.toString('utf8',central+46,central+46+nameSize);
 if(!/^[^/\\\x00-\x1f]+\.(?:csv|tsv|txt)$/i.test(name)||name.includes('..'))invalid('Expected a report text filename.');
 if(bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)invalid('ZIP headers disagree.');
 const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),start=local+30+localName+localExtra;
 if(start+compressed>central||bytes.toString('utf8',local+30,local+30+localName)!==name)invalid('Invalid ZIP member boundaries.');
 const compressedBytes=bytes.subarray(start,start+compressed);let text:Buffer;
 try{text=method===0?Buffer.from(compressedBytes):inflateRawSync(compressedBytes,{maxOutputLength:MAX_TEXT});}catch{invalid('Invalid or oversized compressed report.');}
 if(text.length!==expanded||crc32(text)!==checksum)invalid('Report ZIP failed its size or CRC check.');
 return {name,bytes:text};
}
function textRows(text:string,separator:string):string[][]{
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 const push=()=>{if(Buffer.byteLength(cell)>65536)invalid('One report field exceeds 64 KiB; narrow the selected columns.');row.push(cell);cell='';closed=false;if(row.length>100)invalid('Report exceeds 100 columns.');};
 for(let i=0;i<text.length;i++){const c=text[i]!;
  if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
  if(c===separator){push();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;push();rows.push(row);row=[];if(rows.length>MAX_ROWS+100)invalid('Report exceeds 10000 rows; narrow the date range or breakdowns.');continue;}
  if(closed)invalid('Unexpected characters after a quoted field.');
  if(c==='"'){if(cell)invalid('Unexpected quote in report field.');quoted=true;}else cell+=c;
 }
 if(quoted)invalid('Unclosed quoted report field.');if(cell||closed||row.length){push();rows.push(row);}return rows;
}
export function parseMicrosoftReport(bytes:Buffer,request:JsonObject,account:string){
 const format=request.Format??'Csv';if(!['Csv','Tsv'].includes(format))throw new MirrorError('REPORT_FORMAT_UNSUPPORTED','Server parsing supports Csv and Tsv reports; submit another report in one of those formats.');
 const member=unzipReport(bytes);let decoded:string;
 try{const bom=member.bytes.subarray(0,2).toString('hex');decoded=new TextDecoder(bom==='fffe'?'utf-16le':bom==='feff'?'utf-16be':'utf-8',{fatal:true}).decode(member.bytes);}catch{invalid('Report encoding must be valid UTF-8 or BOM-marked UTF-16.');}
 const columns=request.Columns as string[];if(!Array.isArray(columns)||!columns.length||new Set(columns).size!==columns.length||columns.some(c=>typeof c!=='string'||!c))invalid('Original report columns are missing or ambiguous.');
 const all=textRows(decoded,format==='Tsv'?'\t':','),metadata:Record<string,string>={},rows:Record<string,string>[]=[],headerless=request.ExcludeColumnHeaders===true;let found=headerless,footer=false;
 for(const row of all){if(row.every(v=>v===''))continue;
  if(!found){if(row.length===columns.length&&row.every((v,i)=>v===columns[i])){found=true;continue;}if(row.length===1&&/^([^:]+):\s*(.*)$/s.test(row[0]!)){const [,key,value]=/^([^:]+):\s*(.*)$/s.exec(row[0]!)!;if(key!.length>64||value!.length>4096||Object.hasOwn(metadata,key!))invalid('Report metadata is oversized or ambiguous.');metadata[key!]=value!;if(Object.keys(metadata).length>32||Buffer.byteLength(JSON.stringify(metadata))>16384)invalid('Report metadata exceeds the response limit.');continue;}invalid('Report column header does not match the submitted columns.');}
  if(row.length===1&&/^@\d{4} Microsoft Corporation\./.test(row[0]!)){footer=true;continue;}
  if(footer||row.length!==columns.length)invalid('Report row shape does not match its columns.');
  // Headerless parsing is only safe when the submitted report also omits metadata.
  if(headerless&&request.ExcludeReportHeader!==true)invalid('Headerless parsing requires ExcludeReportHeader=true.');
  const record=Object.fromEntries(columns.map((key,i)=>[key,row[i]!]));if(record.AccountId!==undefined&&record.AccountId!==account)throw new MirrorError('ACCOUNT_SCOPE_MISMATCH','Downloaded report contains a different advertising account.',{},502);
  rows.push(record);if(rows.length>MAX_ROWS)invalid('Report exceeds 10000 rows; narrow the report.');
 }
 if(!found)invalid('Report has no matching column header.');
 if(metadata.Rows!==undefined&&(!/^\d+$/.test(metadata.Rows)||Number(metadata.Rows)!==rows.length))invalid('Report row count does not match its metadata.');
 const incomplete=metadata['Potential Incomplete Data'];
 if(incomplete!==undefined&&!/^(true|false)$/i.test(incomplete))invalid('Invalid report completeness metadata.');
 return {columns,rows,metadata,row_count:rows.length,potentially_incomplete:incomplete===undefined?(request.ReturnOnlyCompleteData===true?false:null):incomplete.toLowerCase()==='true',values:'native_strings',format};
}
