import {compileReport, dateRange} from './workflows.js';
import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
export const reportPresets = [
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
export function reportPreset(input: JsonObject): JsonObject {
  const preset = reportPresets.find(p => p.id === input.preset);
  if (!preset) bad('Choose a supported capture preset.');
  const range = dateRange({since: input.semantics?.date_from, until: input.semantics?.date_to});
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
