import {compileReport, dateRange} from './workflows.js';
import {bad} from './workspace-core.js';
import type {JsonObject} from './types.js';
import {normalizeAccount} from './scope.js';
import {linkedInDailyRange, linkedInReportDate} from './linkedin-reporting.js';
import {tiktokDailyRange} from './tiktok-reporting.js';
import {googleReportId} from './google-reporting.js';
import {snapchatDailyRange, snapchatReportId} from './snapchat-evidence.js';
import {linkedInConversionUrn, linkedInConversionWindowSentinel} from './linkedin-conversion-windows.js';
import {metaBreakdownKey, metaBreakdownPresets} from './report-breakdowns.js';
import {metaWindowsMessage, metaWindowsOrdered, metaWindowsValid} from './meta-attribution-windows.js';
const googlePresets = [
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
export const reportPresets = [
  ...googlePresets,
  ...['campaign', 'adsquad', 'ad'].map(level => ({
    id: 'snapchat_' + level,
    name: 'Snapchat ' + (level === 'adsquad' ? 'ad squad' : level) + ' performance',
    level,
    grain: (level === 'adsquad' ? 'ad squad' : level) + ' × day',
    gateway: 'snapchat_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Account-local daily purchases with explicit swipe/view attribution, conversion-time reporting and total conversion sources. Account identity, currency and timezone are checked before and after complete bounded pages. Each page must confirm delivery and conversion processing through the requested end. Uses swipes for clicks and exact spend micros. Requires 1–31 closed days and whole-hour local midnight boundaries. Missing metrics stay unknown; no conversion-value or creative-assignment claim.',
  })),
  ...['campaign', 'adsquad', 'ad'].map(level => ({
    id: 'snapchat_' + level + '_leads',
    name: 'Snapchat ' + (level === 'adsquad' ? 'ad squad' : level) + ' native lead submissions',
    level,
    grain: (level === 'adsquad' ? 'ad squad' : level) + ' × day',
    gateway: 'snapchat_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Account-local daily native_leads counts for submitted Snapchat lead forms. No submitted lead records are read. Exact spend micros and swipes remain separate. Account identity, currency and timezone are checked before and after complete bounded pages; ad squads and ads require an exact owned parent campaign. Each page must confirm non-conversion metric finalization through the requested end. Requires 1–31 closed days and whole-hour local midnight boundaries. Missing counts stay unknown. Pixel/MMP attribution, lead quality and historical creative assignment are not established.',
  })),
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
      'Native UTC daily analytics with account identity and currency verified before and after collection under unchanged authorization. Keeps source references for both account checks and the single complete analytics response. Uses externalWebsiteConversions; attribution windows remain declared. Empty responses are ambiguous and cannot establish zero activity. No pagination; narrow oversized reports. Current month and previous five calendar months only.',
  })),
  {
    // RPT-07 (B18): windows verified per conversion rule instead of declared.
    id: 'linkedin_campaign_conversion',
    name: 'LinkedIn campaign conversions with verified rule windows',
    level: 'campaign_conversion',
    grain: 'campaign × conversion × day',
    gateway: 'linkedin_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Native UTC daily conversions by campaign and conversion rule (statistics finder, CAMPAIGN and CONVERSION pivots) with post-click and post-view counts. In the same authorization bracket the account’s current conversion rules are read and each conversion is joined to its rule’s windows: verified_per_rule when all match, mixed when they differ (no single window), unknown when a rule is missing. Declare attribution verified_per_rule; windows are never typed. Spend, impressions and clicks are not split by conversion and stay unmapped. Empty or truncated (15,000-element) responses are refused. Current month and previous five calendar months only.',
  },
  ...['campaign', 'adset', 'ad'].map(level => ({
    id: 'meta_' + level,
    name: 'Meta ' + (level === 'adset' ? 'ad set' : level) + ' performance',
    level,
    grain: (level === 'adset' ? 'ad set' : level) + ' × day',
    gateway: 'meta_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Daily native Insights with an exact action type, explicit attribution windows and impression-time reporting. Pixel and aggregate purchase aliases are never added together. Missing action values remain unknown. Currency and timezone are verified against the account before and after complete pages; each account/page read retains a source reference.',
  })),
  // RPT-07 P1 dimension packs: campaign Insights by one native breakdown set.
  ...[
    {
      id: 'meta_campaign_age_gender',
      name: 'Meta campaign age and gender',
      grain: 'campaign × age × gender × day',
    },
    {id: 'meta_campaign_country', name: 'Meta campaign country', grain: 'campaign × country × day'},
    {
      id: 'meta_campaign_placement',
      name: 'Meta campaign placement',
      grain: 'campaign × publisher platform × placement × day',
    },
  ].map(p => ({
    ...p,
    level: 'campaign',
    breakdowns: metaBreakdownPresets[p.id]!.breakdowns,
    gateway: 'meta_native_action',
    max_rows: 10000,
    max_requests: 120,
    meaning:
      'Daily campaign Insights by the native breakdown values Meta returns (literal age, gender, country, publisher platform or placement), with an exact action type, explicit attribution windows and impression-time reporting. Account, currency, timezone, breakdown values and the campaign/breakdown/day grain are checked around complete pages. Buckets Meta does not return (privacy thresholds, no delivery) stay unknown and bucket totals need not equal campaign totals. Reach and frequency stay per bucket; Meta omits reach for breakdown reports that start more than 13 months ago.',
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
      linkedin_campaign_conversion: 'sponsoredCampaign',
    };
    const pattern = new RegExp('^urn:li:' + kind[preset] + ':[1-9][0-9]{0,31}$'),
      // RPT-07: the conversion preset pivots by campaign and conversion; pivotValues follow the requested order.
      conversion = preset === 'linkedin_campaign_conversion',
      seen = new Set<string>();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        !Array.isArray(row.pivotValues) ||
        row.pivotValues.length !== (conversion ? 2 : 1) ||
        typeof row.pivotValues[0] !== 'string' ||
        !pattern.test(row.pivotValues[0]) ||
        (conversion && (typeof row.pivotValues[1] !== 'string' || !linkedInConversionUrn.test(row.pivotValues[1])))
      )
        bad('LinkedIn did not return the requested native entity pivot.', 'REPORT_SHAPE_CHANGED');
      const date = linkedInReportDate(row.dateRange?.start);
      if (
        date !== linkedInReportDate(row.dateRange?.end) ||
        date < input.semantics.date_from ||
        date > input.semantics.date_to
      )
        bad('LinkedIn returned a different reporting period or grain.', 'REPORT_DATE_MISMATCH');
      const key = row.pivotValues.join('|') + ':' + date;
      if (seen.has(key)) bad('LinkedIn returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
      seen.add(key);
    }
    return;
  }
  if (!preset?.startsWith('meta_')) return;
  const level = reportPresets.find(p => p.id === preset)?.level;
  if (!level) bad('Unknown Meta preset.');
  const seen = new Set<string>(),
    parents = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      bad('Meta returned a malformed Insights row.', 'REPORT_SHAPE_CHANGED');
    if (row.account_id !== normalizeAccount('meta_native_action', input.account_id))
      bad('Meta returned an unbound or different account.', 'REPORT_ACCOUNT_MISMATCH');
    if (row.account_currency !== input.semantics.currency)
      bad('Meta returned a different or missing account currency.', 'REPORT_CURRENCY_MISMATCH');
    for (const entity of ['campaign', ...(level !== 'campaign' ? ['adset'] : []), ...(level === 'ad' ? ['ad'] : [])]) {
      if (typeof row[entity + '_id'] !== 'string' || !/^[1-9][0-9]{0,31}$/.test(row[entity + '_id']))
        bad('Meta did not return the exact requested entity and parent IDs.', 'REPORT_SHAPE_CHANGED');
      if (entity !== 'campaign') {
        const key = entity + ':' + row[entity + '_id'],
          parent = entity === 'ad' ? row.adset_id : row.campaign_id;
        if (parents.has(key) && parents.get(key) !== parent)
          bad('Meta returned an entity under different native parents.', 'REPORT_ACCOUNT_MISMATCH');
        parents.set(key, parent);
      }
    }
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
    // RPT-07: a breakdown pack's grain is the entity, its breakdown values and the day.
    const key = JSON.stringify([row[level + '_id'], ...metaBreakdownKey(preset, row), date]);
    if (seen.has(key)) bad('Meta returned duplicate entity/day rows.', 'REPORT_DUPLICATE_ROWS');
    seen.add(key);
  }
}
export function reportPreset(input: JsonObject): JsonObject {
  const preset = reportPresets.find(p => p.id === input.preset);
  if (!preset) bad('Choose a supported capture preset.');
  const leads = ['snapchat_campaign_leads', 'snapchat_adsquad_leads', 'snapchat_ad_leads'].includes(preset.id),
    parent =
      preset.gateway === 'snapchat_native_action' && (preset.level === 'adsquad' || (leads && preset.level === 'ad'));
  if (input.campaign_id !== undefined && !parent)
    bad('A campaign filter requires a qualified parent-scoped Snapchat preset.');
  const range = dateRange({since: input.semantics?.date_from, until: input.semantics?.date_to});
  if (preset.gateway === 'snapchat_native_action') {
    if (!snapchatReportId(input.account_id)) bad('Use the exact Snapchat advertising account UUID.');
    if (parent && !snapchatReportId(input.campaign_id)) bad('Choose the exact Snapchat parent campaign UUID.');
    const swipe = input.swipe_up_attribution_window,
      view = input.view_attribution_window;
    if (leads && (swipe !== undefined || view !== undefined))
      bad('Native lead-form submissions do not use the purchase attribution window controls.');
    if (
      !leads &&
      (!['1_DAY', '7_DAY', '28_DAY'].includes(swipe) ||
        !['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'].includes(view) ||
        (view === '7_DAY' && swipe === '1_DAY'))
    )
      bad(
        'Choose explicit supported Snapchat swipe and view attribution windows; a seven-day view requires at least a seven-day swipe window.',
      );
    const days = snapchatDailyRange(input.semantics);
    return {
      gateway: preset.gateway,
      account_id: input.account_id,
      connection_id: input.connection_id,
      arguments: {
        action: parent ? 'snapchat_campaign_stats_get' : 'snapchat_account_stats_get',
        path_params: parent ? {campaign_id: input.campaign_id} : {ad_account_id: input.account_id},
        aggregate_pages: false,
        query: {
          granularity: 'DAY',
          breakdown: preset.level,
          start_time: new Date(days[0]!.start).toISOString(),
          end_time: new Date(days.at(-1)!.end).toISOString(),
          fields: 'spend,impressions,swipes,' + (leads ? 'native_leads' : 'conversion_purchases'),
          ...(!leads
            ? {
                swipe_up_attribution_window: swipe,
                view_attribution_window: view,
                action_report_time: 'conversion',
                conversion_source_types: 'total',
              }
            : {}),
          omit_empty: false,
          limit: 200,
        },
      },
      semantics: {
        ...input.semantics,
        attribution: leads
          ? 'Snapchat native form submissions; no off-platform attribution claim'
          : 'Snapchat ' + swipe + ' swipe / ' + view + ' view; conversion time; total sources',
        conversion_definition: leads
          ? 'native_leads (submitted native lead forms)'
          : 'conversion_purchases (total sources)',
      },
      rows_pointer: '/data/data/rows',
      mapping: {
        entity_id: '/entity_id',
        date: '/date',
        spend: {path: '/stats/spend', divisor: 1000000},
        impressions: '/stats/impressions',
        clicks: '/stats/swipes',
        conversions: '/stats/' + (leads ? 'native_leads' : 'conversion_purchases'),
      },
    };
  }
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
    if (preset.level === 'campaign_conversion') {
      // RPT-07: windows come from the conversion rules read in the same bracket; a typed window is never accepted.
      if (input.semantics.attribution !== linkedInConversionWindowSentinel)
        bad(
          'LinkedIn conversion windows are read from each conversion rule. Declare attribution verified_per_rule; a typed single window is not accepted.',
          'REPORT_ATTRIBUTION_DECLARED',
        );
      const tuple = (date: string) => {
        const [y, m, d] = date.split('-').map(Number);
        return `(year:${y},month:${m},day:${d})`;
      };
      return {
        gateway: preset.gateway,
        account_id: input.account_id,
        connection_id: input.connection_id,
        arguments: {
          action: 'linkedin_rest_ad_analytics_get',
          query: {
            q: 'statistics',
            pivots: 'List(CAMPAIGN,CONVERSION)',
            accounts: 'List(urn:li:sponsoredAccount:' + input.account_id + ')',
            timeGranularity: 'DAILY',
            dateRange: `(start:${tuple(range.since)},end:${tuple(range.until)})`,
            fields: [
              'dateRange',
              'pivotValues',
              'externalWebsiteConversions',
              'externalWebsitePostClickConversions',
              'externalWebsitePostViewConversions',
              'conversionValueInLocalCurrency',
            ].join(','),
          },
          aggregate_pages: false,
        },
        semantics: {...input.semantics, conversion_definition: 'externalWebsiteConversions by conversion rule'},
        rows_pointer: '/data/data/elements',
        mapping: {
          entity_id: '/pivotValues/0',
          native_conversion: '/pivotValues/1',
          date: {path: '/dateRange/start', format: 'linkedin_utc_date'},
          conversions: '/externalWebsiteConversions',
          post_click_conversions: '/externalWebsitePostClickConversions',
          post_view_conversions: '/externalWebsitePostViewConversions',
          conversion_value: '/conversionValueInLocalCurrency',
        },
      };
    }
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
      arguments: {...native.input, aggregate_pages: false},
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
    // RPT-07: 28d_click and 1d_ev are explicit Meta windows too (central rule in meta-attribution-windows.ts).
    if (!metaWindowsValid(windows)) bad(metaWindowsMessage);
    const selected = metaWindowsOrdered(windows),
      pack = metaBreakdownPresets[preset.id];
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
          ...(pack ? {breakdowns: pack.breakdowns} : {}),
          time_range: range,
          time_increment: 1,
          action_report_time: 'impression',
          action_attribution_windows: selected,
          use_account_attribution_setting: false,
          use_unified_attribution_setting: false,
          limit: 100,
        },
        aggregate_pages: false,
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
        ...(pack ? Object.fromEntries(Object.entries(pack.dimensions).map(([key, field]) => [key, '/' + field])) : {}),
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
}
