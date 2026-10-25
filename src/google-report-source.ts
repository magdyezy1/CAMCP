import {googleAdsCustomers} from './google-version.js';
import {googleGuidedReporting} from './google-guided-reports.js';
import {reportList, type ReportSource} from './report-source.js';

/** Google Ads campaign rows of googleAds:search (ProtoJSON camelCase; cost in micros). */
export const googleReportSource: ReportSource = {
  platform: 'google',
  nativeMetricExamples: [
    'metrics.all_conversions',
    'metrics.all_conversions_value',
    'metrics.interactions',
    'metrics.video_views',
    'metrics.engagements',
    'metrics.view_through_conversions',
  ],
  nativeMetricContainer: 'metrics',
  // Requested native metrics may name GAQL metric fields (`metrics.all_conversions`).
  nativeMetricName: /^metrics\.[a-z][a-z0-9_]{0,80}$/,
  minimumRequestsPerPeriod: 1,
  // RPT-03: one request segmented by `segments.date`.
  daily: {day: native => native?.segments?.date},
  guided: googleGuidedReporting,
  /** One GAQL campaign query over the period, with the requested native metrics (and the date segment when daily). */
  async collect(c) {
    const fields = [
      ...new Set([
        'campaign.id',
        'campaign.name',
        'campaign.status',
        'campaign.advertising_channel_type',
        'customer.currency_code',
        'metrics.cost_micros',
        'metrics.impressions',
        'metrics.clicks',
        'metrics.conversions',
        'metrics.conversions_value',
        ...(c.segment === 'daily' ? ['segments.date'] : []),
        ...c.extra,
      ]),
    ];
    c.raw = reportList(
      (
        await c.run(
          c.plan(
            googleAdsCustomers + c.account + '/googleAds:search',
            {},
            {
              query: `SELECT ${fields.join(', ')} FROM campaign WHERE segments.date BETWEEN '${c.range.since}' AND '${c.range.until}'`,
            },
          ),
        )
      ).results ?? [],
    );
    c.resultDefinition = 'Google primary conversions (conversions column; interaction date)';
  },
  normalize(raw, {value}) {
    const m = raw.metrics ?? {};
    return {
      id: raw.campaign?.id,
      name: raw.campaign?.name,
      objective: null,
      currency: raw.customer?.currencyCode,
      metrics: {
        spend: value(m.costMicros, 1e6),
        impressions: value(m.impressions),
        clicks: value(m.clicks),
        conversions: value(m.conversions),
        conversion_value: value(m.conversionsValue),
        video_views: value(m.videoViews),
        engagements: value(m.engagements),
      },
    };
  },
};

/** RPT-04: Search Console requests no more rows than one source may hold, so a large site keeps its top pages. */
const searchConsoleRowLimit = 10000;
/** Search Console reports days in Pacific time. */
const searchConsoleZone = 'America/Los_Angeles';

/** Search Console rows of searchAnalytics.query: one row per first dimension key, or the whole site. */
export const searchConsoleReportSource: ReportSource = {
  platform: 'gsc',
  nativeMetricExamples: [],
  // The site is the source: no account is read before collection.
  accountLookup: false,
  minimumRequestsPerPeriod: 1,
  fixedTimezone: searchConsoleZone,
  /** One final-data page report of the site (Search Console reports in Pacific time), bounded to the row limit. */
  async collect(c) {
    c.timezone = searchConsoleZone;
    const d = await c.run(
      c.plan(
        '/webmasters/v3/sites/' + encodeURIComponent(c.account) + '/searchAnalytics/query',
        {},
        {
          startDate: c.range.since,
          endDate: c.range.until,
          dimensions: ['page'],
          // RPT-04: request no more rows than one source may hold, so a large site keeps its top pages.
          rowLimit: searchConsoleRowLimit,
          startRow: 0,
          dataState: 'final',
        },
      ),
      false,
    );
    c.raw = reportList(d.rows ?? []);
    if (c.raw.length >= searchConsoleRowLimit) {
      c.raw = c.raw.slice(0, searchConsoleRowLimit);
      c.complete = false;
      c.collectionComplete = false;
      c.warnings.push(
        'Search Console returned the 10,000-row request limit; lower-ranked pages are not included, so this organic context is partial.',
      );
    }
    // Owner policy P6: top-row coverage with privacy omissions is the scope of this organic source, not a failure.
    c.scopeLimitations.push('search_console_top_rows');
    c.warnings.push(
      'Search Console reports pages, not paid campaigns, and returns top rows with privacy omissions. This is organic context, not a reconciled advertising total.',
    );
  },
  normalize(raw, {field}) {
    const id = raw.keys?.[0] ?? 'site';
    return {
      id,
      name: id,
      metrics: {clicks: field('clicks'), impressions: field('impressions'), position: field('position')},
    };
  },
};
