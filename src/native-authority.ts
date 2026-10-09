import {MirrorError} from './errors.js';
import {ScopeGuard} from './scope.js';
import {sameLogin} from './connection-authority.js';
import type {Actor, CompiledRequest, Connection, Credentials} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';

/**
 * Bind one request to the authenticated login while allowing unrelated label/grant edits. The credentials in hand
 * must still belong to the stored login revision (CON-01): AMCP's own token refresh keeps it, a replaced login does not.
 */
export function nativeAuthority(
  store: Store,
  registry: Registry,
  actor: Actor,
  plan: CompiledRequest,
  connection: Connection,
  credentials: Credentials,
  before?: () => unknown,
) {
  const scope = new ScopeGuard(registry, store);
  return () => {
    store.assertActorActive(actor);
    before?.();
    const current = store.resolveConnection(actor, plan.gateway, plan.accountId, connection.id);
    scope.authorize(plan, current);
    if (connection.scopes.some(s => !current.scopes.includes(s)))
      throw new MirrorError(
        'INSUFFICIENT_SCOPE',
        'The selected login lost recorded permissions during this request. Inspect its current scopes before restarting.',
        {},
        403,
      );
    if (!sameLogin(credentials, store.connectionCredentials(current)))
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'The selected login changed during this request. Restart reads with its current authorization; preserve existing write receipts.',
        {},
        409,
      );
    return current;
  };
}
