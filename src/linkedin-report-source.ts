import type {ReportSource} from './report-source.js';

/** LinkedIn adAnalytics rows pivoted by campaign (its URN in pivotValues); money in the account currency. */
export const linkedinReportSource: ReportSource = {
  platform: 'linkedin',
  nativeMetricExamples: [
    'videoViews',
    'videoCompletions',
    'likes',
    'comments',
    'shares',
    'externalWebsiteConversions',
    'externalWebsitePostClickConversions',
    'externalWebsitePostViewConversions',
    'conversionValueInLocalCurrency',
    'oneClickLeads',
  ],
  normalize(raw, {field: n}) {
    return {
      id: raw.pivotValues?.[0]?.split(':').at(-1),
      name: raw.name,
      objective: raw.objectiveType,
      metrics: {
        spend: n('costInLocalCurrency'),
        impressions: n('impressions'),
        clicks: n('clicks'),
        conversions: n('externalWebsiteConversions'),
        conversion_value: n('conversionValueInLocalCurrency'),
        leads: n('oneClickLeads'),
        video_views: n('videoViews'),
        video_completions: n('videoCompletions'),
      },
    };
  },
};
