import {MirrorError} from './errors.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {ScopeGuard} from './scope.js';
import {stable} from './security.js';
import {bad, fingerprint} from './workspace-core.js';
import {snapchatCatalogIngestion} from './catalog-ingestion.js';
import {
  catalogDestinations,
  catalogItemSchemaVersion,
  comparisonItemV2,
  comparisonSummary,
} from './catalog-destinations.js';
import {
  snapCompareGateway as gateway,
  snapComparePageLimit as pageLimit,
  snapCompareRead as read,
  snapId,
  snapObject as object,
  snapProductId as productId,
  snapSearchBody as searchBody,
  snapText as text,
} from './snapchat-catalog-reads.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport, TransportResult} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {fail} from './family-kit.js';

/**
 * Read-only Snapchat catalog item comparison (COM-02 D). Snapchat changes catalog products only through product feeds
 * (Snapchat "Dynamic Product Ads" reference: products are read with POST /v1/catalogs/{catalog_id}/products/search, which
 * filters on ID with IS_ANY, takes a limit of 50–1000 and pages with paging.next_link; there is no per-product write).
 * So a comparison names what to fix in the feed and saves no draft.
 *
 * Reads, each authorized only from the read before it: the selected ad account (its organization), the catalog (it must
 * belong to that organization), then the supplied product IDs in one IS_ANY search, twice, and the catalog again. Both
 * scans must agree; a repeated, empty-but-continued, foreign, duplicated or over-long page is refused, and nothing
 * partial becomes a comparison. Prices stay exact decimal strings. The search body follows the product-set filter
 * grammar ({ID: {IS_ANY: [...]}}); its live acceptance is a native qualification read (see docs/OPERATIONS.md).
 */
