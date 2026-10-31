import {catalogComparisonSteps} from './provider-workflows.js';
import {catalogDestination, catalogDestinations, fallbackCatalogDestination} from './catalog-destinations.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, JsonObject} from './types.js';

/**
 * Each catalog destination's read-only comparison of supplied products with its current catalog (COM-03), and the
 * checks and read of a listed selection, are its provider's steps in the provider workflows registry
 * (src/provider-workflows.ts catalogComparisonSteps). This keeps their order. A load-time check: every destination
 * has its comparison.
 */
for (const gateway of Object.keys(catalogDestinations))
  if (!Object.hasOwn(catalogComparisonSteps.comparisons, gateway))
    throw new Error('The catalog destination ' + gateway + ' has no comparison in the provider workflows registry.');
export async function catalogComparison(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  catalogComparisonSteps.inventoryRequested(input);
  // An explicit selection of listed products by native key (COM-02 B) reads only those products.
  const keys = catalogComparisonSteps.listedSelectionRequested(input);
  if (keys) return catalogComparisonSteps.listedSelection(store, registry, transport, credentials, actor, input, keys);
  // A gateway that is not a catalog destination keeps the refusal it had before the destination contract.
  const destination = (catalogDestination(input.gateway) ?? fallbackCatalogDestination).gateway;
  return catalogComparisonSteps.comparisons[destination]!(store, registry, transport, credentials, actor, input);
}
