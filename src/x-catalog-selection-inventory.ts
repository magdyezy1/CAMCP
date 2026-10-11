import type {JsonObject} from './types.js';
import {bad, fingerprint} from './workspace-core.js';
import {catalogPrice, text, xCatalogProductGrouping} from './x-catalogs.js';

/** Explicit read-only inspection; a supplied selection never establishes whole-store absence. */
export function catalogInventoryRequested(input: JsonObject): boolean {
  if (input.inspect_other_listed_products !== undefined && typeof input.inspect_other_listed_products !== 'boolean')
    bad('Choose true or false for inspecting other listed catalog products.');
  if (input.absent_source_policy !== undefined && input.absent_source_policy !== 'retain')
    bad('Supplied products do not establish whole-store absence. The absent-source policy must be retain.');
  if (input.inspect_other_listed_products === true && input.gateway !== 'x_ads_native_action')
    bad('Inspection of other listed products is qualified for X catalogs only.');
  return input.inspect_other_listed_products === true;
}

/**
 * An explicit selection of listed X products by native key (COM-02 B): `selection_source: "listed_inventory"` with 1–50
 * distinct `product_keys`. It reads only the selected products' current evidence; no supplied source is involved, so
 * nothing is selected because it is absent from one. Returns the keys, or undefined for a supplied-product request.
 */
export function listedSelectionRequested(input: JsonObject): string[] | undefined {
  if (input.selection_source === undefined || input.selection_source === 'supplied_products') {
    if (input.product_keys !== undefined || input.listed_inventory_hash !== undefined)
      bad('Native product keys select listed products only with selection_source listed_inventory.');
    return undefined;
  }
  if (input.selection_source !== 'listed_inventory')
    bad('Choose supplied_products or listed_inventory as the selection.');
  if (input.gateway !== 'x_ads_native_action') bad('Selection of listed products is qualified for X catalogs only.');
  if (
    typeof input.catalog_id !== 'string' ||
    !/^[1-9][0-9]{0,24}$/.test(input.catalog_id) ||
    typeof input.account_id !== 'string' ||
    !input.account_id
  )
    bad('Choose an exact X product catalog ID and selected X ad account.');
  if (
    ['products', 'retailer_ids', 'allow_upsert', 'inspect_other_listed_products', 'absent_source_policy', 'name'].some(
      k => input[k] !== undefined,
    )
  )
    bad('A listed selection takes native product keys, not supplied products or retailer IDs.');
  const keys = input.product_keys;
  if (
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > 50 ||
    keys.some((k: unknown) => typeof k !== 'string' || !/^[1-9][0-9]{0,24}$/.test(k)) ||
    new Set(keys).size !== keys.length
  )
    bad('Choose 1–50 distinct listed native product keys.');
  return keys as string[];
}

function observation(row: JsonObject): JsonObject {
  const money = catalogPrice(row.price);
  return {
    retailer_id: row.id,
    product_id: row.product_key,
    name: text(row.title, 150) ? row.title : null,
    price: money ? row.price : null,
    currency: money?.currency ?? null,
    group_status: xCatalogProductGrouping(row),
    item_group_id: text(row.item_group_id, 100) ? row.item_group_id : null,
    item_group_key: text(row.item_group_key, 100) ? row.item_group_key : null,
  };
}

/** The existing bounded reader verifies every native ID/key before calling this projection. */
export function catalogSelectionInventory(rows: JsonObject[], products: JsonObject[]) {
  const supplied = new Set(products.map(p => p.retailer_id)),
    listed = rows.map(observation),
    items = listed.filter(p => !supplied.has(p.retailer_id)),
    counts = {individual: 0, grouped: 0, unknown: 0};
  for (const item of items) counts[item.group_status as keyof typeof counts]++;
  // Page order is not an identity or a field change. Preserve the first scan's order for display.
  const material = [...listed].sort((a, b) =>
    a.retailer_id < b.retailer_id ? -1 : a.retailer_id > b.retailer_id ? 1 : 0,
  );
  return {
    record_kind: 'x_catalog_selection_inventory',
    coverage: 'bounded_listed_products',
    listed_scan_complete: true,
    variant_inventory_complete: false,
    source_coverage: 'supplied_products_only',
    source_absence_established: false,
    absent_source_policy: 'retain',
    source_selection_count: products.length,
    listed_product_count: listed.length,
    supplied_listed_count: listed.length - items.length,
    outside_selection_count: items.length,
    outside_selection_group_counts: counts,
    material_hash: fingerprint(material),
    items,
    provider_mutations: 0,
    destructive_deletions: 0,
  };
}
