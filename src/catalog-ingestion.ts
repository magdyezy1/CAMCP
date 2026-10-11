import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {assertXCatalogProductFields} from './x-catalog-products.js';
import {xSnowflake} from './x-catalogs.js';
import {assertMetaCatalogProductFields} from './meta-catalog-products.js';
const fields = [
  'retailer_id',
  'name',
  'price',
  'currency',
  'image_url',
  'url',
  'availability',
  'condition',
  'brand',
  'description',
];
export function catalogIngestion(input: JsonObject) {
  if (input.gateway === 'x_ads_native_action') return xCatalogIngestion(input);
  if (input.gateway !== 'meta_native_action' || !/^\d+$/.test(input.catalog_id ?? ''))
    bad('Choose a numeric Meta product catalog ID and selected Meta ad account.');
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 50)
    bad('Import 1–50 products per reviewed plan.', 'CATALOG_IMPORT_LIMIT');
  if (typeof input.allow_upsert !== 'boolean') bad('Explicitly choose whether existing retailer IDs may be updated.');
  const seen = new Set<string>();
  const products = input.products.map((p: JsonObject, i: number) => {
    validate(p, [...fields, 'retailer_product_group_id'], 16384, 'product field');
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
        {field: p.price + ' ' + p.currency, product: i + 1},
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
    if (p.condition && !['new', 'used', 'refurbished'].includes(p.condition))
      bad('Use new, used or refurbished condition.');
    const payload = {...p, price: Number(cents), allow_upsert: input.allow_upsert};
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
        '. Each item requires native before-state review and independent read-back. Missing source items are not deleted.',
      steps,
    },
    network_requests: 0,
    destructive_deletions: 0,
    meaning:
      'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.',
  };
}

/** A bounded local projection into the existing single-product X reviewed contract. No inferred source values. */
function xCatalogIngestion(input: JsonObject) {
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
  const native = input.products.map((p: JsonObject) => {
    validate(p, fields, 16384, 'product field');
    for (const key of fields)
      if (typeof p[key] !== 'string' || !p[key].trim())
        bad(
          'X imports require explicit retailer_id, name, price, currency, image_url, url, availability, condition, brand and plain text description.',
          'INVALID_X_CATALOG_IMPORT',
        );
    if (seen.has(p.retailer_id)) bad('Product retailer IDs must be unique.', 'INVALID_X_CATALOG_IMPORT');
    seen.add(p.retailer_id);
    if (!/^[A-Z]{3}$/.test(p.currency))
      bad('Choose one explicit uppercase three-letter product currency.', 'INVALID_X_CATALOG_IMPORT');
    const product = {
      id: p.retailer_id,
      title: p.name,
      price: p.price + ' ' + p.currency,
      image_link: p.image_url,
      link: p.url,
      availability: p.availability,
      condition: p.condition,
      brand: p.brand,
      description: p.description,
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
        '. Each item requires native before-state review and independent read-back. Matching IDs are updated; missing source items are not deleted.',
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