const maxPages = 3,
  source = 'https://developers.snap.com/api/marketing-api/Ads-API/dynamic-product-ads';
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {source}, 502);
}
const httpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
};
type Fetch = (p: CompiledRequest) => Promise<TransportResult>;
function succeeded(r: TransportResult, key: string, message: string): JsonObject {
  const d = r.data;
  if (
    r.status !== 200 ||
    !object(d) ||
    String(d.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray((d as JsonObject)[key])
  )
    unverified(message);
  return d as JsonObject;
}
/** The selected ad account's organization. */
async function organization(account: string, fetch: Fetch): Promise<string> {
  const message = 'Snapchat did not return the selected ad account with its organization.',
    d = succeeded(await fetch(read(account, '/v1/adaccounts/' + account)), 'adaccounts', message),
    row = d.adaccounts.length === 1 && object(d.adaccounts[0]) ? d.adaccounts[0].adaccount : undefined;
  if (!object(row) || row.id !== account || !snapId(row.organization_id)) unverified(message);
  return String(row.organization_id);
}
/** The catalog, which must belong to the account's organization. */
async function ownedSnapCatalog(account: string, org: string, id: string, fetch: Fetch): Promise<JsonObject> {
  let r: TransportResult;
  try {
    r = await fetch(read(account, '/v1/catalogs/' + id, {snapCompareOrg: org, snapCompareCatalog: id}));
  } catch (e) {
    if (e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND'))
      r = {status: 404, headers: {}, data: {}};
    else throw e;
  }
  const d = r.status === 404 ? undefined : succeeded(r, 'catalogs', 'Snapchat did not return the selected catalog.'),
    row = d && d.catalogs.length === 1 && object(d.catalogs[0]) ? d.catalogs[0].catalog : undefined;
  if (!object(row) || row.id !== id || row.organization_id !== org)
    fail(
      'STATE_TARGET_MISMATCH',
      "This catalog does not belong to the selected Snapchat ad account's organization.",
      {field: id, product_catalog_id: id},
      409,
    );
  return {id, organization_id: org, name: text(row.name, 375) ? row.name : null};
}
/** Every product the search returns for the supplied IDs: complete, unrepeated and only the IDs asked for. */
async function searchProducts(account: string, org: string, catalog: string, ids: string[], fetch: Fetch) {
  const asked = new Set(ids),
    rows = new Map<string, JsonObject>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages)
      fail(
        'CATALOG_SCAN_LIMIT',
        'Snapchat returned more pages of products than one comparison reads. No product changes were submitted.',
        {},
        409,
      );
    const d = succeeded(
      await fetch(
        read(account, '/v1/catalogs/' + catalog + '/products/search', {
          method: 'POST',
          query: {limit: pageLimit, ...(cursor ? {cursor} : {})},
          body: searchBody(ids),
          snapCompareOrg: org,
          snapCompareCatalog: catalog,
        }),
      ),
      'products',
      'Snapchat did not return the products AMCP searched for.',
    );
    if (d.products.length > pageLimit) unverified('Snapchat returned more products than the requested page size.');
    for (const x of d.products as unknown[]) {
      if (
        !object(x) ||
        (x.sub_request_status !== undefined && String(x.sub_request_status).toUpperCase() !== 'SUCCESS') ||
        !object(x.product)
      )
        unverified('Snapchat returned a malformed product row.');
      const product = (x as JsonObject).product as JsonObject;
      if (!productId(product.id) || !asked.has(product.id) || rows.has(product.id))
        unverified('Snapchat returned a product that was not asked for, or the same product twice.');
      rows.set(product.id, product);
    }
    const link = object(d.paging) ? d.paging.next_link : undefined;
    if (link === undefined || link === null || link === '') return rows;
    let next: string | null = null;
    try {
      next = new URL(String(link)).searchParams.get('cursor');
    } catch {
      next = null;
    }
    if (!next || cursors.has(next) || !d.products.length)
      unverified('Snapchat returned a repeated or empty page of products.');
    cursors.add(next!);
    cursor = next!;
  }
}
/** An exact Snapchat price {value, currency} as "amount CUR", or undefined when it is not one AMCP can compare. */
export function snapPrice(v: unknown): string | undefined {
  if (!object(v) || !/^[A-Z]{3}$/.test(String(v.currency))) return undefined;
  const value = v.value;
  // A JSON number is kept only when its shortest decimal form is exact (at most 15 significant digits, no exponent).
  const amount =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? String(value)
        : undefined;
  if (amount === undefined || !/^\d{1,12}(\.\d{1,6})?$/.test(amount)) return undefined;
  if (typeof value === 'number' && amount.replace(/^0+|\./g, '').length > 15) return undefined;
  return amount + ' ' + v.currency;
}
/** Exact equality of two "amount CUR" prices: trailing fractional zeros do not change a value. */
function samePrice(a: string, b: string): boolean {
  const canonical = (s: string) => {
    const [amount = '', currency] = s.split(' '),
      [whole = '0', fraction = ''] = amount.split('.');
    return BigInt(whole).toString() + '.' + fraction.replace(/0+$/, '') + ' ' + currency;
  };
  return canonical(a) === canonical(b);
}
const availability: Record<string, string> = {
    IN_STOCK: 'in stock',
    OUT_OF_STOCK: 'out of stock',
    PREORDER: 'preorder',
    AVAILABLE_FOR_ORDER: 'available for order',
    DISCONTINUED: 'discontinued',
  },
  condition: Record<string, string> = {NEW: 'new', USED: 'used', REFURBISHED: 'refurbished'};
