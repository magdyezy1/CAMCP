import {compileReport} from './workflows.js';
import {bad} from './workspace-core.js';
import {normalizeAccount} from './account-id.js';
import {
  collectGoogleReport,
  googleGeographicResource,
  googleReportAdNetworks,
  googleReportCountryId,
  googleReportDevices,
  googleReportId,
  googleReportLocationTypes,
} from './google-reporting.js';
import type {GuidedReporting} from './report-source.js';
import {googleAllocationDraft} from './google-allocation-draft.js';

/**
 * Google Ads' guided reporting (ARC-04 stage F): what the shared guided modules (src/report-breakdowns.ts,
 * src/report-presets.ts and the modules above them) ask Google instead of naming it: its capture presets and the
 * Search read each defines, and its dimension packs. Google's report source declares it.
 */
const presets = [
  {id: 'google_campaign', name: 'Google campaign performance', level: 'campaign', grain: 'campaign × day'},
  {id: 'google_adset', name: 'Google ad group performance', level: 'adset', grain: 'ad group × day'},
  {id: 'google_ad', name: 'Google ad performance', level: 'ad', grain: 'ad group × ad × day'},
  {id: 'google_keyword', name: 'Google keyword performance', level: 'keyword', grain: 'keyword × day'},
  {
    id: 'google_campaign_device',
    name: 'Google campaign device performance',
    level: 'campaign_device',
    grain: 'campaign × device × day',
  },
  {
    id: 'google_campaign_hour',
    name: 'Google campaign hourly performance',
    level: 'campaign_hour',
    grain: 'campaign × hour × day',
  },
  {
    id: 'google_campaign_country',
    name: 'Google campaign country performance',
    level: 'campaign_country',
    grain: 'campaign × native country × native location type × day',
  },
  {
    id: 'google_search_terms',
    name: 'Google search term evidence',
    level: 'search_term',
    grain: 'campaign × ad group × search term',
  },
  // RPT-07 P1 dimension packs.
  {
    id: 'google_pmax_search_terms',
    name: 'Google Performance Max search terms',
    level: 'pmax_search_term',
    grain: 'Performance Max campaign × search term',
  },
  {
    id: 'google_campaign_network',
    name: 'Google campaign network performance',
    level: 'campaign_network',
    grain: 'campaign × native ad network × day',
  },
].map(p => ({
  ...p,
  gateway: 'google_ads_native_action',
  max_rows: 10000,
  max_requests: 120,
  meaning:
    p.id === 'google_keyword'
      ? 'Positive Search keywords from keyword_view, by account-local day. Original keyword text, match type and full view/criterion/parent resource identities are checked; immutable keyword metadata must remain consistent. Native customer currency and timezone checked before and after complete bounded Search pages. Counts, dates and duplicate grain are checked. Conversions use metrics.conversions; attribution and window completeness remain declared. Keyword performance does not establish search-query coverage, whole-campaign totals or negative-keyword/budget eligibility.'
      : p.id === 'google_campaign_device'
        ? 'Campaign performance by original native device and account-local day, without device or status filtering. Exact customer/campaign resources, currency, timezone, date/device grain, counts and duplicates are checked under unchanged authorization. UNKNOWN and UNSPECIFIED remain literal native categories; missing device categories do not establish zero activity. Conversions use metrics.conversions; attribution and window completeness remain declared. This grain does not qualify device bid, campaign budget or search-exclusion changes.'
        : p.id === 'google_campaign_hour'
          ? 'Campaign performance by original provider-reported hour 0–23 and date, without hour or status filtering. Exact customer/campaign resources, currency, timezone, requested date/hour grain, counts and duplicates are checked under unchanged authorization. Explicit hour zero is retained; absent hours do not establish zero activity. No timestamp, timezone conversion or daylight-saving split is inferred. Conversions use metrics.conversions; attribution and window completeness remain declared. This grain does not qualify delivery schedules, bid, campaign budget or search-exclusion changes.'
          : p.id === 'google_campaign_country'
            ? 'Campaign performance by original native country criterion, location type and account-local day from geographic_view. Location presence and location interest remain distinct native categories; country IDs are not inferred country names or audience identities. Exact customer/campaign/geographic resources, currency, timezone, counts and duplicate grain are checked under unchanged authorization. Missing countries do not establish zero activity. Conversions use metrics.conversions; attribution and window completeness remain declared. This grain does not qualify geographic targeting, campaign budgets or search exclusions.'
            : p.id === 'google_pmax_search_terms'
              ? 'Performance Max search terms over the selected window from campaign_search_term_view (no keyword segments, so Performance Max data is included). Each row keeps its exact campaign search term view resource, the original search term and its PERFORMANCE_MAX campaign. Customer currency and timezone are checked before and after complete bounded pages; counts and duplicate campaign/term grain are checked. Search-term visibility thresholds mean terms need not add up to campaign totals, and an absent term is unknown, not zero. Conversions use metrics.conversions; attribution and window completeness remain declared. This grain does not qualify negative keywords, brand exclusions or budget changes.'
              : p.id === 'google_campaign_network'
                ? 'Campaign performance by original native ad network type (segments.ad_network_type: SEARCH, SEARCH_PARTNERS, CONTENT, YOUTUBE, MIXED and the other documented values) and account-local day, without network or status filtering. Exact customer/campaign resources, currency, timezone, network/day grain, counts and duplicates are checked under unchanged authorization. Network values stay literal; an absent network is unknown, not zero. Conversions use metrics.conversions; attribution and window completeness remain declared. This grain does not qualify network targeting, bid or budget changes.'
                : 'Native customer currency and timezone checked before and after complete Search pages. Exact account/resource identity, requested grain, dates, counts and duplicate rows are checked. Ads and search terms retain full resource identities. Conversions use metrics.conversions; attribution and window completeness remain declared. Search term visibility and attribution can prevent equality with campaign totals; search_term_view excludes Performance Max.',
}));

