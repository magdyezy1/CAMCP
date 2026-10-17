import {fail} from './family-kit.js';
import {sha256, stable} from './security.js';
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
  xCatalogVerificationVersion = 'x-catalog-identities-v3',
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
export {fail};
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
      // A product group's members are read by its key (COM-02 E).
      only(...(m[2] === 'products' ? ['count', 'cursor', 'item_group_key'] : ['cursor'])) &&
      (p.query.item_group_key === undefined || text(p.query.item_group_key, 100))
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
    if (typeof first.query.count === 'number' && d.data.length > first.query.count)
      unverified('X returned more ' + what + ' than the requested page size.');
    rows.push(...(d.data as JsonObject[]));
    const next = d.next_cursor;
    if (next === null || next === undefined || next === '') return {rows, complete: true};
    if (!text(next, 2048) || seen.has(next) || !(d.data as unknown[]).length)
      unverified('X returned a repeated or empty page of ' + what + '.');
    seen.add(next);
    cursor = next;
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
      const id = c.id;
      if (
        typeof id !== 'string' ||
        !xSnowflake.test(id) ||
        ids.has(id) ||
        (c.user_id !== undefined && c.user_id !== user)
      )
        unverified('X returned a malformed, contradictory or repeated catalog.');
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
export async function xCatalogProducts(p: CompiledRequest, fetch: Fetch, id: string) {
  const result = await xList(
      fetch,
      xCatalogRead(p, catalogPath(id, 'products'), {count: 100}, {xCatalogId: id}),
      productPages,
      'products',
    ),
    skus = new Set<string>(),
    keys = new Set<string>();
  for (const row of result.rows) {
    if (
      !text(row.id, 100) ||
      typeof row.product_key !== 'string' ||
      !xSnowflake.test(row.product_key) ||
      skus.has(row.id) ||
      keys.has(row.product_key)
    )
      unverified('X returned a malformed or repeated product identity.');
    skus.add(row.id);
    keys.add(row.product_key);
  }
  return result;
}
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
  catalogChildIdentities(r.rows, id, 'product set');
  for (const row of r.rows)
    if (
      row.type === 'MANUAL' &&
      (!Array.isArray(row.product_ids) ||
        !row.product_ids.every((v: unknown) => text(v, 100)) ||
        new Set(row.product_ids).size !== row.product_ids.length)
    )
      unverified('X returned incomplete or unrecognized manual product membership.');
  return r.rows;
}
function catalogChildIdentities(rows: JsonObject[], catalog: string, what: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.id !== 'string' ||
      !xSnowflake.test(row.id) ||
      seen.has(row.id) ||
      (row.product_catalog_id !== undefined && row.product_catalog_id !== catalog)
    )
      unverified('X returned a malformed, contradictory or repeated ' + what + ' identity.');
    seen.add(row.id);
  }
}
export async function xCatalogFeeds(p: CompiledRequest, fetch: Fetch, id: string): Promise<JsonObject[]> {
  const r = await xList(fetch, xCatalogRead(p, catalogPath(id, 'scheduled_feeds'), {}, {xCatalogId: id}), 5, 'feeds');
  if (!r.complete) unverified('The catalog has more scheduled feeds than AMCP reads.');
  catalogChildIdentities(r.rows, id, 'scheduled feed');
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
/** Source field → native X attribute, for the attributes a supplied-source comparison sends and compares. */
export const xCatalogComparedFields: Record<string, string> = {
  name: 'title',
  image_url: 'image_link',
  url: 'link',
  availability: 'availability',
  condition: 'condition',
  brand: 'brand',
  description: 'description',
};
/** Optional native attributes a product can hold without the import sending them. */
export const xCatalogOptionalFields = [
  'gtin',
  'mpn',
  'mobile_link',
  'additional_image_link',
  'google_product_category',
  'product_type',
  'inventory',
  'sale_price',
  'sale_price_effective_date',
  'gender',
  'color',
  'size',
  'age_group',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
/** A listed product as a comparison shows it: supported plain values, or null for anything AMCP cannot compare. */
export function xCatalogRowView(row: JsonObject): JsonObject {
  const out: JsonObject = {present: true, id: row.product_key, retailer_id: row.id};
  for (const [source, native] of Object.entries(xCatalogComparedFields)) {
    const value = row[native],
      max = native === 'title' ? 150 : native === 'description' ? 5000 : native.endsWith('link') ? 2048 : 1000;
    if (value != null && typeof value !== 'string') unverified('X returned an unrecognized product field.');
    const plain =
      typeof value === 'string' &&
      (native === 'description' ? text(value.replace(/\r?\n/g, ' '), max) : text(value, max));
    out[source] = plain && (!native.endsWith('link') || httpsUrl(value)) ? value : null;
  }
  out.price = catalogPrice(row.price) ? row.price : null;
  out.currency = catalogPrice(row.price)?.currency ?? null;
  // The current sale as X returns it (COM-02 A): null when the product has none; an unparseable price stays as text.
  for (const k of ['sale_price', 'sale_price_effective_date']) {
    const value = row[k];
    if (value != null && typeof value !== 'string') unverified('X returned an unrecognized product field.');
    out[k] = typeof value === 'string' && text(value, 1000) ? value : null;
  }
  return out;
}
/** The optional attributes a listed product holds a value for. */
export function xCatalogHeldOptional(row: JsonObject, sent: JsonObject = {}): string[] {
  return xCatalogOptionalFields.filter(
    k =>
      !(k in sent) &&
      row[k] != null &&
      row[k] !== '' &&
      !(Array.isArray(row[k]) && !row[k].length) &&
      // A review's price view of an empty native value is {raw: ''}: still no value.
      !(object(row[k]) && row[k].raw === ''),
  );
}
/**
 * The selected-removal evidence of one product in a form both observations share (COM-02 C): the comparison's row view
 * and the native review's own product read. Prices compare by exact value, never by their formatted text.
 */
export function xCatalogRemovalEvidence(before: JsonObject, unsent: unknown): JsonObject {
  const money = catalogPrice(before.price);
  return {
    product_id: before.id ?? null,
    retailer_id: before.retailer_id ?? null,
    ...Object.fromEntries(Object.keys(xCatalogComparedFields).map(k => [k, before[k] ?? null])),
    price: money ? money.amount + ' ' + money.currency : null,
    unsent_fields: Array.isArray(unsent) ? [...unsent].map(String).sort() : null,
  };
}
/**
 * X variant groups (COM-02 E). X lists only the first product of a group ("only the product that you submitted first"),
 * so a grouped listed record can hide a supplied SKU and its absence is not established. GET products accepts
 * item_group_key, but X does not document whether that filter returns every member of a group. Per-group expansion
 * therefore runs only after an owner-authorized read has shown complete membership listing and the owner has set
 * AMCP_X_CATALOG_GROUP_EXPANSION=qualified (docs/OPERATIONS.md). Until then the block stays and names its records.
 */
export const xGroupExpansionLimits = {groups: 10, pages: 3, named: 10} as const;
export function xGroupExpansionQualified(): boolean {
  return process.env.AMCP_X_CATALOG_GROUP_EXPANSION === 'qualified';
}
export type XGroupExpansion = {
  /** not_needed: no grouped record; complete: every group read in full; otherwise absence stays unestablished. */
  state: 'not_needed' | 'not_qualified' | 'complete' | 'incomplete';
  /**
   * Why an expansion is incomplete: a grouped record without a readable group key, more groups or member pages than
   * one read takes, or a group read that does not return the listed record of its own group (the filter did not list
   * every member).
   */
  reason: null | 'group_status_unknown' | 'group_limit' | 'page_limit' | 'listed_member_missing';
  /** Every member of every expanded group, by SKU. */
  members: Map<string, JsonObject>;
  membership_hash: string | null;
  grouped_record_count: number;
  /** The listed grouped records that can hide a SKU, named for the explanation (at most ten). */
  grouped_records: JsonObject[];
};
/** Whether an expansion establishes that a SKU outside the listing and its groups is absent. */
export const xGroupAbsenceEstablished = (e: XGroupExpansion): boolean =>
  e.state === 'not_needed' || e.state === 'complete';
export async function xCatalogGroupExpansion(
  p: CompiledRequest,
  fetch: Fetch,
  id: string,
  rows: JsonObject[],
): Promise<XGroupExpansion> {
  const grouped = rows.filter(row => xCatalogProductGrouping(row) !== 'individual'),
    named = grouped.slice(0, xGroupExpansionLimits.named).map(row => ({
      retailer_id: row.id,
      product_id: row.product_key,
      group_status: xCatalogProductGrouping(row),
      item_group_id: text(row.item_group_id, 100) ? row.item_group_id : null,
      item_group_key: text(row.item_group_key, 100) ? row.item_group_key : null,
    })),
    base = {members: new Map<string, JsonObject>(), grouped_record_count: grouped.length, grouped_records: named};
  if (!grouped.length) return {...base, state: 'not_needed', reason: null, membership_hash: null, grouped_records: []};
  if (!xGroupExpansionQualified()) return {...base, state: 'not_qualified', reason: null, membership_hash: null};
  // A group can be read only by its key: an unknown group status or a group without a key stays unexpanded.
  if (grouped.some(row => xCatalogProductGrouping(row) !== 'grouped' || !text(row.item_group_key, 100)))
    return {...base, state: 'incomplete', reason: 'group_status_unknown', membership_hash: null};
  const keys = [...new Set(grouped.map(row => row.item_group_key as string))].sort();
  if (keys.length > xGroupExpansionLimits.groups)
    return {...base, state: 'incomplete', reason: 'group_limit', membership_hash: null};
  const members = new Map<string, JsonObject>(),
    productKeys = new Set<string>(),
    listedById = new Map(rows.map(row => [row.id as string, row])),
    listedByKey = new Map(rows.map(row => [row.product_key as string, row])),
    membership: [string, [string, string][]][] = [];
  for (const key of keys) {
    const group = await xList(
      fetch,
      xCatalogRead(p, catalogPath(id, 'products'), {count: 100, item_group_key: key}, {xCatalogId: id}),
      xGroupExpansionLimits.pages,
      'products',
    );
    if (!group.complete) return {...base, state: 'incomplete', reason: 'page_limit', membership_hash: null};
    // Every member has its own identity, belongs to this group and appears once across all groups; a member that is
    // also listed is that same listed record of this group, never another product.
    for (const row of group.rows) {
      const listed = listedById.get(row.id) ?? listedByKey.get(row.product_key);
      if (
        !text(row.id, 100) ||
        typeof row.product_key !== 'string' ||
        !xSnowflake.test(row.product_key) ||
        row.item_group_key !== key ||
        members.has(row.id) ||
        productKeys.has(row.product_key) ||
        (listed && (listed.id !== row.id || listed.product_key !== row.product_key || listed.item_group_key !== key))
      )
        unverified('X returned a malformed, repeated or foreign member of a product group.');
      members.set(row.id, row);
      productKeys.add(row.product_key);
    }
    // The listed record of a group is one of its members: a group read without it did not list every member.
    if (grouped.some(row => row.item_group_key === key && !productKeys.has(row.product_key)))
      return {...base, state: 'incomplete', reason: 'listed_member_missing', membership_hash: null};
    membership.push([
      key,
      group.rows.map(row => [row.product_key as string, row.id as string] as [string, string]).sort(),
    ]);
  }
  return {...base, state: 'complete', reason: null, members, membership_hash: sha256(stable(membership))};
}
/** The variant-group evidence a comparison or review shows: no members, only their count and hash. */
export function xGroupEvidence(e: XGroupExpansion): JsonObject {
  return {
    expansion: e.state,
    reason: e.reason,
    grouped_record_count: e.grouped_record_count,
    grouped_records: e.grouped_records,
    member_count: e.members.size,
    membership_hash: e.membership_hash,
    // Variants are added or changed through the catalog's scheduled feed while their absence is not established.
    remedy: xGroupAbsenceEstablished(e) ? null : 'scheduled_feed',
  };
}
/** The same evidence from a product a native review read (the family's productView, with exact price values). */
export function xCatalogReviewRemovalEvidence(product: JsonObject): JsonObject {
  const price = object(product.price) && typeof product.price.amount === 'string' ? product.price : undefined,
    row: JsonObject = {
      ...product,
      id: product.id,
      product_key: product.product_key,
      price: price ? price.amount + ' ' + price.currency : null,
    };
  return xCatalogRemovalEvidence(xCatalogRowView(row), xCatalogHeldOptional(product));
}
