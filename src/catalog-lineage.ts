import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {fingerprint, optional} from './workspace-core.js';
import {catalogRequirement} from './catalog-requirements.js';
import type {CatalogSource} from './catalog-sources.js';

/**
 * Catalog plan lineage (COM-03 Phases 2 and 3). Every plan `catalog_plan` saves records where its products came from on
 * its campaign_run as `catalog_lineage`:
 *
 * - `source_kind`, `source_hash` (the plan's products), `catalog_source_hash` (the CSV as received), `source_rows`;
 * - `mapping_profile` {profile_id, version, profile_hash} and `mapping_profile_version` when a saved mapping projected
 *   the CSV;
 * - `comparison_hash` and `compared_at` when the plan's products are exactly products of a comparison the same person
 *   read: `catalog_compare` returns a sealed `lineage_token` (actor-bound, 15 minutes, no stored rows) and catalog_plan
 *   takes it as requirements.comparison_token;
 * - `lineage_group` {id, part, parts, group_source_hash, group_products} when one source of more than 50 products was
 *   saved as consecutive plans of at most 50 (requirements.chunked).
 *
 * Only catalog_plan can set a lineage: it stores a short-lived binding and names it in the campaign create, which
 * checks the binding against the exact steps (catalogLineageCreationBinding). Lineage is metadata: it changes no native
 * request, review or approval, and an older release ignores it (an additive document field, no schema step).
 */
export const catalogLineageVersion = 'catalog-plan-lineage-v1';
/** Products per plan, and per chunked plan group. */
export const catalogPlanLimits = {plan: 50, group: 500} as const;
const comparisonBinding = 'catalog-comparison-lineage-v1',
  bindingKind = 'catalog_lineage_binding';
function refuse(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
/** The fields of a plan step a lineage binding covers (the runner adds status and defaults). */
const cleanStep = (s: JsonObject) =>
  Object.fromEntries(
    ['id', 'kind', 'gateway', 'account_id', 'connection_id', 'depends_on', 'description', 'arguments'].map(k => [
      k,
      s[k],
    ]),
  );
/**
 * A sealed reference to one comparison for the lineage of the plan saved from it, or null when this deployment cannot
 * seal (no encryption key). It names the scope, the compared source and each compared product's fingerprint.
 */
export function comparisonLineageToken(
  store: Store,
  actor: Actor,
  comparison: JsonObject,
  products: JsonObject[],
  source: CatalogSource,
): string | null {
  try {
    return store.sealReadCursor(actor, comparisonBinding, {
      comparison_hash: comparison.comparison_hash,
      scope: comparison.scope,
      source_hash: comparison.source_hash,
      captured_at: comparison.captured_at,
      products: products.map(p => [p.retailer_id, fingerprint(p)]),
      source,
    });
  } catch (error) {
    if (error instanceof MirrorError && ['ENCRYPTION_REQUIRED', 'INVALID_READ_CURSOR'].includes(error.code))
      return null;
    throw error;
  }
}
/** The comparison a plan names, verified: the same person, scope and exactly compared products. */
export function comparisonLineage(
  store: Store,
  actor: Actor,
  input: JsonObject,
  products: JsonObject[],
  connectionId: string,
): JsonObject | null {
  const token = catalogRequirement(input, 'comparison_token');
  if (token === undefined) return null;
  let c: JsonObject;
  try {
    c = store.openReadCursor(actor, comparisonBinding, token);
  } catch {
    return refuse(
      'CATALOG_LINEAGE_EXPIRED',
      'The comparison this plan names expired or was read by someone else. Compare the products again, then save.',
      {},
      409,
    );
  }
  if (
    !c.scope ||
    c.scope.gateway !== input.gateway ||
    c.scope.account_id !== input.account_id ||
    c.scope.catalog_id !== input.catalog_id ||
    c.scope.connection_id !== connectionId
  )
    refuse('CATALOG_LINEAGE_MISMATCH', 'The comparison this plan names is for another account, login or catalog.');
  const compared = new Map<string, string>(c.products);
  if (products.some(p => compared.get(p.retailer_id) !== fingerprint(p)))
    refuse(
      'CATALOG_LINEAGE_MISMATCH',
      'These products differ from the comparison this plan names. Save the products you compared, or compare again.',
    );
  return {comparison_hash: c.comparison_hash, compared_at: c.captured_at, compared_products: c.products.length};
}
/** The lineage of one plan. */
export function catalogPlanLineage(
  source: CatalogSource,
  products: JsonObject[],
  comparison: JsonObject | null,
  group?: JsonObject,
): JsonObject {
  return {
    lineage_version: catalogLineageVersion,
    source_kind: source.source_kind,
    source_hash: fingerprint(products),
    catalog_source_hash: source.catalog_source_hash,
    source_rows: source.source_rows,
    selected_rows: source.selected_rows,
    columns: source.columns,
    mapping_profile: source.mapping_profile,
    mapping_profile_version: source.mapping_profile?.version ?? null,
    comparison_hash: comparison?.comparison_hash ?? null,
    compared_at: comparison?.compared_at ?? null,
    ...(group ? {lineage_group: group} : {}),
  };
}
/** Consecutive parts of at most 50 products, in source order. */
export function catalogPlanParts<T>(products: T[]): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < products.length; i += catalogPlanLimits.plan)
    parts.push(products.slice(i, i + catalogPlanLimits.plan));
  return parts;
}
/**
 * Stores the binding a catalog plan's campaign create names, for 90 seconds, and returns the binding; the caller
 * releases it after the create. The binding fixes the lineage, the exact steps, name, brief and creation key, and the
 * retailer IDs the plan retires (COM-02 B), which the plan runner holds its native reviews to (src/catalog-retirement.ts).
 * A binding a crashed process never released is removed by the next binding of the workspace once it has expired.
 */