export const googleGuidedReporting: GuidedReporting = {
  // RPT-07 P1: campaign × native ad network (segments.ad_network_type), kept as the literal documented AdNetworkType.
  dimensions: {native_ad_network: v => typeof v === 'string' && googleReportAdNetworks.includes(v)},
  presets,
  presetPrefix: 'google_',
  // What amcp_reporting capture_preset help shows of Google's presets (R25 M0, owner 2026-11-15, observation 7 of the live checks).
  help: {
    preset: 'google_campaign',
    account: '1234567890',
    timezone: 'Asia/Riyadh',
    currency: 'USD',
    source: 'Google Ads campaign report',
    rules: [
      'semantics.timezone and semantics.currency are the customer’s own, as Google reports them; the capture refuses a different one.',
      'semantics.complete may be true or false. semantics.attribution names the attribution settings in text, or unknown when they are not established; conversions use metrics.conversions.',
      'The ad group, ad, keyword, search term, device, hour, country and network presets take the same arguments.',
    ],
  },
  // DEC-01: an allocation models campaign × day evidence by native campaign ID.
  allocation: {preset: 'google_campaign', entity: id => typeof id === 'string' && /^\d{1,40}$/.test(id)},
  presetRequest(preset, input, range, context) {
    if (typeof input.account_id !== 'string') bad('Choose the exact Google customer ID.');
    const account = normalizeAccount(preset.gateway, input.account_id);
    if (!googleReportId(account)) bad('Choose the exact Google customer ID.');
    const native = compileReport({
      platform: 'google',
      account_id: account,
      date_range: range,
      level: [
        'search_term',
        'keyword',
        'campaign_device',
        'campaign_hour',
        'campaign_country',
        'campaign_network',
        'pmax_search_term',
      ].includes(preset.level)
        ? 'campaign'
        : preset.level,
      granularity: 'day',
    });
    if (preset.level === 'search_term')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    if (preset.level === 'keyword')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, campaign.advertising_channel_type, ad_group.id, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}' AND campaign.advertising_channel_type = 'SEARCH' AND ad_group_criterion.negative = FALSE`;
    if (preset.level === 'campaign_device')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, segments.date, segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    if (preset.level === 'campaign_hour')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, segments.date, segments.hour, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    if (preset.level === 'campaign_country')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, geographic_view.resource_name, geographic_view.country_criterion_id, geographic_view.location_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM geographic_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    // RPT-07 P1 packs: network by day from campaign, and Performance Max terms (no keyword segment keeps PMax data).
    if (preset.level === 'campaign_network')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, segments.date, segments.ad_network_type, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`;
    if (preset.level === 'pmax_search_term')
      native.input.payload.query = `SELECT customer.currency_code, customer.time_zone, campaign.id, campaign.name, campaign.advertising_channel_type, campaign_search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign_search_term_view WHERE segments.date BETWEEN '${range.since}' AND '${range.until}' AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'`;
    const identity = [
      'customer.id',
      'customer.resource_name',
      'campaign.resource_name',
      ...(context?.overviewV4 === true
        ? [
            preset.level === 'ad'
              ? 'ad_group_ad.status'
              : preset.level === 'adset'
                ? 'ad_group.status'
                : 'campaign.status',
          ]
        : []),
      ...(![
        'campaign',
        'campaign_device',
        'campaign_hour',
        'campaign_country',
        'campaign_network',
        'pmax_search_term',
      ].includes(preset.level)
        ? ['ad_group.resource_name']
        : []),
      ...(preset.level === 'ad' ? ['ad_group_ad.resource_name', 'ad_group_ad.ad.resource_name'] : []),
      ...(preset.level === 'search_term' ? ['search_term_view.resource_name'] : []),
      ...(preset.level === 'pmax_search_term' ? ['campaign_search_term_view.resource_name'] : []),
      ...(preset.level === 'keyword' ? ['keyword_view.resource_name'] : []),
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
              : preset.level === 'pmax_search_term'
                ? '/campaignSearchTermView/resourceName'
                : preset.level === 'keyword'
                  ? '/keywordView/resourceName'
                  : ['campaign_device', 'campaign_hour', 'campaign_country', 'campaign_network'].includes(preset.level)
                    ? '/campaign/resourceName'
                    : `/${entity}/id`,
        ...(preset.level === 'ad'
          ? {}
          : {entity_name: preset.level === 'keyword' ? '/adGroupCriterion/keyword/text' : `/${entity}/name`}),
        ...(preset.level === 'keyword' ? {keyword_match_type: '/adGroupCriterion/keyword/matchType'} : {}),
        ...(preset.level === 'campaign_device' ? {native_device: '/segments/device'} : {}),
        ...(preset.level === 'campaign_network' ? {native_ad_network: '/segments/adNetworkType'} : {}),
        ...(preset.level === 'campaign_hour' ? {native_hour: '/segments/hour'} : {}),
        ...(preset.level === 'campaign_country'
          ? {
              native_country_criterion_id: '/geographicView/countryCriterionId',
              native_location_type: '/geographicView/locationType',
              native_geographic_resource: '/geographicView/resourceName',
            }
          : {}),
        ...(preset.level === 'search_term'
          ? {search_term: '/searchTermView/searchTerm'}
          : preset.level === 'pmax_search_term'
            ? {search_term: '/campaignSearchTermView/searchTerm'}
            : {date: '/segments/date'}),
        spend: {path: '/metrics/costMicros', divisor: 1000000},
        impressions: '/metrics/impressions',
        clicks: '/metrics/clicks',
        conversions: '/metrics/conversions',
        conversion_value: '/metrics/conversionsValue',
      },
    };
  },
  // ARC-01 (reporting): a capture of a Google preset collects complete bounded Search pages (src/google-reporting.ts).
  collect: ({store, call, actor, args, semantics, preset}) =>
    collectGoogleReport(store, call, actor, args, semantics, preset),
  sourceCollection: 'google_search_pages',
  semanticsSource: () =>
    'Google customer currency and timezone verified before and after complete Search pages; native resource identity, dates, result counts and unique grain checked; conversions use metrics.conversions. Attribution and reporting-window completeness remain declared, not independently verified. Collection is not a point-in-time snapshot.',
  // The native device, country, location type and geographic resource a capture's mapping may retain.
  dimensionChecks: {
    native_device: {valid: value => typeof value === 'string' && googleReportDevices.includes(value)},
    native_country_criterion_id: {valid: value => googleReportCountryId(value)},
    native_location_type: {
      valid: value => typeof value === 'string' && Object.hasOwn(googleReportLocationTypes, value),
    },
    // A geographic resource names the capture's own customer, and the row's country and location type agree with it.
    native_geographic_resource: {
      valid: (value, capture) =>
        capture.gateway === 'google_ads_native_action' &&
        googleGeographicResource(value)?.account_id === normalizeAccount(capture.gateway, capture.account_id),
      agrees(row) {
        const geographic = googleGeographicResource(row.native_geographic_resource)!;
        return !(
          (row.native_country_criterion_id !== undefined &&
            row.native_country_criterion_id !== null &&
            row.native_country_criterion_id !== geographic.country_criterion_id) ||
          (row.native_location_type !== undefined &&
            row.native_location_type !== null &&
            googleReportLocationTypes[row.native_location_type as keyof typeof googleReportLocationTypes] !==
              geographic.location_type_value)
        );
      },
    },
  },
  // Wave 4c round 6 (w4c-arc6-reporting): DEC-02's native budget draft of the allocation model (campaign budgets).
  allocationDraft: googleAllocationDraft,
};
