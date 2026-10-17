import {MirrorError} from './errors.js';
import type {ReportSource} from './report-source.js';

/** Apple Ads v1 campaign report rows: totalMetrics with local spend; conversions are installs. */
export const appleReportSource: ReportSource = {
  platform: 'apple',
  nativeMetricExamples: [],
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
