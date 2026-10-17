import type {ReportSource} from './report-source.js';

/** TikTok integrated report rows (dimensions and metrics); conversions name the ad groups' optimization events. */
export const tiktokReportSource: ReportSource = {
  platform: 'tiktok',
  nativeMetricExamples: [
    'reach',
    'frequency',
    'video_play_actions',
    'video_watched_2s',
    'video_watched_6s',
    'video_views_p100',
    'likes',
    'comments',
    'shares',
    'follows',
    'total_purchase',
    'total_purchase_value',
  ],
  nativeMetricContainer: 'metrics',
  normalize(raw, {value}) {
    const m = raw.metrics ?? {};
    // RPT-04: the result definition names the campaign's ad group optimization events; mixed events are held.
    const events: string[] = Array.isArray(raw.optimization_events) ? raw.optimization_events : [];
    let resultDefinition: string | undefined,
      mixedResult = false;
    if (events.length === 1) resultDefinition = 'TikTok conversions for optimization event ' + events[0];
    else if (events.length > 1) {
      resultDefinition = 'TikTok conversions mixing optimization events: ' + events.join(', ');
      mixedResult = true;
    }
    return {
      id: raw.dimensions?.campaign_id,
      name: m.campaign_name,
      objective: raw.objective_type,
      metrics: {
        spend: value(m.spend),
        impressions: value(m.impressions),
        clicks: value(m.clicks),
        conversions: value(m.conversion),
        reach: value(m.reach),
        frequency: value(m.frequency),
        video_views: value(m.video_play_actions),
        video_completions: value(m.video_views_p100),
        purchases: value(m.total_purchase),
        conversion_value: value(m.total_purchase_value),
      },
      resultDefinition,
      mixedResult,
    };
  },
};
