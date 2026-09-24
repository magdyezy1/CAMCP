import {MirrorError} from './errors.js';
import {sha256,stable} from './security.js';
import {ScopeGuard} from './scope.js';
import type {Actor,CompiledRequest,Connection,Credentials} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';

/** Bind one request to the authenticated login while allowing unrelated label/grant edits. */
export function nativeAuthority(store:Store,registry:Registry,actor:Actor,plan:CompiledRequest,connection:Connection,credentials:Credentials,before?:()=>unknown){
 const fingerprint=sha256(stable(credentials)),scope=new ScopeGuard(registry,store);
 return ()=>{
  store.assertActorActive(actor);before?.();
  const current=store.resolveConnection(actor,plan.gateway,plan.accountId,connection.id);scope.authorize(plan,current);
  if(connection.scopes.some(s=>!current.scopes.includes(s)))throw new MirrorError('INSUFFICIENT_SCOPE','The selected login lost recorded permissions during this request. Inspect its current scopes before restarting.',{},403);
  if(sha256(stable(store.connectionCredentials(current)))!==fingerprint)throw new MirrorError('REAUTHORIZATION_REQUIRED','The selected login changed during this request. Restart reads with its current authorization; preserve existing write receipts.',{},403);
  return current;
 };
}
