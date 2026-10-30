import {bad, fingerprint, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {assertMetaCatalogProductFields} from './meta-catalog-products.js';
import {catalogDestinations, catalogSourceFields} from './catalog-destinations.js';
import {catalogRetirement, catalogSale, retired} from './supplied-catalog-ingestion.js';

/**
 * Meta's catalog destination projection (COM-03), registered with its provider hooks (src/meta-adapter.ts); the
 * shared src/catalog-ingestion.ts dispatches to it by gateway.
 */
const gateway = 'meta_native_action';
/** Hundredths of a decimal amount, as Meta counts it; digits after the second decimal place must be zeros. */
function hundredths(amount: string): bigint | undefined {
  const [whole = '0', decimals = ''] = amount.split('.');
  if (/[1-9]/.test(decimals.slice(2))) return undefined;
  return BigInt(whole) * 100n + BigInt(decimals.slice(0, 2).padEnd(2, '0'));
}
/** Supplied products → one Meta product create per item; Meta counts prices in hundredths. */
export function metaCatalogIngestion(input: JsonObject) {
  const fields = catalogSourceFields(catalogDestinations[gateway]!),
    retire = catalogRetirement(input);
  if (input.gateway !== gateway || !/^\d+$/.test(input.catalog_id ?? ''))
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
    const sale = catalogSale(p, i),
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
      gateway,
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
