import {compileReport, dateRange} from './workflows.js';
import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
import {linkedInDailyRange, linkedInReportDate} from './linkedin-reporting.js';
import {tiktokDailyRange} from './tiktok-reporting.js';
import {googleReportId} from './google-reporting.js';
const googlePresets = [
  {id: 'google_campaign', name: 'Google campaign performance', level: 'campaign', grain: 'campaign × day'},
  {id: 'google_adset', name: 'Google ad group performance', level: 'adset', grain: 'ad group × day'},
  {id: 'google_ad', name: 'Google ad performance', level: 'ad', grain: 'ad group × ad × day'},
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
    'Native customer currency and timezone checked before and after complete Search pages. Exact account/resource identity, requested grain, dates, counts and duplicate rows are checked. Ads and search terms retain full resource identities. Conversions use metrics.conversions; attribution and window completeness remain declared. Search term visibility and attribution can prevent equality with campaign totals; search_term_view excludes Performance Max.',
}));
export const reportPresets = [
  ...googlePresets,
  ...['campaign', 'adgroup', 'ad'].map(level => ({
    id: 'tiktok_' + level,
    name: 'TikTok ' + (level === 'adgroup' ? 'ad group' : level) + ' performance',
    level,
    grain: (level === 'adgroup' ? 'ad group' : level) + ' × day',
    gateway: 'tiktok_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Standard BASIC auction daily reporting in the verified advertiser currency and timezone. Requires 1–31 closed days, complete native pagination and stable row counts. Uses the native conversion metric for each entity optimization goal; these goals may differ. Attribution remains declared. Smart+, GMV Max and other specialized reports are separate.',
  })),
  ...[
    {
      id: 'linkedin_campaign_group',
      name: 'LinkedIn campaign group performance',
      level: 'campaign_group',
      grain: 'campaign group × day',
    },
    {id: 'linkedin_campaign', name: 'LinkedIn campaign performance', level: 'campaign', grain: 'campaign × day'},
    {id: 'linkedin_creative', name: 'LinkedIn creative performance', level: 'creative', grain: 'creative × day'},
  ].map(p => ({
    ...p,
    gateway: 'linkedin_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Native UTC daily analytics after account currency verification. Uses externalWebsiteConversions; attribution windows remain declared. Empty responses are ambiguous and cannot establish zero activity. No pagination; narrow oversized reports. Current month and previous five calendar months only.',
  })),
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

/** Guided evidence must retain its requested native hierarchy, reporting window and grain. */
export function validatePresetRows(preset: string | undefined, input: JsonObject, rows: JsonObject[]) {
  if (preset?.startsWith('linkedin_')) {
    if (!rows.length)
      bad(
        'LinkedIn returned no rows. No activity and missing reporting access cannot be distinguished; no zero-performance evidence was saved.',
        'REPORT_EMPTY_AMBIGUOUS',
      );
    const kind: Record<string, string> = {
      linkedin_campaign_group: 'sponsoredCampaignGroup',
      linkedin_campaign: 'sponsoredCampaign',
      linkedin_creative: 'sponsoredCreative',
    };
    const pattern = new RegExp('^urn:li:' + kind[preset] + ':[1-9][0-9]{0,31}$'),
      seen = new Set<string>();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        !Array.isArray(row.pivotValues) ||
        row.pivotValues.length !== 1 ||
        typeof row.pivotValues[0] !== 'string' ||
        !pattern.test(row.pivotValues[0])
      )
        bad('LinkedIn did not return the requested native entity pivot.', 'REPORT_SHAPE_CHANGED');
      const date = linkedInReportDate(row.dateRange?.start);
      if (
        date !== linkedInReportDate(row.dateRange?.end) ||
        date < input.semantics.date_from ||
        date > input.semantics.date_to
      )
        bad('LinkedIn returned a different reporting period or grain.', 'REPORT_DATE_MISMATCH');
      const key = row.pivotValues[0] + ':' + date;
      if (seen.has(key)) bad('LinkedIn returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
      seen.add(key);
    }
    return;
  }
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
  if (preset.gateway === 'tiktok_native_action') {
    if (typeof input.account_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(input.account_id))
      bad('Use the exact TikTok advertiser ID.');
    tiktokDailyRange(input.semantics);
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
          metrics: [preset.level + '_name', 'spend', 'impressions', 'clicks', 'conversion'],
          start_date: range.since,
          end_date: range.until,
          query_lifetime: false,
          multi_adv_report_in_utc_time: false,
          enable_total_metrics: false,
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
  }
  if (preset.gateway === 'linkedin_native_action') {
    if (typeof input.account_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(input.account_id))
      bad('Use the exact LinkedIn advertising account ID.');
    if (input.semantics.timezone !== 'UTC') bad('LinkedIn analytics dates require UTC.');
    linkedInDailyRange(range.since, range.until);
    const level = {campaign_group: 'campaign', campaign: 'adset', creative: 'ad'}[preset.level];
    const native = compileReport({
      platform: 'linkedin',
      account_id: input.account_id,
      date_range: range,
      level,
      granularity: 'day',
    });
    return {
      gateway: native.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: native.input,
      semantics: {...input.semantics, conversion_definition: 'externalWebsiteConversions'},
      rows_pointer: '/data/data/elements',
      mapping: {
        entity_id: '/pivotValues/0',
        date: {path: '/dateRange/start', format: 'linkedin_utc_date'},
        spend: '/costInLocalCurrency',
        impressions: '/impressions',
        clicks: '/clicks',
        conversions: '/externalWebsiteConversions',
        conversion_value: '/conversionValueInLocalCurrency',
      },
    };
  }
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
  if (typeof input.account_id !== 'string') bad('Choose the exact Google customer ID.');
  const account = normalizeAccount(preset.gateway, input.account_id);
  if (!googleReportId(account)) bad('Choose the exact Google customer ID.');
  const native = compileReport({
    platform: 'google',
    account_id: account,
    date_range: range,
    level: preset.level === 'search_term' ? 'campaign' : preset.level,
    granularity: 'day',
  });
  if (preset.level === 'search_term')
    native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
  const identity = [
    'customer.id',
    'customer.resource_name',
    'campaign.resource_name',
    ...(preset.level !== 'campaign' ? ['ad_group.resource_name'] : []),
    ...(preset.level === 'ad' ? ['ad_group_ad.resource_name', 'ad_group_ad.ad.resource_name'] : []),
    ...(preset.level === 'search_term' ? ['search_term_view.resource_name'] : []),
  ];
  native.input.payload.query = native.input.payload.query.replace(/^SELECT /, 'SELECT ' + identity.join(', ') + ', ');
  native.input.payload.search_settings = {return_total_results_count: true};
  native.input.aggregate_pages = false;
  const entity =
    preset.level === 'ad'
      ? 'adGroupAd/ad'
      : preset.level === 'adset' || preset.level === 'search_term'
        ? 'adGroup'
        : 'campaign';
  return {
    gateway: native.gateway,
    account_id: account,
    connection_id: input.connection_id,
    arguments: native.input,
    semantics: {...input.semantics, conversion_definition: 'metrics.conversions'},
    rows_pointer: '/data/data/results',
    mapping: {
      entity_id:
        preset.level === 'ad'
          ? '/adGroupAd/resourceName'
          : preset.level === 'search_term'
            ? '/searchTermView/resourceName'
            : `/${entity}/id`,
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
