import {objectiveGroup} from './report-metrics.js';
import type {ReportSource} from './report-source.js';
import type {JsonObject} from './types.js';

/** Snapchat campaign stats rows (micros); conversions follow the campaign objective. */
export const snapchatReportSource: ReportSource = {
  platform: 'snapchat',
  nativeMetricExamples: [
    'video_views',
    'view_completion',
    'conversion_purchases',
    'conversion_purchases_value',
    'conversion_sign_ups',
    'total_installs',
  ],
  nativeMetricContainer: 'stats',
  normalize(raw, {value}) {
    const objective = raw.objective,
      m = raw.stats ?? {};
    const metrics: JsonObject = {
      spend: value(m.spend, 1e6),
      impressions: value(m.impressions),
      clicks: value(m.swipes),
      purchases: value(m.conversion_purchases),
      conversion_value: value(m.conversion_purchases_value, 1e6),
      leads: value(m.conversion_sign_ups),
      installs: value(m.total_installs),
      video_views: value(m.video_views),
      video_completions: value(m.view_completion),
    };
    metrics.conversions =
      objectiveGroup(objective) === 'app_installs'
        ? metrics.installs
        : objectiveGroup(objective) === 'leads'
          ? metrics.leads
          : objectiveGroup(objective) === 'sales'
            ? metrics.purchases
            : null;
    return {id: raw.id, name: raw.name, objective, metrics};
  },
};
