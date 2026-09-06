import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import type {CallOptions} from '../src/types.js';
export function createRuntime(){
 if(process.env.MIRROR_ALLOW_WRITES==='true')throw new Error('Live mutation execution has not passed release qualification. This build supports reads and local dry-run previews.');
 const registry=new Registry();
 const store=new Store(process.env.MIRROR_DB??'.runtime/mirror.sqlite',process.env.MIRROR_MASTER_KEY);
 const enhanced=process.env.MIRROR_MODE==='enhanced';
 const flags=JSON.parse(process.env.MIRROR_FLAGS??'{}');
 const options:CallOptions={mode:enhanced?'enhanced':'strict',flags};
 const service=new MirrorService(registry,store,undefined,options,{allowWrites:false,maxBudgetChange:0,requireBeforeState:true});
 return {registry,store,service};
}
