import {MirrorError} from './errors.js';
import type {ReportCollection} from './report-source.js';
import {appleQueryBounds, appleQueryPages, appleSafeId} from './apple-report-pages.js';
import type {JsonObject} from './types.js';

/**
 * The exact campaigns of a report, looked up in the same Apple ad-account context: their IDs in batches of at most 1,000,
 * each batch read to its last page (src/apple-report-pages.ts).
 */
export async function appleCampaignMetadata(c: ReportCollection): Promise<Record<string, JsonObject>> {
  const wanted = [
    ...new Set(
      c.raw.map(row => {
        const id = row.metadata?.id;
        return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
      }),
    ),
  ];
  if (wanted.some(value => !appleSafeId(value)))
    throw new MirrorError(
      'REPORT_ID_MISSING',
      'The provider report did not include a safe campaign/resource identifier.',
      {},
      502,
    );
  const records: Record<string, JsonObject> = {};
  for (let at = 0; at < wanted.length; at += appleQueryBounds.ids_per_query) {
    const batch = new Set(wanted.slice(at, at + appleQueryBounds.ids_per_query)),
      read = await appleQueryPages(c, {
        kind: 'entities',
        list: 'campaigns',
        path: '/v1/campaigns/query',
        action: 'apple_ads_v1_campaigns_query',
        stage: 'entity_metadata',
        body: {filters: [{field: 'id', operator: 'IN', value: [...batch].map(Number)}]},
      });
    for (const row of read.rows) {
      const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
      if ((typeof row.id === 'number' && !Number.isSafeInteger(row.id)) || !batch.has(id) || Object.hasOwn(records, id))
        throw new MirrorError(
          'REPORT_SHAPE_CHANGED',
          'Apple returned an unrequested or repeated parent record.',
          {},
          502,
        );
      if (String(row.adAccountId) !== c.account)
        throw new MirrorError(
          'REPORT_ACCOUNT_MISMATCH',
          'The native entity belongs to another advertising account.',
          {},
          502,
        );
      records[id] = row;
    }
  }
  return records;
}
