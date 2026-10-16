import {AsyncLocalStorage} from 'node:async_hooks';
import type {ReviewedFamily} from './reviewed-family.js';
import {sha256, stable} from './security.js';
import {assertCatalogRetirementTarget} from './catalog-retirement.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {
  authorizeXCatalogRead,
  fail,
  httpsUrl,
  object,
  ownedCatalog,
  priceView,
  catalogPrice,
  text,
  unverified,
  xCatalogGateway as gateway,
  xCatalogVerificationVersion,
  xCatalogOwners,
  xCatalogProducts,
  xCatalogProductGrouping,
  xCatalogRead,
  xCatalogRemovalEvidence,
  xCatalogReviewRemovalEvidence,
  xCatalogGroupExpansion,
  xCatalogSource as source,
  xGroupAbsenceEstablished,
  xGroupEvidence,
  xSnowflake,
  type Fetch,
} from './x-catalogs.js';

/**
 * Products of X catalogs, opened by the owner on 2026-09-29. X Ads API v12, "Catalog Management API Reference"
 * (docs.x.com, read 2026-09-29): PUT product_catalogs/:id/products adds or updates up to 25 products ("If we do not
 * recognize the id, we create a new product. If we recognize the id in your catalog, we update the corresponding
 * existing product") and answers each with CREATE_SUCCESS, UPDATE_SUCCESS, ERROR or NO_CHANGE; DELETE takes
 * product_keys and is "a permanent deletion". GET products lists 100 at a time and filters only by item group, and "only
 * the product that you submitted first will be returned" of a product group.
 *
 * AMCP writes one product per request, so each has its own review. To say whether a PUT creates or replaces, and to read
 * it back, AMCP reads up to 1,000 products; larger catalogs are changed through their scheduled feed. Products with
 * item_group_id stay outside: X lists one variant of a group, so the others could not be read back.
 */
type Kind = 'upsert' | 'delete';
type State = {kind: Kind; catalog: string; id?: string; key?: string; verify?: boolean};
type Read = CompiledRequest & {xCatalogProductState?: State};
const required = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link'],
  optional = [
    'brand',
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
  ],
  enums: Record<string, string[]> = {
    availability: ['in stock', 'available for order', 'preorder', 'out of stock', 'discontinued'],
    condition: ['new', 'used', 'refurbished'],
    gender: ['female', 'male', 'unisex'],
    age_group: ['adult', 'all ages', 'teen', 'kids', 'toddler', 'infant', 'newborn'],
  };
function invalid(message: string): never {
  return fail('INVALID_X_CATALOG_PRODUCT', message, {source});
}
export function xCatalogProductKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  if (!/^\/12\/product_catalogs\/[1-9][0-9]{0,24}\/products$/.test(p.path)) return;
  return p.method === 'PUT' ? 'upsert' : p.method === 'DELETE' ? 'delete' : undefined;
}
const catalogOf = (p: CompiledRequest) => p.path.split('/')[3]!;
const product = (p: CompiledRequest): JsonObject =>
  (object(p.body) && Array.isArray(p.body.products) && object(p.body.products[0])
    ? p.body.products[0]
    : {}) as JsonObject;
const keyOf = (p: CompiledRequest): string =>
  object(p.body) && Array.isArray(p.body.product_keys) ? String(p.body.product_keys[0]) : '';
