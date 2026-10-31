import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {catalogDestinations, catalogSourceFields} from './catalog-destinations.js';
import {catalogRequirement} from './catalog-requirements.js';
import {catalogSale} from './supplied-catalog-ingestion.js';

/**
 * Snapchat's catalog destination projection (COM-03), registered with its provider hooks (src/snapchat-adapter.ts);
 * the shared src/catalog-ingestion.ts dispatches to it by gateway, and its comparison reads with it.
 */
const gateway = 'snapchat_native_action';
/**
 * Supplied products for a read-only Snapchat comparison (COM-02 D). Snapchat changes products only through product
 * feeds, so there is no reviewed step and no draft: the projection validates the supplied rows and keeps every price as
 * the exact decimal the source wrote, in "amount CUR" form. allow_upsert has no meaning here and is ignored.
 */
export function snapchatCatalogIngestion(input: JsonObject) {
  const d = catalogDestinations[gateway]!,
    fields = catalogSourceFields(d);
  if (typeof input.catalog_id !== 'string' || !d.catalogId.test(input.catalog_id))
    bad(
      'Choose an exact Snapchat product catalog ID and selected Snapchat ad account.',
      'INVALID_SNAPCHAT_CATALOG_COMPARISON',
    );
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 50)
    bad('Import 1–50 products per reviewed plan.', 'CATALOG_IMPORT_LIMIT');
  if (input.allow_upsert !== undefined && typeof input.allow_upsert !== 'boolean')
    bad('Explicitly choose whether existing retailer IDs may be updated.');
  if (['retire_retailer_ids', 'retire_availability'].some(k => catalogRequirement(input, k) !== undefined))
    bad(
      'Snapchat products change only through product feeds; retire them in the feed.',
      'INVALID_SNAPCHAT_CATALOG_COMPARISON',
    );
  const seen = new Set<string>();
  const products = input.products.map((p: JsonObject, i: number) => {
    validate(p, fields, 16384, 'product field');
    if (Object.values(p).some(v => typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v)))
      bad('Product fields must be plain text without control characters.');
    for (const key of d.sourceFields.required)
      if (typeof p[key] !== 'string' || !p[key].trim()) bad('Product ' + (i + 1) + ' requires ' + key + '.');
    if (p.retailer_id.length > 100 || p.name.length > 500 || seen.has(p.retailer_id))
      bad('Product retailer IDs must be unique and at most 100 characters; names at most 500.');
    seen.add(p.retailer_id);
    if (!/^\d{1,12}(\.\d{1,6})?$/.test(p.price) || !/^[A-Z]{3}$/.test(p.currency))
      bad('Use an explicit currency and a nonnegative decimal price.');
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
    const sale = catalogSale(p, i);
    if (sale && !/^\d{1,12}(\.\d{1,6})?$/.test(sale.amount))
      bad(
        'Use a nonnegative decimal sale price, optionally followed by the product currency.',
        'INVALID_CATALOG_SALE',
        {
          field: 'sale_price',
          product: i + 1,
        },
      );
    return {...p, ...(sale ? {sale_price: sale.amount} : {})};
  });
  return {
    source_hash: fingerprint(input.products),
    item_count: products.length,
    items: products.map((p: JsonObject) => ({
      retailer_id: p.retailer_id,
      name: p.name,
      native_price: p.price + ' ' + p.currency,
      ...(p.sale_price !== undefined ? {native_sale_price: p.sale_price + ' ' + p.currency} : {}),
      currency: p.currency,
      existing_item_policy: 'feed only; compared read-only',
    })),
    // The rows the comparison reads with: the supplied products, a sale price without its currency suffix.
    products,
    plan: null,
    writes: 'feed_only',
    network_requests: 0,
    destructive_deletions: 0,
    destination_limitations: [
      'Snapchat changes catalog products only through product feeds. AMCP compares supplied products read-only and saves no draft; fix differences in the feed.',
      'Feed processing can take time, so a comparison shows current catalog evidence, not the next feed result.',
    ],
    meaning:
      'Preview validates supplied product data for a read-only Snapchat comparison. Exact decimal prices are kept as written. No review, draft or provider change is created.',
  };
}
