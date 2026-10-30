import type {CatalogVersion} from './provider-adapter.js';
import type {JsonObject} from './types.js';
import {registeredProviderHooks} from './provider-hooks.js';

/**
 * Gateways whose captured catalog AMCP sends at a newer provider version than it was captured at. Each says how a
 * catalog action, a captured LIST_ACTIONS page or DESCRIBE_ACTION response, and (when its text names a version) the
 * tool definition read at the version sent. The registry, introspection and the capture verification all use this
 * table, so a listing never claims one version while requests go to another. Each entry is its provider's (ARC-01
 * phase B, wave 4c: its adapter's catalog hooks, src/<provider>-adapter.ts: Google Ads', Meta's, LinkedIn's), by
 * gateway in the provider hooks registry's order.
 */
export const catalogVersions: Record<string, CatalogVersion> = Object.fromEntries(
  registeredProviderHooks.flatMap(({gateway, catalog}) => (catalog?.version ? [[gateway, catalog.version]] : [])),
);
/** A captured page or description of this gateway, as AMCP answers it now. */
export const currentCapture = (gateway: string, data: JsonObject): JsonObject =>
  catalogVersions[gateway]?.capture(data) ?? data;
