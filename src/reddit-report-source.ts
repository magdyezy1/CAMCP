import {redditConversionValueDivisor} from './report-metrics.js';
import type {ReportSource} from './report-source.js';

/** Reddit Ads report rows, in upper- or lower-case field names; spend in micros, conversion value in cents (ACC-06). */
export const redditReportSource: ReportSource = {
  platform: 'reddit',
  nativeMetricExamples: [
    'VIDEO_STARTED',
    'VIDEO_VIEWABLE_IMPRESSIONS',
    'CONVERSION_PURCHASE_TOTAL_ITEMS',
    'CONVERSION_PURCHASE_TOTAL_VALUE',
  ],
  normalize(raw, {value}) {
    return {
      id: raw.campaign_id ?? raw.CAMPAIGN_ID,
      name: raw.campaign_name,
      objective: raw.objective,
      metrics: {
        spend: value(raw.SPEND ?? raw.spend, 1e6),
        impressions: value(raw.IMPRESSIONS ?? raw.impressions),
        clicks: value(raw.CLICKS ?? raw.clicks),
        purchases: value(raw.CONVERSION_PURCHASE_TOTAL_ITEMS ?? raw.conversion_purchase_total_items),
        conversion_value: value(
          raw.CONVERSION_PURCHASE_TOTAL_VALUE ?? raw.conversion_purchase_total_value,
          redditConversionValueDivisor,
        ),
      },
    };
  },
};
