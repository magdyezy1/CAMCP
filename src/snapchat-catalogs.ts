import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {all} from './snapchat-product-feeds.js';
import {fail, stateReadOf} from './family-kit.js';

/**
 * Snapchat product catalogs, opened by the owner on 2026-09-29. Snapchat's "Dynamic Product Ads" reference (read
 * 2026-09-29): "The permission Organization Admin is required to create, update or delete a Product Catalog." A catalog
 * has name (1-375 characters), organization_id, vertical (UNKNOWN_VERTICAL, COMMERCE, HOTELS, PLACES, FLIGHTS) and
 * event_sources ("List of Pixel IDs and/or the Snap App IDs that reports events for the Catalog"); at most 200 catalogs
 * per organization. POST /v1/organizations/{organization_id}/catalogs creates, PUT on the same path updates ("IMPORTANT!
 * The API expects the entire object when updating any fields. Omitting attributes that have default values will reset
 * those attributes to the default"; name and event_sources can be updated), DELETE /v1/catalogs/{catalog_id} deletes.
 *
 * AMCP writes catalogs of the selected ad account's organization, one at a time: COMMERCE catalogs whose event sources
 * are pixels of the ad account (Snap App IDs stay outside). The reference does not say what deleting a catalog does to
 * its feed, product sets and ads, so AMCP deletes only an empty catalog: no product feed, and no product set but the
 * default one Snapchat maintains.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog?: string; verify?: boolean};
type Read = CompiledRequest & {snapCatalogState?: State; snapCatalogOrg?: string; snapCatalogId?: string};
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com',
  marker = 'AMCP_SNAPCHAT_CATALOG_READ',
  perOrganization = 200,
  source = 'https://developers.snap.com/marketing-api/Ads-API/dynamic-product-ads';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function invalid(message: string): never {
  return fail('INVALID_SNAPCHAT_CATALOG', message, {source});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function snapCatalogKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== origin)) return;
  if (/^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/catalogs$/.test(p.path))
    return p.method === 'POST' ? 'create' : p.method === 'PUT' ? 'update' : undefined;
  if (p.method === 'DELETE' && /^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}$/.test(p.path)) return 'delete';
}
const orgOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const catalogOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const item = (p: CompiledRequest): JsonObject =>
  (object(p.body) && Array.isArray(p.body.catalogs) && object(p.body.catalogs[0])
    ? p.body.catalogs[0]
    : {}) as JsonObject;
const sources = (v: unknown): JsonObject[] =>
  (Array.isArray(v) ? (v as JsonObject[]) : [])
    .map(x => ({id: x.id, type: x.type}))
    .sort((a, b) => stable(a).localeCompare(stable(b)));
export function assertSnapCatalog(p: CompiledRequest): void {
  const kind = snapCatalogKind(p);
  if (!kind) return;
  if (!snapId(p.accountId))
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose organization owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Catalog writes take no query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the catalog in the path.');
    return;
  }
  const b = p.body;
  if (!object(b) || Object.keys(b).some(k => k !== 'catalogs') || !Array.isArray(b.catalogs) || b.catalogs.length !== 1)
    invalid('Send {catalogs: [one catalog]}: AMCP writes one catalog at a time.');
  const c = item(p),
    fields = ['organization_id', 'name', 'vertical', 'event_sources', ...(kind === 'update' ? ['id'] : [])];
  const extra = Object.keys(c).filter(k => !fields.includes(k));
  if (extra.length) invalid('A catalog takes ' + fields.join(', ') + '; unqualified: ' + extra.join(', ') + '.');
  if (kind === 'update') {
    if (!snapId(c.id)) invalid('id names the catalog to update.');
    // "The API expects the entire object": an omitted attribute would be reset.
    for (const k of fields) if (c[k] === undefined) invalid('An update sends the whole catalog: ' + k + ' is missing.');
  }
  if (c.organization_id !== orgOf(p)) invalid('organization_id is the organization in the path.');
  if (!text(c.name, 375)) invalid('name has 1 to 375 characters without surrounding spaces.');
  if (c.vertical !== 'COMMERCE')
    invalid('AMCP writes COMMERCE catalogs (hotel, place and flight catalogs stay outside).');
  if (c.event_sources !== undefined) {
    const list = c.event_sources;
    if (
      !Array.isArray(list) ||
      list.length > 20 ||
      !list.every(x => object(x) && Object.keys(x).length === 2 && snapId(x.id) && x.type === 'PIXEL') ||
      new Set(list.map(x => (x as JsonObject).id)).size !== list.length
    )
      invalid(
        'event_sources lists different pixels of the ad account as {id, type: "PIXEL"} (Snap App IDs stay outside AMCP).',
      );
  }
}
const read = (
  p: CompiledRequest,
  path: string,
  query: Record<string, string | number>,
  extra: Partial<Read> = {},
): Read =>
  stateReadOf<Read>(p, marker, path, query, {
    snapCatalogState: undefined,
    snapCatalogOrg: undefined,
    snapCatalogId: undefined,
    ...extra,
  });
const accountRead = (p: CompiledRequest, state: State) =>
  read(p, '/v1/adaccounts/' + p.accountId, {}, {snapCatalogState: state});
export function snapCatalogSnapshots(p: CompiledRequest): Read[] {
  const kind = snapCatalogKind(p)!;
  return [
    accountRead(p, {
      kind,
      ...(kind === 'delete' ? {catalog: catalogOf(p)} : kind === 'update' ? {catalog: String(item(p).id)} : {}),
    }),
  ];
}
export function isSnapCatalogRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).snapCatalogState;
}
/** Writes after validation. Internal reads: the account and its pixels, its organization's catalogs, and one catalog. */
export function authorizeSnapCatalog(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (snapCatalogKind(p)) {
    assertSnapCatalog(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose organization owns the catalog.', {}, 403);
    return true;
  }
  if (p.action !== marker || p.method !== 'GET' || !p.readOnly || p.body !== undefined || p.accountId !== account)
    return false;
  const r = p as Read,
    id = p.path.split('/')[3];
  if (
    (p.path === '/v1/adaccounts/' + account || p.path === '/v1/adaccounts/' + account + '/pixels') &&
    !r.snapCatalogOrg
  )
    return true;
  // Each marker is set only by readSnapCatalogs from the account or organization just read.
  if (/^\/v1\/organizations\/[A-Za-z0-9-]{1,64}\/catalogs$/.test(p.path) && r.snapCatalogOrg === id) return true;
  if (/^\/v1\/catalogs\/[A-Za-z0-9-]{1,64}(\/product_sets|\/product_feeds)?$/.test(p.path) && r.snapCatalogId === id)
    return true;
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal catalog read.', {}, 403);
}
const catalogView = (c: JsonObject): JsonObject => ({
  id: String(c.id),
  organization_id: c.organization_id ?? null,
  name: c.name ?? null,
  vertical: c.vertical ?? null,
  event_sources: sources(c.event_sources),
  default_product_set_id: c.default_product_set_id ?? null,
});
async function oneCatalog(p: CompiledRequest, id: string, fetch: (p: CompiledRequest) => Promise<TransportResult>) {
  try {
    const r = await fetch(read(p, '/v1/catalogs/' + id, {}, {snapCatalogId: id})),
      d = r.data;
    if (
      r.status !== 200 ||
      !object(d) ||
      String(d.request_status).toUpperCase() !== 'SUCCESS' ||
      !Array.isArray(d.catalogs)
    )
      unverified('Snapchat did not return catalog ' + id + '.');
    const x = (d.catalogs as unknown[])[0];
    return object(x) && object(x.catalog) && x.catalog.id === id ? (x.catalog as JsonObject) : undefined;
  } catch (e) {
    if (e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND')) return undefined;
    throw e;
  }
}
/** The account's organization, its catalogs and pixels, and for a deletion the catalog's feeds and product sets. */
export async function readSnapCatalogs(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).snapCatalogState;
  if (!s) return fetch(p);
  if (s.verify) {
    const c = await oneCatalog(p, s.catalog!, fetch);
    return {
      status: 200,
      headers: {},
      data: {catalog: c ? {present: true, ...catalogView(c)} : {present: false, id: s.catalog}},
    };
  }
  const account = p.accountId!,
    a = await fetch({...(p as Read), snapCatalogState: undefined} as Read),
    ad = a.data;
  const row =
    object(ad) &&
    String(ad.request_status).toUpperCase() === 'SUCCESS' &&
    Array.isArray(ad.adaccounts) &&
    object(ad.adaccounts[0])
      ? ad.adaccounts[0].adaccount
      : undefined;
  if (a.status !== 200 || !object(row) || row.id !== account || !snapId(row.organization_id))
    unverified('Snapchat did not return the selected ad account with its organization.');
  const org = String(row.organization_id);
  const catalogs = (
    await all(
      read(p, '/v1/organizations/' + org + '/catalogs', {limit: 100}, {snapCatalogOrg: org}),
      'catalogs',
      'catalog',
      fetch,
    )
  )
    .map(catalogView)
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const out: JsonObject = {ad_account_id: account, organization_id: org, catalogs};
  if (s.kind !== 'delete')
    out.pixels = (await all(read(p, '/v1/adaccounts/' + account + '/pixels', {}), 'pixels', 'pixel', fetch))
      .map(x => String(x.id))
      .sort();
  if (s.kind === 'delete' && catalogs.some(c => c.id === s.catalog)) {
    const tag = {snapCatalogId: s.catalog};
    out.feeds = (
      await all(
        read(p, '/v1/catalogs/' + s.catalog + '/product_feeds', {}, tag),
        'product_feeds',
        'product_feed',
        fetch,
      )
    ).map(f => String(f.id));
    out.product_sets = (
      await all(
        read(p, '/v1/catalogs/' + s.catalog + '/product_sets', {limit: 50}, tag),
        'product_sets',
        'product_set',
        fetch,
      )
    ).map(x => String(x.id));
  }
  return {status: 200, headers: {}, data: out};
}
export function validateSnapCatalogState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).snapCatalogState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.catalog) : !Array.isArray(d.catalogs)))
    unverified('Missing verified catalog state.');
}
export function snapCatalogPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = snapCatalogKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.catalogs)) unverified('Missing verified catalog state.');
  const catalogs = s.catalogs as JsonObject[];
  if (kind === 'delete') {
    const c = catalogs.find(x => x.id === catalogOf(p));
    if (!c)
      fail(
        'STATE_TARGET_MISMATCH',
        'Catalog ' + catalogOf(p) + " is not a catalog of the ad account's organization.",
        {},
        409,
      );
    const feeds = s.feeds as string[],
      sets = ((s.product_sets as string[]) ?? []).filter(x => x !== c.default_product_set_id);
    if (!Array.isArray(s.feeds) || !Array.isArray(s.product_sets))
      unverified('Missing the feed and product sets of the catalog.');
    if (feeds.length || sets.length)
      fail(
        'CATALOG_NOT_EMPTY',
        'Catalog ' +
          catalogOf(p) +
          ' still has ' +
          [
            ...(feeds.length ? ['its product feed'] : []),
            ...(sets.length ? [sets.length + ' product set(s)'] : []),
          ].join(' and ') +
          ". Snapchat's reference does not say what deleting a catalog does to them and the ads using them: delete them first, each with its own review.",
        {product_feeds: feeds, product_sets: sets},
        409,
      );
    return;
  }
  if (orgOf(p) !== s.organization_id)
    fail(
      'STATE_TARGET_MISMATCH',
      "The organization in the path is not the ad account's organization (" + String(s.organization_id) + ').',
      {},
      409,
    );
  const c = item(p);
  if (!Array.isArray(s.pixels)) unverified('Missing the pixels of the ad account.');
  const foreign = sources(c.event_sources).filter(x => !(s.pixels as string[]).includes(String(x.id)));
  if (foreign.length)
    fail(
      'STATE_TARGET_MISMATCH',
      'Pixel ' + foreign.map(x => String(x.id)).join(', ') + ' is not a pixel of the ad account.',
      {},
      409,
    );
  if (kind === 'create') {
    if (catalogs.length >= perOrganization)
      fail(
        'CONFIGURATION_LIMIT',
        'The organization already has ' + perOrganization + ' catalogs, the most Snapchat allows.',
        {},
        409,
      );
    return;
  }
  const before = catalogs.find(x => x.id === c.id);
  if (!before)
    fail('STATE_NOT_FOUND', 'Catalog ' + String(c.id) + " is not a catalog of the ad account's organization.", {}, 404);
  if (before.vertical !== c.vertical) invalid('A catalog keeps its vertical; only name and event_sources change.');
  if (before.name === c.name && stable(before.event_sources) === stable(sources(c.event_sources)))
    invalid('Catalog ' + String(c.id) + ' already has these values.');
}
export function snapCatalogImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = snapCatalogKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    catalogs = (Array.isArray(s.catalogs) ? s.catalogs : []) as JsonObject[],
    c = item(p);
  const before = catalogs.find(x => x.id === (kind === 'delete' ? catalogOf(p) : c.id));
  const after =
    kind === 'delete' ? null : {name: c.name, vertical: c.vertical, event_sources: sources(c.event_sources)};
  const dropped =
    kind === 'update' && before
      ? (before.event_sources as JsonObject[]).filter(x => !sources(c.event_sources).some(y => y.id === x.id))
      : [];
  return {
    provider: 'snapchat',
    scope: 'catalog',
    operation: kind,
    organization_id: s.organization_id ?? null,
    ...(kind === 'create' ? {creating: after} : kind === 'update' ? {before, after} : {deleting: before}),
    ...(dropped.length
      ? {
          warning:
            'The update drops event source(s) ' +
            dropped.map(x => String(x.id)).join(', ') +
            ': the whole catalog is sent, and what it leaves out is removed.',
        }
      : {}),
    may_affect_serving: kind === 'update' && dropped.length > 0,
    effect:
      kind === 'create'
        ? 'Creates an empty COMMERCE catalog in the organization; a product feed fills it.'
        : kind === 'update'
          ? 'Replaces the catalog\'s name and event sources with the ones sent ("the entire object").'
          : 'Deletes the empty catalog: it has no product feed and no product set but its default.',
    note: 'Snapchat requires Organization Admin for catalog changes; it refuses them for other members.',
    verification:
      kind === 'delete'
        ? 'Reads the catalog again and expects it to be gone.'
        : 'Reads the catalog again and compares name, vertical and event sources.',
    source,
  };
}
export function snapCatalogOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status !== 200 || !object(d) || String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
  if (snapCatalogKind(p) === 'delete') return true;
  const x = Array.isArray(d.catalogs) ? (d.catalogs as unknown[])[0] : undefined;
  return (
    object(x) && String(x.sub_request_status).toUpperCase() === 'SUCCESS' && object(x.catalog) && snapId(x.catalog.id)
  );
}
export function snapCatalogVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = snapCatalogKind(p)!,
    x = Array.isArray(result.data?.catalogs) ? result.data.catalogs[0] : undefined,
    id = kind === 'delete' ? catalogOf(p) : String(object(x) && object(x.catalog) ? x.catalog.id : '');
  if (!snapId(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no catalog.');
  const c = item(p),
    expected: JsonObject =
      kind === 'delete'
        ? {catalog: {present: false}}
        : {
            catalog: {
              present: true,
              organization_id: c.organization_id,
              name: c.name,
              vertical: c.vertical,
              event_sources: sources(c.event_sources),
            },
          };
  return [{read: accountRead(p, {kind, catalog: id, verify: true}), expected, id: 'catalog ' + id}];
}
export function snapCatalogObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const x = object(data.catalog) ? data.catalog : {};
  return x.present ? {catalog: x} : {catalog: {present: false}};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const snapCatalogFamily: ReviewedFamily = {
  name: 'snapchat_catalogs',
  files: ['src/snapchat-catalogs.ts', ['tests/snapchat-catalogs.test.mjs']],
  kind: snapCatalogKind,
  assert: plan => assertSnapCatalog(plan),
  authorize: authorizeSnapCatalog,
  snapshots: snapCatalogSnapshots,
  isRead: isSnapCatalogRead,
  reader: readSnapCatalogs,
  validateState: validateSnapCatalogState,
  prerequisites: snapCatalogPrerequisites,
  impact: snapCatalogImpact,
  outcome: snapCatalogOutcome,
  verification: snapCatalogVerification,
  observed: snapCatalogObserved,
  destructive: plan => snapCatalogKind(plan) === 'delete',
};
