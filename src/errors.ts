export class MirrorError extends Error {
  constructor(public code:string, message:string, public details:Record<string,unknown>={}, public status=400, public retryable=false){super(message);this.name='MirrorError';}
}
export const fail=(code:string,message:string,details:Record<string,unknown>={}):never=>{throw new MirrorError(code,message,details);};
// A 403 is an access denial, not evidence that an OAuth scope is missing.
export function providerHttpErrorCode(status:number,data:unknown,wwwAuthenticate:string|null=null):string{
 if(status===401)return 'AUTH_EXPIRED';
 if(status===429)return 'PLATFORM_RATE_LIMIT';
 if(status!==403)return 'UPSTREAM_ERROR';
 const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
 const root=object(data),error=object(root.error),rows=[root,error,...[error.details,error.errors,root.errors].flatMap(v=>Array.isArray(v)?v.slice(0,20).map(object):[])];
 const scopeCodes=new Set(['ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENT_SCOPE']);
 const scopeDenied=rows.some(row=>[row.reason,row.code,row.error].some(v=>typeof v==='string'&&scopeCodes.has(v.toUpperCase())));
 return scopeDenied||/\berror\s*=\s*"insufficient_scope"/i.test(wwwAuthenticate??'')?'INSUFFICIENT_SCOPE':'PROVIDER_ACCESS_DENIED';
}
export function errorResult(error:unknown,requestId:string,latencyMs:number){
 const e=error instanceof MirrorError?error:new MirrorError('INTERNAL_ERROR','The request failed. Inspect the audit trail using this request ID.',{},500);
 const remediation:Record<string,string>={REAUTHORIZATION_REQUIRED:'Reconnect the provider from Connections, then retry the read or prepare a fresh review.',AUTH_EXPIRED:'Reconnect the affected provider account.',PROVIDER_ACCESS_DENIED:'The provider denied access. Check its error details and request ID; a 403 alone does not identify a missing OAuth scope.',INSUFFICIENT_SCOPE:'Check provider permissions and the selected account; reconnect with the required scope.',WRITE_ACCOUNT_FORBIDDEN:'Ask the workspace owner to grant reviewed write access for this exact account.',RESOURCE_SCOPE_REQUIRED:'Read the parent account-scoped collection to establish ownership, then prepare again.',STATE_CHANGED:'Inspect changed_fields and the state hashes, then prepare and approve a fresh review.',REVIEW_EXPIRED:'Prepare a fresh request and review it again.',WRITE_OUTCOME_UNCERTAIN:'Inspect the saved receipt and provider resources. Do not create another resource or use a new idempotency key.',REPORT_PENDING:'The provider is still preparing the report. The worker will retry using its saved report identifier.',EMAIL_SETUP_REQUIRED:'Ask the owner to configure and verify the site email sender.',SHEETS_PERMISSION_DENIED:'Reconnect Google Sheets and select an editable spreadsheet.'};
 return {success:false,error:{code:e.code,message:e.message,...(Object.keys(e.details).length?{details:e.details}:{}),retryable:e.retryable,...(remediation[e.code]?{next_action:remediation[e.code]}:{})},meta:{requestId,latencyMs}};
}
