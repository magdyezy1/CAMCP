import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
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
    if (!/^\d+(\.\d{1,2})?$/.test(p.price) || !/^[A-Z]{3}$/.test(p.currency))
      bad('Use an explicit currency and nonnegative decimal price with at most two places.');
    const [whole, fraction = ''] = p.price.split('.'),
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
    return {...p, price: Number(cents), allow_upsert: input.allow_upsert};
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
