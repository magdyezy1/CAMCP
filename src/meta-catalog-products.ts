import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {
  assertMetaCatalogOfBusiness,
  assertMetaCatalogScope,
  metaCatalogFields,
  metaCatalogView,
  optionalMetaRead,
} from './meta-catalogs.js';

/**
 * Products of Meta catalogs, one at a time, opened by the owner on 2026-09-29. Meta's "Product Catalog Products"
 * reference (read 2026-09-29): POST /{product_catalog_id}/products creates a ProductItem from retailer_id, name, price
 * ("Price of the item with 2 digits added for cents (ex: use "100" for 1 or "599" for 5.99)"), currency and image_url
 * (all required) and optional fields, and answers {id}. `allow_upsert` ("Default value: true. If the retailer_id of the
 * item already exists in the catalog, setting this flag to true allows the request to update the item, otherwise it
 * throws an error"). Updating and deleting the edge: "You can't perform this operation on this endpoint"; the captured
 * catalog holds no product item update or delete, so a product is changed by sending it again with allow_upsert, and
 * taken out of ads with availability or visibility.
 *
 * Because a create silently replaces an existing product by default, AMCP reads the catalog for the retailer_id first
 * and refuses to replace one unless the request says allow_upsert: true; the review then shows before and after.
 * Prices read back as formatted text, so verification asks Meta itself whether the product's price_amount (and
 * sale_price_amount) equals the reviewed value, with the documented filter fields ("The price multiplied by 100, for
 * all currencies").
 */
type State = {catalog: string; retailer: string; verify?: {id: string; price: number; sale?: number}};
type Page = {catalog: string};
type Read = CompiledRequest & {metaCatalogProductState?: State; metaCatalogProductPage?: Page};
const gateway = 'meta_native_action',
  action = 'meta_product_catalog_id_products_create',
  marker = 'AMCP_META_CATALOG_PRODUCT_READ',
  source = 'https://developers.facebook.com/docs/marketing-api/reference/product-catalog/products/';
const productFields =
  'id,retailer_id,name,description,url,image_url,price,sale_price,currency,availability,condition,brand,visibility';
const enums: Record<string, string[]> = {
  availability: [
    'in stock',
    'out of stock',
    'preorder',
    'available for order',
    'discontinued',
    'pending',
    'mark_as_sold',
    'mark_as_expired',
  ],
  condition: ['new', 'refurbished', 'used', 'used_like_new', 'used_good', 'used_fair', 'cpo', 'open_box_new'],
  age_group: ['adult', 'all ages', 'infant', 'kids', 'newborn', 'teen', 'toddler'],
  gender: ['female', 'male', 'unisex'],
  visibility: ['staging', 'published'],
};
/** Text fields and their bound: Meta's where documented (description, material, product_type, custom labels). */
const texts: Record<string, number> = {
  retailer_id: 100,
  name: 500,
  description: 5000,
  short_description: 1000,
  brand: 500,
  category: 500,
  fb_product_category: 500,
  product_type: 750,
  color: 200,
  size: 200,
  material: 200,
  pattern: 200,
  gtin: 70,
  manufacturer_part_number: 200,
  retailer_product_group_id: 100,
  custom_label_0: 100,
  custom_label_1: 100,
  custom_label_2: 100,
  custom_label_3: 100,
  custom_label_4: 100,
};
const urls = ['url', 'image_url', 'mobile_link'],
  amounts = ['price', 'sale_price'],
  dates = ['sale_price_start_date', 'sale_price_end_date'],
  required = ['retailer_id', 'name', 'price', 'currency', 'image_url'];
