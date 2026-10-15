import type {JsonObject} from './types.js';
import {bad} from './workspace-core.js';

/**
 * Catalog destinations (COM-03): one contract for the commerce destinations a supplied product source can be compared
 * with or imported into. Each destination names its source fields, its item identity, how it accepts product changes
 * (explicit upsert intent, explicit removal intent, per-item receipts, or feeds only); its projection
 * (src/catalog-ingestion.ts) and its comparison (src/catalog-comparison.ts) are registered under the same gateway, so
 * adding a destination is one entry here plus its two adapters, checked at compile time. Product sources plug in on the
 * other side (src/catalog-sources.ts, with column mappings in src/catalog-mapping.ts): whatever produced the products,
 * a destination sees the same supplied rows. tests/catalog-destination-contract.test.mjs holds each projection and the
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
export type CatalogGateway = 'meta_native_action' | 'x_ads_native_action' | 'snapchat_native_action';
export type CatalogDestination = {
  gateway: CatalogGateway;
  provider: 'meta' | 'x' | 'snapchat';
  /** Source columns a product may carry; required first. Unknown columns are refused. */
  sourceFields: {required: readonly string[]; optional: readonly string[]};
  /** The destination's native catalog ID. */
  catalogId: RegExp;
  /**
   * Item identity: the source's retailer_id names a product, and `native` is the destination's own key of that product
   * in a comparison item's product_id (Meta's product ID, X's product key, Snapchat's product ID, which is the
   * retailer_id itself).
   */
  identity: {source: 'retailer_id'; native: 'product_id' | 'product_key' | 'retailer_id'; pattern: RegExp};
  /**
   * How product changes reach the destination: one reviewed native step per product, each with its own receipt and
   * read-back (`reviewed_steps`), or only through the destination's own product feeds (`feed_only`: a comparison names
   * what to fix in the feed and no draft is saved).
   */
  writes: 'reviewed_steps' | 'feed_only';
  /** How an existing retailer ID is treated: Meta asks for an explicit choice, X always updates matching IDs. */
  upsert: 'explicit_choice' | 'required' | 'none';
  /**
   * Explicit removal intent the destination supports: a non-destructive retirement of supplied products through the
   * reviewed update (`retire`), also an explicit deletion of selected individual products by native key
   * (`retire_and_selected_deletion`), or nothing (`none`). Absence from a source never selects anything.
   */
  removal: 'retire' | 'retire_and_selected_deletion' | 'none';
  /**
   * What a populated attribute the source does not send means for the comparison (owner decision P9): `review` puts
   * an otherwise matching product in the review set as `unknown`; `note` names it without changing the state.
   */
  destinationOnlyValues: 'review' | 'note';
  itemSchemaVersion: typeof catalogItemSchemaVersion;
};
const shared = ['retailer_id', 'name', 'price', 'currency', 'image_url'] as const,
  described = ['url', 'availability', 'condition', 'brand', 'description'] as const,
  // An optional sale in the product currency with literal start and end times (COM-02 A).
  sale = ['sale_price', 'sale_price_start_date', 'sale_price_end_date'] as const;
export const catalogDestinations: Readonly<Record<CatalogGateway, CatalogDestination>> = {
  meta_native_action: {
    gateway: 'meta_native_action',
    provider: 'meta',
    sourceFields: {required: shared, optional: [...described, 'retailer_product_group_id', ...sale]},
    catalogId: /^[1-9][0-9]{0,31}$/,
    identity: {source: 'retailer_id', native: 'product_id', pattern: /^[1-9][0-9]{0,31}$/},
    writes: 'reviewed_steps',
    upsert: 'explicit_choice',
    // Meta has no product delete contract: a discontinued product is retired (COM-02 B).
    removal: 'retire',
    // Owner decision P9 (2026-10-11): a populated Meta attribute the source does not send needs review.
    destinationOnlyValues: 'review',
    itemSchemaVersion: catalogItemSchemaVersion,
  },
  x_ads_native_action: {
    gateway: 'x_ads_native_action',
    provider: 'x',
    sourceFields: {required: [...shared, ...described], optional: sale},
    catalogId: /^[1-9][0-9]{0,24}$/,
    identity: {source: 'retailer_id', native: 'product_key', pattern: /^[1-9][0-9]{0,24}$/},
    writes: 'reviewed_steps',
    upsert: 'required',
    removal: 'retire_and_selected_deletion',
    destinationOnlyValues: 'note',
    itemSchemaVersion: catalogItemSchemaVersion,
  },
  // COM-02 D: Snapchat products change only through product feeds, so its comparison is read-only and names what to fix
  // in the feed. Its sale is a sale price only: the read format of Snapchat sale dates is not qualified.
  snapchat_native_action: {
    gateway: 'snapchat_native_action',
    provider: 'snapchat',
    sourceFields: {required: shared, optional: [...described, 'sale_price']},
    catalogId: /^[A-Za-z0-9-]{1,64}$/,
    identity: {source: 'retailer_id', native: 'retailer_id', pattern: /^[^\u0000-\u001f\u007f]{1,100}$/},
    writes: 'feed_only',
    upsert: 'none',
    removal: 'none',
    destinationOnlyValues: 'note',
    itemSchemaVersion: catalogItemSchemaVersion,
  },
};
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
 * The shared item v2 fields beside a destination's own: existing fields keep their values. Under the destination's
 * `review` policy (owner decision P9), a product that matches every supplied field but holds values the source does
 * not send is `unknown`, so it enters the review set instead of reading as already current.
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