const images = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []).map(x => x.trim()).filter(Boolean);
/** Native field validation shared with source-to-destination previews; it does not read or grant ownership. */
export function assertXCatalogProductFields(x: JsonObject): void {
  const extra = Object.keys(x).filter(k => !required.includes(k) && !optional.includes(k));
  if (extra.length)
    invalid(
      (extra.some(k => ['item_group_id', 'item_group_key'].includes(k))
        ? 'Product variants stay outside AMCP: X lists one product of a group, so the others could not be read back. '
        : extra.includes('product_key')
          ? 'product_key is the ID X generates; the product is named by id. '
          : '') +
        'Unqualified: ' +
        extra.join(', ') +
        '.',
    );
  const missing = required.filter(k => x[k] === undefined);
  if (missing.length) invalid('A product needs ' + missing.join(', ') + '.');
  if (x.brand === undefined && x.gtin === undefined && x.mpn === undefined)
    invalid('A product needs brand, gtin or mpn: X requires one when the others are not available.');
  if (!text(x.id, 100)) invalid('id is the SKU or another unique ID of 1 to 100 characters.');
  if (!text(x.title, 150)) invalid('title has 1 to 150 characters (X: "Max 150 characters").');
  if (
    typeof x.description !== 'string' ||
    !text(x.description.replace(/\r?\n/g, ' '), 5000) ||
    /<[a-z!/]/i.test(x.description)
  )
    invalid('description is plain text of 1 to 5000 characters: X "does not support HTML".');
  for (const [k, values] of Object.entries(enums))
    if (x[k] !== undefined && !values.includes(String(x[k]))) invalid(k + ' is one of: ' + values.join(', ') + '.');
  for (const k of ['price', 'sale_price'])
    if (x[k] !== undefined && !catalogPrice(x[k]))
      invalid(k + ' is an amount, a space and the ISO 4217 currency code, with "." as decimal point: "60.00 USD".');
  if (x.sale_price !== undefined) {
    const sale = catalogPrice(x.sale_price)!,
      price = catalogPrice(x.price)!;
    if (sale.currency !== price.currency || sale.units >= price.units)
      invalid('sale_price is lower than price, in the same currency.');
  }
  for (const k of ['link', 'mobile_link', 'image_link'])
    if (x[k] !== undefined && !httpsUrl(x[k])) invalid(k + ' is an HTTPS address without credentials.');
  if (x.additional_image_link !== undefined) {
    const list = images(x.additional_image_link);
    if (typeof x.additional_image_link !== 'string' || !list.length || list.length > 10 || !list.every(httpsUrl))
      invalid('additional_image_link is a comma-separated list of up to 10 HTTPS image addresses.');
  }
  if (x.inventory !== undefined && !(Number.isInteger(x.inventory) && x.inventory >= 0 && x.inventory <= 1e9))
    invalid('inventory is a whole number of items available to sell.');
  if (x.availability === 'in stock' && x.inventory !== undefined && Number(x.inventory) < 1)
    invalid('inventory is at least 1 when availability is "in stock".');
  if (x.sale_price_effective_date !== undefined) {
    const parts = typeof x.sale_price_effective_date === 'string' ? x.sale_price_effective_date.split('/') : [];
    const [from, to] = parts.map(v => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? Date.parse(v) : NaN));
    if (parts.length !== 2 || !Number.isFinite(from) || !Number.isFinite(to) || from! >= to!)
      invalid('sale_price_effective_date is an ISO 8601 start and end joined by "/", the start first.');
  }
  for (const k of [
    'brand',
    'gtin',
    'mpn',
    'google_product_category',
    'product_type',
    'color',
    'size',
    'custom_label_0',
    'custom_label_1',
    'custom_label_2',
    'custom_label_3',
    'custom_label_4',
  ])
    if (x[k] !== undefined && !text(x[k], 1000)) invalid(k + ' is text of 1 to 1000 characters.');
}
export function assertXCatalogProduct(p: CompiledRequest): void {
  const kind = xCatalogProductKind(p);
  if (!kind) return;
  if (typeof p.accountId !== 'string' || !p.accountId)
    fail('ACCOUNT_REQUIRED', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Product writes take a JSON body, without query or header overrides.');
  const b = p.body;
  if (kind === 'delete') {
    if (
      !object(b) ||
      Object.keys(b).length !== 1 ||
      !Array.isArray(b.product_keys) ||
      b.product_keys.length !== 1 ||
      typeof b.product_keys[0] !== 'string' ||
      !xSnowflake.test(b.product_keys[0])
    )
      invalid('Send {product_keys: ["<product_key>"]}: AMCP deletes one product at a time, by the key X generated.');
    return;
  }
  if (!object(b) || Object.keys(b).length !== 1 || !Array.isArray(b.products) || b.products.length !== 1)
    invalid('Send {products: [one product]}: AMCP writes one product at a time, each with its own review.');
  if (!object(b.products[0])) invalid('The product is an object of X product attributes.');
  assertXCatalogProductFields(b.products[0] as JsonObject);
}
const stateRead = (p: CompiledRequest, state: State): Read => ({
  ...(xCatalogRead(p, '/12/accounts/' + p.accountId + '/promotable_users', {count: 200}) as Read),
  xCatalogProductState: state,
});
export function xCatalogProductSnapshots(p: CompiledRequest): Read[] {
  const kind = xCatalogProductKind(p)!;
  return [
    stateRead(p, {kind, catalog: catalogOf(p), ...(kind === 'upsert' ? {id: String(product(p).id)} : {key: keyOf(p)})}),
  ];
}
export function isXCatalogProductRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xCatalogProductState;
}
export function authorizeXCatalogProduct(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== gateway) return false;
  if (xCatalogProductKind(p)) {
    assertXCatalogProduct(p);
    if (p.accountId !== account)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose promotable user owns the catalog.', {}, 403);
    return true;
  }
  return authorizeXCatalogRead(p, account);
}
/** A product as AMCP compares it: prices as amount and currency, image lists as lists. */
function productView(x: JsonObject): JsonObject {
  const out: JsonObject = {
    item_group_id: x.item_group_id ?? null,
    item_group_key: x.item_group_key ?? null,
    group_status: xCatalogProductGrouping(x),
  };
  for (const k of [...required, ...optional]) {
    const v = x[k];
    out[k] =
      k === 'price' || k === 'sale_price'
        ? priceView(v)
        : k === 'additional_image_link'
          ? v === undefined || v === null
            ? null
            : images(v)
          : k === 'inventory' && v !== undefined && v !== null
            ? Number(v)
            : (v ?? null);
  }
  return out;
}
/** The owners' catalogs and, for a catalog in scope, the one product the request names. */
export async function readXCatalogProducts(p: CompiledRequest, fetch: Fetch): Promise<TransportResult> {
  const s = (p as Read).xCatalogProductState;
  if (!s) return fetch(p);
  const owners = await xCatalogOwners(p, fetch),
    found = owners.catalogs.some(c => c.id === s.catalog);
  let match: JsonObject | undefined,
    hiddenVariants = false,
    complete = true,
    groups: JsonObject | undefined;
  if (found) {
    const scan = await xCatalogProducts(p, fetch, s.catalog),
      rows = scan.rows.filter(r => (s.key ? r.product_key === s.key : r.id === s.id));
    if (rows.length > 1) unverified('X listed the product twice.');
    match = rows[0];
    complete = scan.complete;
    hiddenVariants = scan.rows.some(row => xCatalogProductGrouping(row) !== 'individual');
    // COM-02 E: an upsert of a SKU that is not listed reads the listed groups, when that read is qualified. Its absence
    // is established only when every group was read in full; a group member is a grouped product.
    if (!match && hiddenVariants && complete && !s.key) {
      const expansion = await xCatalogGroupExpansion(p, fetch, s.catalog, scan.rows);
      match = expansion.members.get(String(s.id));
      hiddenVariants = !xGroupAbsenceEstablished(expansion);
      groups = xGroupEvidence(expansion);
    }
  }
  const view = match ? {present: true, product_key: match.product_key, ...productView(match)} : undefined;
  if (s.verify) {
    if (!view && !complete)
      unverified('The catalog has more than 1,000 products; AMCP cannot find the product among the first 1,000.');
    return {status: 200, headers: {}, data: {product: view ?? {present: false}}};
  }
  return {
    status: 200,
    headers: {},
    data: {
      users: owners.users,
      catalogs: owners.catalogs,
      ...(found
        ? {
            product: view ?? null,
            ...(view
              ? {}
              : {
                  products_complete: complete,
                  products_grouped_or_unknown: hiddenVariants,
                }),
            // The variant-group evidence of the read (COM-02 E): which records hide the SKU, or the groups read in full.
            ...(groups ? {variant_groups: groups} : {}),
          }
        : {}),
    },
  };
}
export function validateXCatalogProductState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xCatalogProductState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || (s.verify ? !object(d.product) : !Array.isArray(d.catalogs)))
    unverified('Missing verified product state.');
}
const sentView = (p: CompiledRequest): JsonObject => {
  const x = product(p),
    all = productView(x);
  return Object.fromEntries(Object.keys(x).map(k => [k, all[k]]));
};
export function xCatalogProductPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xCatalogProductKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !Array.isArray(s.catalogs)) unverified('Missing verified product state.');
  ownedCatalog(s, catalogOf(p));
  if (s.product === undefined) unverified('Missing the products of the catalog.');
  const before = object(s.product) ? s.product : undefined;
  if (!before && s.products_complete === false)
    fail(
      'CATALOG_SCAN_LIMIT',
      'AMCP reads the first 1,000 products of a catalog, and catalog ' +
        catalogOf(p) +
        ' has more; ' +
        (kind === 'delete' ? 'product key ' + keyOf(p) : 'product id ' + String(product(p).id)) +
        ' is not among them, so AMCP cannot tell what this request would ' +
        (kind === 'delete' ? 'delete.' : 'create or replace.'),
      {},
      409,
    );
  if (kind === 'delete') {
    if (!before)
      fail(
        'STATE_NOT_FOUND',
        'Product key ' + keyOf(p) + ' is not a product of catalog ' + catalogOf(p) + '.',
        {},
        404,
      );
    return;
  }
  // The refusal names the grouped records that hide the SKU and the path for variants: the catalog's scheduled feed.
  if (!before && s.products_grouped_or_unknown === true)
    fail(
      'INVALID_X_CATALOG_PRODUCT',
      'Grouped or unrecognized product records can hide the supplied SKU. AMCP cannot establish its absence for an individual-product update.',
      {
        source,
        ...(object(s.variant_groups)
          ? {
              grouped_records: s.variant_groups.grouped_records,
              grouped_record_count: s.variant_groups.grouped_record_count,
              group_expansion: s.variant_groups.expansion,
              remedy: 'scheduled_feed',
            }
          : {}),
      },
    );
  if (before && before.group_status !== 'individual')
    invalid(
      'The existing product is grouped or its group status is unknown. Individual-product updates require explicit native group evidence.',
    );
  const sent = sentView(p);
  // Exact equality of every sent attribute only. The refusal stays for a direct prepare; it also carries the read
  // evidence, so a saved plan records the step as unchanged instead of failed (COM-01). A real difference never
  // reaches here.
  if (before && Object.entries(sent).every(([k, v]) => JSON.stringify(v) === JSON.stringify(before[k])))
    fail('INVALID_X_CATALOG_PRODUCT', 'Product ' + String(product(p).id) + ' already has these values.', {
      source,
      already_current: true,
      no_op_evidence: {
        provider: 'x',
        product_catalog_id: catalogOf(p),
        product_id: String(product(p).id),
        compared_fields: Object.keys(sent).sort(),
        // A hash of the observed product, not its provider text: the review that read it keeps the values.
        observed_hash: sha256(stable(before)),
      },
    });
}
export function xCatalogProductImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xCatalogProductKind(p);
  if (!kind) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    before = object(s.product) ? s.product : null;
  if (kind === 'delete')
    return {
      provider: 'x',
      scope: 'catalog_product',
      operation: 'delete',
      product_catalog_id: catalogOf(p),
      deleting: before,
      may_affect_serving: true,
      effect:
        'Permanently deletes the product ("This is a permanent deletion"); ads stop showing it. X documents feed imports as additive, so a product still in the catalog\'s feed file may come back at its next import.',
      verification: "Reads the catalog's products again and expects this product key to be gone.",
      source,
    };
  const sent = sentView(p),
    notSent = before
      ? optional.filter(k => !(k in sent) && before[k] !== null && !(Array.isArray(before[k]) && !before[k].length))
      : [];
  return {
    provider: 'x',
    scope: 'catalog_product',
    operation: before ? 'replace' : 'create',
    product_catalog_id: catalogOf(p),
    ...(before ? {before, after: sent} : {creating: sent}),
    ...(notSent.length
      ? {
          warning:
            'Not sent, with a value today: ' +
            notSent.join(', ') +
            '. X does not say whether an update keeps or clears attributes it does not receive.',
        }
      : {}),
    // A new product can enter a filtered set that dynamic ads use.
    may_affect_serving: true,
    effect: before
      ? 'X recognizes the id and updates product ' + String(product(p).id) + ' with the values sent.'
      : 'X does not know the id and creates product ' + String(product(p).id) + ' in the catalog.',
    verification: "Reads the catalog's products again and compares every attribute sent.",
    source,
  };
}
export function xCatalogProductOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xCatalogProductKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined;
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind === 'delete') {
    const x = Array.isArray(t.delete_products) ? t.delete_products[0] : undefined;
    return object(x) && x.product_key === keyOf(p) && !x.failed_product_key;
  }
  const x = Array.isArray(t.products_response) ? t.products_response[0] : undefined;
  return (
    object(x) &&
    x.id === product(p).id &&
    ['CREATE_SUCCESS', 'UPDATE_SUCCESS', 'NO_CHANGE'].includes(String(x.status)) &&
    !(Array.isArray(x.errors) && x.errors.length)
  );
}
export function xCatalogProductVerification(
  p: CompiledRequest,
  _result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xCatalogProductKind(p)!;
  if (kind === 'delete')
    return [
      {
        read: stateRead(p, {kind, catalog: catalogOf(p), key: keyOf(p), verify: true}),
        expected: {product: {present: false}},
        id: 'product key ' + keyOf(p),
      },
    ];
  const id = String(product(p).id);
  return [
    {
      read: stateRead(p, {kind, catalog: catalogOf(p), id, verify: true}),
      expected: {product: {present: true, ...sentView(p)}},
      id: 'product ' + id,
    },
  ];
}
export function xCatalogProductObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {product: object(data.product) ? data.product : null};
}

