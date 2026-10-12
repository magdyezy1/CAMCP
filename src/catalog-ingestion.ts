import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {assertXCatalogProductFields} from './x-catalog-products.js';
import {xSnowflake} from './x-catalogs.js';
import {assertMetaCatalogProductFields} from './meta-catalog-products.js';
import {
  catalogDestination,
  catalogDestinations,
  catalogSourceFields,
  type CatalogGateway,
} from './catalog-destinations.js';

/** Each catalog destination's projection of supplied products into its native reviewed steps (COM-03). */
const projections: Record<CatalogGateway, (input: JsonObject) => JsonObject> = {
  meta_native_action: metaCatalogIngestion,
  x_ads_native_action: xCatalogIngestion,
};
export function catalogIngestion(input: JsonObject) {
  const destination = catalogDestination(input.gateway);
  // An unknown gateway keeps the refusal it had before the destination contract.
  if (!destination) return bad('Choose a numeric Meta product catalog ID and selected Meta ad account.');
  return projections[destination.gateway](input) as ReturnType<typeof metaCatalogIngestion>;
}
/** Exact order of two nonnegative decimal strings, without floating point: negative, zero or positive. */
function decimalOrder(a: string, b: string): number {
  const [aw = '0', af = ''] = a.split('.'),
    [bw = '0', bf = ''] = b.split('.'),
    n = Math.max(af.length, bf.length),
    x = BigInt(aw + af.padEnd(n, '0')),
    y = BigInt(bw + bf.padEnd(n, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
/** Hundredths of a decimal amount, as Meta counts it; digits after the second decimal place must be zeros. */
function hundredths(amount: string): bigint | undefined {
  const [whole = '0', decimals = ''] = amount.split('.');
  if (/[1-9]/.test(decimals.slice(2))) return undefined;
  return BigInt(whole) * 100n + BigInt(decimals.slice(0, 2).padEnd(2, '0'));
}
/** ISO 8601 date and time with an explicit offset: a sale's start or end is kept as written, never re-zoned. */
const saleTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * The optional sale of a supplied product (COM-02 A), for every destination: a decimal sale price in the product's
 * own currency (an explicit currency suffix must be that currency), lower than the price, and an optional literal
 * start and end. X needs both times or neither. A source without a sale sends none, and the destination keeps its
 * current one (named as a value the source does not send); clearing a destination sale is not offered.
 */
function catalogSale(p: JsonObject, index: number, x: boolean): {amount: string} | undefined {
  const product = index + 1;
  if (p.sale_price === undefined) {
    if (p.sale_price_start_date !== undefined || p.sale_price_end_date !== undefined)
      bad('A sale start or end needs a sale price.', 'INVALID_CATALOG_SALE', {product});
    return undefined;
  }
  const m = typeof p.sale_price === 'string' ? /^(\d+(?:\.\d+)?)(?: ([A-Z]{3}))?$/.exec(p.sale_price) : null;
  if (!m)
    return bad(
      'Use a nonnegative decimal sale price, optionally followed by the product currency.',
      'INVALID_CATALOG_SALE',
      {field: 'sale_price', product},
    );
  if (m[2] !== undefined && m[2] !== p.currency)
    bad('The sale price must be in the product currency.', 'INVALID_CATALOG_SALE', {
      field: 'sale_price',
      product,
      sale_price: p.sale_price,
      currency: p.currency,
    });
  // A malformed price is the destination's own refusal; the order needs two decimals.
  if (typeof p.price === 'string' && /^\d+(\.\d+)?$/.test(p.price) && decimalOrder(m[1]!, p.price) >= 0)
    bad('The sale price must be lower than the price.', 'INVALID_CATALOG_SALE', {
      field: 'sale_price',
      product,
      sale_price: m[1]!,
      price: p.price,
    });
  for (const field of ['sale_price_start_date', 'sale_price_end_date'])
    if (
      p[field] !== undefined &&
      (typeof p[field] !== 'string' || !saleTime.test(p[field]) || !Number.isFinite(Date.parse(p[field])))
    )
      bad(
        'A sale start or end is an ISO 8601 date and time with an explicit offset, such as 2026-11-01T00:00:00+03:00.',
        'INVALID_CATALOG_SALE',
        {field, product},
      );
  if (
    p.sale_price_start_date !== undefined &&
    p.sale_price_end_date !== undefined &&
    Date.parse(p.sale_price_end_date) <= Date.parse(p.sale_price_start_date)
  )
    bad('The sale must end after it starts.', 'INVALID_CATALOG_SALE', {product});
  if (x && (p.sale_price_start_date === undefined) !== (p.sale_price_end_date === undefined))
    bad('X needs both the sale start and the sale end, or neither.', 'INVALID_CATALOG_SALE', {product});
  return {amount: m[1]!};
}
/**
 * A non-destructive retirement of supplied products (COM-02 B): their availability becomes "out of stock" or
 * "discontinued" through the same reviewed upsert, so ads stop showing them while the product, its history and its sets
 * stay. Nothing is deleted, and a comparison blocks retiring a product the catalog does not have (it would be created).
 */
export function catalogRetirement(input: JsonObject): {ids: Set<string>; availability: string} | undefined {
  if (input.retire_retailer_ids === undefined && input.retire_availability === undefined) return undefined;
  const ids = input.retire_retailer_ids;
  if (!['out of stock', 'discontinued'].includes(input.retire_availability))
    bad('Retire products as "out of stock" or "discontinued".', 'INVALID_CATALOG_RETIREMENT');
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 50 ||
    ids.some((v: unknown) => typeof v !== 'string') ||
    new Set(ids).size !== ids.length ||
    !Array.isArray(input.products) ||
    ids.some((v: string) => !input.products.some((p: JsonObject) => p?.retailer_id === v))
  )
    bad('Choose 1–50 distinct retailer IDs of the supplied products to retire.', 'INVALID_CATALOG_RETIREMENT');
  if (input.allow_upsert !== true)
    bad(
      'Retiring updates existing products: explicitly allow updates to existing retailer IDs.',
      'INVALID_CATALOG_RETIREMENT',
    );
  return {ids: new Set(ids), availability: input.retire_availability};
}
/** A retired product's projection source: the supplied row with the retirement availability. */
export function retired(p: JsonObject, retire: ReturnType<typeof catalogRetirement>): JsonObject {
  return retire?.ids.has(p.retailer_id) ? {...p, availability: retire.availability} : p;
}
/** Supplied products → one Meta product create per item; Meta counts prices in hundredths. */
export function metaCatalogIngestion(input: JsonObject) {
  const fields = catalogSourceFields(catalogDestinations.meta_native_action),
    retire = catalogRetirement(input);
  if (input.gateway !== 'meta_native_action' || !/^\d+$/.test(input.catalog_id ?? ''))
    bad('Choose a numeric Meta product catalog ID and selected Meta ad account.');
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 50)
    bad('Import 1–50 products per reviewed plan.', 'CATALOG_IMPORT_LIMIT');
  if (typeof input.allow_upsert !== 'boolean') bad('Explicitly choose whether existing retailer IDs may be updated.');
  const seen = new Set<string>();
  const products = input.products.map((p: JsonObject, i: number) => {
    validate(p, fields, 16384, 'product field');
    if (Object.values(p).some(v => typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v)))
      bad('Product fields must be plain text without control characters.');
    for (const key of ['retailer_id', 'name', 'price', 'currency', 'image_url'])
      if (typeof p[key] !== 'string' || !p[key].trim()) bad('Product ' + (i + 1) + ' requires ' + key + '.');
    if (p.retailer_id.length > 100 || p.name.length > 500 || seen.has(p.retailer_id))
      bad('Product retailer IDs must be unique and at most 100 characters; names at most 500.');
    seen.add(p.retailer_id);
    if (!/^\d+(\.\d+)?$/.test(p.price) || !/^[A-Z]{3}$/.test(p.currency))
      bad('Use an explicit currency and a nonnegative decimal price.');
    // Meta counts hundredths (COM-01): the precision applies to the value, not the source text. Digits after the second
    // decimal place must be zeros, so "12.500 KWD" is exactly 1250 while "12.345 KWD" cannot be represented and is
    // refused. Nothing is rounded. The refusal names the exact price and currency after its fixed sentence.
    const [whole, decimals = ''] = p.price.split('.');
    if (/[1-9]/.test(decimals.slice(2)))
      bad(
        'Meta counts prices in hundredths of the currency, so digits after the second decimal place must be zeros; nothing is rounded. This price cannot be represented exactly.',
        'INVALID_ARGUMENT',
        // The suffix after the fixed sentence (message_parts) names the exact value for the website; MCP clients also
        // read it structured. field carries that value because the message suffix is built from it.
        {field: p.price + ' ' + p.currency, price: p.price, currency: p.currency, product: i + 1},
      );
    const fraction = decimals.slice(0, 2),
      cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) bad('Product price exceeds the safe native integer range.');
    for (const key of ['image_url', 'url'])
      if (p[key]) {
        let u: URL;
        try {
          u = new URL(p[key]);
        } catch {
          return bad('Product ' + key + ' must be an HTTPS URL.');
        }
        if (u.protocol !== 'https:' || u.username || u.password)
          bad('Product URLs must use HTTPS without embedded credentials.');
      }
    if (
      p.availability &&
      !['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued'].includes(p.availability)
    )
      bad('Use a supported product availability.');
    const q = retired(p, retire);
    if (p.condition && !['new', 'used', 'refurbished'].includes(p.condition))
      bad('Use new, used or refurbished condition.');
    // An optional sale in the same hundredths (COM-02 A); its dates stay literal.
    const sale = catalogSale(p, i, false),
      saleCents = sale ? hundredths(sale.amount) : undefined;
    if (sale && saleCents === undefined)
      bad(
        'Meta counts prices in hundredths of the currency, so digits after the second decimal place must be zeros; nothing is rounded. This price cannot be represented exactly.',
        'INVALID_ARGUMENT',
        {field: sale.amount + ' ' + p.currency, price: sale.amount, currency: p.currency, product: i + 1},
      );
    const payload = {
      ...q,
      price: Number(cents),
      ...(saleCents !== undefined ? {sale_price: Number(saleCents)} : {}),
      allow_upsert: input.allow_upsert,
    };
    assertMetaCatalogProductFields(payload);
    return payload;
  });
  const source_hash = fingerprint(input.products),
    steps = products.map((payload: JsonObject, i: number) => ({
      id: 'product-' + (i + 1),
      kind: 'write',
      gateway: 'meta_native_action',
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {
        action: 'meta_product_catalog_id_products_create',
        params: {product_catalog_id: input.catalog_id},
        payload,
      },
      depends_on: [],
      description: 'Catalog retailer ID ' + payload.retailer_id,
    }));
  return {
    source_hash,
    item_count: products.length,
    items: products.map((p: JsonObject) => ({
      retailer_id: p.retailer_id,
      name: p.name,
      ...(p.retailer_product_group_id !== undefined ? {retailer_product_group_id: p.retailer_product_group_id} : {}),
      price_minor_units: p.price,
      ...(p.sale_price !== undefined ? {sale_price_minor_units: p.sale_price} : {}),
      ...(retire?.ids.has(p.retailer_id) ? {retire_availability: retire.availability} : {}),
      currency: p.currency,
      existing_item_policy: input.allow_upsert
        ? 'explicit upsert after native review'
        : 'create only; existing IDs refused',
    })),
    plan: {
      action: 'create',
      name: input.name ?? 'Catalog import ' + input.catalog_id,
      brief:
        'Import ' +
        products.length +
        ' products into Meta catalog ' +
        input.catalog_id +
        '. Source hash ' +
        source_hash +
        '. Each item requires native before-state review and independent read-back. Missing source items are not deleted.' +
        (retire
          ? ' Retires ' + retire.ids.size + ' existing products as "' + retire.availability + '"; nothing is deleted.'
          : ''),
      steps,
    },
    network_requests: 0,
    destructive_deletions: 0,
    meaning:
      'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.',
  };
}

