import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {MirrorError} from './errors.js';
import {stateRead} from './write-snapshots.js';

/**
 * The ads a Snapchat creative edit changes (WRT-05 Stage C). Every ad that references an edited creative uses the
 * changed creative, so the review lists them: a bounded read of the account's ads collection (at most 25 pages of
 * 1,000) through the review's guarded reader, projecting each matching ad's id, name, status and ad squad. Past the
 * bound the list is null with `incomplete: true`; it is never a partial list. The read is a disclosure, not part of the
 * state the review freezes, so it does not make the review stale. `affected_ad_ids` names every matching ad;
 * `affected_ads` details at most the first 100 of them (`affected_ad_count` is the total and `listed_truncated` says
 * whether some are not detailed), so a widely shared creative keeps the review compact.
 */
export const snapAffectedAdPages = 25;
export const snapAffectedAdsListed = 100;
const pageSize = '1000';
const origin = 'https://adsapi.snapchat.com';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const malformed = (): never => {
  throw new MirrorError('SNAPCHAT_ADS_READ_INVALID', 'Snapchat returned an ads page AMCP cannot read completely.');
};
const text = (v: unknown, limit = 375) =>
  typeof v === 'string' && v.length <= limit && !/[\u0000-\u001f]/.test(v) ? v : undefined;
/** The continuation cursor of a page, or undefined on the last page. */
function nextCursor(data: JsonObject, path: string): string | undefined {
  const link = data.paging?.next_link;
  if (link === undefined || link === null || link === '') return undefined;
  try {
    if (typeof link !== 'string' || link.length > 8192) throw Error();
    const u = new URL(link),
      cursor = u.searchParams.get('cursor');
    if (
      u.origin !== origin ||
      u.username ||
      u.password ||
      u.hash ||
      u.pathname !== path ||
      [...u.searchParams.keys()].some(k => !['limit', 'cursor'].includes(k) || u.searchParams.getAll(k).length !== 1) ||
      !cursor ||
      cursor.length > 4096
    )
      throw Error();
    return cursor;
  } catch {
    return malformed();
  }
}
export async function snapchatAffectedAds(
  plan: CompiledRequest,
  creativeIds: unknown[],
  read: (request: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject> {
  const path = '/v1/adaccounts/' + plan.accountId + '/ads',
    wanted = new Set(creativeIds.map(String)),
    ads: JsonObject[] = [];
  let cursor: string | undefined,
    pages = 0;
  do {
    if (pages === snapAffectedAdPages)
      return {
        affected_ad_ids: null,
        affected_ads: null,
        incomplete: true,
        enumeration: 'bound_exceeded',
        pages_read: pages,
        page_bound: snapAffectedAdPages,
      };
    const response = await read(stateRead(plan, path, {limit: pageSize, ...(cursor ? {cursor} : {})}));
    pages++;
    const data = response.data;
    if (!object(data) || String(data.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(data.ads))
      malformed();
    for (const row of (data as JsonObject).ads) {
      if (!object(row) || String(row.sub_request_status).toUpperCase() !== 'SUCCESS' || !object(row.ad)) malformed();
      const ad = row.ad as JsonObject;
      if (!text(ad.id, 200)) malformed();
      if (ad.creative_id !== undefined && wanted.has(String(ad.creative_id)))
        ads.push({
          id: ad.id,
          name: text(ad.name) ?? null,
          status: text(ad.status, 80) ?? null,
          ad_squad_id: text(ad.ad_squad_id, 200) ?? null,
          creative_id: String(ad.creative_id),
        });
    }
    cursor = nextCursor(data as JsonObject, path);
  } while (cursor);
  return {
    affected_ad_ids: ads.map(a => a.id),
    affected_ads: ads.slice(0, snapAffectedAdsListed),
    affected_ad_count: ads.length,
    listed_truncated: ads.length > snapAffectedAdsListed,
    incomplete: false,
    enumeration: 'account_ads_read',
    pages_read: pages,
  };
}
