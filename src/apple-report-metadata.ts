import {MirrorError} from './errors.js';
import {reportList, type ReportCollection} from './report-source.js';
import type {JsonObject} from './types.js';

/** Exact campaign IDs from a bounded report, looked up in the same Apple ad-account context. */
export async function appleCampaignMetadata(c: ReportCollection): Promise<Record<string, JsonObject>> {
  const wanted = [
    ...new Set(
      c.raw.map(row => {
        const id = row.metadata?.id;
        return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
      }),
    ),
  ];
  if (wanted.some(value => !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))))
    throw new MirrorError(
      'REPORT_ID_MISSING',
      'The provider report did not include a safe campaign/resource identifier.',
      {},
      502,
    );
  if (!wanted.length) return {};
  const data = await c.run(
    {
      ...c.plan(
        '/v1/campaigns/query',
        {},
        {
          filters: [{field: 'id', operator: 'IN', value: wanted.map(Number)}],
          pagination: {offset: 0, pageSize: 1000},
        },
        'https://api.ads.apple.com',
      ),
      action: 'apple_ads_v1_campaigns_query',
    },
    false,
    'entity_metadata',
  );
  const rows = reportList(data.result ?? []),
    total = data.pagination?.totalResults,
    records: Record<string, JsonObject> = {};
  if (
    rows.length > wanted.length ||
    (total !== undefined && (!Number.isSafeInteger(Number(total)) || Number(total) !== rows.length))
  )
    throw new MirrorError('REPORT_INCOMPLETE', 'Native parents were not returned completely.', {}, 502);
  for (const row of rows) {
    const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
    if (
      (typeof row.id === 'number' && !Number.isSafeInteger(row.id)) ||
      !wanted.includes(id) ||
      Object.hasOwn(records, id)
    )
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
  return records;
}
