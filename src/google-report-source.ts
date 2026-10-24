import {googleAdsCustomers} from './google-version.js';
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
  // RPT-03: one request segmented by `segments.date`.
  daily: {day: native => native?.segments?.date},
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

/** Search Console rows of searchAnalytics.query: one row per first dimension key, or the whole site. */
export const searchConsoleReportSource: ReportSource = {
  platform: 'gsc',
  nativeMetricExamples: [],
  normalize(raw, {field}) {
    const id = raw.keys?.[0] ?? 'site';
    return {
      id,
      name: id,
      metrics: {clicks: field('clicks'), impressions: field('impressions'), position: field('position')},
    };
  },
};
