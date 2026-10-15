import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {accountKey, bindingKey} from './access-sets.js';

/**
 * The working client (SEC-08 phase 1, owner direction P1): a view filter that narrows lists and pickers to the accounts
 * an approved client profile binds. It is derived from the profile's bindings and intersected with the actor's current
 * access (Store.connectionsFor), so it can only hide accounts, never reveal or grant one: an account the actor cannot
 * reach stays out even when the profile binds it. It is not a security boundary; client access sets are
 * (src/access-sets.ts).
 */
export interface ClientView {
  profile_id: string;
  name: string;
  /** The profile's bound accounts that are within the actor's current access, as their logins list them. */
  accounts: {gateway: string; connection_id: string; account_id: string}[];
  /** Whether an account (on this gateway, through this login when one is named) is one of the client's. */
  has(gateway: unknown, account: unknown, connection?: unknown): boolean;
}
type Reached = {gateway: string; connection_id: string; account_id: string};
/**
 * The accounts the actor can reach, indexed by login and account (as Store.resolveConnection compares accounts) and by
 * account alone, so each profile binding is one lookup however many accounts the workspace has.
 */
interface Reachable {
  byLogin: Map<string, Reached>;
  byAccount: Map<string, Reached[]>;
}

/** The client profiles of this workspace that bind at least one account the actor can reach, with those accounts. */
export function clientViews(store: Store, actor: Actor): ClientView[] {
  const reachable = reachableAccounts(store, actor);
  return (
    store
      .documents(actor.tenantId, 'client_profile')
      // Access limited to a client access set sees only the profiles wholly within it, as the profiles action does.
      .filter(p => profileWithinAccess(store, actor, p, reachable))
      .map(p => view(p, reachable))
      .filter(v => v.accounts.length)
      .sort(
        (a, b) => a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}) || a.profile_id.localeCompare(b.profile_id),
      )
  );
}

/**
 * One working client by profile ID, for an optional `profile_id` filter. A profile of another workspace, or one that was
 * removed, is refused rather than ignored, so a stale filter never silently shows every client's work.
 */
export function clientView(store: Store, actor: Actor, profileId: unknown): ClientView {
  if (typeof profileId !== 'string' || !profileId || profileId.length > 200)
    throw new MirrorError('INVALID_ARGUMENT', 'Use the ID of a client profile of this workspace.', {
      field: 'profile_id',
    });
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='client_profile' AND id=?")
    .get(actor.tenantId, profileId) as {data: string} | undefined;
  const reachable = reachableAccounts(store, actor),
    profile = row ? {...JSON.parse(row.data), id: profileId} : undefined;
  // A profile outside the actor's client access set is not found either, so its name is never shown (SEC-08).
  if (!profile || !profileWithinAccess(store, actor, profile, reachable))
    throw new MirrorError(
      'PROFILE_NOT_FOUND',
      'This client profile no longer exists in this workspace. Choose another client or show all clients.',
      {profile_id: profileId},
      404,
    );
  return view(profile, reachable);
}

/** An optional filter: undefined when the input names no profile. */
export const optionalClientView = (store: Store, actor: Actor, profileId: unknown) =>
  profileId === undefined || profileId === null || profileId === '' ? undefined : clientView(store, actor, profileId);

/**
 * Whether a client profile is within the actor's access (SEC-08): always without a client access set; with one, only a
 * profile whose every binding the set reaches, since a profile's bindings, templates and naming describe its client.
 */
export function profileWithinAccess(
  store: Store,
  actor: Actor,
  profile: JsonObject,
  reachable = actor.accessSetId === undefined ? undefined : reachableAccounts(store, actor),
): boolean {
  if (actor.accessSetId === undefined || !reachable) return true;
  const bindings = Array.isArray(profile.bindings) ? profile.bindings : [];
  // A profile binding no account names no client this access may work for.
  return bindings.length > 0 && bindings.every((b: unknown) => bound(reachable, b).length > 0);
}
/** A saved profile the actor may see; one outside a client access set is not found, like one that does not exist. */
export function visibleProfile(store: Store, actor: Actor, id: unknown): JsonObject {
  store.assertActorActive(actor);
  if (typeof id !== 'string' || !id || id.length > 200)
    throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
  const profile = store.document(actor.tenantId, 'client_profile', id);
  if (!profileWithinAccess(store, actor, profile))
    throw new MirrorError('NOT_FOUND', 'Document not found in this tenant.', {}, 404);
  return profile;
}

const accountIndex = (gateway: string, account: unknown) => gateway + '\u0000' + accountKey(gateway, account);
function reachableAccounts(store: Store, actor: Actor): Reachable {
  const reachable: Reachable = {byLogin: new Map(), byAccount: new Map()};
  for (const c of store.connectionsFor(actor))
    if (c.enabled)
      for (const account of c.accounts) {
        const value = {gateway: c.gateway, connection_id: c.id, account_id: account},
          key = accountIndex(c.gateway, account);
        reachable.byLogin.set(bindingKey(c.gateway, c.id, account), value);
        reachable.byAccount.set(key, [...(reachable.byAccount.get(key) ?? []), value]);
      }
  return reachable;
}
/** The reachable accounts a profile binding covers: through its login, or through any login when it names none. */
function bound(reachable: Reachable, b: unknown): Reached[] {
  const binding = b as JsonObject | null;
  if (!binding || typeof binding.gateway !== 'string' || typeof binding.account_id !== 'string') return [];
  if (typeof binding.connection_id === 'string' && binding.connection_id) {
    const one = reachable.byLogin.get(bindingKey(binding.gateway, binding.connection_id, binding.account_id));
    return one ? [one] : [];
  }
  return reachable.byAccount.get(accountIndex(binding.gateway, binding.account_id)) ?? [];
}

function view(profile: JsonObject, reachable: Reachable): ClientView {
  const accounts = new Map<string, Reached>();
  for (const b of Array.isArray(profile.bindings) ? profile.bindings : [])
    for (const value of bound(reachable, b))
      accounts.set(bindingKey(value.gateway, value.connection_id, value.account_id), value);
  const list = [...accounts.values()];
  return {
    profile_id: String(profile.id),
    name: String(profile.name ?? profile.id),
    accounts: list,
    has(gateway, account, connection) {
      if (typeof gateway !== 'string' || (typeof account !== 'string' && typeof account !== 'number')) return false;
      return list.some(
        a =>
          a.gateway === gateway &&
          (typeof connection !== 'string' || !connection || a.connection_id === connection) &&
          bindingKey(a.gateway, a.connection_id, a.account_id) === bindingKey(gateway, a.connection_id, account),
      );
    },
  };
}
