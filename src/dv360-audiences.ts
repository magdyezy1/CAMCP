import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection} from './types.js';

/**
 * Advertiser-scoped DV360 audience reads, per the pinned Display & Video 360 API v4 Discovery document
 * (firstPartyAndPartnerAudiences, googleAudiences, customLists and combinedAudiences get and list, checked 2026-09-27).
 * These collections are not under /advertisers/: each read names the advertiser in advertiserId, and DV360 returns only
 * audiences that advertiser can access. A partnerId read would use the partner's access, which no advertiser connection
 * is bound to, so it stays out of scope.
 */
export const dv360AudienceCollections:Record<string,{id:string;label:string}>={
 firstPartyAndPartnerAudiences:{id:'firstPartyAndPartnerAudienceId',label:'first-party or partner audience'},
 googleAudiences:{id:'googleAudienceId',label:'Google audience'},
 customLists:{id:'customListId',label:'custom list'},
 combinedAudiences:{id:'combinedAudienceId',label:'combined audience'}
};
const route=/^\/v4\/(firstPartyAndPartnerAudiences|googleAudiences|customLists|combinedAudiences)(?:\/([1-9]\d*))?$/;
const listQuery=['advertiserId','pageSize','pageToken','orderBy','filter'];
function denied(message:string,code='RESOURCE_SCOPE_REQUIRED'):never{throw new MirrorError(code,message,{},403);}
export function dv360AudienceRead(p:CompiledRequest):{collection:string;id?:string}|undefined{
 if(p.gateway!=='dv360_native_action'||p.method!=='GET'||!p.readOnly||p.body!==undefined||p.specialTransport||p.origin!==undefined&&p.origin!=='https://displayvideo.googleapis.com')return;
 const m=route.exec(p.path);return m?{collection:m[1]!,...(m[2]?{id:m[2]}:{})}:undefined;
}
/** A get or list of audiences the selected advertiser can access; the scope guard has already compared advertiserId with the account. */
export function authorizeDV360AudienceRead(p:CompiledRequest,c:Connection,account:string):boolean{
 const r=dv360AudienceRead(p);if(!r)return false;
 if(p.query.advertiserId!==account)denied('DV360 audience reads name the selected advertiser in advertiserId; DV360 then returns only audiences it can access.');
 const allowed=r.id?['advertiserId']:listQuery,extra=Object.keys(p.query).filter(k=>!allowed.includes(k));
 if(extra.length)denied('This DV360 audience read takes only '+allowed.join(', ')+'; partnerId would use partner access, which this connection is not bound to.');
 if(Object.keys(p.headers??{}).length)denied('DV360 audience reads take no header overrides.');
 if(!c.scopes.includes('https://www.googleapis.com/auth/display-video'))throw new MirrorError('INSUFFICIENT_SCOPE','Reconnect the selected DV360 connection with display-video scope.',{},403);
 return true;
}
