export class MirrorError extends Error {
  constructor(public code:string, message:string, public details:Record<string,unknown>={}, public status=400, public retryable=false){super(message);this.name='MirrorError';}
}
export const fail=(code:string,message:string,details:Record<string,unknown>={}):never=>{throw new MirrorError(code,message,details);};
export function errorResult(error:unknown,requestId:string,latencyMs:number){
 const e=error instanceof MirrorError?error:new MirrorError('INTERNAL_ERROR','The request failed. Inspect the audit trail using this request ID.',{},500);
 return {success:false,error:{code:e.code,message:e.message,...(Object.keys(e.details).length?{details:e.details}:{}),retryable:e.retryable},meta:{requestId,latencyMs}};
}
