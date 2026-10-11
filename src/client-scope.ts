import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {bindingKey} from './access-sets.js';
import {reportPlatforms} from './report-metrics.js';

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

/** The client profiles of this workspace that bind at least one account the actor can reach, with those accounts. */
export function clientViews(store: Store, actor: Actor): ClientView[] {
  const reachable = reachableKeys(store, actor);
  return store
    .documents(actor.tenantId, 'client_profile')
    .map(p => view(p, reachable))
    .filter(v => v.accounts.length)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}) || a.profile_id.localeCompare(b.profile_id),
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
  if (!row)
    throw new MirrorError(
      'PROFILE_NOT_FOUND',
      'This client profile no longer exists in this workspace. Choose another client or show all clients.',
      {profile_id: profileId},
      404,
    );
  return view({...JSON.parse(row.data), id: profileId}, reachableKeys(store, actor));
}

/** An optional filter: undefined when the input names no profile. */
export const optionalClientView = (store: Store, actor: Actor, profileId: unknown) =>
  profileId === undefined || profileId === null || profileId === '' ? undefined : clientView(store, actor, profileId);

/** The client profiles (by ID) that bind each of these accounts, for a cross-client warning. */
export function clientsOf(views: ClientView[], scopes: {gateway?: unknown; connection_id?: unknown; account_id?: unknown}[]) {
  const ids = new Set<string>();
  for (const s of scopes)
    for (const v of views) if (v.has(s.gateway, s.account_id, s.connection_id)) ids.add(v.profile_id);
  return [...ids];
}

/** A report source names its platform, not its gateway. */
export const sourceGateway = (s: JsonObject) => s.gateway ?? reportPlatforms[s.platform]?.gateway;

function reachableKeys(store: Store, actor: Actor) {
  const keys = new Map<string, {gateway: string; connection_id: string; account_id: string}>();
  for (const c of store.connectionsFor(actor))
    if (c.enabled)
      for (const account of c.accounts)
        keys.set(bindingKey(c.gateway, c.id, account), {gateway: c.gateway, connection_id: c.id, account_id: account});
  return keys;
}

function view(
  profile: JsonObject,
  reachable: Map<string, {gateway: string; connection_id: string; account_id: string}>,
): ClientView {
  const accounts = new Map<string, {gateway: string; connection_id: string; account_id: string}>();
  for (const b of Array.isArray(profile.bindings) ? profile.bindings : []) {
    if (!b || typeof b.gateway !== 'string' || typeof b.account_id !== 'string') continue;
    // A binding without a login covers the account through any login that selects it.
    for (const [key, value] of reachable)
      if (
        value.gateway === b.gateway &&
        (typeof b.connection_id !== 'string' || !b.connection_id || value.connection_id === b.connection_id) &&
        key === bindingKey(value.gateway, value.connection_id, b.account_id)
      )
        accounts.set(key, value);
  }
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
