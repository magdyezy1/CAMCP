import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {assertXCatalogProductFields} from './x-catalog-products.js';
import {xCatalogGateway as gateway, xSnowflake} from './x-catalogs.js';
import {catalogDestinations, catalogSourceFields} from './catalog-destinations.js';
import {catalogRetirement, catalogSale} from './supplied-catalog-ingestion.js';

/**
 * X's catalog destination projection (COM-03), registered with its provider hooks (src/x-adapter.ts); the shared
 * src/catalog-ingestion.ts dispatches to it by gateway.
 */
/** A bounded local projection into the existing single-product X reviewed contract. No inferred source values. */
export function xCatalogIngestion(input: JsonObject) {
  const fields = catalogSourceFields(catalogDestinations[gateway]!),
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
    for (const key of catalogDestinations[gateway]!.sourceFields.required)
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
    const sale = catalogSale(p, i);
    if (sale && (p.sale_price_start_date === undefined) !== (p.sale_price_end_date === undefined))
      bad('X needs both the sale start and the sale end, or neither.', 'INVALID_CATALOG_SALE', {product: i + 1});
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
      gateway,
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
