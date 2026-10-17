import type {ReportSource} from './report-source.js';

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