const enumView = (v: unknown, values: Record<string, string>) => {
  const key = typeof v === 'string' ? v.trim().toUpperCase().replace(/ /g, '_') : '';
  return Object.hasOwn(values, key) ? values[key]! : null;
};
/** Optional Snapchat product attributes a product can hold without the comparison's source sending them. */
export const snapUnsentFields = [
  'sale_price',
  'item_group_id',
  'google_product_category',
  'product_type',
  'additional_image_link',
  'mobile_link',
  'color',
  'size',
  'gender',
  'age_group',
  'material',
  'pattern',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
/** A listed Snapchat product as the comparison shows it: supported plain values, or null for anything else. */
function rowView(row: JsonObject): JsonObject {
  const price = snapPrice(row.price),
    sale = row.sale_price === undefined || row.sale_price === null ? null : snapPrice(row.sale_price);
  return {
    present: true,
    id: row.id,
    retailer_id: row.id,
    name: text(row.title, 500) ? row.title : null,
    image_url: httpsUrl(row.image_link) ? row.image_link : null,
    url: httpsUrl(row.link) ? row.link : null,
    availability: enumView(row.availability, availability),
    condition: enumView(row.condition, condition),
    brand: text(row.brand, 1000) ? row.brand : null,
    description: text(typeof row.description === 'string' ? row.description.replace(/\r?\n/g, ' ') : null, 5000)
      ? row.description
      : null,
    price: price ?? null,
    currency: price ? price.slice(-3) : null,
    // A sale the product holds: its exact price, or its raw value when AMCP cannot compare it.
    sale_price:
      sale ?? (row.sale_price === undefined || row.sale_price === null ? null : {raw: stable(row.sale_price)}),
    item_group_id: text(row.item_group_id, 255) ? row.item_group_id : null,
  };
}
const compared = ['name', 'image_url', 'url', 'availability', 'condition', 'brand', 'description'];
/** One supplied product against its current Snapchat product, if any. */
function compareItem(supplied: JsonObject, row: JsonObject | undefined): JsonObject {
  if (!row)
    return {
      retailer_id: supplied.retailer_id,
      product_id: null,
      before: {present: false, price: null},
      state: 'new',
      price_matches: null,
      ...(supplied.sale_price !== undefined ? {sale_price_matches: null} : {}),
      changes: [],
      unknown_fields: [],
      unsent_fields: [],
      blocked: false,
      blocked_reason: null,
      fix_in: 'feed',
    };
  const before = rowView(row),
    changes: JsonObject[] = [],
    unknown: string[] = [];
  for (const field of compared.filter(k => supplied[k] !== undefined)) {
    if (before[field] === null) unknown.push(field);
    else if (before[field] !== supplied[field]) changes.push({field, before: before[field], after: supplied[field]});
  }
  const proposed = supplied.price + ' ' + supplied.currency;
  let price_matches: boolean | null = null;
  if (before.price === null) unknown.push('price', 'currency');
  else {
    price_matches = samePrice(before.price, proposed);
    if (!price_matches) changes.push({field: 'price', before: before.price, after_native_price: proposed});
  }
  let sale_price_matches: boolean | null = null;
  if (supplied.sale_price !== undefined) {
    const sale = supplied.sale_price + ' ' + supplied.currency;
    if (object(before.sale_price)) unknown.push('sale_price');
    else {
      sale_price_matches = before.sale_price !== null && samePrice(before.sale_price, sale);
      if (!sale_price_matches) changes.push({field: 'sale_price', before: before.sale_price, after_native_price: sale});
    }
  }
  const unsent = snapUnsentFields.filter(
    k =>
      supplied[k] === undefined &&
      row[k] !== undefined &&
      row[k] !== null &&
      row[k] !== '' &&
      !(Array.isArray(row[k]) && !row[k].length),
  );
  return {
    retailer_id: supplied.retailer_id,
    product_id: row.id,
    before,
    state: changes.length ? 'changed' : unknown.length ? 'unknown' : 'matching',
    price_matches,
    ...(supplied.sale_price !== undefined ? {sale_price_matches} : {}),
    changes,
    unknown_fields: unknown,
    unsent_fields: unsent,
    blocked: false,
    blocked_reason: null,
    fix_in: changes.length || unknown.length ? 'feed' : null,
  };
}
/**
 * catalog_compare for a Snapchat catalog: current evidence of the supplied product IDs, two agreeing scans bracketed by
 * catalog ownership, under the selected account and login. Read-only; Snapchat products change only through feeds.
 */
export async function snapchatCatalogComparison(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  const preview = snapchatCatalogIngestion(input),
    account = input.account_id;
  if (!snapId(account)) bad('Choose an exact Snapchat product catalog ID and selected Snapchat ad account.');
  const products = preview.products as JsonObject[],
    ids = products.map(p => p.retailer_id as string),
    first = read(account, '/v1/adaccounts/' + account),
    connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  new ScopeGuard(registry, store).authorize(first, connection);
  const auth = await credentials.get(connection),
    current = store.resolveConnection(actor, gateway, account, connection.id),
    scope = {gateway, account_id: account, connection_id: connection.id, catalog_id: input.catalog_id},
    budget = new ReportCollectionBudget(undefined, fingerprint({scope, source_hash: preview.source_hash}), () => {}, {
      requests: 30,
      rows: 3 * maxPages * pageLimit,
      bytes: 4 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    requested_at = Date.now();
  let network_requests = 0;
  try {
    return await budget.run(async () => {
      const fetch: Fetch = async page => {
        const access = nativeAuthority(store, registry, actor, page, current, auth);
        const response = await transport.request(page, access(), auth, undefined, {
          beforeAttempt: () => {
            access();
            network_requests++;
          },
        });
        access();
        budget.rows(
          'request-' + network_requests,
          object(response.data) && Array.isArray(response.data.products) ? response.data.products.length : 0,
        );
        return response;
      };
      const org = await organization(account, fetch),
        catalog = await ownedSnapCatalog(account, org, input.catalog_id, fetch);
      const collect = async () => {
        const rows = await searchProducts(account, org, input.catalog_id, ids, fetch);
        return products.map(p => compareItem(p, rows.get(p.retailer_id)));
      };
      const collected = await collect(),
        repeated = await collect(),
        after = await ownedSnapCatalog(account, await organization(account, fetch), input.catalog_id, fetch);
      if (fingerprint(collected) !== fingerprint(repeated) || fingerprint(catalog) !== fingerprint(after))
        fail(
          'CATALOG_COMPARISON_CHANGED',
          'Snapchat catalog ownership or supplied-product evidence changed during comparison. Read the source products again; no product changes were submitted.',
          {},
          409,
        );
      nativeAuthority(store, registry, actor, first, current, auth)();
      budget.check();
      const items = collected.map((item, i) =>
          comparisonItemV2(item, products[i]!, catalogDestinations.snapchat_native_action),
        ),
        {summary, review_retailer_ids} = comparisonSummary(items),
        captured_at = Date.now();
      return {
        record_kind: 'catalog_comparison',
        item_schema_version: catalogItemSchemaVersion,
        scope,
        complete: true,
        catalog,
        source_hash: preview.source_hash,
        comparison_hash: fingerprint({scope, source_hash: preview.source_hash, items, requested_at, captured_at}),
        requested_at,
        captured_at,
        item_count: items.length,
        summary,
        items,
        // Products whose feed rows need a fix: no draft can be saved for Snapchat.
        review_retailer_ids,
        writes: 'feed_only',
        remedy: 'fix_in_feed',
        network_requests,
        provider_mutations: 0,
        destructive_deletions: 0,
        meaning:
          'Current evidence for the supplied Snapchat product IDs only, from two agreeing bounded reads with exact decimal prices. Snapchat changes products only through product feeds, so nothing is saved: fix the differences in the feed. Feed processing can take time; this is current evidence, not a point-in-time inventory snapshot. Products outside the supplied source are not read or deleted.',
      };
    });
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      throw new MirrorError(
        'CATALOG_COMPARISON_LIMIT',
        'Catalog comparison reached its collection limit. Compare fewer source products and read them again; no product changes were submitted.',
        {dimension: error.details.dimension, used: error.details.used, limit: error.details.limit},
        422,
      );
    throw error;
  } finally {
    budget.close();
  }
}
