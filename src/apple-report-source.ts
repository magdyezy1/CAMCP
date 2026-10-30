import {MirrorError} from './errors.js';
import {appleDetail, nativeDetailLookupLimit, nativeDetailLookupLimitedWarning} from './overview-native-detail.js';
import {detailParentsUnavailableWarning, optionalReadRefused} from './overview-parents.js';
import {reportList, type ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';

const appleOrigin = 'https://api.ads.apple.com';

/** Apple Ads reports days in UTC. */
const reportZone = 'UTC';

/** Apple Ads v1 campaign report rows: totalMetrics with local spend; conversions are installs. */
export const appleReportSource: ReportSource = {
  platform: 'apple',
  nativeMetricExamples: [],
  // The collection reads the ad account itself (its currency; Apple reports in UTC).
  accountLookup: false,
  // RPT-07: its own reports collect the ad group and ad levels.
  nativeDetail: true,
  // Apple report rows nest their metrics in their own shape, so requested metrics are not checked against them.
  nativeMetricCheck: false,
  // The account and the report.
  minimumRequestsPerPeriod: 2,
  fixedTimezone: reportZone,
  /**
   * The ad account (its currency; Apple reports in UTC), then one bounded campaign report page, or for the RPT-07 ad
   * group and ad levels one bounded report page and the account's own records for exact parents.
   */
  async collect(c) {
    const m = await c.run({...c.plan('/v1/ad-accounts/' + c.account), origin: appleOrigin}, false);
    c.metadata = m.result ?? m;
    c.currency = c.metadata.currency ?? null;
    c.timezone = reportZone;
    if (c.detail) {
      // RPT-07: one bounded ad group or ad report page, then the account's own records for exact parents.
      const detail = c.detail,
        entity = detail === 'ad' ? 'ads' : 'adgroups',
        apple = (path: string, body: JsonObject, action: string, stage?: string) =>
          c.run({...c.plan(path, {}, body, appleOrigin), action}, false, stage);
      const d = await apple(
        '/v1/reports/apps/' + entity + '/query',
        {
          timeRange: {start: c.range.since, end: c.range.until, timeZone: 'UTC'},
          pagination: {offset: 0, pageSize: 1000},
          options: {},
        },
        'apple_ads_v1_reports_apps_' + entity,
      );
      c.raw = reportList(d.result?.rows ?? []);
      const total = d.pagination?.totalResults ?? d.result?.pagination?.totalResults;
      if (c.raw.length >= 1000 || (total !== undefined && Number(total) !== c.raw.length))
        throw new MirrorError(
          'INCOMPLETE_REPORT',
          'Report reached a pagination limit. Split the date range or accounts.',
        );
      // Apple IDs are JSON numbers; only safe integers can be requested and matched exactly.
      const safeId = (id: string) => /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)),
        lists = {campaigns: [] as JsonObject[], adGroups: [] as JsonObject[], ads: [] as JsonObject[]},
        ids = [...new Set(c.raw.map(r => String(r.metadata?.id ?? '')))].filter(safeId);
      if (ids.length > nativeDetailLookupLimit) c.warnings.push(nativeDetailLookupLimitedWarning);
      const query = async (kind: 'campaigns' | 'adgroups' | 'ads', wanted: string[]) => {
        if (!wanted.length) return [];
        const rows = reportList(
          (
            await apple(
              '/v1/' + kind + '/query',
              {
                filters: [{field: 'id', operator: 'IN', value: wanted.map(Number)}],
                pagination: {offset: 0, pageSize: 1000},
              },
              'apple_ads_v1_' + kind + '_query',
              'detail_parents',
            )
          ).result ?? [],
        );
        if (rows.length > wanted.length || rows.some(r => !wanted.includes(String(r.id))))
          throw new MirrorError(
            'REPORT_SHAPE_CHANGED',
            'Apple returned an unrequested or repeated parent record.',
            {},
            502,
          );
        return rows;
      };
      const parentIds = (rows: JsonObject[], key: string) =>
        [...new Set(rows.map(r => String(r[key] ?? '')))].filter(safeId);
      try {
        const wanted = ids.slice(0, nativeDetailLookupLimit);
        if (detail === 'ad') lists.ads = await query('ads', wanted);
        lists.adGroups = await query('adgroups', detail === 'ad' ? parentIds(lists.ads, 'adGroupId') : wanted);
        lists.campaigns = await query('campaigns', [
          ...new Set([...parentIds(lists.adGroups, 'campaignId'), ...parentIds(lists.ads, 'campaignId')]),
        ]);
      } catch (e) {
        // Only a provider refusal of these reads keeps the rows with unknown parents (as for other detail levels).
        if (!optionalReadRefused(e)) throw e;
        lists.campaigns = lists.adGroups = lists.ads = [];
        c.warnings.push(detailParentsUnavailableWarning);
      }
      c.resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
      c.detailRows = appleDetail(detail, c.raw, lists, c.currency, c.detailRounding);
    } else {
      const d = await c.run({
        ...c.plan(
          '/v1/reports/apps/campaigns/query',
          {},
          {
            timeRange: {start: c.range.since, end: c.range.until, timeZone: 'UTC'},
            pagination: {offset: 0, pageSize: 100},
            options: {},
          },
          appleOrigin,
        ),
        action: 'apple_ads_v1_reports_apps_campaigns',
      });
      c.raw = reportList(d.result?.rows ?? d.result ?? []);
      c.resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
      if (c.extra.length)
        c.warnings.push(
          'Apple report returns native metric columns; arbitrary field selection is not supported by this endpoint.',
        );
    }
  },
  normalize(raw, {value}) {
    const m = raw.totalMetrics;
    if (!m || typeof m !== 'object' || Array.isArray(m))
      throw new MirrorError('REPORT_SHAPE_CHANGED', 'Apple v1 report row is missing totalMetrics.', {}, 502);
    return {
      id: raw.metadata?.id,
      name: raw.metadata?.name,
      objective: 'APP_INSTALLS',
      currency: m.localSpend?.currency,
      metrics: {
        spend: value(m.localSpend?.amount),
        impressions: value(m.impressions),
        clicks: value(m.taps),
        installs: value(m.totalInstalls),
        conversions: value(m.totalInstalls),
      },
    };
  },
};
