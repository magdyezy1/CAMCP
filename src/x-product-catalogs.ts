import type {ReviewedFamily} from './reviewed-family.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  authorizeXCatalogRead,
  fail,
  object,
  ownedCatalog,
  text,
  unverified,
  xCatalogFeeds,
  xCatalogGateway as gateway,
  xCatalogOwners,
  xCatalogHasProducts,
  xCatalogRead,
  xCatalogSets,
  xCatalogSource as source,
  xSnowflake,
  type Fetch,
} from './x-catalogs.js';

/**
 * X product catalogs, opened by the owner on 2026-09-29. X Ads API v12, "Catalog Management API Reference" (docs.x.com,
 * read 2026-09-29): POST product_catalogs with name (required) and user_id ("Create a product catalog. One user can only
 * create one catalog that holds all products"); PUT product_catalogs/:id with name; DELETE product_catalogs/:id ("This is
 * a permanent deletion").
 *
 * AMCP writes catalogs of FULL promotable users of the selected ad account (src/x-catalogs.ts), one at a time. The
 * reference does not say what deleting a catalog does to its products, product sets, feed and the ads using them, so
 * AMCP deletes only an empty catalog: no product, no product set and no scheduled feed.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; verify?: boolean};
type Read = CompiledRequest & {xCatalogState?: State};
const nameBound = 255;
function invalid(message: string): never {
  return fail('INVALID_X_CATALOG', message, {source});
}
export function xCatalogKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (p.method === 'POST' && p.path === '/12/product_catalogs') return 'create';
  if (/^\/12\/product_catalogs\/[1-9][0-9]{0,24}$/.test(p.path))
    return p.method === 'PUT' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
}
const catalogOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
export function assertXCatalog(p: CompiledRequest): void {
  const kind = xCatalogKind(p);
  if (!kind) return;
  if (typeof p.accountId !== 'string' || !p.accountId)
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Catalog writes take their parameters in the body, without query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the catalog in the path.');
    return;
  }
  const b = p.body,
    fields = kind === 'create' ? ['name', 'user_id'] : ['name'];
  if (!object(b)) invalid('Send the catalog as {' + fields.join(', ') + '}.');
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length)
    invalid('A catalog ' + kind + ' takes ' + fields.join(' and ') + '; unqualified: ' + extra.join(', ') + '.');
  if (!text(b.name, nameBound))
    invalid('name has 1 to ' + nameBound + ' characters without surrounding spaces or control characters.');
  if (kind === 'create' && (typeof b.user_id !== 'string' || !xSnowflake.test(b.user_id)))
    invalid(
      "user_id is required: the ID, as a string, of the FULL promotable user of the selected ad account whose catalog this is (X's one catalog per user).",
    );
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...(xCatalogRead(p, '/12/accounts/' + p.accountId + '/promotable_users', {count: 200}) as Read),
  xCatalogState: state,
});
export function xCatalogSnapshots(p: CompiledRequest): Read[] {
  const kind = xCatalogKind(p)!;
  return [stateRead(p, {kind, ...(kind === 'create' ? {} : {catalog: catalogOf(p)})})];
}
export function isXCatalogRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xCatalogState;
}
/** Writes after validation, and the shared internal catalog reads (src/x-catalogs.ts). */
export function authorizeXCatalog(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (xCatalogKind(p)) {
    assertXCatalog(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
    return true;
  }
  return authorizeXCatalogRead(p, account);
}
/** The account's FULL promotable users and their catalogs; for a deletion, what the catalog still holds. */
export async function readXCatalogs(p: CompiledRequest, fetch: Fetch): Promise<TransportResult> {
  const s = (p as Read).xCatalogState;
  if (!s) return fetch(p);
  const owners = await xCatalogOwners(p, fetch),
    found = owners.catalogs.find(c => c.id === s.catalog);
  if (s.verify)
    return {
      status: 200,
      headers: {},
      data: {catalog: found ? {present: true, ...found} : {present: false, id: s.catalog ?? null}},
    };
  const out: JsonObject = {users: owners.users, catalogs: owners.catalogs};
  if (s.kind === 'delete' && found) {
    out.contents = {
      products: await xCatalogHasProducts(p, fetch, found.id),
      product_sets: (await xCatalogSets(p, fetch, found.id)).map(x => String(x.id)).sort(),
      scheduled_feeds: (await xCatalogFeeds(p, fetch, found.id)).map(x => String(x.id)).sort(),
    };
  }
  return {status: 200, headers: {}, data: out};
}
export function validateXCatalogState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xCatalogState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.catalog) : !Array.isArray(d.catalogs)))
    unverified('Missing verified catalog state.');
}
export function xCatalogPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xCatalogKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.users) || !Array.isArray(s.catalogs))
    unverified('Missing verified catalog state.');
  const catalogs = s.catalogs as JsonObject[];
  if (kind === 'create') {
    const user = String(body(p).user_id);
    if (!(s.users as string[]).includes(user))
      fail(
        'STATE_TARGET_MISMATCH',
        'User ' + user + ' is not a FULL promotable user of the selected ad account.',
        {user_id: user},
        409,
      );
    const existing = catalogs.find(c => c.user_id === user);
    if (existing)
      fail(
        'CONFIGURATION_EXISTS',
        'User ' + user + ' already has catalog ' + String(existing.id) + ': X allows one catalog per user.',
        {product_catalog_id: String(existing.id)},
        409,
      );
    return;
  }
  const c = ownedCatalog(s, catalogOf(p));
  if (kind === 'update') {
    if (c.name === body(p).name) invalid('Catalog ' + catalogOf(p) + ' already has this name.');
    return;
  }
  const inside = s.contents;
  if (!object(inside) || !Array.isArray(inside.product_sets) || !Array.isArray(inside.scheduled_feeds))
    unverified('Missing the contents of the catalog.');
  const sets = inside.product_sets as string[],
    feeds = inside.scheduled_feeds as string[];
  if (inside.products || sets.length || feeds.length)
    fail(
      'CATALOG_NOT_EMPTY',
      'Catalog ' +
        catalogOf(p) +
        ' still has ' +
        [
          ...(inside.products ? ['products'] : []),
          ...(sets.length ? [sets.length + ' product set(s)'] : []),
          ...(feeds.length ? ['its scheduled feed'] : []),
        ].join(', ') +
        ". X's reference does not say what deleting a catalog does to them and the ads using them: delete them first, each with its own review.",
      {product_sets: sets, scheduled_feeds: feeds},
      409,
    );
}
export function xCatalogImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xCatalogKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    catalogs = (Array.isArray(s.catalogs) ? s.catalogs : []) as JsonObject[],
    b = body(p),
    before = kind === 'create' ? undefined : catalogs.find(c => c.id === catalogOf(p));
  return {
    provider: 'x',
    scope: 'product_catalog',
    operation: kind,
    user_id: kind === 'create' ? b.user_id : (before?.user_id ?? null),
    ...(kind === 'create'
      ? {creating: {name: b.name}}
      : kind === 'update'
        ? {before: {name: before?.name ?? null}, after: {name: b.name}}
        : {deleting: before ?? null}),
    may_affect_serving: false,
    effect:
      kind === 'create'
        ? "Creates the user's catalog, empty; a scheduled feed or product writes fill it. X allows one catalog per user."
        : kind === 'update'
          ? 'Renames the catalog.'
          : 'Permanently deletes the empty catalog ("This is a permanent deletion"): it has no product, product set or scheduled feed.',
    note: "X's catalog endpoints are early access, and X requires the X Shopping Manager terms to be accepted; X refuses the write otherwise.",
    verification:
      kind === 'delete'
        ? "Lists the user's catalogs again and expects this one to be gone."
        : "Lists the user's catalogs again and compares the name.",
    source,
  };
}
export function xCatalogOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xCatalogKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined;
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    !xSnowflake.test(String(t.id ?? '')) ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind !== 'create' && String(t.id) !== catalogOf(p)) return false;
  return kind === 'delete' || t.name === body(p).name;
}
export function xCatalogVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xCatalogKind(p)!,
    id = kind === 'create' ? String(result.data?.data?.id ?? '') : catalogOf(p);
  if (!xSnowflake.test(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no catalog.');
  const prior = object(before[0]) && Array.isArray(before[0].catalogs) ? (before[0].catalogs as JsonObject[]) : [],
    user = kind === 'create' ? body(p).user_id : prior.find(c => c.id === id)?.user_id;
  const expected =
    kind === 'delete'
      ? {catalog: {present: false}}
      : {catalog: {present: true, id, name: body(p).name, ...(user ? {user_id: user} : {})}};
  return [{read: stateRead(p, {kind, catalog: id, verify: true}), expected, id: 'product catalog ' + id}];
}
export function xCatalogObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {catalog: object(data.catalog) ? data.catalog : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xCatalogFamily: ReviewedFamily = {
  name: 'x_product_catalogs',
  files: ['src/x-product-catalogs.ts', ['tests/x-product-catalogs.test.mjs']],
  kind: xCatalogKind,
  assert: plan => assertXCatalog(plan),
  authorize: authorizeXCatalog,
  snapshots: xCatalogSnapshots,
  isRead: isXCatalogRead,
  reader: readXCatalogs,
  validateState: validateXCatalogState,
  prerequisites: xCatalogPrerequisites,
  impact: xCatalogImpact,
  outcome: xCatalogOutcome,
  verification: xCatalogVerification,
  observed: xCatalogObserved,
  destructive: plan => xCatalogKind(plan) === 'delete',
};