const allowed = [
  ...Object.keys(texts),
  ...Object.keys(enums),
  ...urls,
  ...amounts,
  ...dates,
  'additional_image_urls',
  'currency',
  'inventory',
  'allow_upsert',
];
/** What a read compares after the write: the product's text fields as Meta returns them. */
const compared = [
  'retailer_id',
  'name',
  'description',
  'url',
  'image_url',
  'currency',
  'availability',
  'condition',
  'brand',
  'visibility',
];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const https = (v: unknown): boolean => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !!u.hostname;
  } catch {
    return false;
  }
};
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_META_CATALOG_PRODUCT', message, {source, ...details});
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function metaCatalogProductKind(p: CompiledRequest): 'create' | undefined {
  if (p.gateway !== gateway || p.specialTransport || (p.origin && p.origin !== 'https://graph.facebook.com')) return;
  return p.action === action && p.method === 'POST' && metaRoute('[1-9][0-9]{0,31}/products$').test(p.path)
    ? 'create'
    : undefined;
}
const catalogOf = (p: CompiledRequest) => p.path.split('/')[2]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
/** The amount as people read it: Meta counts hundredths in every currency. */
const amount = (v: number, currency: unknown) => (v / 100).toFixed(2).replace(/\.00$/, '') + ' ' + String(currency);
export function assertMetaCatalogProduct(p: CompiledRequest): void {
  if (!metaCatalogProductKind(p)) return;
  if (!numeric(account(p.accountId))) invalid('Select one Meta ad account.');
  if (Object.keys(p.headers).length || Object.keys(p.query).length)
    invalid('Send the product in the body, without query or header overrides.');
  if (!object(p.body)) invalid('Send the product as a native object.');
  const b = p.body;
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length)
    invalid(
      'Unqualified product fields: ' +
        extra.join(', ') +
        ' (shops, checkout, app links, variants and compliance fields stay outside AMCP; one product per request).',
      {fields: extra},
    );
  const missing = required.filter(k => b[k] === undefined);
  if (missing.length) invalid('Required: ' + missing.join(', ') + '.', {fields: missing});
  for (const [k, max] of Object.entries(texts))
    if (b[k] !== undefined && !text(b[k], max))
      invalid(k + ' has 1 to ' + max + ' characters without surrounding spaces.', {field: k});
  for (const [k, values] of Object.entries(enums))
    if (b[k] !== undefined && !values.includes(b[k])) invalid(k + ' is one of: ' + values.join(', ') + '.', {field: k});
  for (const k of urls) if (b[k] !== undefined && !https(b[k])) invalid(k + ' is an HTTPS address.', {field: k});
  if (
    b.additional_image_urls !== undefined &&
    (!Array.isArray(b.additional_image_urls) ||
      b.additional_image_urls.length > 20 ||
      !b.additional_image_urls.every(https))
  )
    invalid('additional_image_urls is a list of at most 20 HTTPS addresses.');
  for (const k of amounts)
    if (b[k] !== undefined && (!Number.isSafeInteger(b[k]) || b[k] < 0))
      invalid(k + ' is a whole number of hundredths of the currency ("599" for 5.99).', {field: k});
  if (b.inventory !== undefined && (!Number.isSafeInteger(b.inventory) || b.inventory < 0))
    invalid('inventory is a whole number of at least 0.');
  if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) invalid('currency is an ISO 4217 code.');
  if (b.allow_upsert !== undefined && typeof b.allow_upsert !== 'boolean') invalid('allow_upsert is true or false.');
  for (const k of dates)
    if (b[k] !== undefined && (typeof b[k] !== 'string' || !Number.isFinite(Date.parse(b[k]))))
      invalid(k + ' is an ISO 8601 date and time.', {field: k});
  if ((b.sale_price_start_date !== undefined || b.sale_price_end_date !== undefined) && b.sale_price === undefined)
    invalid('Sale dates need a sale_price.');
  if (
    b.sale_price_start_date !== undefined &&
    b.sale_price_end_date !== undefined &&
    Date.parse(b.sale_price_end_date) <= Date.parse(b.sale_price_start_date)
  )
    invalid('sale_price_end_date is after sale_price_start_date.');
}
export function assertMetaCatalogProductScope(c: Connection, write = false): void {
  assertMetaCatalogScope(c, write, 'Catalog product changes');
}
const graph = (p: CompiledRequest, path: string, query: JsonObject, page?: Page): Read => ({
  ...p,
  metaCatalogProductState: undefined,
  metaCatalogProductPage: page,
  action: marker,
  method: 'GET',
  path: metaPrefix + path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
});
const read = (p: CompiledRequest, s: State): Read => ({
  ...graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
  metaCatalogProductState: s,
});
export function metaCatalogProductSnapshots(p: CompiledRequest): Read[] {
  return [read(p, {catalog: catalogOf(p), retailer: String(body(p).retailer_id)})];
}
export function isMetaCatalogProductRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).metaCatalogProductState;
}
const byRetailer = (retailer: string, more: JsonObject[] = []) =>
  JSON.stringify(more.length ? {and: [{retailer_id: {eq: retailer}}, ...more]} : {retailer_id: {eq: retailer}});