/**
 * A selected-removal plan step's bound evidence (COM-02 C): the catalog and the observed product the step was saved
 * for. The plan runner sets it around the step's native prepare and execute, so the review's own state read is the
 * evidence check, instead of a separate pair of full catalog comparisons per phase.
 */
export type XCatalogRemovalExpectation = {catalog: JsonObject; target: JsonObject};
const removalExpectation = new AsyncLocalStorage<XCatalogRemovalExpectation>();
export function withXCatalogRemovalExpectation<T>(expected: XCatalogRemovalExpectation, fn: () => Promise<T>) {
  return removalExpectation.run(expected, fn);
}
function removalChanged(): never {
  return fail(
    'CATALOG_REMOVAL_CHANGED',
    'The selected product evidence changed after this draft. Read a new removal preview; no products were deleted.',
  );
}
/** At prepare and execute of a selected-removal step: the review state still shows the bound product, unchanged. */
export function xCatalogRemovalStateCheck(p: CompiledRequest, state: unknown[]): void {
  const expected = removalExpectation.getStore();
  if (!expected || xCatalogProductKind(p) !== 'delete') return;
  const s = state[0],
    target = expected.target,
    bound = expected.catalog;
  if (!object(s)) return removalChanged();
  if (
    !object(target) ||
    !object(bound) ||
    catalogOf(p) !== bound.id ||
    keyOf(p) !== target.product_id ||
    !object(target.before)
  )
    removalChanged();
  const catalog = (Array.isArray(s.catalogs) ? (s.catalogs as JsonObject[]) : []).find(c => c.id === bound.id),
    product = object(s.product) ? s.product : undefined;
  if (
    !catalog ||
    catalog.user_id !== bound.user_id ||
    (typeof catalog.name === 'string' && text(catalog.name, 1000) ? catalog.name : null) !== bound.name ||
    !product ||
    product.present !== true ||
    product.group_status !== 'individual' ||
    product.product_key !== target.product_id ||
    stable(xCatalogReviewRemovalEvidence(product)) !==
      stable(xCatalogRemovalEvidence(target.before as JsonObject, target.unsent_fields))
  )
    removalChanged();
}

