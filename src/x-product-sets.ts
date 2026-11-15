import type {ReviewedFamily} from './reviewed-family.js';
import {stable} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  authorizeXCatalogRead,
  fail,
  object,
  ownedCatalog,
  priceFormat,
  priceView,
  text,
  unverified,
  xCatalogGateway as gateway,
  xCatalogOwners,
  xCatalogProducts,
  xCatalogVerificationVersion,
  xCatalogRead,
  xCatalogSets,
  xCatalogSource as source,
  xSnowflake,
  type Fetch,
} from './x-catalogs.js';
import {createsOnPost, defineFamily} from './family-kit.js';

/**
 * Product sets of X catalogs, opened by the owner on 2026-09-29. X Ads API v12, "Catalog Management" and its API
 * reference (docs.x.com, read 2026-09-29): two types, "Manual: Select up to 50 products" and "Filter: Add up to 30
 * filters". POST product_catalogs/:id/product_sets takes name, description, type (MANUAL or FILTERED), filters
 * ("attribute, operator, and value"; attributes price, product_type, google_product_category, sale_price, inventory,
 * custom_label_0 through custom_label_4; operators GREATER_THAN, EQUAL_TO, LESS_THAN, MATCH, NOT_CONTAINS, CONTAINS) and
 * product_keys ("X-generated product keys"). PUT product_sets/:id changes name, description and product_keys ("Updating
 * FILTERED product sets is not supported"); DELETE is "a permanent deletion".
 *
 * A manual set names products by key, and X lists products 100 at a time with no lookup by key, so AMCP reads up to
 * 1,000 products to find them. X's API documents no link between ads and product sets, so AMCP cannot tell whether an
 * ad uses a set; the review says so for changes and deletions.
 */
type Kind = 'create' | 'update' | 'delete';
type State = {kind: Kind; catalog: string; set?: string; keys?: string[]; verify?: boolean};
type Read = CompiledRequest & {xProductSetState?: State};
const attributes = [
    'price',
    'product_type',
    'google_product_category',
    'sale_price',
    'inventory',
    'custom_label_0',
    'custom_label_1',
    'custom_label_2',
    'custom_label_3',
    'custom_label_4',
  ],
  operators = ['GREATER_THAN', 'EQUAL_TO', 'LESS_THAN', 'MATCH', 'NOT_CONTAINS', 'CONTAINS'],
  maxFilters = 30,
  maxProducts = 50;
function invalid(message: string): never {
  return fail('INVALID_X_PRODUCT_SET', message, {source});
}
export function xProductSetKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (p.method === 'POST' && /^\/12\/product_catalogs\/[1-9][0-9]{0,24}\/product_sets$/.test(p.path)) return 'create';
  if (/^\/12\/product_catalogs\/[1-9][0-9]{0,24}\/product_sets\/[1-9][0-9]{0,24}$/.test(p.path))
    return p.method === 'PUT' ? 'update' : p.method === 'DELETE' ? 'delete' : undefined;
}
const catalogOf = (p: CompiledRequest) => p.path.split('/')[3]!,
  setOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
