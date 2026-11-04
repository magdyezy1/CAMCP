import {metaPrefix} from './meta-version.js';
import {currentStatusUnavailableWarning} from './report-status.js';
import type {DetailParentReader} from './report-source.js';
import type {JsonObject} from './types.js';

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const kinds: Record<string, {edge: string; action: string}> = {
  meta_campaign: {edge: 'campaigns', action: 'meta_campaign_list'},
  meta_adset: {edge: 'adsets', action: 'meta_adset_list'},
  meta_ad: {edge: 'ads', action: 'meta_ad_list'},
};

/** Account-owned current metadata, at most two 500-entity pages. Unseen entities retain unknown status. */
export const metaReportMetadata: DetailParentReader = Object.freeze<DetailParentReader>({
  unavailableWarning: currentStatusUnavailableWarning,
  limitedWarning: currentStatusUnavailableWarning,
  kind: (level, _scoped, contract) =>
    contract === 'overview-config-v4' && ['campaign', 'adset', 'ad'].includes(level) ? 'meta_' + level : undefined,
  async read(kind, wanted, {account, read, record, shape, foreign}) {
    const declaration = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
    if (!declaration) shape('The native metadata level is unsupported.');
    const {edge, action} = declaration!;
    const seen = new Set<string>(),
      cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 2; page++) {
      const data = await read(action, metaPrefix + 'act_' + account + '/' + edge, {
        fields: 'id,account_id,status,configured_status,effective_status',
        limit: 500,
        ...(after ? {after} : {}),
      });
      if (!Array.isArray(data.data) || data.data.length > 500) shape('Native entity metadata is malformed.');
      for (const row of data.data as JsonObject[]) {
        if (!object(row) || !id(row.id) || seen.has(row.id)) shape('Native entity metadata is malformed.');
        if (row.account_id !== account) foreign('The native entity belongs to another advertising account.');
        seen.add(row.id);
        if (wanted.includes(row.id)) record(row.id, {entity_metadata: row});
      }
      if (wanted.every(value => seen.has(value)) || !data.paging?.next) break;
      const cursor = data.paging?.cursors?.after;
      if (
        typeof cursor !== 'string' ||
        !cursor ||
        cursor.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(cursor) ||
        cursors.has(cursor)
      )
        shape('Native entity metadata pagination is malformed.');
      cursors.add(cursor);
      after = cursor;
    }
  },
});
