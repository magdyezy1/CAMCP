import type {JsonObject} from './types.js';
import type {CatalogDestinationFacts, ProviderAdapter} from './provider-adapter.js';
import {catalogDestinationOrder, providerById} from './provider-adapters.js';
import {bad} from './workspace-core.js';

/**
 * Catalog destinations (COM-03): one contract for the commerce destinations a supplied product source can be compared
 * with or imported into. Each destination names its source fields, its item identity, how it accepts product changes
 * (explicit upsert intent, explicit removal intent, per-item receipts, or feeds only). The destinations are facts of
 * their providers' adapters (src/provider-adapters.ts, ARC-01), listed here under their gateways in the registry's
 * catalogDestinationOrder; each provider registers its projection (src/catalog-ingestion.ts) and its comparison
 * (src/catalog-comparison.ts) under the same gateway. Product sources plug in on the other side
 * (src/catalog-sources.ts, with column mappings in src/catalog-mapping.ts): whatever produced the products, a
 * destination sees the same supplied rows. tests/catalog-destination-contract.test.mjs holds each projection and the
 * website to this contract.
 *
 * Every destination returns the shared comparison item (`catalog-comparison-item-v2`): `state`, `changes`,
 * `unknown_fields`, `unsent_fields`, `blocked`/`blocked_reason` and `serving_notes`, beside its own evidence. The v2
 * fields are additive to the responses pinned before this contract (tests/catalog-destination-golden.test.mjs).
 *
 * Native write contracts are unchanged: an import still becomes one reviewed native step per product, and no
 * destination infers a deletion from a product's absence in the source.
 */
export const catalogItemSchemaVersion = 'catalog-comparison-item-v2';
/** A catalog destination's gateway; the provider adapters name the destinations (src/provider-adapters.ts). */
export type CatalogGateway = string;
/** A destination: its adapter's facts (src/provider-adapter.ts CatalogDestinationFacts) under its gateway. */
export type CatalogDestination = Omit<CatalogDestinationFacts, 'fallback' | 'stepRetailerId'> & {
  gateway: CatalogGateway;
  /** The ID of its provider adapter. */
  provider: string;
  itemSchemaVersion: typeof catalogItemSchemaVersion;
};
function destinationOf(adapter: ProviderAdapter): CatalogDestination {
  const d = adapter.catalogDestination!;
  return {
    gateway: adapter.gateway,
    provider: adapter.id,
    sourceFields: d.sourceFields,
    catalogId: d.catalogId,
    identity: d.identity,
    writes: d.writes,
    upsert: d.upsert,
    removal: d.removal,
    destinationOnlyValues: d.destinationOnlyValues,
    itemSchemaVersion: catalogItemSchemaVersion,
  };
}
const destinationAdapters = catalogDestinationOrder.map(id => providerById(id)!);
export const catalogDestinations: Readonly<Record<CatalogGateway, CatalogDestination>> = Object.fromEntries(
  destinationAdapters.map(a => [a.gateway, destinationOf(a)]),
);
/** The destination whose comparison answers a gateway that is no catalog destination (its adapter's `fallback`). */
export const fallbackCatalogDestination: CatalogDestination =
  catalogDestinations[destinationAdapters.find(a => a.catalogDestination!.fallback)!.gateway]!;
/** The destination of a gateway, or undefined for a gateway that is not a catalog destination. */
export function catalogDestination(gateway: unknown): CatalogDestination | undefined {
  return typeof gateway === 'string' && Object.hasOwn(catalogDestinations, gateway)
    ? catalogDestinations[gateway as CatalogGateway]
    : undefined;
}
export function catalogSourceFields(d: CatalogDestination): string[] {
  return [...d.sourceFields.required, ...d.sourceFields.optional];
}
/** Availability values under which the destination may show the product in ads. */
const serving = ['in stock', 'available for order', 'preorder'];
/**
 * Serving notes of one compared product (codes; the website names them): the availability after the change keeps it
 * out of ads, or the current product is in staging and the source does not change its visibility.
 */
export function catalogServingNotes(supplied: JsonObject, before: JsonObject): string[] {
  const notes: string[] = [],
    availability = supplied.availability ?? (before.present === true ? before.availability : undefined);
  if (typeof availability === 'string' && !serving.includes(availability)) notes.push('availability_limits_serving');
  if (before.present === true && supplied.visibility === undefined && before.visibility === 'staging')
    notes.push('staging_visibility');
  return notes;
}
/**
 * The shared item v2 fields beside a destination's own: existing fields keep their values. Under a destination's
 * `review` policy (Meta, owner decision P9), a product that matches every supplied field but holds values the source
 * does not send is `unknown` and enters the review set; under `note` (X and Snapchat) it stays matching. Either way its
 * `unsent_fields` name those values.
 */
export function comparisonItemV2(
  item: JsonObject,
  supplied: JsonObject,
  destination: CatalogDestination,
  retiring = false,
): JsonObject {
  const unsent: string[] = item.unsent_fields ?? [];
  return {
    ...item,
    ...(destination.destinationOnlyValues === 'review' && item.state === 'matching' && unsent.length
      ? {state: 'unknown'}
      : {}),
    blocked_reason: item.blocked_reason ?? null,
    // A retirement (COM-02 B) only updates an existing product: retiring a missing one would create it.
    ...(retiring && !item.blocked && item.before?.present !== true
      ? {blocked: true, blocked_reason: 'retire_absent'}
      : {}),
    unsent_fields: unsent,
    serving_notes: catalogServingNotes(supplied, item.before ?? {}),
  };
}
/** Counts and the eligible review set, the same for every destination: blocked and matching products need no draft. */
export function comparisonSummary(items: JsonObject[]) {
  const review_retailer_ids = items.filter(i => !i.blocked && i.state !== 'matching').map(i => i.retailer_id),
    summary: Record<string, number> = {
      new: 0,
      changed: 0,
      matching: 0,
      unknown: 0,
      blocked: 0,
      needs_review: review_retailer_ids.length,
      // Products holding values for attributes the source does not send (COM-01).
      with_destination_only_values: 0,
    };
  for (const item of items) {
    if (!['new', 'changed', 'matching', 'unknown'].includes(item.state)) bad('Unrecognized comparison state.');
    summary[item.state]!++;
    if (item.blocked) summary.blocked!++;
    if (item.unsent_fields.length) summary.with_destination_only_values!++;
  }
  return {summary, review_retailer_ids};
}
