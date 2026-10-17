import type {ReportSource} from './report-source.js';

/** GA4 runReport rows by session campaign; conversions are key events. */
export const ga4ReportSource: ReportSource = {
  platform: 'ga4',
  nativeMetricExamples: [
    'engagedSessions',
    'engagementRate',
    'bounceRate',
    'screenPageViews',
    'averageSessionDuration',
    'eventCount',
    'ecommercePurchases',
    'purchaseRevenue',
  ],
  normalize(raw, {field: n}) {
    return {
      id: raw.campaign_id,
      name: raw.campaign_name,
      metrics: {
        sessions: n('sessions'),
        users: n('totalUsers'),
        conversions: n('keyEvents'),
        conversion_value: n('totalRevenue'),
        purchases: n('ecommercePurchases'),
      },
    };
  },
};
