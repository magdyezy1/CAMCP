import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {metaRoute} from './meta-version.js';

/**
 * Ownership of Meta pixels (datasets) for aggregate measurement reads (MSR-03, owner direction P8). A pixel ID does not
 * name its ad account, so ScopeGuard cannot bind a read of it to the selected account. The account's own pixel list,
 * GET /act_{ad_account_id}/adspixels (Meta "Ad Account Adspixels", read 2026-10-11), is the evidence: each pixel it lists
 * is remembered for that connection and account for five minutes under its own key (adspixels/{id}).
 *
 * That ownership opens only two aggregate reads, never the pixel node, its users, its events or any write:
 * - GET /{ads_pixel_id}/stats (Meta "Ads Pixel Stats": aggregation, start_time, end_time, event, event_source; data
 *   "up to seven days from the request time"), and
 * - GET /dataset_quality?dataset_id={id} (Meta "Dataset Quality API": dataset_id, fields, agent_name; aggregates only).
 */
const gateway = 'meta_native_action';
export const metaDatasetResource = (pixel: string) => 'adspixels/' + pixel;
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
