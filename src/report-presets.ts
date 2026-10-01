import {compileReport, dateRange} from './workflows.js';
import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
const googlePresets = [
  {id: 'google_campaign', name: 'Google campaign performance', level: 'campaign', grain: 'campaign × day'},
  {id: 'google_adset', name: 'Google ad group performance', level: 'adset', grain: 'ad group × day'},
  {id: 'google_ad', name: 'Google ad performance', level: 'ad', grain: 'ad × day'},
  {
    id: 'google_search_terms',
    name: 'Google search term evidence',
    level: 'search_term',
    grain: 'campaign × ad group × search term',
  },
].map(p => ({
  ...p,
  gateway: 'google_ads_native_action',
  max_rows: 10000,
  max_requests: 120,
  meaning:
    'Native read with complete paging required. Dates, currency, timezone and attribution remain explicit. Search term visibility and attribution can prevent equality with campaign totals.',
}));
export const reportPresets = [
  ...googlePresets,
  ...['campaign', 'adset', 'ad'].map(level => ({
    id: 'meta_' + level,
    name: 'Meta ' + (level === 'adset' ? 'ad set' : level) + ' performance',
    level,
    grain: (level === 'adset' ? 'ad set' : level) + ' × day',
    gateway: 'meta_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Daily native Insights with an exact action type, explicit attribution windows and impression-time reporting. Pixel and aggregate purchase aliases are never added together. Missing action values remain unknown. Currency and timezone must match the account.',
  })),
];

/** Native rows of guided Meta reads must retain their requested account, currency and daily grain. */
export function validatePresetRows(preset: string | undefined, input: JsonObject, rows: JsonObject[]) {
  if (!preset?.startsWith('meta_')) return;
  const level = reportPresets.find(p => p.id === preset)?.level;
  if (!level) bad('Unknown Meta preset.');
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      bad('Meta returned a malformed Insights row.', 'REPORT_SHAPE_CHANGED');
    if (String(row.account_id ?? '') !== normalizeAccount('meta_native_action', input.account_id))
      bad('Meta returned an unbound or different account.', 'REPORT_ACCOUNT_MISMATCH');
    if (row.account_currency !== input.semantics.currency)
      bad('Meta returned a different or missing account currency.', 'REPORT_CURRENCY_MISMATCH');
    if (typeof row[level + '_id'] !== 'string' || !/^[1-9][0-9]{0,31}$/.test(row[level + '_id']))
      bad('Meta did not return the requested entity ID.', 'REPORT_SHAPE_CHANGED');
    const date = row.date_start;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date !== row.date_stop ||
      date < input.semantics.date_from ||
      date > input.semantics.date_to
    )
      bad('Meta returned a different reporting period or grain.', 'REPORT_DATE_MISMATCH');
    const key = row[level + '_id'] + ':' + date;
    if (seen.has(key)) bad('Meta returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
    seen.add(key);
  }
}
export function reportPreset(input: JsonObject): JsonObject {
  const preset = reportPresets.find(p => p.id === input.preset);
  if (!preset) bad('Choose a supported capture preset.');
  const range = dateRange({since: input.semantics?.date_from, until: input.semantics?.date_to});
  if (preset.gateway === 'meta_native_action') {
    const account = normalizeAccount(preset.gateway, input.account_id ?? '');
    if (!/^[1-9][0-9]{0,31}$/.test(account)) bad('Use the exact Meta advertising account ID.');
    if (typeof input.result_action_type !== 'string' || !/^[a-z][a-z0-9_.]{0,159}$/.test(input.result_action_type))
      bad('Choose the exact native Meta result action_type; overlapping aliases are never combined.');
    const windows = input.attribution_windows;
    if (
      !Array.isArray(windows) ||
      !windows.length ||
      windows.length > 2 ||
      new Set(windows).size !== windows.length ||
      windows.some(w => !['1d_click', '7d_click', '1d_view'].includes(w)) ||
      (windows.includes('1d_click') && windows.includes('7d_click'))
    )
      bad('Choose one click window (1d_click or 7d_click), with optional 1d_view, or 1d_view alone.');
    const selected = ['1d_click', '7d_click', '1d_view'].filter(w => windows.includes(w));
    return {
      gateway: preset.gateway,
      account_id: account,
      connection_id: input.connection_id,
      arguments: {
        action: 'meta_ad_account_id_insights_get',
        ad_account_id: 'act_' + account,
        query: {
          fields: [
            'account_id',
            'account_currency',
            'campaign_id',
            'campaign_name',
            ...(preset.level !== 'campaign' ? ['adset_id', 'adset_name'] : []),
            ...(preset.level === 'ad' ? ['ad_id', 'ad_name'] : []),
            'date_start',
            'date_stop',
            'spend',
            'impressions',
            'clicks',
            'reach',
            'frequency',
            'actions',
            'action_values',
          ].join(','),
          level: preset.level,
          time_range: range,
          time_increment: 1,
          action_report_time: 'impression',
          action_attribution_windows: selected,
          use_account_attribution_setting: false,
          use_unified_attribution_setting: false,
          limit: 100,
        },
        aggregate_pages: true,
        max_pages: 100,
      },
      semantics: {
        ...input.semantics,
        attribution: 'Meta ' + selected.join(' + ') + '; impression time',
        conversion_definition: input.result_action_type,
      },
      rows_pointer: '/data/data/data',
      mapping: {
        entity_id: '/' + preset.level + '_id',
        entity_name: '/' + preset.level + '_name',
        date: '/date_start',
        spend: '/spend',
        impressions: '/impressions',
        clicks: '/clicks',
        reach: '/reach',
        frequency: '/frequency',
        conversions: {path: '/actions', action_type: input.result_action_type},
        conversion_value: {path: '/action_values', action_type: input.result_action_type},
      },
    };
  }
  const native = compileReport({
    platform: 'google',
    account_id: input.account_id,
    date_range: range,
    level: preset.level === 'search_term' ? 'campaign' : preset.level,
    granularity: 'day',
  });
  if (preset.level === 'search_term')
    native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
  const entity =
    preset.level === 'ad'
      ? 'adGroupAd/ad'
      : preset.level === 'adset' || preset.level === 'search_term'
        ? 'adGroup'
        : 'campaign';
  return {
    gateway: native.gateway,
    account_id: input.account_id,
    connection_id: input.connection_id,
    arguments: native.input,
    semantics: input.semantics,
    rows_pointer: '/data/data/results',
    mapping: {
      entity_id: `/${entity}/id`,
      ...(preset.level === 'ad' ? {} : {entity_name: `/${entity}/name`}),
      ...(preset.level === 'search_term' ? {search_term: '/searchTermView/searchTerm'} : {date: '/segments/date'}),
      spend: {path: '/metrics/costMicros', divisor: 1000000},
      impressions: '/metrics/impressions',
      clicks: '/metrics/clicks',
      conversions: '/metrics/conversions',
      conversion_value: '/metrics/conversionsValue',
    },
  };
}
