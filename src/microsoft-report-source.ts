import type {ReportSource} from './report-source.js';

/** Microsoft Advertising campaign performance report rows (decimal money in the account currency). */
export const microsoftReportSource: ReportSource = {
  platform: 'microsoft',
  nativeMetricExamples: [
    'AllConversions',
    'AllRevenue',
    'Assists',
    'ViewThroughConversions',
    'QualityScore',
    'PhoneCalls',
    'ImpressionSharePercent',
  ],
  normalize(raw, {field: n}) {
    return {
      id: raw.CampaignId,
      name: raw.CampaignName,
      currency: raw.CurrencyCode,
      metrics: {
        spend: n('Spend'),
        impressions: n('Impressions'),
        clicks: n('Clicks'),
        conversions: n('Conversions'),
        conversion_value: n('Revenue'),
      },
    };
  },
};
