import {MirrorError} from './errors.js';
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
 const diagnostic:JsonObject={code:e.code,message:text(e.message),retryable:e.retryable,http_status:typeof e.details.http_status==='number'?e.details.http_status:e.status,platform:source.platform,account_id:source.account_id,connection_id:source.connection_id};
 if(providerCode||providerMessage||requestId)diagnostic.provider={...(providerCode?{code:providerCode}:{}),...(providerMessage?{message:providerMessage}:{}),...(requestId?{request_id:requestId}:{}),...(errors.length?{errors}:{})};
 const request=object(e.details.report_request);
 if(request.stage)diagnostic.request={stage:text(request.stage,40),method:text(request.method,8),path:text(request.path,500)};
 if(Object.hasOwn(e.details,'login_customer_id'))diagnostic.login_customer_id=e.details.login_customer_id===null?null:text(e.details.login_customer_id,32);
 const specific=String(providerCode??e.code);
 if(source.platform==='google'&&['USER_PERMISSION_DENIED','INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION'].includes(specific))diagnostic.next_action='Reconnect Google Ads with a Google identity that can access this customer. For access through a manager, use that manager’s login customer ID. For direct access, omit an unrelated manager ID. Sync the connection and retry.';
 else if(source.platform==='google'&&['DEVELOPER_TOKEN_NOT_APPROVED','DEVELOPER_TOKEN_NOT_ON_ALLOWLIST','DEVELOPER_TOKEN_PROHIBITED','PROJECT_DISABLED','SERVICE_DISABLED','SERVICE_ACCESS_DENIED'].includes(specific))diagnostic.next_action='Ask the AMCP owner to check the Google Ads developer token’s production access and its Google Cloud project/API configuration. Reconnecting the user alone will not fix this restriction.';
 else if(['ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENT_PERMISSION'].includes(specific))diagnostic.next_action='Reconnect this provider with its required reporting permissions, then sync the selected account and retry.';
 else if(['AUTH_EXPIRED','REAUTHORIZATION_REQUIRED','CREDENTIALS_REQUIRED','TOKEN_REFRESH_FAILED'].includes(e.code))diagnostic.next_action='Reconnect the affected login in Connections, sync its accounts, then retry this report.';
 else if(e.retryable)diagnostic.next_action='The worker will retry temporary failures. If all attempts fail, retry the report after the provider is available.';
 else if(e.status===403)diagnostic.next_action='Check this connection’s account permissions and provider app/API access. Use the provider error below to distinguish missing access from app restrictions.';
 else if(['DEVELOPER_TOKEN_REQUIRED','CLIENT_ID_REQUIRED','USER_AGENT_REQUIRED'].includes(e.code))diagnostic.next_action='Ask the workspace owner to finish the provider connection setup, then reconnect and retry.';
 else if(['INVALID_REPORT_SOURCE','INVALID_ARGUMENT','UPSTREAM_ERROR','PLATFORM_ERROR','PROVIDER_REPORT_FAILED'].includes(e.code))diagnostic.next_action='Review the provider message and the selected native metrics/date range. Correct unsupported fields or combinations, then run the report again.';
 else diagnostic.next_action='Review this source’s error, correct its connection or report settings, then retry.';
 return diagnostic;
}

// Existing audit events retain provider details even when older report records
// discarded them. Project only diagnostic fields; never expose raw responses.
export function activityReportErrors(event:JsonObject):JsonObject[]{
 const request=object(event.request),error=object(event.error),details=object(error.details);
 const platform=Object.entries(reportPlatforms).find(([,p])=>p.gateway===request.gateway)?.[0];
 if(!platform||typeof error.code!=='string')return [];
 const status=Number(details.http_status??object(object(details.upstream).error).code);
 const context={...details,report_request:{method:request.method,path:request.path,stage:request.action==='AMCP_READINESS'?'account_lookup':'campaign_report'}};
 return [reportSourceError(new MirrorError(error.code,text(error.message)??'Provider request failed.',context,Number.isInteger(status)&&status>=400&&status<600?status:502),{platform,account_id:request.accountId,connection_id:event.connection_id})];
}
