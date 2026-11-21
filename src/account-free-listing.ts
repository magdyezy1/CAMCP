import type {Actor, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';

/**
 * The ownership rule of an account-free listing (r25-field2-access, B3; the lead's request that a second provider can reuse it).
 * A provider's top-level containers (Tag Manager accounts; TikTok Business Centers later) are listed by a read that names no
 * account, so ScopeGuard cannot bind it to one, and the read must neither show an actor what their login does not bind nor open
 * anything for them. The rule, which a provider's workflow applies to the answer before anything is returned, kept or cached:
 *
 * - A listing is no ownership evidence. Nothing it returns is remembered, so it widens no guard and no later request.
 * - What the login binds and the actor reaches is returned whole, marked `connected: true`.
 * - What the login does not bind is shown, as an identifier and a name only and marked `connected: false`, to the one actor who
 *   may connect it, an administrator without a client access set (the website's discovery shows that role the same); to
 *   everyone else it is a count and nothing more.
 * - What the login binds but the actor's client access set does not reach (SEC-08) is neither shown nor counted: the set
 *   narrows the login, and an outside account's existence stays unsaid.
 * - A lookup by ID checks the answer's own top-level ID against the same binding before it returns the body; the provider
 *   workflow refuses an ID the actor does not reach, naming the ID only to that administrator.
 *
 * Shared on purpose: it names no provider. The provider's workflow resolves the login, reads read-only and bounded, and gives
 * this module the rows, how it reads an ID from one, and where the login's IDs at the listed level come from (`listingBinding`'s
 * `ids`; lead review S3-3): Tag Manager's listed accounts are the login's accounts, its default. A login does not always bind the
 * containers it lists as accounts: a TikTok login binds advertisers, so its Business Centers need a source of their own, whatever
 * the TikTok package decides its Business Center bindings are. The source must be one a client access set narrows the way it narrows
 * accounts (a login's accounts, or what is derived from its resource bindings or other per-account records, which
 * src/access-sets.ts narrows by account): an ID that no access set narrows would be bound for every client of the workspace, and
 * the rule above about what a set does not reach could not hold.
 */
export interface ListingBinding {
  /** The IDs the actor reaches on this login (a client access set narrows them). */
  readonly reachable: ReadonlySet<string>;
  /** The IDs the login binds that the actor's access set does not reach: never shown, never counted. */
  readonly elsewhere: ReadonlySet<string>;
  /** An administrator without a client access set: the actor who is shown what the login does not bind. */
  readonly administrator: boolean;
}
/** Where a top-level ID stands for this actor on this login. */
export type ListingPlace = 'bound' | 'elsewhere' | 'unbound';

/**
 * What the login binds and the actor reaches, as `store.resolveConnection` returned the login for them (an access set narrows it).
 * `ids` reads the IDs a login binds at the listed level: its accounts unless the provider says otherwise. It is applied to the
 * login as the actor reads it and to the login as the workspace stores it, so what only the set hides is `elsewhere`.
 */
export function listingBinding(
  store: Store,
  actor: Actor,
  connection: Connection,
  ids: (login: Connection) => readonly string[] = login => login.accounts,
): ListingBinding {
  const reachable = new Set(ids(connection)),
    // The login as the workspace stores it, which only a client access set's actor reads narrowed (src/access-sets.ts).
    whole =
      actor.accessSetId === undefined
        ? connection
        : (store.connectionsWithin(actor.tenantId).find(c => c.id === connection.id) ?? connection);
  return {
    reachable,
    elsewhere: new Set(ids(whole).filter(id => !reachable.has(id))),
    administrator: actor.role === 'admin' && actor.accessSetId === undefined,
  };
}
export const listingPlace = (binding: ListingBinding, id: string): ListingPlace =>
  binding.reachable.has(id) ? 'bound' : binding.elsewhere.has(id) ? 'elsewhere' : 'unbound';

/**
 * A listing as this actor may see it: each row the login binds and the actor reaches, whole and `connected: true`; each row it
 * does not bind, as what `unbound` makes of it (`connected: false`) for an administrator, and counted for everyone; the rows an
 * access set does not reach, left out. A row whose ID `idOf` cannot read is the caller's to refuse before this is called.
 */
export function projectListing<Row extends JsonObject>(
  binding: ListingBinding,
  rows: readonly Row[],
  idOf: (row: Row) => string,
  unbound: (row: Row, id: string) => JsonObject,
): {rows: JsonObject[]; notConnected: number} {
  const out: JsonObject[] = [];
  let notConnected = 0;
  for (const row of rows) {
    const id = idOf(row),
      place = listingPlace(binding, id);
    if (place === 'bound') out.push({...row, connected: true});
    else if (place === 'unbound') {
      notConnected++;
      if (binding.administrator) out.push(unbound(row, id));
    }
  }
  return {rows: out, notConnected};
}
