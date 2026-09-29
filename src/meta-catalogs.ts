import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * What Meta catalog families share (meta-product-sets.ts, meta-catalog-products.ts): the permissions they need, Meta's
 * refusals as the transport raises them, reads that may find nothing, and the rule that AMCP changes only catalogs of
 * the selected ad account's business.
 */
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export function assertMetaCatalogScope(c: Connection, write: boolean, what: string): void {
  const has = (s: string) => c.scopes.includes(s);
  if (write ? !(has('catalog_management') && has('ads_management')) : !(has('ads_read') || has('ads_management')))
    throw new MirrorError(
      'INSUFFICIENT_SCOPE',
      what +
        ' need the catalog_management and ads_management permissions: add them to AMCP_META_SCOPES and reconnect Meta. catalog_management needs Meta app review.',
      {required: ['catalog_management', 'ads_management']},
      403,
    );
}
/** Meta's refusal of a read, as the transport raises it: HTTP 400 with the native error in the details. */
export function metaRefusal(e: unknown): JsonObject | undefined {
  if (!(e instanceof MirrorError) || e.code !== 'UPSTREAM_ERROR' || e.status !== 400) return;
  const up = object(e.details?.upstream) ? (e.details.upstream as JsonObject) : {};
  return object(up.error) ? up.error : undefined;
}
/** "Unsupported get request" (code 100, subcode 33): the object does not exist or is not visible. */
export function metaAbsent(e: unknown): boolean {
  const err = metaRefusal(e);
  return (
    (e instanceof MirrorError && (e.status === 404 || e.code === 'NOT_FOUND')) ||
    (!!err && Number(err.code) === 100 && Number(err.error_subcode) === 33)
  );
}
/** A read that may find nothing: the reply's data, or undefined when Meta says the object does not exist. */
export async function optionalMetaRead(
  fetch: (p: CompiledRequest) => Promise<TransportResult>,
  q: CompiledRequest,
  label: string,
): Promise<JsonObject | undefined> {
  let r: TransportResult;
  try {
    r = await fetch(q);
  } catch (e) {
    if (metaAbsent(e)) return undefined;
    throw e;
  }
  if (r.status !== 200 || !object(r.data) || r.data.error)
    throw new MirrorError('INCOMPLETE_STATE', 'Meta did not return the ' + label + '.', {}, 502);
  return r.data as JsonObject;
}
export const metaCatalogFields = 'id,name,vertical,product_count,business{id}';
/** The catalog as a review shows it, from a read with metaCatalogFields. */
export function metaCatalogView(c: JsonObject | undefined, id: string): JsonObject {
  return c
    ? {
        present: true,
        id: String(c.id),
        name: c.name ?? null,
        vertical: c.vertical ?? null,
        product_count: c.product_count === undefined ? null : Number(c.product_count),
        business: object(c.business) && c.business.id !== undefined ? String(c.business.id) : null,
      }
    : {present: false, id};
}
/** The catalog must exist and belong to the selected ad account's business. */
export function assertMetaCatalogOfBusiness(state: JsonObject, requested: string | null): void {
  const catalog = state.catalog;
  if (!object(catalog) || catalog.present === false)
    throw new MirrorError('STATE_NOT_FOUND', 'The catalog was not found.', {catalog_id: requested}, 404);
  if (state.business === null || state.business === undefined || catalog.business !== state.business)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Catalog ' +
        String(catalog.id) +
        " does not belong to the selected ad account's business" +
        (state.business ? ' (' + String(state.business) + ')' : '') +
        '; AMCP changes only catalogs of that business.',
      {catalog_id: String(catalog.id), business: (state.business as string | null) ?? null},
      409,
    );
}
