import {randomUUID} from 'node:crypto';
import type {Actor, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {normalizeAccount} from './account-id.js';

/**
 * Client access sets (SEC-08 phase 2, owner direction P1: many clients per workspace). An agency names the accounts one
 * client's work may reach, and a connector token, an AI client's authorization or a member is limited to that set:
 * every account read, report, review and listing then sees only the bound accounts of the bound logins. A credential
 * without a set reaches the whole workspace, as before, so nothing existing changes and nothing needs migrating.
 *
 * - The set is enforced where every account is resolved (Store.connectionsFor and Store.resolveConnection): a login is
 *   narrowed to its bound accounts and their write grants, and a login with none disappears. Writes still need their
 *   own per-account grant, review, spending policy and confirmation; a set never grants anything.
 * - A removed set reaches nothing (fail closed). A change to a set applies at the next request.
 * - Sets apply to operator and viewer access only: an owner or administrator manages sets and is never limited by one.
 *
 * The working client of the website (phase 1) is a different, non-authorizing view filter; see src/client-scope.ts.
 */
export const accessSetKind = 'access_set';
/** A member's set is kept beside the membership as a document keyed by the member's user ID. */
export const memberAccessSetKind = 'member_access_set';
/** The client access set a member is limited to, or undefined for the whole workspace. */
export function memberAccessSetId(store: Store, tenant: string, userId: string): string | undefined {
  const id = store.repo(memberAccessSetKind, tenant).field(userId, 'access_set_id');
  return typeof id === 'string' && id ? id : undefined;
}
/** Limits a member to a set, or with none lifts the limit. */
export function setMemberAccessSet(store: Store, tenant: string, userId: string, accessSetId?: string | null) {
  if (accessSetId) store.putDocument(tenant, memberAccessSetKind, userId, {access_set_id: accessSetId});
  else store.deleteDocument(tenant, memberAccessSetKind, userId);
}
/**
 * Audit rows of work done under a client access set name the set (SEC-08); work without one adds nothing. One helper for
 * every writer of such a row (the service's tool, preview and request rows, and the report library's).
 */
export const accessSetAudit = (actor: Actor) =>
  actor.accessSetId !== undefined ? {access_set_id: actor.accessSetId} : {};
/** At most this many sets per workspace and bindings per set (profiles are capped at 100 the same way). */
export const accessSetLimit = 100;
export const accessSetBindingLimit = 200;

export interface AccessBinding {
  gateway: string;
  connection_id: string;
  account_id: string;
}

/**
 * Account IDs compare as resolution compares them: in each provider adapter's account form (src/account-id.ts: Meta
 * without act_, Google Ads without dashes, every other ID as given).
 */
export function accountKey(gateway: string, id: unknown): string {
  return normalizeAccount(gateway, id);
}
export const bindingKey = (gateway: string, connectionId: string, accountId: unknown) =>
  gateway + '\u0000' + connectionId + '\u0000' + accountKey(gateway, accountId);

/** The bindings a stored set holds; anything malformed is left out, so a damaged set reaches less, never more. */
export function setBindings(record: JsonObject | undefined): AccessBinding[] {
  if (!record || !Array.isArray(record.bindings)) return [];
  return record.bindings.filter(
    (b: unknown): b is AccessBinding =>
      !!b &&
      typeof b === 'object' &&
      typeof (b as JsonObject).gateway === 'string' &&
      typeof (b as JsonObject).connection_id === 'string' &&
      typeof (b as JsonObject).account_id === 'string',
  );
}

/**
 * Marks a login narrowed to a client access set with the set's ID. Object spread keeps an enumerable symbol key (JSON
 * never stores it), so a copy made from a narrowed view is still recognised (SEC-08): Store refuses to write one back,
 * since saving it would drop every account outside the set from the login itself, and a refusal about the login lists
 * only the logins of the same set.
 */
export const narrowedConnection = Symbol('amcp.narrowedConnection');
/** The client access set a login was read through, or undefined for a login as the workspace stores it. */
export function narrowedAccessSetId(c: Connection): string | undefined {
  const id = (c as Connection & {[narrowedConnection]?: unknown})[narrowedConnection];
  return typeof id === 'string' ? id : undefined;
}
export const isNarrowedConnection = (c: Connection) => narrowedAccessSetId(c) !== undefined;

/**
 * The logins a set reaches: each bound login with only its bound accounts, and only those accounts' write grants,
 * resource bindings and recorded manager routes. A login without a bound account is left out entirely.
 */
export function narrowConnections(
  connections: Connection[],
  bindings: AccessBinding[],
  accessSetId: string,
): Connection[] {
  const keys = new Set(bindings.map(b => bindingKey(b.gateway, b.connection_id, b.account_id)));
  return connections.flatMap(c => {
    const inSet = (account: string) => keys.has(bindingKey(c.gateway, c.id, account));
    const accounts = c.accounts.filter(inSet);
    if (!accounts.length) return [];
    const keep = (record: Record<string, string> | undefined) =>
      record ? Object.fromEntries(Object.entries(record).filter(([account]) => inSet(account))) : undefined;
    const narrowed: Connection = {...c, accounts, [narrowedConnection]: accessSetId} as Connection;
    if (c.writeAccounts) narrowed.writeAccounts = c.writeAccounts.filter(inSet);
    if (c.resourceBindings) narrowed.resourceBindings = c.resourceBindings.filter(b => inSet(b.accountId));
    if (c.accountCustomers) narrowed.accountCustomers = keep(c.accountCustomers)!;
    if (c.accountLoginCustomers) narrowed.accountLoginCustomers = keep(c.accountLoginCustomers)!;
    return [narrowed];
  });
}

/**
 * Whether a stored record of one login and account (a write receipt, a report destination) is within these logins, as
 * Store.connectionsFor(actor) returns them. Without a client access set the login decides, as before; with one, the
 * account must also be one the set reaches through that login: a login stays listed when the set binds any of its
 * accounts, so the login alone would let another client's records through.
 */
export function recordWithinAccess(
  actor: Actor,
  connections: Connection[],
  record: {connection_id?: unknown; account_id?: unknown},
): boolean {
  const c = connections.find(c => c.id === record.connection_id);
  if (!c) return false;
  if (actor.accessSetId === undefined) return true;
  return c.accounts.some(a => accountKey(c.gateway, a) === accountKey(c.gateway, record.account_id));
}
/**
 * The uploaded media receipts (workspace_asset documents) an actor may list: every one without a client access set, as
 * before; with one, only those of accounts the set reaches (a receipt names its platform, login and account).
 */
export function assetsWithinAccess(store: Store, actor: Actor, assets: JsonObject[]): JsonObject[] {
  if (actor.accessSetId === undefined) return assets;
  const connections = store.connectionsFor(actor).filter(c => c.enabled);
  return assets.filter(
    a =>
      typeof a.platform === 'string' &&
      connections.some(
        c =>
          c.gateway === a.platform + '_native_action' &&
          (a.connection_id === undefined || a.connection_id === c.id) &&
          c.accounts.some(id => accountKey(c.gateway, id) === accountKey(c.gateway, a.account_id)),
      ),
  );
}

/** What an actor limited to a set is told about it: its ID, name and how many accounts it binds (never removed: null). */
export function accessSetView(store: Store, actor: Actor): JsonObject | null {
  if (actor.accessSetId === undefined) return null;
  const record = store.repo(accessSetKind, actor.tenantId).payload(actor.accessSetId);
  return {
    id: actor.accessSetId,
    name: typeof record?.name === 'string' ? record.name : null,
    accounts: setBindings(record).length,
    removed: !record,
    meaning:
      'This access is limited to the accounts of one client. Accounts outside the set are refused with ACCOUNT_SCOPE_RESTRICTED.',
  };
}

/** The refusal for an account outside the actor's set. It never says whether the account exists in the workspace. */
export function accountScopeRestricted(accessSetId: string, details: JsonObject = {}) {
  return new MirrorError(
    'ACCOUNT_SCOPE_RESTRICTED',
    'This access is limited to a client access set that does not include this account. Use an account of that client, or ask a workspace administrator to change the set.',
    {...details, access_set_id: accessSetId},
    403,
  );
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : undefined;

/**
 * A set as an administrator saves it: a name of 1 to 80 characters and 1 to 200 distinct bindings, each naming an
 * account that a login of this workspace currently selects. Bindings are stored as the login lists the account.
 */
export function validateAccessSet(
  input: JsonObject,
  connections: Connection[],
): {name: string; bindings: AccessBinding[]} {
  const name = text(input?.name, 80);
  if (!name)
    throw new MirrorError('INVALID_ARGUMENT', 'Name the client access set in 1 to 80 characters.', {field: 'name'});
  const raw = input.bindings;
  if (!Array.isArray(raw) || !raw.length || raw.length > accessSetBindingLimit)
    throw new MirrorError('INVALID_ARGUMENT', 'Choose 1 to 200 accounts for this client access set.', {
      field: 'bindings',
    });
  const seen = new Set<string>(),
    bindings: AccessBinding[] = [];
  for (const b of raw) {
    const gateway = text(b?.gateway, 100),
      connection = text(b?.connection_id, 200),
      account = text(b?.account_id, 200);
    const login = connections.find(c => c.id === connection && c.gateway === gateway);
    const listed = login?.accounts.find(a => accountKey(login.gateway, a) === accountKey(login.gateway, account));
    if (!gateway || !connection || !account || !login || listed === undefined)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Each account of a client access set must be selected in a connection of this workspace.',
        {field: 'bindings', gateway: gateway ?? null, connection_id: connection ?? null, account_id: account ?? null},
      );
    const key = bindingKey(gateway, connection, listed);
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({gateway, connection_id: connection, account_id: listed});
  }
  return {name, bindings};
}

const administrator = (store: Store, actor: Actor) => {
  store.assertActorActive(actor);
  if (actor.role !== 'admin')
    throw new MirrorError('FORBIDDEN', 'A workspace administrator manages client access sets.', {}, 403);
};
const publicSet = (record: JsonObject) => ({
  id: String(record.id),
  name: String(record.name ?? record.id),
  bindings: setBindings(record),
  revision: record.revision,
  updated_at: record.updated_at ?? null,
});

/**
 * The client access sets of a workspace. An administrator sees each set with its bound accounts; anyone else sees the
 * set names only (to limit their own token or AI client to one), and a person limited to a set sees just that set.
 */
export function listAccessSets(store: Store, actor: Actor): JsonObject {
  store.assertActorActive(actor);
  const records = store
    .documents(actor.tenantId, accessSetKind)
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? ''), 'en', {sensitivity: 'base'}) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const visible = actor.accessSetId === undefined ? records : records.filter(r => r.id === actor.accessSetId);
  return {
    sets: visible.map(r =>
      actor.role === 'admin'
        ? publicSet(r)
        : {id: String(r.id), name: String(r.name ?? r.id), accounts: setBindings(r).length},
    ),
    limited_to: accessSetView(store, actor),
    limit: accessSetLimit,
  };
}

