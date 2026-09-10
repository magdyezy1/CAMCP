import {MirrorError,providerHttpErrorCode} from './errors.js';
import {redact} from './security.js';
import type {JsonObject} from './types.js';
import {reportPlatforms} from './report-metrics.js';

const object=(value:unknown):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
const text=(value:unknown,limit=1200):string|undefined=>{
 if(typeof value!=='string'&&typeof value!=='number')return undefined;
 return String(redact(String(value))).replace(/\b(?:access[_-]?token|refresh[_-]?token|developer[_-]?token|client[_-]?secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,'[REDACTED]').replace(/\bEAA[A-Za-z0-9]{60,}\b/g,'[REDACTED]').slice(0,limit);
};
const code=(value:unknown)=>text(value,160);

export function reportSourceError(error:unknown,source:JsonObject):JsonObject {
 const e=error instanceof MirrorError?error:new MirrorError('REPORT_FAILED','This source could not be collected.',{},500);
 const upstream=object(e.details.upstream),provider=object(upstream.error),errors:JsonObject[]=[];
 const add=(item:unknown)=>{
  const row=object(item),codes=object(row.errorCode??row.error_code);
  const providerCode=code(Object.values(codes).find(v=>typeof v==='string')??row.reason??row.code??row.error_code);
  const message=text(row.error_user_msg??row.message??row.error_message);
  const elements=object(row.location).fieldPathElements;
  const field=Array.isArray(elements)?elements.slice(0,12).map(v=>text(object(v).fieldName,80)).filter(Boolean).join('.'):undefined;
  if((providerCode||message)&&errors.length<10)errors.push({...(providerCode?{code:providerCode}:{}),...(message?{message}:{}),...(field?{field}:{})});
 };
 for(const detail of Array.isArray(provider.details)?provider.details.slice(0,10):[]){
  const d=object(detail);
  if(Array.isArray(d.errors))d.errors.slice(0,10).forEach(add);
  else if(d.reason)add(d);
 }
 if(!errors.length&&Array.isArray(upstream.errors))upstream.errors.slice(0,10).forEach(add);
 const providerCode=errors.find(v=>v.code)?.code??code(provider.status??provider.code??upstream.error_code??upstream.code??upstream.serviceErrorCode);
 const providerMessage=text(provider.error_user_msg??errors.find(v=>v.message)?.message??provider.message??upstream.message??upstream.error_message??upstream.debug_message);
 const requestId=text(e.details.request_id??provider.fbtrace_id??upstream.request_id??upstream.requestId??(Array.isArray(provider.details)?provider.details.find((v:JsonObject)=>v?.requestId)?.requestId:undefined),160);
 const syncing=source.operation==='account_sync';
 // Correct legacy audit entries without misclassifying local permission gates.
 const errorCode=e.code==='INSUFFICIENT_SCOPE'&&e.status===403&&e.details.scope_denial!==true&&Object.keys(upstream).length?providerHttpErrorCode(403,upstream):e.code;
 const diagnostic:JsonObject={code:errorCode,message:text(e.message),retryable:e.retryable,http_status:typeof e.details.http_status==='number'?e.details.http_status:e.status,platform:source.platform,account_id:source.account_id,connection_id:source.connection_id,...(syncing?{operation:'account_sync',asset_kind:source.asset_kind}:{})};
 if(providerCode||providerMessage||requestId)diagnostic.provider={...(providerCode?{code:providerCode}:{}),...(providerMessage?{message:providerMessage}:{}),...(requestId?{request_id:requestId}:{}),...(errors.length?{errors}:{})};
 const request=object(e.details.report_request);
 if(request.stage)diagnostic.request={stage:text(request.stage,40),method:text(request.method,8),path:text(request.path,500)};
 if(Object.hasOwn(e.details,'login_customer_id'))diagnostic.login_customer_id=e.details.login_customer_id===null?null:text(e.details.login_customer_id,32);
 const specific=String(providerCode??e.code);
 if(source.platform==='google'&&specific==='AUTHORIZATION_ERROR')diagnostic.next_action='Google returned a generic authorization denial, not a confirmed missing OAuth scope. Explorer Access supports account lookup and reporting. In Connections, use Reauthorize on this saved Google login, choose the Google user with access to this account and approve Google Ads access. Sync alone reuses the saved authorization. If a fresh authorization still fails and the saved OAuth client matches the approved Cloud project, contact Google Ads API support with the provider request ID, account ID and request path below.';
 else if(source.platform==='google'&&['USER_PERMISSION_DENIED','INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION'].includes(specific))diagnostic.next_action='Reconnect Google Ads with a Google identity that can access this customer. For access through a manager, use that manager’s login customer ID. For direct access, omit an unrelated manager ID. Sync the connection and retry.';
 else if(source.platform==='google'&&specific==='CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')diagnostic.next_action='Open Google Ads API → Overview in the Google Cloud project that owns AMCP’s Google Ads OAuth client. Check that this exact project has Explorer, Basic or Standard Access. Since September 9, 2026, the project determines API access; a legacy developer token cannot grant it. Reconnecting the user alone will not fix this restriction.';
 else if(source.platform==='google'&&specific==='ACTION_NOT_PERMITTED')diagnostic.next_action='Google rejected this operation. On API versions before v25, this can indicate a Cloud project without production access. Check the project that owns AMCP’s Google Ads OAuth client, its Google Ads API access level, and the connected user’s account permissions. Explorer Access permits account sync and reporting; this code alone does not prove that a higher tier is needed.';
 else if(source.platform==='google'&&specific==='CUSTOMER_NOT_ENABLED')diagnostic.next_action='Google will not serve requests directly against this inactive or incomplete account. AMCP can retain cancelled accounts returned by an accessible manager’s inventory, but direct reporting still depends on Google’s account restrictions. Check the account’s status in Google Ads; AMCP does not reactivate it.';
 else if(source.platform==='google'&&['DEVELOPER_TOKEN_NOT_APPROVED','DEVELOPER_TOKEN_NOT_ON_ALLOWLIST','DEVELOPER_TOKEN_PROHIBITED','PROJECT_DISABLED','SERVICE_DISABLED','SERVICE_ACCESS_DENIED'].includes(specific))diagnostic.next_action='Ask the AMCP owner to check that Google Ads API is enabled and production access is granted to the Google Cloud project that owns the OAuth client. Legacy developer token errors may describe the old approval model; access now belongs to the Cloud project. Reconnecting the user alone will not fix this restriction.';
 else if(['ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENT_PERMISSION'].includes(specific))diagnostic.next_action='Reconnect this provider with its required reporting permissions, then sync the selected account and retry.';
 else if(['AUTH_EXPIRED','REAUTHORIZATION_REQUIRED','CREDENTIALS_REQUIRED','TOKEN_REFRESH_FAILED'].includes(e.code))diagnostic.next_action=syncing?'Reconnect the affected login in Connections, then sync its accounts again.':'Reconnect the affected login in Connections, sync its accounts, then retry this report.';
 else if(e.retryable)diagnostic.next_action=syncing?'This is a temporary provider failure. Sync the connection again after the provider is available.':'The worker will retry temporary failures. If all attempts fail, retry the report after the provider is available.';
 else if(e.status===403)diagnostic.next_action='Check this connection’s account permissions and provider app/API access. Use the provider error below to distinguish missing access from app restrictions.';
 else if(['DEVELOPER_TOKEN_REQUIRED','CLIENT_ID_REQUIRED','USER_AGENT_REQUIRED'].includes(e.code))diagnostic.next_action='Ask the workspace owner to finish the provider connection setup, then reconnect and retry.';
 else if(['INVALID_REPORT_SOURCE','INVALID_ARGUMENT','UPSTREAM_ERROR','PLATFORM_ERROR','PROVIDER_REPORT_FAILED'].includes(e.code))diagnostic.next_action=syncing?'Review the provider message and request below. Check the connection’s account permissions and API setup, then sync again.':'Review the provider message and the selected native metrics/date range. Correct unsupported fields or combinations, then run the report again.';
 else diagnostic.next_action=syncing?'Review this sync error, correct the connection settings, then sync again.':'Review this source’s error, correct its connection or report settings, then retry.';
 return diagnostic;
}

export function assetSyncDiagnostic(error:unknown,platform:string,connectionId:string,kind:string,accountId?:string):JsonObject {
 return reportSourceError(error instanceof MirrorError?error:new MirrorError('ASSET_SYNC_FAILED','Asset sync failed. Check the provider connection.',{},502),{platform,connection_id:connectionId,asset_kind:kind,account_id:accountId,operation:'account_sync'});
}
export function assetSyncErrorMessage(diagnostic:JsonObject):string {
 return (diagnostic.account_id?diagnostic.account_id+': ':'')+(diagnostic.provider?.code??diagnostic.code)+' — '+(diagnostic.provider?.message??diagnostic.message);
}

// Existing audit events retain provider details even when older report records
// discarded them. Project only diagnostic fields; never expose raw responses.
export function activityReportErrors(event:JsonObject):JsonObject[]{
 if(event.event==='website_asset_sync'&&Array.isArray(event.diagnostics))return event.diagnostics.slice(0,100).filter(d=>object(d).operation==='account_sync').map(d=>redact(d));
 const request=object(event.request),error=object(event.error),details=object(error.details);
 const platform=Object.entries(reportPlatforms).find(([,p])=>p.gateway===request.gateway)?.[0];
 if(!platform||typeof error.code!=='string')return [];
 const status=Number(details.http_status??object(object(details.upstream).error).code);
 const context={...details,report_request:{method:request.method,path:request.path,stage:request.action==='AMCP_READINESS'?'account_lookup':'campaign_report'}};
 return [reportSourceError(new MirrorError(error.code,text(error.message)??'Provider request failed.',context,Number.isInteger(status)&&status>=400&&status<600?status:502),{platform,account_id:request.accountId,connection_id:event.connection_id})];
}