/**
 * At prepare and execute of a catalog plan's retirement step (COM-02 B): the reviewed product is the retired one and
 * the catalog lists it, so the upsert updates it instead of creating it (src/catalog-retirement.ts).
 */
export function xCatalogRetirementCheck(p: CompiledRequest, state: unknown[]): void {
  if (xCatalogProductKind(p) !== 'upsert') return;
  const s = state[0];
  assertCatalogRetirementTarget(product(p).id, object(s) && object(s.product) && s.product.present === true);
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xCatalogProductFamily: ReviewedFamily = {
  name: 'x_catalog_products',
  verificationCacheVersion: xCatalogVerificationVersion,
  files: ['src/x-catalog-products.ts', ['tests/x-catalog-products.test.mjs']],
  kind: xCatalogProductKind,
  assert: plan => assertXCatalogProduct(plan),
  authorize: authorizeXCatalogProduct,
  snapshots: xCatalogProductSnapshots,
  isRead: isXCatalogProductRead,
  reader: readXCatalogProducts,
  validateState: validateXCatalogProductState,
  prerequisites: xCatalogProductPrerequisites,
  stateChecks: (plan, state) => {
    xCatalogRemovalStateCheck(plan, state);
    xCatalogRetirementCheck(plan, state);
  },
  impact: xCatalogProductImpact,
  outcome: xCatalogProductOutcome,
  verification: xCatalogProductVerification,
  observed: xCatalogProductObserved,
  destructive: plan => xCatalogProductKind(plan) === 'delete',
};
