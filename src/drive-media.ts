import {MirrorError} from './errors.js';
export const MAX_MEDIA_BYTES=32*1024*1024;
const idPattern=/^[A-Za-z0-9_-]{10,200}$/;

/** A file share link is an identifier, never an arbitrary download destination. */
export function driveDownloadUrl(input:string):URL{
 let source:URL;try{source=new URL(input);}catch{throw new MirrorError('INVALID_DRIVE_LINK','Provide a Google Drive file share link.');}
 if(source.origin!=='https://drive.google.com'||source.username||source.password||source.hash)throw new MirrorError('INVALID_DRIVE_LINK','Use an HTTPS drive.google.com file share link.');
 const match=/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/view|\/preview|\/edit)?\/?$/.exec(source.pathname);
 const id=match?.[1]??(/^\/(?:open|uc)$/.test(source.pathname)?source.searchParams.get('id'):null);
 if(!id||!idPattern.test(id))throw new MirrorError('INVALID_DRIVE_LINK','Link must identify one Drive file, not a folder or Google document.');
 const url=new URL('https://drive.usercontent.google.com/download');url.searchParams.set('id',id);url.searchParams.set('export','download');
 const resourceKey=source.searchParams.get('resourcekey');if(resourceKey){if(!idPattern.test(resourceKey))throw new MirrorError('INVALID_DRIVE_LINK','Invalid Drive resource key.');url.searchParams.set('resourcekey',resourceKey);}
 return url;
}
function allowedDownload(url:URL){
 return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&(
  url.hostname==='drive.usercontent.google.com'&&url.pathname==='/download'||
  /^[a-z0-9-]+-docs\.googleusercontent\.com$/.test(url.hostname)&&url.pathname.startsWith('/docs/'));
}
export function mediaType(bytes:Buffer):{mime:string;kind:'image'|'video';extension:string}{
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',kind:'image',extension:'png'};
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',kind:'image',extension:'jpg'};
 if(bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'){
  const brand=bytes.toString('ascii',8,12);if(['avif','avis','heic','heix','mif1','msf1'].includes(brand))throw new MirrorError('MEDIA_TYPE_UNSUPPORTED','Convert HEIC/AVIF images to PNG or JPEG.');
  if(!['isom','iso2','mp41','mp42','avc1','M4V ','MSNV','qt  '].includes(brand))throw new MirrorError('MEDIA_TYPE_UNSUPPORTED','Use PNG, JPEG, MP4 or MOV media.');
  return {mime:brand==='qt  '?'video/quicktime':'video/mp4',kind:'video',extension:brand==='qt  '?'mov':'mp4'};
 }
 throw new MirrorError('MEDIA_TYPE_UNSUPPORTED','The download is not PNG, JPEG, MP4 or MOV. Private Drive links and download confirmation pages cannot be uploaded.');
}
export async function downloadDriveMedia(source:string,fetcher:typeof fetch=fetch){
 let url=driveDownloadUrl(source);const signal=AbortSignal.timeout(45000);
 for(let redirects=0;redirects<=3;redirects++){
  if(!allowedDownload(url))throw new MirrorError('UNAPPROVED_MEDIA_SOURCE','Drive redirected outside its approved download hosts.');
  let response:Response;try{response=await fetcher(url,{redirect:'manual',signal,credentials:'omit',headers:{Accept:'application/octet-stream'}});}catch{throw new MirrorError('MEDIA_DOWNLOAD_FAILED','The Drive download failed or timed out.',{},502);}
  if([301,302,303,307,308].includes(response.status)){
   await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new MirrorError('MEDIA_DOWNLOAD_FAILED','Drive returned an invalid redirect.');
   try{url=new URL(location,url);}catch{throw new MirrorError('MEDIA_DOWNLOAD_FAILED','Drive returned an invalid redirect.');}continue;
  }
  if(!response.ok){await response.body?.cancel();throw new MirrorError('DRIVE_FILE_UNAVAILABLE','Make this Drive file downloadable by anyone with the link, then prepare again.',{http_status:response.status});}
  if(Number(response.headers.get('content-length'))>MAX_MEDIA_BYTES){await response.body?.cancel();throw new MirrorError('MEDIA_TOO_LARGE','Media must be at most 32 MiB.');}
  if(/text\/html|application\/json/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new MirrorError('DRIVE_FILE_UNAVAILABLE','Drive returned a permission or download confirmation page. Use a directly downloadable shared file.');}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_MEDIA_BYTES){await reader.cancel();throw new MirrorError('MEDIA_TOO_LARGE','Media must be at most 32 MiB.');}chunks.push(value);}}
  catch(e){if(e instanceof MirrorError)throw e;throw new MirrorError('MEDIA_DOWNLOAD_FAILED','The Drive download did not complete.',{},502);}
  finally{reader?.releaseLock();}
  const bytes=Buffer.concat(chunks);return {bytes,...mediaType(bytes)};
 }
 throw new MirrorError('MEDIA_DOWNLOAD_FAILED','Drive exceeded the download redirect limit.');
}