/** The set a person may limit a new token or AI client to: their own set when they have one, otherwise any set. */
export function choosableAccessSet(store: Store, actor: Actor, requested: unknown): string | undefined {
  if (requested !== undefined && requested !== null && requested !== '' && typeof requested !== 'string')
    throw new MirrorError('INVALID_ARGUMENT', 'Choose a client access set of this workspace.', {
      field: 'access_set_id',
    });
  const id = typeof requested === 'string' && requested ? requested : undefined;
  if (actor.accessSetId !== undefined) {
    // A person limited to a set can only hand on that same limit; nothing they create reaches further than they do.
    if (id !== undefined && id !== actor.accessSetId)
      throw accountScopeRestricted(actor.accessSetId, {requested_access_set_id: id});
    return actor.accessSetId;
  }
  if (id === undefined) return undefined;
  const exists = store.repo(accessSetKind, actor.tenantId).has(id);
  if (!exists)
    throw new MirrorError('ACCESS_SET_NOT_FOUND', 'This client access set no longer exists. Choose another one.', {
      access_set_id: id,
    });
  return id;
}

/**
 * An administrator creates or replaces a set (with the revision they read). A change applies to every token, AI client
 * and member limited to it at their next request; nothing is revoked, and nothing outside the workspace is touched.
 */
