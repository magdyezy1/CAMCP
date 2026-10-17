import type {ReportSource} from './report-source.js';

/** X campaign rows as xCampaignReport (src/x-campaign-report.ts) prepares them: the metrics are already shared ones. */
export const xReportSource: ReportSource = {
  platform: 'x',
  nativeMetricExamples: ['VIDEO', 'WEB_CONVERSION', 'MOBILE_CONVERSION'],
  normalize(raw) {
    return {id: raw.id, name: raw.name, objective: raw.objective, metrics: raw.metrics ?? {}};
  },
};
