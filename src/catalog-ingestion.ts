import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import type {metaCatalogIngestion} from './meta-catalog-ingestion.js';
import {catalogDestination, catalogDestinations} from './catalog-destinations.js';
import {providerHooks} from './provider-hooks.js';
// The retirement every destination's projection applies (COM-02 B), at the path its callers import it from.
export {catalogRetirement, retired} from './supplied-catalog-ingestion.js';

/**
 * Each catalog destination's projection of supplied products into its native reviewed steps (COM-03) is its
 * provider's hook (`catalogProjection`, src/<provider>-catalog-ingestion.ts, registered in src/provider-hooks.ts), under
 * the destination's gateway. A load-time check: every destination has its projection.
 */
for (const destination of Object.values(catalogDestinations))
  if (!providerHooks(destination.gateway)?.catalogProjection)
    throw new Error('The catalog destination ' + destination.gateway + ' has no projection in its provider hooks.');
export function catalogIngestion(input: JsonObject) {
  const destination = catalogDestination(input.gateway);
  // An unknown gateway keeps the refusal it had before the destination contract.
  if (!destination) return bad('Choose a numeric Meta product catalog ID and selected Meta ad account.');
  return providerHooks(destination.gateway)!.catalogProjection!(input) as ReturnType<typeof metaCatalogIngestion>;
}
