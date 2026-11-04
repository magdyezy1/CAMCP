import {bad} from './workspace-core.js';
import type {GuidedReporting} from './report-source.js';
import {collectTikTokDailyReport, tiktokDailyRange, tiktokReportDate} from './tiktok-reporting.js';
import {tiktokStatusFilter} from './tiktok-report-request.js';

/**
 * TikTok's guided reporting (ARC-04 stage F): its capture presets (BASIC auction daily reports by campaign, ad group
 * and ad) and the integrated report each defines. TikTok's report source declares it; src/report-presets.ts lists the
 * presets and keeps the shared checks.
 */
const presets = ['campaign', 'adgroup', 'ad'].map(level => ({
  id: 'tiktok_' + level,
  name: 'TikTok ' + (level === 'adgroup' ? 'ad group' : level) + ' performance',
  level,
  grain: (level === 'adgroup' ? 'ad group' : level) + ' × day',
  gateway: 'tiktok_native_action',
  max_rows: 10000,
  max_requests: 120,
  meaning:
    'Standard BASIC auction daily reporting in the verified advertiser currency and timezone. Requires 1–366 closed days in the advertiser time zone; read in spans of 30 days. Uses the native conversion metric for each entity optimization goal; these goals may differ. Attribution remains declared. Smart+, GMV Max and other specialized reports are separate.',
}));

export const tiktokGuidedReporting: GuidedReporting = {
  presets,
  presetPrefix: 'tiktok_',
  presetRequest(preset, input, range, context) {
    if (typeof input.account_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(input.account_id))
      bad('Use the exact TikTok advertiser ID.');
    tiktokDailyRange(input.semantics, context?.overviewV4 === true);
    return {
      gateway: preset.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {
        action: 'tiktok_report_integrated_get',
        query: {
          advertiser_id: input.account_id,
          report_type: 'BASIC',
          data_level: 'AUCTION_' + preset.level.toUpperCase(),
          dimensions: [preset.level + '_id', 'stat_time_day'],
          metrics: [
            preset.level + '_name',
            'spend',
            'impressions',
            'clicks',
            'conversion',
            ...(context?.overviewV4 && preset.level !== 'campaign' ? ['result', 'cost_per_result', 'result_rate'] : []),
          ],
          start_date: range.since,
          end_date: range.until,
          query_lifetime: false,
          multi_adv_report_in_utc_time: false,
          enable_total_metrics: true,
          filtering: tiktokStatusFilter(preset.level),
          page: 1,
          page_size: 1000,
        },
        aggregate_pages: false,
      },
      semantics: {...input.semantics, conversion_definition: 'conversion (optimization goal)'},
      rows_pointer: '/data/data/list',
      mapping: {
        entity_id: '/dimensions/' + preset.level + '_id',
        entity_name: '/metrics/' + preset.level + '_name',
        date: {path: '/dimensions/stat_time_day', format: 'tiktok_day'},
        spend: '/metrics/spend',
        impressions: '/metrics/impressions',
        clicks: '/metrics/clicks',
        conversions: '/metrics/conversion',
      },
    };
  },
  // ARC-01 (reporting): a capture of a TikTok preset collects complete BASIC daily pages (src/tiktok-reporting.ts).
  collect: ({store, call, actor, args, semantics, allowPartial, lookup}) =>
    collectTikTokDailyReport(store, call, actor, args, semantics, {allowPartial, lookup}),
  dashAsUnknown: true,
  sourceCollection: 'tiktok_daily_pages',
  semanticsSource: () =>
    'TikTok advertiser currency and timezone verified before and after complete native pages; native conversion refers to each entity optimization goal and goals may differ; attribution windows and completeness declared, not independently verified. Collection is not a point-in-time snapshot.',
  // A mapping may read the report date from TikTok's stat_time_day.
  dateFormats: {tiktok_day: tiktokReportDate},
};
