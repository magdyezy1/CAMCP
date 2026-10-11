import type {Actor, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';

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
/** At most this many sets per workspace and bindings per set (profiles are capped at 100 the same way). */
export const accessSetLimit = 100;
export const accessSetBindingLimit = 200;

export interface AccessBinding {
  gateway: string;
  connection_id: string;
  account_id: string;
}

/** Account IDs compare as resolution compares them: Meta without act_, Google Ads without dashes. */
export function accountKey(gateway: string, id: unknown): string {
  const value = String(id);
  return gateway === 'meta_native_action'
    ? value.replace(/^act_/, '')
    : gateway === 'google_ads_native_action'
      ? value.replaceAll('-', '')
      : value;
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
 * The logins a set reaches: each bound login with only its bound accounts, and only those accounts' write grants,
 * resource bindings and recorded manager routes. A login without a bound account is left out entirely.
 */
export function narrowConnections(connections: Connection[], bindings: AccessBinding[]): Connection[] {
  const keys = new Set(bindings.map(b => bindingKey(b.gateway, b.connection_id, b.account_id)));
  return connections.flatMap(c => {
    const inSet = (account: string) => keys.has(bindingKey(c.gateway, c.id, account));
    const accounts = c.accounts.filter(inSet);
    if (!accounts.length) return [];
    const keep = (record: Record<string, string> | undefined) =>
      record ? Object.fromEntries(Object.entries(record).filter(([account]) => inSet(account))) : undefined;
    const narrowed: Connection = {...c, accounts};
    if (c.writeAccounts) narrowed.writeAccounts = c.writeAccounts.filter(inSet);
    if (c.resourceBindings) narrowed.resourceBindings = c.resourceBindings.filter(b => inSet(b.accountId));
    if (c.accountCustomers) narrowed.accountCustomers = keep(c.accountCustomers)!;
    if (c.accountLoginCustomers) narrowed.accountLoginCustomers = keep(c.accountLoginCustomers)!;
    return [narrowed];
  });
}

/** What an actor limited to a set is told about it: its ID, name and how many accounts it binds (never removed: null). */
export function accessSetView(store: Store, actor: Actor): JsonObject | null {
  if (actor.accessSetId === undefined) return null;
  const row = store.db
    .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
    .get(actor.tenantId, accessSetKind, actor.accessSetId) as {data: string} | undefined;
  const record = row ? (JSON.parse(row.data) as JsonObject) : undefined;
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
export function validateAccessSet(input: JsonObject, connections: Connection[]): {name: string; bindings: AccessBinding[]} {
  const name = text(input?.name, 80);
  if (!name) throw new MirrorError('INVALID_ARGUMENT', 'Name the client access set in 1 to 80 characters.', {field: 'name'});
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