/** A bounded local projection into the existing single-product X reviewed contract. No inferred source values. */
export function xCatalogIngestion(input: JsonObject) {
  const fields = catalogSourceFields(catalogDestinations.x_ads_native_action),
    retire = catalogRetirement(input);
  if (typeof input.catalog_id !== 'string' || !xSnowflake.test(input.catalog_id))
    bad('Choose an exact X product catalog ID and selected X ad account.', 'INVALID_X_CATALOG_IMPORT');
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 50)
    bad('Import 1–50 products per reviewed plan.', 'CATALOG_IMPORT_LIMIT');
  if (input.allow_upsert !== true)
    bad(
      'X imports require explicit upsert approval: X updates matching product IDs. Create-only imports are not qualified.',
      'INVALID_X_CATALOG_IMPORT',
    );
  const seen = new Set<string>();
  const native = input.products.map((p: JsonObject, i: number) => {
    validate(p, fields, 16384, 'product field');
    for (const key of catalogDestinations.x_ads_native_action.sourceFields.required)
      if (typeof p[key] !== 'string' || !p[key].trim())
        bad(
          'X imports require explicit retailer_id, name, price, currency, image_url, url, availability, condition, brand and plain text description.',
          'INVALID_X_CATALOG_IMPORT',
        );
    if (seen.has(p.retailer_id)) bad('Product retailer IDs must be unique.', 'INVALID_X_CATALOG_IMPORT');
    seen.add(p.retailer_id);
    if (!/^[A-Z]{3}$/.test(p.currency))
      bad('Choose one explicit uppercase three-letter product currency.', 'INVALID_X_CATALOG_IMPORT');
    // An optional sale (COM-02 A): X's "amount CUR" and one "start/end" effective period.
    const sale = catalogSale(p, i, true);
    const product: JsonObject = {
      id: p.retailer_id,
      title: p.name,
      price: p.price + ' ' + p.currency,
      image_link: p.image_url,
      link: p.url,
      availability: p.availability,
      condition: p.condition,
      brand: p.brand,
      description: p.description,
      ...(retire?.ids.has(p.retailer_id) ? {availability: retire.availability} : {}),
      ...(sale ? {sale_price: sale.amount + ' ' + p.currency} : {}),
      ...(p.sale_price_start_date !== undefined
        ? {sale_price_effective_date: p.sale_price_start_date + '/' + p.sale_price_end_date}
        : {}),
    };
    assertXCatalogProductFields(product);
    return product;
  });
  const source_hash = fingerprint(input.products),
    steps = native.map((product: JsonObject, i: number) => ({
      id: 'product-' + (i + 1),
      kind: 'write',
      gateway: 'x_ads_native_action',
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {
        action: 'x_product_catalogs_product_catalog_id_products_put',
        params: {product_catalog_id: input.catalog_id},
        payload: {products: [product]} as JsonObject,
      },
      depends_on: [],
      description: 'X catalog retailer ID ' + product.id,
    }));
  return {
    source_hash,
    item_count: native.length,
    items: native.map((p: JsonObject, i: number) => ({
      retailer_id: p.id,
      name: p.title,
      native_price: p.price,
      ...(p.sale_price !== undefined ? {native_sale_price: p.sale_price} : {}),
      ...(p.sale_price_effective_date !== undefined ? {sale_price_effective_date: p.sale_price_effective_date} : {}),
      ...(retire?.ids.has(p.id) ? {retire_availability: retire.availability} : {}),
      currency: input.products[i]!.currency,
      existing_item_policy: 'explicit upsert after native review',
    })),
    plan: {
      action: 'create',
      name: input.name ?? 'X catalog import ' + input.catalog_id,
      brief:
        'Import ' +
        native.length +
        ' products into X catalog ' +
        input.catalog_id +
        '. Source hash ' +
        source_hash +
        '. Each item requires native before-state review and independent read-back. Matching IDs are updated; missing source items are not deleted.' +
        (retire
          ? ' Retires ' + retire.ids.size + ' existing products as "' + retire.availability + '"; nothing is deleted.'
          : ''),
      steps,
    },
    network_requests: 0,
    destructive_deletions: 0,
    destination_limitations: [
      'X catalog endpoints require early-access entitlement; a local preview does not establish account eligibility.',
      'X updates matching product IDs. Ownership and existing values are checked during each native review.',
      'Product variants, live store synchronization and deletion of missing source items are outside this import.',
    ],
    meaning:
      'Preview uses supplied product data and the existing X product contract. Each product keeps a separate native review, accepted receipt and independent read-back. Matching IDs are updated; missing source items are retained.',
  };
}