export function storeCatalogLineageBinding(
  store: Store,
  actor: Actor,
  plan: JsonObject,
  lineage: JsonObject,
  retirement?: {retailer_ids: string[]; availability: string},
) {
  const id = randomUUID(),
    nonce = randomUUID(),
    hash = fingerprint(lineage),
    now = Date.now();
  for (const old of store.documents(actor.tenantId, bindingKind))
    if (!(Number(old.expires_at) > now)) store.deleteDocument(actor.tenantId, bindingKind, String(old.id));
  store.putDocument(actor.tenantId, bindingKind, id, {
    lineage,
    hash,
    ...(retirement
      ? {retirement: {retailer_ids: [...retirement.retailer_ids], availability: retirement.availability}}
      : {}),
    steps: fingerprint((plan.steps as JsonObject[]).map(cleanStep)),
    name: plan.name,
    brief: plan.brief,
    idempotency_key: plan.idempotency_key ?? null,
    user_id: actor.userId,
    nonce,
    expires_at: now + 90000,
  });
  return {kind: 'lineage', id, hash, save_nonce: nonce};
}
export function releaseCatalogLineageBinding(store: Store, actor: Actor, binding: JsonObject): void {
  store.deleteDocument(actor.tenantId, bindingKind, binding.id);
}
/**
 * Campaign create (src/campaign-runner.ts): the lineage of the catalog_plan workflow that just stored this binding, or
 * undefined for a plan without one. A binding anyone else names, or one for other steps, is refused.
 */
export function catalogLineageCreationBinding(
  store: Store,
  actor: Actor,
  input: JsonObject,
  steps: JsonObject[],
): JsonObject | undefined {
  const b = input.catalog_binding;
  if (b === undefined || b?.kind !== 'lineage') return undefined;
  const doc =
    Object.keys(b).every(k => ['kind', 'id', 'hash', 'save_nonce'].includes(k)) &&
    ['id', 'hash', 'save_nonce'].every(k => typeof b[k] === 'string' && b[k].length <= 200)
      ? optional(store, actor.tenantId, bindingKind, b.id)
      : undefined;
  if (
    !doc ||
    doc.user_id !== actor.userId ||
    doc.nonce !== b.save_nonce ||
    !(doc.expires_at > Date.now()) ||
    doc.hash !== b.hash ||
    fingerprint(doc.lineage) !== b.hash ||
    doc.steps !== fingerprint(steps.map(cleanStep)) ||
    doc.name !== input.name ||
    doc.brief !== input.brief ||
    doc.idempotency_key !== (input.idempotency_key ?? null)
  )
    refuse(
      'CATALOG_LINEAGE_UNBOUND',
      'Save catalog plans with amcp_workspace catalog_plan; a plan lineage cannot be named directly.',
      {},
      409,
    );
  return doc.lineage;
}

/**
 * The retirement a catalog plan's binding records (COM-02 B), or undefined. Campaign create reads it only after
 * catalogLineageCreationBinding accepted the same binding.
 */
export function catalogRetirementCreationBinding(
  store: Store,
  actor: Actor,
  input: JsonObject,
): JsonObject | undefined {
  const b = input.catalog_binding;
  if (b?.kind !== 'lineage' || typeof b.id !== 'string') return undefined;
  const retirement = optional(store, actor.tenantId, bindingKind, b.id)?.retirement;
  return retirement && Array.isArray(retirement.retailer_ids) && retirement.retailer_ids.length
    ? {retailer_ids: [...retirement.retailer_ids], availability: retirement.availability}
    : undefined;
}
