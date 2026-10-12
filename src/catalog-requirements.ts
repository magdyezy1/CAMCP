import type {JsonObject} from './types.js';
import {bad} from './workspace-core.js';

/**
 * The catalog inputs that ride in `requirements` (COM-02, COM-03). tools/list carries one flat amcp_workspace schema
 * whose size is budgeted (MCP-07), so the per-action catalog inputs are named here and documented by amcp_tool_help:
 *
 * - catalog_preview, catalog_compare, catalog_plan: `retire_retailer_ids` and `retire_availability` (a non-destructive
 *   retirement of supplied products), `source` (a CSV projected on the server by a saved mapping profile);
 * - catalog_plan: `comparison_hash` (the comparison the plan's products come from, recorded in its lineage);
 * - catalog_compare and preview_catalog_removal: `selection_source: "listed_inventory"` with native `product_keys`, and
 *   for the preview the `listed_inventory_hash` of the inspection they were chosen from;
 * - save_catalog_mapping: `columns`, `fixed_currency`, `image_mode` and `replace_identity_column`.
 *
 * Each action reads only its own keys; any other key is refused before anything is read.
 */
const catalogKeys: Readonly<Record<string, readonly string[]>> = {
  catalog_preview: ['retire_retailer_ids', 'retire_availability', 'source'],
  catalog_compare: ['retire_retailer_ids', 'retire_availability', 'source', 'selection_source', 'product_keys'],
  catalog_plan: ['retire_retailer_ids', 'retire_availability', 'source', 'comparison_hash'],
  preview_catalog_removal: ['selection_source', 'product_keys', 'listed_inventory_hash'],
  save_catalog_mapping: ['columns', 'fixed_currency', 'image_mode', 'replace_identity_column'],
};
/** Whether an action takes its catalog inputs in requirements. */
export const catalogRequirementActions = Object.keys(catalogKeys);
/** Refuses a catalog action's requirements key that the action does not read. */
export function assertCatalogRequirements(input: JsonObject): void {
  const allowed = catalogKeys[input.action];
  if (!allowed || input.requirements === undefined) return;
  const r = input.requirements;
  if (!r || typeof r !== 'object' || Array.isArray(r))
    bad('requirements is an object of the inputs this catalog action names.', 'INVALID_ARGUMENT', {
      field: 'requirements',
    });
  // The fixed sentence is translated; the unread keys follow it as named fields.
  const extra = Object.keys(r).filter(k => !allowed.includes(k));
  if (extra.length)
    bad('This catalog action does not read these requirements.', 'INVALID_ARGUMENT', {
      fields: extra,
      accepted: [...allowed],
    });
}
/** One catalog input of requirements, or undefined. */
export function catalogRequirement(input: JsonObject, key: string): any {
  const r = input.requirements;
  return r && typeof r === 'object' && !Array.isArray(r) ? r[key] : undefined;
}
