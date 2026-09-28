import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/** A missing Insights collection is a protocol failure, not evidence of no delivery. */
export function metaCampaignRows(
  data: JsonObject,
  account: string,
  range: {since: string; until: string},
): JsonObject[] {
  if (
    !Array.isArray(data.data) ||
    data.data.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))
  )
    throw new MirrorError(
      'REPORT_SHAPE_CHANGED',
      'Meta Insights did not return its campaign data collection. No empty report was accepted.',
      {},
      502,
    );
  for (const row of data.data) {
    if (row.account_id !== undefined && String(row.account_id).replace(/^act_/, '') !== account)
      throw new MirrorError('REPORT_ACCOUNT_MISMATCH', 'Meta returned report rows for a different account.', {}, 502);
    for (const field of ['date_start', 'date_stop'])
      if (row[field] !== undefined) {
        const date = row[field];
        if (
          typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date)) ||
          new Date(date).toISOString().slice(0, 10) !== date ||
          date < range.since ||
          date > range.until
        )
          throw new MirrorError(
            'REPORT_DATE_MISMATCH',
            'Meta returned report dates outside the requested period.',
            {requested: range, field},
            502,
          );
      }
    if (row.date_start && row.date_stop && row.date_start > row.date_stop)
      throw new MirrorError('REPORT_DATE_MISMATCH', 'Meta returned an inverted reporting period.', {}, 502);
  }
  return data.data;
}
