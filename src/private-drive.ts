import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {MirrorError} from './errors.js';
import {driveDownloadUrl,mediaType,MAX_MEDIA_BYTES} from './drive-media.js';
import type {Actor} from './types.js';
export const driveGateway='google_drive_native_action';
export function driveAccess(store:Store,actor:Actor,connection:string,url:string){
 const fileId=driveDownloadUrl(url).searchParams.get('id')!;store.assertActorActive(actor);
 const c=store.resolveConnection(actor,driveGateway,fileId,connection);if(!c.scopes.some(s=>['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive'].includes(s)))throw new MirrorError('DRIVE_SCOPE_REQUIRED','Reconnect Drive with permission to download selected files.');return {c,fileId};
}
async function bounded(response:Response,limit:number){
 if(!response.ok||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new MirrorError('DRIVE_FILE_UNAVAILABLE','Drive refused the download or the file exceeds its size limit.',{http_status:response.status});}
 const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new MirrorError('MEDIA_TOO_LARGE','The Drive response exceeded its size limit.');}chunks.push(value);}}finally{reader?.releaseLock();}return Buffer.concat(chunks);
}
export async function downloadPrivateDrive(store:Store,credentials:CredentialProvider,actor:Actor,connection:string,source:string,fetcher:typeof fetch=fetch){
 const {c,fileId}=driveAccess(store,actor,connection,source),auth=await credentials.get(c);driveAccess(store,actor,connection,source);
 const headers:Record<string,string>={Authorization:'Bearer '+auth.accessToken},key=driveDownloadUrl(source).searchParams.get('resourcekey');if(key)headers['X-Goog-Drive-Resource-Keys']=fileId+'/'+key;
 const url=new URL('https://www.googleapis.com/drive/v3/files/'+fileId);url.searchParams.set('supportsAllDrives','true');url.searchParams.set('fields','id,mimeType,size,capabilities(canDownload)');
 const options:RequestInit={method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(45000)};
 const metadata=JSON.parse((await bounded(await fetcher(url,options),65536)).toString('utf8'));
 if(metadata.id!==fileId||metadata.capabilities?.canDownload!==true||!['image/png','image/jpeg','video/mp4','video/quicktime'].includes(metadata.mimeType))throw new MirrorError('DRIVE_DOWNLOAD_FORBIDDEN','Select a downloadable PNG, JPEG, MP4 or MOV file in the connected Drive account.');
 if(!/^\d+$/.test(metadata.size)||Number(metadata.size)>MAX_MEDIA_BYTES)throw new MirrorError('MEDIA_TOO_LARGE','Drive media must be at most the configured media limit (128 MiB by default).');
 driveAccess(store,actor,connection,source);url.searchParams.delete('fields');url.searchParams.set('alt','media');
 const bytes=await bounded(await fetcher(url,options),MAX_MEDIA_BYTES);driveAccess(store,actor,connection,source);const type=mediaType(bytes);
 if(bytes.length!==Number(metadata.size)||type.mime!==metadata.mimeType)throw new MirrorError('MEDIA_CHANGED','The file changed during download. Prepare it again.');return {bytes,...type};
}