function keysOf(v: unknown): string[] {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > maxProducts ||
    !v.every(k => typeof k === 'string' && xSnowflake.test(k)) ||
    new Set(v).size !== v.length
  )
    invalid(
      'product_keys lists 1 to ' +
        maxProducts +
        ' different product keys, the IDs X generated for products (product_key), as strings.',
    );
  return v as string[];
}
function checkFilters(v: unknown): void {
  if (!Array.isArray(v) || !v.length || v.length > maxFilters)
    invalid('filters lists 1 to ' + maxFilters + ' filters of {attribute, operator, value}.');
  for (const f of v as unknown[]) {
    if (!object(f) || Object.keys(f).some(k => !['attribute', 'operator', 'value'].includes(k)))
      invalid('Each filter is {attribute, operator, value}.');
    if (!attributes.includes(String(f.attribute))) invalid('filter attribute is one of ' + attributes.join(', ') + '.');
    if (!operators.includes(String(f.operator))) invalid('filter operator is one of ' + operators.join(', ') + '.');
    if (!text(f.value, 1000)) invalid('filter value is text of 1 to 1000 characters.');
    if (['price', 'sale_price'].includes(String(f.attribute)) && !priceFormat.test(String(f.value)))
      invalid('A ' + String(f.attribute) + ' filter value is an amount and currency code, such as "100.00 USD".');
    if (f.attribute === 'inventory' && !/^\d{1,9}$/.test(String(f.value)))
      invalid('An inventory filter value is a whole number, such as "5".');
  }
}
export function assertXProductSet(p: CompiledRequest): void {
  const kind = xProductSetKind(p);
  if (!kind) return;
  if (typeof p.accountId !== 'string' || !p.accountId)
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Product set writes take a JSON body, without query or header overrides.');
  if (kind === 'delete') {
    if (p.body !== undefined && !(object(p.body) && !Object.keys(p.body).length))
      invalid('Deletion takes only the catalog and product set in the path.');
    return;
  }
  const b = p.body;
  if (!object(b)) invalid('Send the product set as a JSON object.');
  const fields =
    kind === 'create'
      ? ['name', 'description', 'type', b.type === 'FILTERED' ? 'filters' : 'product_keys']
      : ['name', 'description', 'product_keys'];
  const extra = Object.keys(b).filter(k => !fields.includes(k));
  if (extra.length)
    invalid(
      (kind === 'update' && extra.some(k => ['type', 'filters'].includes(k))
        ? 'X does not support updating FILTERED product sets or a set type: create a new set and delete this one. '
        : '') +
        'This request takes ' +
        fields.join(', ') +
        '; unqualified: ' +
        extra.join(', ') +
        '.',
    );
  if (kind === 'update' && !Object.keys(b).length) invalid('Name what changes: name, description or product_keys.');
  if ((kind === 'create' || b.name !== undefined) && !text(b.name, 255))
    invalid('name has 1 to 255 characters without surrounding spaces or control characters.');
  if (b.description !== undefined && !text(b.description, 1000))
    invalid('description has 1 to 1000 characters without surrounding spaces or control characters.');
  if (kind === 'create') {
    if (!['MANUAL', 'FILTERED'].includes(String(b.type))) invalid('type is MANUAL or FILTERED.');
    if (b.type === 'FILTERED') checkFilters(b.filters);
    else keysOf(b.product_keys);
  } else if (b.product_keys !== undefined) keysOf(b.product_keys);
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...(xCatalogRead(p, '/12/accounts/' + p.accountId + '/promotable_users', {count: 200}) as Read),
  xProductSetState: state,
});
export function xProductSetSnapshots(p: CompiledRequest): Read[] {
  const kind = xProductSetKind(p)!,
    keys = body(p).product_keys;
  return [
    stateRead(p, {
      kind,
      catalog: catalogOf(p),
      ...(kind === 'create' ? {} : {set: setOf(p)}),
      ...(Array.isArray(keys) ? {keys: keys.map(String)} : {}),
    }),
  ];
}
export function isXProductSetRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xProductSetState;
}
export function authorizeXProductSet(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (xProductSetKind(p)) {
    assertXProductSet(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
    return true;
  }
  return authorizeXCatalogRead(p, account);
}
const filterView = (v: unknown): JsonObject[] =>
  (Array.isArray(v) ? (v as JsonObject[]) : [])
    .map(f => ({
      attribute: f.attribute ?? null,
      operator: f.operator ?? null,
      value: ['price', 'sale_price'].includes(String(f.attribute)) ? priceView(f.value) : (f.value ?? null),
    }))
    .sort((a, b) => stable(a).localeCompare(stable(b)));
const setView = (x: JsonObject): JsonObject => ({
  id: x.id,
  name: x.name ?? null,
  description: x.description ?? null,
  type: x.type ?? null,
  filters: filterView(x.filters),
  // A filtered set's products change as the catalog does; only a manual set's list is its own.
  ...(x.type === 'MANUAL' ? {product_ids: [...x.product_ids].sort()} : {}),
});
/** Products the request names by key, reading until all are found; `complete` when X listed the whole catalog. */
async function productsByKey(p: CompiledRequest, fetch: Fetch, catalog: string, keys: string[]) {
  const scan = await xCatalogProducts(p, fetch, catalog),
    found: JsonObject = {};
  for (const row of scan.rows) {
    const key = row.product_key;
    if (keys.includes(key)) found[key] = {id: row.id ?? null, title: row.title ?? null};
  }
  return {found, complete: scan.complete};
}
/** The owners' catalogs; for a catalog in scope, its product sets and the products a manual set names. */
export async function readXProductSets(p: CompiledRequest, fetch: Fetch): Promise<TransportResult> {
  const s = (p as Read).xProductSetState;
  if (!s) return fetch(p);
  const owners = await xCatalogOwners(p, fetch),
    found = owners.catalogs.some(c => c.id === s.catalog);
  if (s.verify) {
    const x = found ? (await xCatalogSets(p, fetch, s.catalog)).find(r => r.id === s.set) : undefined;
    return {status: 200, headers: {}, data: {set: x ? {present: true, ...setView(x)} : {present: false, id: s.set}}};
  }
  const out: JsonObject = {users: owners.users, catalogs: owners.catalogs};
  if (found) {
    out.sets = (await xCatalogSets(p, fetch, s.catalog))
      .map(setView)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (s.keys?.length) {
      const r = await productsByKey(p, fetch, s.catalog, s.keys);
      out.products = r.found;
      if (Object.keys(r.found).length < s.keys.length) out.products_complete = r.complete;
    }
  }
  return {status: 200, headers: {}, data: out};
}
export function validateXProductSetState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xProductSetState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.set) : !Array.isArray(d.catalogs)))
    unverified('Missing verified product set state.');
}
function checkKeys(s: JsonObject, keys: string[], catalog: string): void {
  const found = object(s.products) ? s.products : {},
    missing = keys.filter(k => !object(found[k]));
  if (!missing.length) return;
  if (s.products_complete === false)
    fail(
      'CATALOG_SCAN_LIMIT',
      'AMCP reads the first 1,000 products of a catalog to find the keys a request names, and catalog ' +
        catalog +
        ' has more; not found among them: ' +
        missing.join(', ') +
        '.',
      {product_keys: missing},
      409,
    );
  fail(
    'STATE_TARGET_MISMATCH',
    'Not products of catalog ' + catalog + ': ' + missing.join(', ') + '.',
    {product_keys: missing},
    409,
  );
}
export function xProductSetPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xProductSetKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.catalogs)) unverified('Missing verified product set state.');
  ownedCatalog(s, catalogOf(p));
  if (!Array.isArray(s.sets)) unverified('Missing the product sets of the catalog.');
  const b = body(p),
    keys = Array.isArray(b.product_keys) ? (b.product_keys as string[]) : [];
  if (keys.length) checkKeys(s, keys, catalogOf(p));
  if (kind === 'create') return;
  const set = (s.sets as JsonObject[]).find(x => x.id === setOf(p));
  if (!set)
    fail('STATE_NOT_FOUND', 'Product set ' + setOf(p) + ' is not a set of catalog ' + catalogOf(p) + '.', {}, 404);
  if (kind === 'delete') return;
  if (set.type !== 'MANUAL')
    invalid(
      'Product set ' +
        setOf(p) +
        ' is ' +
        String(set.type) +
        ': X does not support updating FILTERED product sets. Create a new set with the new filters and delete this one.',
    );
  const ids = keys.map(k => String((s.products as JsonObject)[k]?.id)).sort();
  if (
    (b.name === undefined || b.name === set.name) &&
    (b.description === undefined || b.description === set.description) &&
    (!keys.length || stable(ids) === stable(set.product_ids))
  )
    invalid('Product set ' + setOf(p) + ' already has these values.');
}
const afterOf = (p: CompiledRequest, s: JsonObject, before: JsonObject | undefined): JsonObject => {
  const b = body(p),
    products = object(s.products) ? s.products : {},
    keys = Array.isArray(b.product_keys) ? (b.product_keys as string[]) : undefined;
  return {
    name: b.name ?? before?.name ?? null,
    description: b.description ?? before?.description ?? null,
    type: b.type ?? before?.type ?? null,
    ...((b.type ?? before?.type) === 'FILTERED'
      ? {filters: filterView(b.filters ?? before?.filters)}
      : keys
        ? {products: keys.map(k => ({product_key: k, ...(object(products[k]) ? products[k] : {})}))}
        : {product_ids: before?.product_ids ?? []}),
  };
};
export function xProductSetImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xProductSetKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    sets = (Array.isArray(s.sets) ? s.sets : []) as JsonObject[],
    before = kind === 'create' ? undefined : sets.find(x => x.id === setOf(p));
  const unknownUse =
    "X's API documents no link between ads and product sets, so AMCP cannot tell whether an ad uses this set; check X Ads Manager first.";
  return {
    provider: 'x',
    scope: 'product_set',
    operation: kind,
    product_catalog_id: catalogOf(p),
    ...(kind === 'create'
      ? {creating: afterOf(p, s, undefined)}
      : kind === 'update'
        ? {before: before ?? null, after: afterOf(p, s, before)}
        : {deleting: before ?? null}),
    ...(kind === 'create' ? {} : {warning: unknownUse}),
    may_affect_serving: kind !== 'create',
    effect:
      kind === 'create'
        ? body(p).type === 'FILTERED'
          ? "Creates a filtered set: X selects the catalog's products by these filters and keeps the set current (processing_status says when it is done)."
          : 'Creates a manual set of exactly these products.'
        : kind === 'update'
          ? 'Changes what is sent of the manual set; product_keys, when sent, become its products.'
          : 'Permanently deletes the product set ("This is a permanent deletion"). X does not say what becomes of ads that use it.',
    verification:
      kind === 'delete'
        ? "Lists the catalog's product sets again and expects this one to be gone."
        : "Lists the catalog's product sets again and compares name, description, type, filters and a manual set's products.",
    source,
  };
}
export function xProductSetOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xProductSetKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined,
    b = body(p);
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    typeof t.id !== 'string' ||
    !xSnowflake.test(t.id) ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind === 'create') return t.name === b.name && t.type === b.type && t.processing_status !== 'FAILED';
  return t.id === setOf(p) && (b.name === undefined || t.name === b.name);
}
export function xProductSetVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xProductSetKind(p)!,
    id = kind === 'create' ? result.data?.data?.id : setOf(p);
  if (typeof id !== 'string' || !xSnowflake.test(id))
    unverified(
      'The original product-set receipt has no exact generated string identity. Preserve the original receipt; no mutation is repeated.',
    );
  const s: JsonObject = object(before[0]) ? before[0] : {},
    b = body(p),
    products = object(s.products) ? s.products : {},
    prior = (Array.isArray(s.sets) ? (s.sets as JsonObject[]) : []).find(x => x.id === id);
  let expected: JsonObject;
  if (kind === 'delete') expected = {present: false};
  else {
    const type = kind === 'create' ? b.type : prior?.type;
    expected = {
      present: true,
      id,
      name: b.name ?? prior?.name,
      ...(b.description !== undefined ? {description: b.description} : {}),
      type,
      ...(type === 'FILTERED' ? {filters: filterView(b.filters)} : {}),
      ...(Array.isArray(b.product_keys)
        ? {product_ids: (b.product_keys as string[]).map(k => String((products[k] as JsonObject)?.id)).sort()}
        : {}),
    };
  }
  return [
    {
      read: stateRead(p, {kind, catalog: catalogOf(p), set: id, verify: true}),
      expected: {set: expected},
      id: 'product set ' + id,
    },
  ];
}
export function xProductSetObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {set: object(data.set) ? data.set : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xProductSetFamily: ReviewedFamily = defineFamily({
  name: 'x_product_sets',
  verificationCacheVersion: xCatalogVerificationVersion,
  files: ['src/x-product-sets.ts', ['tests/x-product-sets.test.mjs']],
  kind: xProductSetKind,
  operation: createsOnPost,
  assert: plan => assertXProductSet(plan),
  authorize: authorizeXProductSet,
  snapshots: xProductSetSnapshots,
  isRead: isXProductSetRead,
  reader: readXProductSets,
  validateState: validateXProductSetState,
  prerequisites: xProductSetPrerequisites,
  impact: xProductSetImpact,
  outcome: xProductSetOutcome,
  verification: xProductSetVerification,
  observed: xProductSetObserved,
  destructive: plan => xProductSetKind(plan) === 'delete',
});