const exactly = (field: string, v: number) => [{[field]: {gte: v}}, {[field]: {lte: v}}];
/** Writes after validation, and the family's reads: the account, and the catalog each read is tagged with. */
export function authorizeMetaCatalogProduct(p: CompiledRequest, c: Connection, selected: string): boolean {
  if (metaCatalogProductKind(p)) {
    assertMetaCatalogProduct(p);
    assertMetaCatalogProductScope(c, true);
    if (account(p.accountId) !== selected)
      fail('ACCOUNT_SCOPE_MISMATCH', 'Select the ad account whose business owns the catalog.', {}, 403);
    return true;
  }
  const r = p as Read;
  if (
    p.gateway !== gateway ||
    p.action !== marker ||
    p.method !== 'GET' ||
    !p.readOnly ||
    p.body !== undefined ||
    account(p.accountId) !== selected ||
    !(r.metaCatalogProductPage || r.metaCatalogProductState)
  )
    return false;
  assertMetaCatalogProductScope(c);
  const keys = Object.keys(p.query).sort().join(),
    page = r.metaCatalogProductPage;
  if (p.path === metaPrefix + 'act_' + selected) return keys === 'fields' && p.query.fields === 'id,business{id}';
  if (!page || !numeric(page.catalog)) return false;
  if (p.path === metaPrefix + page.catalog) return keys === 'fields' && p.query.fields === metaCatalogFields;
  return (
    p.path === metaPrefix + page.catalog + '/products' &&
    keys === 'fields,filter,limit' &&
    [productFields, 'id'].includes(String(p.query.fields)) &&
    ['1', '2'].includes(String(p.query.limit)) &&
    typeof p.query.filter === 'string'
  );
}
const view = (x: JsonObject) => {
  const out: JsonObject = {id: x.id};
  // Inventory and Meta's review status change on their own; the review compares what a write sets.
  for (const k of [...compared, 'price', 'sale_price']) out[k] = x[k] ?? null;
  return out;
};
/** The account's business, the catalog, and the product of the catalog with this retailer_id, if any. */
export async function readMetaCatalogProducts(
  p: CompiledRequest,
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaCatalogProductState;
  if (!s) return fetch(p);
  const catalogId = s.catalog,
    page = {catalog: catalogId};
  if (!numeric(catalogId) || !text(s.retailer, 100)) unverified('The review names no exact catalog and retailer.');
  const acct = await optionalMetaRead(
    fetch,
    graph(p, 'act_' + account(p.accountId), {fields: 'id,business{id}'}),
    'ad account',
  );
  if (
    !acct ||
    typeof acct.id !== 'string' ||
    !/^(act_)?[1-9][0-9]{0,31}$/.test(acct.id) ||
    account(acct.id) !== account(p.accountId)
  )
    unverified('Meta did not return the selected ad account.');
  const businessId = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (!object(value) || !numeric(value.id)) unverified('Meta returned no exact business identity.');
    return value.id;
  };
  const business = businessId(acct.business),
    nativeCatalog = await optionalMetaRead(fetch, graph(p, catalogId, {fields: metaCatalogFields}, page), 'catalog');
  if (nativeCatalog) {
    if (!numeric(nativeCatalog.id) || nativeCatalog.id !== catalogId)
      unverified('Meta did not return the selected catalog.');
    businessId(nativeCatalog.business);
    for (const field of ['name', 'vertical'])
      if (
        nativeCatalog[field] !== undefined &&
        nativeCatalog[field] !== null &&
        typeof nativeCatalog[field] !== 'string'
      )
        unverified('Meta returned malformed catalog metadata.');
  }
  const catalog = metaCatalogView(nativeCatalog, catalogId);
  assertMetaCatalogOfBusiness({business, catalog}, catalogId);
  const products = async (filter: string, fields: string, limit: number) => {
    const r = await fetch(graph(p, catalogId + '/products', {filter, fields, limit}, page));
    if (r.status !== 200 || !object(r.data) || r.data.error || !Array.isArray(r.data.data))
      unverified('Meta did not list the products.');
    if (r.data.paging !== undefined) {
      const paging = r.data.paging;
      if (
        !object(paging) ||
        Object.keys(paging).some(k => !['next', 'previous', 'cursors'].includes(k)) ||
        (paging.next !== undefined && paging.next !== null) ||
        (paging.previous !== undefined && typeof paging.previous !== 'string') ||
        (paging.cursors !== undefined &&
          (!object(paging.cursors) ||
            Object.keys(paging.cursors).some(
              k => !['before', 'after'].includes(k) || typeof paging.cursors[k] !== 'string',
            )))
      )
        unverified('Meta returned an incomplete or unqualified product page.');
    }
    const rows = r.data.data as unknown[];
    if (rows.length > limit || rows.some(x => !object(x) || !numeric(x.id)))
      unverified('Meta returned malformed product identities or exceeded the requested product bound.');
    const products = rows as JsonObject[];
    if (fields === productFields)
      for (const product of products) {
        if (product.retailer_id !== s.retailer) unverified('Meta returned a different retailer_id.');
        for (const field of [...compared, 'price', 'sale_price'])
          if (product[field] !== undefined && product[field] !== null && typeof product[field] !== 'string')
            unverified('Meta returned malformed product fields.');
      }
    return products;
  };
  const found = await products(byRetailer(s.retailer), productFields, 2);
  if (found.length > 1) unverified('Meta listed retailer_id ' + s.retailer + ' more than once.');
  const product = found[0] ? {present: true, ...view(found[0])} : {present: false, retailer_id: s.retailer};
  if (s.verify) {
    if (!numeric(s.verify.id)) unverified('The receipt names no exact product identity.');
    const out: JsonObject = {product};
    if (found[0]) {
      if (found[0].id !== s.verify.id) unverified('Meta returned a product different from the write receipt.');
      const matches = async (field: string, value: number): Promise<boolean> => {
        const hits = await products(byRetailer(s.retailer, exactly(field, value)), 'id', 1);
        if (hits[0] && hits[0].id !== s.verify!.id) unverified('Meta returned price evidence for a different product.');
        return hits.length === 1;
      };
      out.price_matches = await matches('price_amount', s.verify.price);
      if (s.verify.sale !== undefined) out.sale_price_matches = await matches('sale_price_amount', s.verify.sale);
    }
    return {status: 200, headers: {}, data: out};
  }
  return {
    status: 200,
    headers: {},
    data: {account_id: account(p.accountId), business, catalog, product},
  };
}
export function validateMetaCatalogProductState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaCatalogProductState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || !object(d.product)) unverified('Missing verified catalog product state.');
}
export function metaCatalogProductPrerequisites(p: CompiledRequest, states: unknown[]): void {
  if (!metaCatalogProductKind(p)) return;
  const s = states[0];
  if (!object(s) || !object(s.product)) unverified('Missing verified catalog product state.');
  assertMetaCatalogOfBusiness(s, catalogOf(p));
  const b = body(p);
  if (s.product.present === true && b.allow_upsert !== true)
    fail(
      'CONFIGURATION_EXISTS',
      'The catalog already has a product with retailer_id "' +
        String(b.retailer_id) +
        '" (' +
        String(s.product.id) +
        '). Meta would replace it: to change it, send allow_upsert: true, and the review shows each change.',
      {product_id: String(s.product.id), retailer_id: String(b.retailer_id)},
    );
}
export function metaCatalogProductImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!metaCatalogProductKind(p)) return;
  const s: JsonObject = object(state[0]) ? state[0] : {},
    b = body(p),
    existing: JsonObject = object(s.product) && s.product.present === true ? s.product : {};
  const replaces = existing.present === true;
  const after: JsonObject = {...b};
  delete after.allow_upsert;
  after.price = amount(b.price, b.currency);
  if (b.sale_price !== undefined) after.sale_price = amount(b.sale_price, b.currency);
  const warnings = [
    ...(b.sale_price !== undefined && b.sale_price > b.price ? ['The sale price is above the price.'] : []),
    ...(b.availability && b.availability !== 'in stock' && !replaces
      ? ['The new product is "' + b.availability + '": ads show only what Meta considers available.']
      : []),
  ];
  return {
    provider: 'meta',
    scope: 'catalog_product',
    operation: replaces ? 'update' : 'create',
    catalog: s.catalog ?? null,
    ...(replaces ? {before: existing, after} : {creating: after}),
    ...(warnings.length ? {warnings} : {}),
    may_affect_serving: replaces,
    effect: replaces
      ? 'Replaces the catalog product with this retailer_id: ads and product sets that show it use the new values, including the price.'
      : 'Adds the product to the catalog; product sets whose filter it matches include it, and Meta reviews it before ads show it.',
    units: 'Meta counts prices in hundredths of the currency ("599" for 5.99, "49000" for ¥490).',
    verification:
      'Reads the product by retailer_id and compares its fields; Meta itself compares price_amount (and sale_price_amount) with the reviewed values.',
    source,
  };
}
export function metaCatalogProductOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && numeric(r.data.id);
}
export function metaCatalogProductVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const id = object(result.data) ? result.data.id : undefined;
  if (!numeric(id)) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no product.');
  const b = body(p),
    expected: JsonObject = {product: {present: true, id}, price_matches: true};
  for (const k of compared) if (b[k] !== undefined) (expected.product as JsonObject)[k] = b[k];
  if (b.sale_price !== undefined) expected.sale_price_matches = true;
  return [
    {
      read: read(p, {
        catalog: catalogOf(p),
        retailer: String(b.retailer_id),
        verify: {id, price: b.price, ...(b.sale_price !== undefined ? {sale: b.sale_price} : {})},
      }),
      expected,
      id: 'catalog product ' + id,
    },
  ];
}
export function metaCatalogProductObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const x = object(data.product) ? data.product : {};
  if (!x.present) return {product: {present: false}};
  const product: JsonObject = {present: true, id: x.id};
  for (const k of compared) product[k] = x[k];
  return {
    product,
    price_matches: data.price_matches,
    ...(data.sale_price_matches !== undefined ? {sale_price_matches: data.sale_price_matches} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaCatalogProductFamily: ReviewedFamily = {
  name: 'meta_catalog_products',
  files: ['src/meta-catalog-products.ts', ['tests/meta-catalog-products.test.mjs']],
  kind: metaCatalogProductKind,
  assert: assertMetaCatalogProduct,
  scope: assertMetaCatalogProductScope,
  authorize: authorizeMetaCatalogProduct,
  snapshots: metaCatalogProductSnapshots,
  isRead: isMetaCatalogProductRead,
  reader: readMetaCatalogProducts,
  validateState: validateMetaCatalogProductState,
  prerequisites: metaCatalogProductPrerequisites,
  impact: metaCatalogProductImpact,
  outcome: metaCatalogProductOutcome,
  verification: metaCatalogProductVerification,
  observed: metaCatalogProductObserved,
};
