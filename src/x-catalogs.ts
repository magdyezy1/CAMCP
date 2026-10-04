import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Shared reads of X product catalogs, opened by the owner on 2026-09-29. X Ads API v12, "Catalog Management" and its API
 * reference (docs.x.com, read 2026-09-29): "A catalog holds everything regarding the user's product and product set and
 * is associated with the user's handle. Currently, one user can only create one catalog." GET product_catalogs returns
 * the catalogs "associated with the authenticated user (default) or the user specified in the user_id parameter". The
 * endpoints are early access, and X requires the Shopping Manager terms to be accepted.
 *
 * An X catalog belongs to a user, not to an ad account. AMCP writes only catalogs of FULL promotable users of the
 * selected ad account (GET accounts/:account_id/promotable_users): the handles the account advertises as.
 */
export const xCatalogGateway = 'x_ads_native_action',
  xCatalogMarker = 'AMCP_X_CATALOG_READ',
  xCatalogSource = 'https://docs.x.com/x-ads-api/catalog-management/reference',
  xSnowflake = /^[1-9][0-9]{0,24}$/,
  /** Pages of 100 products (X's maximum count) read to find a product: 1,000 products. */
  productPages = 10,
  usersBound = 10;
/** Tags set only by the readers below, from the account or catalog they just read. */
export type XCatalogTag = {xCatalogUser?: string; xCatalogId?: string};
/** Every family state key, cleared on internal reads so they never reach another family's reader. */
const stateKeys = ['xCatalogState', 'xProductSetState', 'xScheduledFeedState', 'xCatalogProductState'];
export type Fetch = (p: CompiledRequest) => Promise<TransportResult>;
export const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** X lists only the first product of a group. Missing/malformed grouping cannot establish individual identity. */
export function xCatalogProductGrouping(row: JsonObject): 'individual' | 'grouped' | 'unknown' {
  const keys = ['item_group_id', 'item_group_key'];
  if (keys.some(key => row[key] != null && !text(row[key], 100))) return 'unknown';
  if (keys.some(key => row[key] != null)) return 'grouped';
  return keys.some(key => Object.hasOwn(row, key) && row[key] === null) ? 'individual' : 'unknown';
}
export function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
export function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
/** An HTTPS address without credentials, at most 2048 characters. */
export function httpsUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function xCatalogRead(
  p: CompiledRequest,
  path: string,
  query: Record<string, string | number> = {},
  tag: XCatalogTag = {},
): CompiledRequest {
  const r: JsonObject = {
    ...p,
    action: xCatalogMarker,
    method: 'GET',
    path,
    query,
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    xCatalogUser: tag.xCatalogUser,
    xCatalogId: tag.xCatalogId,
  };
  for (const k of stateKeys) r[k] = undefined;
  return r as unknown as CompiledRequest;
}
/**
 * Internal catalog reads: the account's promotable users, the catalogs of one of them, and the products, product sets
 * and scheduled feeds of a catalog found under one of them. Every other read under the marker is refused.
 */
