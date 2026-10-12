import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

/**
 * The internal reads of the read-only Snapchat catalog comparison (COM-02 D, src/snapchat-catalog-comparison.ts),
 * kept apart so the scope guard can authorize them without importing the comparison. Each read is tagged by the read
 * before it: the selected ad account; then its organization's catalog; then that catalog's product search for 1–50
 * supplied product IDs. Every other request under the marker is refused.
 */
export const snapCompareGateway = 'snapchat_native_action',
  snapCompareMarker = 'AMCP_SNAPCHAT_CATALOG_COMPARISON_READ',
  /** Products per search page (Snapchat accepts 50–1000). */
  snapComparePageLimit = 1000;
export type SnapCompareRead = CompiledRequest & {snapCompareOrg?: string; snapCompareCatalog?: string};
export const snapObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
export const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
export const snapText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v === v.trim() && v.length > 0 && [...v].length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** A supplied product ID as the search filter carries it (the retailer_id of the source). */
export const snapProductId = (v: unknown): v is string => snapText(v, 100);
export function snapCompareRead(account: string, path: string, extra: Partial<SnapCompareRead> = {}): SnapCompareRead {
  return {
    gateway: snapCompareGateway,
    accountId: account,
    action: snapCompareMarker,
    method: 'GET',
    path,
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'AMCP read-only Snapchat catalog comparison',
    warnings: [],
    ...extra,
  } as SnapCompareRead;
}
/** The search body: the product-set filter grammar with one ID IS_ANY condition. */
export const snapSearchBody = (ids: string[]): JsonObject => ({filter: {ID: {IS_ANY: ids}}});
export function authorizeSnapCatalogComparisonRead(p: CompiledRequest, _c: Connection, account: string): boolean {
  if (p.gateway !== snapCompareGateway || p.action !== snapCompareMarker) return false;
  const r = p as SnapCompareRead,
    keys = Object.keys(p.query ?? {}),
    plain = p.readOnly && p.accountId === account && !Object.keys(p.headers ?? {}).length;
  if (plain && p.method === 'GET' && p.path === '/v1/adaccounts/' + account) {
    if (!keys.length && p.body === undefined && !r.snapCompareOrg && !r.snapCompareCatalog) return true;
  } else if (plain) {
    const m = /^\/v1\/catalogs\/([A-Za-z0-9-]{1,64})(\/products\/search)?$/.exec(p.path);
    if (m && snapId(r.snapCompareOrg) && r.snapCompareCatalog === m[1]) {
      if (!m[2]) {
        if (p.method === 'GET' && !keys.length && p.body === undefined) return true;
      } else {
        const b = p.body,
          filter = snapObject(b) ? b.filter : undefined,
          id = snapObject(filter) ? filter.ID : undefined,
          ids = snapObject(id) ? id.IS_ANY : undefined;
        // ids is an array only when the body, its filter and its ID condition are objects.
        if (
          p.method === 'POST' &&
          Array.isArray(ids) &&
          keys.every(k => ['limit', 'cursor'].includes(k)) &&
          p.query.limit === snapComparePageLimit &&
          (p.query.cursor === undefined || snapText(p.query.cursor, 2048)) &&
          Object.keys(b as JsonObject).length === 1 &&
          Object.keys(filter as JsonObject).length === 1 &&
          Object.keys(id as JsonObject).length === 1 &&
          ids.length >= 1 &&
          ids.length <= 50 &&
          ids.every(snapProductId) &&
          new Set(ids).size === ids.length
        )
          return true;
      }
    }
  }
  throw new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Unqualified internal catalog read.', {}, 403);
}
