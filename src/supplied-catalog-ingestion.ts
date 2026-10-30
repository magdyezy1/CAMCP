import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {catalogRequirement} from './catalog-requirements.js';

/**
 * The rules every catalog destination's projection applies to supplied products (COM-02 A and B): the optional sale
 * and the non-destructive retirement. The projections are each destination's (src/<provider>-catalog-ingestion.ts,
 * registered with its provider hooks); src/catalog-ingestion.ts dispatches to them and re-exports the retirement.
 */

/** Exact order of two nonnegative decimal strings, without floating point: negative, zero or positive. */
function decimalOrder(a: string, b: string): number {
  const [aw = '0', af = ''] = a.split('.'),
    [bw = '0', bf = ''] = b.split('.'),
    n = Math.max(af.length, bf.length),
    x = BigInt(aw + af.padEnd(n, '0')),
    y = BigInt(bw + bf.padEnd(n, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
/** ISO 8601 date and time with an explicit offset: a sale's start or end is kept as written, never re-zoned. */
const saleTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * The optional sale of a supplied product (COM-02 A), for every destination: a decimal sale price in the product's
 * own currency (an explicit currency suffix must be that currency), lower than the price, and an optional literal
 * start and end. A destination may ask for more of a sale it returns (X needs both times or neither). A source without
 * a sale sends none, and the destination keeps its current one (named as a value the source does not send); clearing a
 * destination sale is not offered.
 */
export function catalogSale(p: JsonObject, index: number): {amount: string} | undefined {
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
  return {amount: m[1]!};
}
/**
 * A non-destructive retirement of supplied products (COM-02 B): their availability becomes "out of stock" or
 * "discontinued" through the same reviewed upsert, so ads stop showing them while the product, its history and its sets
 * stay. Nothing is deleted, and a comparison blocks retiring a product the catalog does not have (it would be created).
 * The inputs are requirements.retire_retailer_ids and requirements.retire_availability.
 */
export function catalogRetirement(input: JsonObject): {ids: Set<string>; availability: string} | undefined {
  const ids = catalogRequirement(input, 'retire_retailer_ids'),
    availability = catalogRequirement(input, 'retire_availability');
  if (ids === undefined && availability === undefined) return undefined;
  if (!['out of stock', 'discontinued'].includes(availability))
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
  return {ids: new Set(ids), availability};
}
/** A retired product's projection source: the supplied row with the retirement availability. */
export function retired(p: JsonObject, retire: ReturnType<typeof catalogRetirement>): JsonObject {
  return retire?.ids.has(p.retailer_id) ? {...p, availability: retire.availability} : p;
}