export function authorizeXCatalogRead(p: CompiledRequest, account: string): boolean {
  if (p.gateway !== xCatalogGateway || p.action !== xCatalogMarker) return false;
  const r = p as CompiledRequest & XCatalogTag,
    keys = Object.keys(p.query),
    only = (...allowed: string[]) => keys.every(k => allowed.includes(k));
  if (p.method === 'GET' && p.readOnly && p.body === undefined && p.accountId === account) {
    if (
      p.path === '/12/accounts/' + account + '/promotable_users' &&
      !r.xCatalogUser &&
      !r.xCatalogId &&
      only('count', 'cursor')
    )
      return true;
    if (
      p.path === '/12/product_catalogs' &&
      !!r.xCatalogUser &&
      p.query.user_id === r.xCatalogUser &&
      !r.xCatalogId &&
      only('user_id', 'cursor')
    )
      return true;
    const m = /^\/12\/product_catalogs\/([1-9][0-9]{0,24})\/(products|product_sets|scheduled_feeds)$/.exec(p.path);
    if (
      m &&
      r.xCatalogId === m[1] &&
      !r.xCatalogUser &&
      only(...(m[2] === 'products' ? ['count', 'cursor'] : ['cursor']))
    )
      return true;
  }
  return fail('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal catalog read.', {}, 403);
}
async function page(fetch: Fetch, r: CompiledRequest): Promise<JsonObject> {
  const res = await fetch(r),
    d = res.data;
  if (res.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
    unverified('X returned a failed or unrecognized catalog read.');
  return d;
}
/** Follows next_cursor for at most `pages` pages; `complete` is false when X has more. */
export async function xList(
  fetch: Fetch,
  first: CompiledRequest,
  pages: number,
  what: string,
): Promise<{rows: JsonObject[]; complete: boolean}> {
  const rows: JsonObject[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const d = await page(fetch, cursor ? {...first, query: {...first.query, cursor}} : first);
    if (!Array.isArray(d.data) || !(d.data as unknown[]).every(object))
      unverified('X returned no list of ' + what + '.');
    rows.push(...(d.data as JsonObject[]));
    const next = d.next_cursor;
    if (next === null || next === undefined || next === '') return {rows, complete: true};
    if (!['string', 'number'].includes(typeof next) || seen.has(String(next)) || !(d.data as unknown[]).length)
      unverified('X returned a repeated or empty page of ' + what + '.');
    seen.add(String(next));
    cursor = String(next);
  }
  return {rows, complete: false};
}
export type XCatalogOwners = {users: string[]; catalogs: {id: string; name: unknown; user_id: string}[]};
/** The account's FULL promotable users and their catalogs. */
export async function xCatalogOwners(p: CompiledRequest, fetch: Fetch): Promise<XCatalogOwners> {
  const account = p.accountId!,
    promotable = await xList(
      fetch,
      xCatalogRead(p, '/12/accounts/' + account + '/promotable_users', {count: 200}),
      5,
      'promotable users',
    );
  if (!promotable.complete) unverified('The account has more than 1,000 promotable users; AMCP reads at most 1,000.');
  const users = new Set<string>();
  for (const u of promotable.rows) {
    if (typeof u.user_id !== 'string' || !xSnowflake.test(u.user_id) || typeof u.deleted !== 'boolean')
      unverified('X returned a malformed promotable user.');
    if (!u.deleted && u.promotable_user_type === 'FULL') users.add(u.user_id);
  }
  if (users.size > usersBound)
    unverified(
      'The account has more than ' +
        usersBound +
        ' FULL promotable users; AMCP reads the catalogs of at most ' +
        usersBound +
        '.',
    );
  const catalogs: XCatalogOwners['catalogs'] = [],
    ids = new Set<string>();
  for (const user of [...users].sort()) {
    const listed = await xList(
      fetch,
      xCatalogRead(p, '/12/product_catalogs', {user_id: user}, {xCatalogUser: user}),
      5,
      'catalogs',
    );
    if (!listed.complete) unverified('X listed more catalogs for user ' + user + ' than AMCP reads.');
    for (const c of listed.rows) {
      const id = String(c.id ?? '');
      if (!xSnowflake.test(id) || ids.has(id)) unverified('X returned a malformed or repeated catalog.');
      ids.add(id);
      catalogs.push({id, name: c.name ?? null, user_id: user});
    }
  }
  return {users: [...users].sort(), catalogs: catalogs.sort((a, b) => a.id.localeCompare(b.id))};
}
/** The catalog among the owners' catalogs, or a refusal naming why it is out of scope. */
export function ownedCatalog(s: JsonObject, id: string): JsonObject {
  const c = (Array.isArray(s.catalogs) ? (s.catalogs as JsonObject[]) : []).find(x => x.id === id);
  if (!c)
    fail(
      'STATE_TARGET_MISMATCH',
      'Catalog ' + id + ' is not a catalog of a FULL promotable user of the selected ad account.',
      {product_catalog_id: id},
      409,
    );
  return c;
}
const catalogPath = (id: string, what: string) => '/12/product_catalogs/' + id + '/' + what;
/** Up to 1,000 products of the catalog; `complete` is false when it has more. */
export const xCatalogProducts = (p: CompiledRequest, fetch: Fetch, id: string) =>
  xList(fetch, xCatalogRead(p, catalogPath(id, 'products'), {count: 100}, {xCatalogId: id}), productPages, 'products');
/** Whether the catalog has any product: one read of one product. */
export async function xCatalogHasProducts(p: CompiledRequest, fetch: Fetch, id: string): Promise<boolean> {
  const d = await page(fetch, xCatalogRead(p, catalogPath(id, 'products'), {count: 1}, {xCatalogId: id}));
  if (!Array.isArray(d.data)) unverified('X returned no list of products.');
  return (d.data as unknown[]).length > 0;
}
export async function xCatalogSets(p: CompiledRequest, fetch: Fetch, id: string): Promise<JsonObject[]> {
  const r = await xList(
    fetch,
    xCatalogRead(p, catalogPath(id, 'product_sets'), {}, {xCatalogId: id}),
    5,
    'product sets',
  );
  if (!r.complete) unverified('The catalog has more product sets than AMCP reads.');
  return r.rows;
}
export async function xCatalogFeeds(p: CompiledRequest, fetch: Fetch, id: string): Promise<JsonObject[]> {
  const r = await xList(fetch, xCatalogRead(p, catalogPath(id, 'scheduled_feeds'), {}, {xCatalogId: id}), 5, 'feeds');
  if (!r.complete) unverified('The catalog has more scheduled feeds than AMCP reads.');
  return r.rows;
}
/** X's price format: "a number followed by the 3-digit ISO currency code (ISO 4217), with a space", "." as decimal point. */
export const priceFormat = /^(\d{1,12}(?:\.\d{1,6})?) ([A-Z]{3})$/;
/** Exact supported native amount; internal fixed-scale integers are never returned in JSON. */
export function catalogPrice(v: unknown): {amount: string; currency: string; units: bigint} | undefined {
  const match = typeof v === 'string' ? priceFormat.exec(v) : null;
  if (!match) return;
  const [whole, fraction = ''] = match[1]!.split('.'),
    integer = BigInt(whole!),
    tail = fraction.replace(/0+$/, '');
  return {
    amount: integer.toString() + (tail ? '.' + tail : ''),
    currency: match[2]!,
    units: integer * 1000000n + BigInt(fraction.padEnd(6, '0')),
  };
}
export function priceView(v: unknown): JsonObject | null {
  const value = catalogPrice(v);
  return value
    ? {amount: value.amount, currency: value.currency}
    : v === null || v === undefined
      ? null
      : {raw: String(v)};
}
