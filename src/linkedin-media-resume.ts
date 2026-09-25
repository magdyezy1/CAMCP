import {MirrorError} from './errors.js';
import {sha256,stable} from './security.js';
import type {Credentials,JsonObject} from './types.js';

export interface LinkedInTransferBinding {account_id:string;connection_id:string;owner_urn?:string;sha256:string;size:number}
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bindingHash=(p:LinkedInTransferBinding)=>sha256(stable({account:p.account_id,connection:p.connection_id,owner:p.owner_urn,sha256:p.sha256,size:p.size}));
export const linkedInPartId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\x00-\x1f\x7f"]/.test(v);

/** These are server-derived encrypted receipts, never accepted from MCP arguments. */
export function linkedInTransfer(p:LinkedInTransferBinding,auth:Credentials,scopes:string[],id:string,value:JsonObject,instructions:JsonObject[]):JsonObject{
 return {version:1,provider:'linkedin',media_id:id,owner_urn:p.owner_urn,request_binding:bindingHash(p),login_fingerprint:sha256(stable(auth)),scopes:[...scopes],upload_token:value.uploadToken,upload_instructions:instructions,upload_urls_expire_at:value.uploadUrlsExpireAt??null,uploaded_part_ids:[],part_in_flight:null,finalization_started:false};
}

/** A missing marker in an older session is unknown, not evidence that no PUT began. */
export function linkedInResumeReason(p:LinkedInTransferBinding,s:JsonObject|undefined,auth?:Credentials,scopes?:string[]):string|undefined{
 if(!s||s.provider!=='linkedin'||s.version!==1)return 'legacy_or_missing_transfer';
 if(s.request_binding!==bindingHash(p)||s.owner_urn!==p.owner_urn||!/^urn:li:video:[A-Za-z0-9_-]+$/.test(s.media_id??''))return 'transfer_binding_mismatch';
 if(typeof s.login_fingerprint!=='string'||!Array.isArray(s.scopes)||s.scopes.some((v:unknown)=>typeof v!=='string'))return 'login_binding_unverified';
 if(auth&&s.login_fingerprint!==sha256(stable(auth))||scopes&&s.scopes.some((v:string)=>!scopes.includes(v)))return 'login_changed';
 if(s.finalization_started!==false)return 'finalization_attempted';
 if(s.part_in_flight!==null)return 'part_receipt_unknown';
 if(!Number.isSafeInteger(s.upload_urls_expire_at))return 'upload_expiry_unverified';
 if(s.upload_urls_expire_at<=Date.now())return 'upload_urls_expired';
 if(typeof s.upload_token!=='string'||s.upload_token.length>16384||!Array.isArray(s.upload_instructions)||!s.upload_instructions.length||s.upload_instructions.length>32)return 'transfer_instructions_invalid';
 let offset=0;
 for(const part of s.upload_instructions){
  if(!object(part)||part.firstByte!==offset||!Number.isSafeInteger(part.lastByte)||part.lastByte<offset||offset>=p.size)return 'transfer_instructions_invalid';
  let url:URL;try{url=new URL(part.uploadUrl);}catch{return 'transfer_instructions_invalid';}
  if(url.origin!=='https://www.linkedin.com'||url.username||url.password||url.hash||!url.pathname.startsWith('/dms-uploads/'))return 'transfer_instructions_invalid';
  offset=Math.min(part.lastByte+1,p.size);
 }
 if(offset!==p.size||!Array.isArray(s.uploaded_part_ids)||s.uploaded_part_ids.length>s.upload_instructions.length||s.uploaded_part_ids.some((v:unknown)=>!linkedInPartId(v)))return 'part_receipts_invalid';
}

export function assertLinkedInResume(p:LinkedInTransferBinding,s:JsonObject|undefined,auth?:Credentials,scopes?:string[]):asserts s is JsonObject{
 const reason=linkedInResumeReason(p,s,auth,scopes);
 if(reason)throw new MirrorError('RECOVERY_NOT_SAFE','This LinkedIn transfer cannot resume safely. Inspect the retained media; do not repeat an uncertain part or finalization.',{reason,retry_safe:false});
}

export function assertLinkedInWaiting(p:LinkedInTransferBinding,s:JsonObject,response:unknown){
 if(!object(response)||response.id!==s.media_id||response.owner!==p.owner_urn||response.mediaLibraryMetadata?.associatedAccount!==undefined&&response.mediaLibraryMetadata.associatedAccount!=='urn:li:sponsoredAccount:'+p.account_id)throw new MirrorError('MEDIA_RESPONSE_INVALID','LinkedIn did not confirm the retained media and its reviewed owner/account.');
 if(response.status!=='WAITING_UPLOAD')throw new MirrorError('RECOVERY_NOT_SAFE','LinkedIn is no longer waiting for this upload. Inspect its status without uploading or finalizing again.',{reason:'provider_not_waiting',processing_status:typeof response.status==='string'?response.status:'UNKNOWN',retry_safe:false});
}