export function saveAccessSet(store: Store, actor: Actor, input: JsonObject): JsonObject {
  administrator(store, actor);
  const {name, bindings} = validateAccessSet(input, store.listConnections(actor.tenantId));
  return store.transaction(() => {
    const id = input.id === undefined ? randomUUID() : String(input.id);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id))
      throw new MirrorError('INVALID_ARGUMENT', 'Choose a client access set of this workspace.', {field: 'id'});
    const previous = store.repo(accessSetKind, actor.tenantId).find(id);
    if (input.id !== undefined && !previous)
      throw new MirrorError('ACCESS_SET_NOT_FOUND', 'This client access set no longer exists. Choose another one.', {
        access_set_id: id,
      });
    if (previous && input.revision !== previous.revision)
      throw new MirrorError('REVISION_CONFLICT', 'Reload the client access set before changing it.', {}, 409);
    if (!previous && store.documents(actor.tenantId, accessSetKind).length >= accessSetLimit)
      throw new MirrorError('WORKSPACE_QUOTA', 'This workspace has reached its limit of 100 client access sets.');
    const before = previous ? setBindings(previous) : [];
    store.putDocument(
      actor.tenantId,
      accessSetKind,
      id,
      {name, bindings, updated_at: Date.now(), updated_by: actor.userId},
      previous?.revision ?? 0,
    );
    const keys = (list: AccessBinding[]) =>
      new Set(list.map(b => bindingKey(b.gateway, b.connection_id, b.account_id)));
    const now = keys(bindings),
      was = keys(before);
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: previous ? 'access_set_changed' : 'access_set_created',
      actor: actor.userId,
      access_set_id: id,
      accounts: bindings.length,
      added: [...now].filter(k => !was.has(k)).length,
      removed: [...was].filter(k => !now.has(k)).length,
      vendor_writes: 0,
    });
    return publicSet(store.document(actor.tenantId, accessSetKind, id));
  });
}

/**
 * An administrator removes a set (with the revision they read and confirmed:true). Tokens, AI clients and members
 * limited to it keep their limit and reach nothing until they are given access again (fail closed).
 */
export function deleteAccessSet(store: Store, actor: Actor, input: JsonObject): JsonObject {
  administrator(store, actor);
  if (input.confirmed !== true)
    throw new MirrorError(
      'CONFIRMATION_REQUIRED',
      'Confirm removing this client access set. Access limited to it then reaches no account.',
    );
  return store.transaction(() => {
    const id = String(input.id ?? ''),
      row = store.repo(accessSetKind, actor.tenantId).find(id);
    if (!row)
      throw new MirrorError('ACCESS_SET_NOT_FOUND', 'This client access set no longer exists. Choose another one.', {
        access_set_id: id,
      });
    if (input.revision !== row.revision)
      throw new MirrorError('REVISION_CONFLICT', 'Reload the client access set before changing it.', {}, 409);
    store.deleteDocument(actor.tenantId, accessSetKind, id);
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: 'access_set_removed',
      actor: actor.userId,
      access_set_id: id,
      vendor_writes: 0,
    });
    return {success: true, id};
  });
}
