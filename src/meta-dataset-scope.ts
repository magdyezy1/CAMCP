import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {metaRoute} from './meta-version.js';

/**
 * Ownership of Meta pixels (datasets) for measurement reads (MSR-03, owner direction P8). A pixel ID does not
 * name its ad account, so ScopeGuard cannot bind a read of it to the selected account. The account's own pixel list,
 * GET /act_{ad_account_id}/adspixels (Meta "Ad Account Adspixels", read 2026-10-11), is the evidence: each pixel it lists
 * is remembered for that connection and account for five minutes under its own key (adspixels/{id}).
 *
 * That ownership opens three reads of a listed pixel, never its other edges, its users, its events or any write:
 * - GET /{ads_pixel_id}, the node, for the six fields Meta documents on it and the measurement ledger already reads for each
 *   listed pixel (Meta "Ads Pixel", read 2026-10-11: id, name, owner_business, creation_time, last_fired_time,
 *   is_unavailable). MSR-03 first left the node out, so that a pixel could not be read by its ID after its account listed it,
 *   which the owner's field report of 2026-11-21 (issue 2) found, and the Meta conversion activation gate, which reads the
 *   pixel, was refused the same way (src/meta-recipe-activation.ts). The lead's decision D5 of that day opens it for those
 *   six fields: no new kind of data is read, since the ledger returns them for each listed pixel. The settings of automatic
 *   matching and data use concern customer data (src/meta-pixels.ts) and `creator` is a person, so none of them is
 *   readable here: any other field, a nested field, no `fields` or another query parameter is refused before the request.
 * - GET /{ads_pixel_id}/stats (Meta "Ads Pixel Stats": aggregation, start_time, end_time, event, event_source; data
 *   "up to seven days from the request time"), and
 * - GET /dataset_quality?dataset_id={id} (Meta "Dataset Quality API": dataset_id, fields, agent_name; aggregates only).
 */
const gateway = 'meta_native_action';
export const metaDatasetResource = (pixel: string) => 'adspixels/' + pixel;
/** The fields of the Ads Pixel node a read may name (D5, 2026-11-21): the ledger's own (src/measurement-ledger-meta.ts). */
export const metaPixelNodeFields: readonly string[] = Object.freeze([
  'id',
  'name',
  'owner_business',
  'creation_time',
  'last_fired_time',
  'is_unavailable',
]);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
// The stats edge pages with Graph API cursors, so 'after' continues the same read (MSR-03 review fix).
const statsQuery = ['aggregation', 'start_time', 'end_time', 'event', 'event_source', 'after'],
  qualityQuery = ['dataset_id', 'fields', 'agent_name'];
const emptyBody = (body: unknown) =>
  body === undefined ||
  (!!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body as JsonObject).length === 0);

/** The pixel an aggregate measurement read of Meta addresses, or undefined for any other request. */
export function metaDatasetRead(p: CompiledRequest): string | undefined {
  if (
    p.gateway !== gateway ||
    p.method !== 'GET' ||
    !p.readOnly ||
    !emptyBody(p.body) ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://graph.facebook.com')
  )
    return;
  const stats = metaRoute('([1-9][0-9]{0,31})/stats$').exec(p.path)?.[1];
  if (stats) return Object.keys(p.query).every(k => statsQuery.includes(k)) ? stats : undefined;
  if (
    metaRoute('dataset_quality$').test(p.path) &&
    numeric(p.query.dataset_id) &&
    Object.keys(p.query).every(k => qualityQuery.includes(k))
  )
    return p.query.dataset_id;
  return;
}
/** True for an aggregate read of a pixel the selected account listed to this connection in the last five minutes. */
export function authorizeMetaDatasetRead(p: CompiledRequest, c: Connection, account: string, store: Store): boolean {
  const pixel = metaDatasetRead(p);
  return !!pixel && store.ownsResource(c, account, metaDatasetResource(pixel));
}
/**
 * The pixel a node read addresses (r25-field2-access, B1): the action meta_pixel_id_get, a GET of the node's own path, no body,
 * no special transport and Graph's own origin; undefined for any other request, so a write to the node, an edge, another
 * action of the same path and every other node keep the checks they had.
 */
export function metaPixelNodeRead(p: CompiledRequest): string | undefined {
  if (
    p.gateway !== gateway ||
    p.action !== 'meta_pixel_id_get' ||
    p.method !== 'GET' ||
    !p.readOnly ||
    !emptyBody(p.body) ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://graph.facebook.com')
  )
    return;
  return metaRoute('([1-9][0-9]{0,31})$').exec(p.path)?.[1];
}
/**
 * True for a node read of a pixel the selected account listed to this connection in the last five minutes. A read that names a
 * field outside metaPixelNodeFields, a nested field, no field or any other query parameter is refused INVALID_ARGUMENT before
 * the ownership is looked at and before any request, owned or not, so it says nothing about the pixel.
 */
export function authorizeMetaPixelNodeRead(p: CompiledRequest, c: Connection, account: string, store: Store): boolean {
  const pixel = metaPixelNodeRead(p);
  if (!pixel) return false;
  const named = typeof p.query.fields === 'string' && p.query.fields ? p.query.fields.split(',') : undefined;
  if (Object.keys(p.query).some(key => key !== 'fields') || !named || named.some(f => !metaPixelNodeFields.includes(f)))
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'A pixel read names only these fields: id, name, owner_business, creation_time, last_fired_time and is_unavailable. Send fields with some of them and no other query parameter.',
      {field: 'fields', allowed_fields: [...metaPixelNodeFields]},
    );
  return store.ownsResource(c, account, metaDatasetResource(pixel));
}
/** Learns the pixels of a successful, account-scoped pixel list (ScopeGuard.observe has authorized its path). */
export function observeMetaPixels(p: CompiledRequest, c: Connection, account: string, data: unknown, store: Store) {
  if (p.gateway !== gateway || p.method !== 'GET' || !metaRoute('act_[0-9]{1,32}/adspixels$').test(p.path)) return;
  const d = data as JsonObject;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.error !== undefined || !Array.isArray(d.data)) return;
  for (const row of d.data as unknown[]) {
    const id = row && typeof row === 'object' ? (row as JsonObject).id : undefined;
    if (numeric(id)) store.rememberResource(c, account, metaDatasetResource(id));
  }
}
