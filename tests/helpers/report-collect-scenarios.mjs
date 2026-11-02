// ARC-04 stage F: synthetic collection scenarios for every reporting platform and level, run through
// NativeCampaignReports (collect, collectDaily, verifyAccount) behind a recording runPlan. Each scenario records every
// request plan the collector sends (with its runPlan options), every checkpoint it saves and its result or refusal, so
// tests/report-collect-golden.test.mjs can hold the collector byte-identical while each platform's collection moves into
// its report source. tools/report-collect-golden.mjs writes the recording. Nothing leaves the process.
import crypto from 'node:crypto';
import {Store} from '../../dist/src/store.js';
import {MirrorError} from '../../dist/src/errors.js';
import {NativeCampaignReports} from '../../dist/src/report-native.js';

const actor = {tenantId: 'collect-golden', userId: 'owner', role: 'admin'};
const week = {since: '2026-08-01', until: '2026-08-07'};
const nextWeek = {since: '2026-08-08', until: '2026-08-14'};
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** JSON text of a recorded value: undefined kept visible, clock values and random IDs as placeholders. */
export function recordedText(value) {
  return JSON.stringify(value, (key, v) => {
    if (v === undefined) return '$undefined';
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1.6e12 && v < 2e12) return '<epoch-ms>';
    if (typeof v === 'string') return v.replace(uuid, '<uuid>');
    return v;
  });
}
const errorRecord = e =>
  e instanceof MirrorError
    ? {code: e.code, message: e.message, status: e.status, retryable: e.retryable, details: e.details}
    : {name: e?.name, message: String(e?.message ?? e)};

/** A store with one connection, and a service whose runPlan answers from `answer` (a value, an envelope or a refusal). */
function fixture(gateway, account, answer, accounts = [account]) {
  const store = new Store(':memory:', Buffer.alloc(32, 83).toString('base64'));
  store.putConnection(
    actor,
    {id: 'login', tenantId: actor.tenantId, gateway, accounts, enabled: true, label: 'Synthetic', scopes: []},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const requests = [],
    saves = [],
    provider = {answer};
  const service = {
    store,
    runPlan: async (plan, input) => {
      requests.push(JSON.parse(recordedText({plan, input})));
      const data = await provider.answer(plan);
      if (data instanceof MirrorError) throw data;
      if (data && data.$envelope) return data.$envelope;
      return {success: true, data};
    },
    // The detailed levels of the guided presets go through amcp_reporting (collectDetailedOverview), which calls the
    // native gateway tool: the scenarios record that routing and stop there.
    call: async (tool, args) => {
      throw new MirrorError('SYNTHETIC_DETAIL_CALL', 'The detailed collector called ' + tool + '.', {
        tool,
        action: args?.action ?? null,
      });
    },
  };
  return {store, requests, saves, provider, native: new NativeCampaignReports(service)};
}
const source = (platform, account, extra = {}) => ({platform, account_id: account, connection_id: 'login', ...extra});
const detailed = (platform, account, level, extra = {}) =>
  source(platform, account, {level, report_options: {complete_window: true, attribution: 'unknown'}, ...extra});

// ---- Synthetic provider answers ----
const googleRow = (id, extra = {}) => ({
  campaign: {id, name: 'Google ' + id, status: 'ENABLED', advertisingChannelType: 'SEARCH'},
  customer: {currencyCode: 'EUR'},
  metrics: {
    costMicros: '1500000',
    impressions: '10',
    clicks: '2',
    conversions: 1.5,
    conversionsValue: '20.5',
    allConversions: '3',
  },
  ...extra,
});
const google =
  (rows, account = {}) =>
  plan => {
    if (String(plan.body?.query ?? '').includes('FROM customer'))
      return {
        results: [{customer: {id: '1234567890', currencyCode: 'EUR', timeZone: 'Europe/Berlin', ...account}}],
      };
    return typeof rows === 'function' ? rows(plan) : {results: rows};
  };
const metaRow = (id, extra = {}) => ({
  account_id: '100',
  campaign_id: id,
  campaign_name: 'Meta ' + id,
  objective: 'OUTCOME_LEADS',
  date_start: '2026-08-01',
  date_stop: '2026-08-07',
  spend: '12.34',
  impressions: '100',
  clicks: '5',
  reach: '80',
  frequency: '1.25',
  actions: [{action_type: 'lead', value: '3'}],
  action_values: [],
  ...extra,
});
const meta = rows => plan => {
  if (plan.path.endsWith('/insights')) return typeof rows === 'function' ? rows(plan) : {data: rows};
  return {id: 'act_100', name: 'Synthetic Meta', currency: 'USD', timezone_name: 'America/New_York'};
};
const tiktokReport = {
  code: 0,
  data: {
    list: [
      {
        dimensions: {campaign_id: '11'},
        metrics: {campaign_name: 'TikTok 11', spend: '1.5', impressions: '10', clicks: '1', conversion: '2'},
      },
      {
        dimensions: {campaign_id: '12'},
        metrics: {campaign_name: 'TikTok 12', spend: '2.5', impressions: '20', clicks: '3', conversion: '1'},
      },
    ],
    page_info: {page: 1, page_size: 1000, total_number: 2, total_page: 1},
  },
};
const tiktok =
  (
    adgroups = {
      code: 0,
      data: {
        list: [
          {campaign_id: '11', optimization_goal: 'CONVERT', optimization_event: 'ON_WEB_ORDER'},
          {campaign_id: '12', optimization_goal: 'CLICK'},
          {campaign_id: '12', optimization_goal: 'CONVERT', optimization_event: 'SHOPPING'},
          {campaign_id: '', optimization_goal: 'CLICK'},
        ],
        page_info: {page: 1, page_size: 1000, total_number: 4, total_page: 1},
      },
    },
    report = tiktokReport,
  ) =>
  plan => {
    if (plan.path === '/v1.3/advertiser/info/')
      return {
        code: 0,
        data: {list: [{advertiser_id: '7000', name: 'Synthetic TikTok', currency: 'USD', timezone: 'UTC'}]},
      };
    if (plan.path === '/v1.3/report/integrated/get/') return report;
    if (plan.path === '/v1.3/campaign/get/')
      return {
        code: 0,
        data: {
          list: [
            {campaign_id: '11', objective_type: 'CONVERSIONS'},
            {campaign_id: '12', objective_type: 'TRAFFIC'},
          ],
          page_info: {page: 1, page_size: 1000, total_number: 2, total_page: 1},
        },
      };
    if (plan.path === '/v1.3/adgroup/get/') return adgroups;
    return new MirrorError('UNEXPECTED_REQUEST', 'Unexpected TikTok request ' + plan.path);
  };
const snapAccount = '11111111-2222-4333-8444-555555555555';
const snapchat =
  (account = {timezone: 'America/Los_Angeles'}) =>
  plan => {
    if (plan.path === '/v1/adaccounts/' + snapAccount)
      return {
        request_status: 'SUCCESS',
        adaccounts: [{adaccount: {id: snapAccount, name: 'Synthetic Snapchat', currency: 'USD', ...account}}],
      };
    if (plan.path.endsWith('/stats'))
      return {
        request_status: 'SUCCESS',
        total_stats: [
          {
            total_stat: {
              breakdown_stats: {
                campaign: [
                  {
                    id: 'c-1',
                    stats: {
                      spend: 2000000,
                      impressions: 10,
                      swipes: 2,
                      conversion_purchases: 1,
                      conversion_purchases_value: 5000000,
                    },
                  },
                  {id: 'c-2', stats: {spend: 0, impressions: 0, swipes: 0}},
                ],
              },
            },
          },
        ],
      };
    if (plan.path.endsWith('/campaigns'))
      return {
        request_status: 'SUCCESS',
        campaigns: [{campaign: {id: 'c-1', name: 'Snapchat 1', objective: 'WEB_CONVERSION'}}],
      };
    return new MirrorError('UNEXPECTED_REQUEST', 'Unexpected Snapchat request ' + plan.path);
  };
const linkedinDate = text => {
  const [, y, m, d] = /year:(\d+),month:(\d+),day:(\d+)/.exec(text);
  return {year: Number(y), month: Number(m), day: Number(d)};
};
const linkedin =
  ({account = {id: 507, name: 'Synthetic LinkedIn', currency: 'USD'}, groups} = {}) =>
  plan => {
    if (plan.path === '/rest/adAccounts/507') return account;
    if (plan.path === '/rest/adAnalytics') {
      const [start, end] = String(plan.query.dateRange).split('end:');
      return {
        elements: (plan.query.pivot === 'CREATIVE'
          ? ['urn:li:sponsoredCreative:3']
          : plan.query.pivot === 'CAMPAIGN'
            ? ['urn:li:sponsoredCampaign:1']
            : ['urn:li:sponsoredCampaignGroup:1', 'urn:li:sponsoredCampaignGroup:2']
        ).map(urn => ({
          pivotValues: [urn],
          dateRange: {start: linkedinDate(start), end: linkedinDate(end)},
          impressions: 100,
          clicks: 2,
          costInLocalCurrency: '10.5',
          externalWebsiteConversions: 1,
          oneClickLeads: '2',
          qualifiedLeads: '1',
          landingPageClicks: '4',
          videoViews: '3',
          talentLeads: '1',
          conversionValueInLocalCurrency: '8',
          approximateMemberReach: '40',
        })),
      };
    }
    if (plan.path === '/rest/adAccounts/507/adCampaigns') {
      return {
        elements: [
          {
            id: 1,
            account: 'urn:li:sponsoredAccount:507',
            name: 'LinkedIn campaign',
            objectiveType: 'LEAD_GENERATION',
            campaignGroup: 'urn:li:sponsoredCampaignGroup:1',
          },
        ],
      };
    }
    if (plan.path === '/rest/adAccounts/507/adCampaignGroups') {
      if (groups instanceof MirrorError) return groups;
      return {
        elements: groups ?? [
          {id: 1, account: 'urn:li:sponsoredAccount:507', name: 'LinkedIn 1', objectiveType: 'LEAD_GENERATION'},
        ],
      };
    }
    if (plan.path === '/rest/adAccounts/507/creatives')
      return {
        elements: [
          {
            id: 'urn:li:sponsoredCreative:3',
            account: 'urn:li:sponsoredAccount:507',
            campaign: 'urn:li:sponsoredCampaign:1',
            name: 'LinkedIn creative',
          },
        ],
        metadata: {},
      };
    return new MirrorError('UNEXPECTED_REQUEST', 'Unexpected LinkedIn request ' + plan.path);
  };
const x =
  ({account = {timezone: 'UTC'}, lineItems, active} = {}) =>
  plan => {
    if (plan.path === '/12/accounts/abc') return {data: {id: 'abc', name: 'Synthetic X', currency: 'USD', ...account}};
    if (plan.path === '/12/accounts/abc/campaigns')
      return {
        data: [
          {id: 'c1', name: 'X c1'},
          {id: 'c2', name: 'X c2'},
        ],
      };
    if (plan.path === '/12/accounts/abc/line_items') {
      if (lineItems instanceof MirrorError) return lineItems;
      return {
        data: lineItems ?? [
          {id: 'li1', campaign_id: 'c1', objective: 'WEBSITE_CLICKS'},
          {id: 'li2', campaign_id: 'c2', objective: 'WEBSITE_CLICKS'},
          {id: 'li3', campaign_id: 'c2', objective: 'APP_INSTALLS'},
        ],
      };
    }
    if (plan.path === '/12/stats/accounts/abc/active_entities') {
      if (active instanceof MirrorError) return active;
      return {
        data: active ?? [
          {
            entity_id: 'c1',
            activity_start_time: '2026-08-01T02:00:00Z',
            activity_end_time: '2026-08-01T05:00:00Z',
            placements: ['ALL_ON_TWITTER'],
          },
        ],
      };
    }
    if (plan.path === '/12/stats/accounts/abc') {
      const ids = String(plan.query.entity_ids).split(','),
        hours = (Date.parse(plan.query.end_time) - Date.parse(plan.query.start_time)) / 3600000;
      return {
        data: ids.map(id => ({
          id,
          id_data: [
            {
              segment: null,
              metrics: {
                impressions: Array(hours).fill(1),
                clicks: Array(hours).fill(0),
                billed_charge_local_micro: Array(hours).fill(10000),
              },
            },
          ],
        })),
      };
    }
    return new MirrorError('UNEXPECTED_REQUEST', 'Unexpected X request ' + plan.path);
  };
const msRow = (extra = {}) => ({
  AccountId: '123',
  CampaignId: '9',
  CampaignName: 'Search',
  CurrencyCode: 'AED',
  Spend: '12.50',
  Impressions: '100',
  Clicks: '7',
  Conversions: '1.5',
  Revenue: '30',
  ...extra,
});
const microsoft =
  ({rows = [msRow()], account = {TimeZone: 'AbuDhabiMuscat'}, submit, poll} = {}) =>
  plan => {
    if (plan.action === 'GetAccount')
      return {Account: {Id: '123', Name: 'Synthetic Microsoft', CurrencyCode: 'AED', ...account}};
    if (plan.action === 'SubmitGenerateReport') return submit ? submit() : {ReportRequestId: 'r1'};
    if (poll) return poll(plan);
    return {
      ReportRequestStatus: {Status: 'Success'},
      download_complete: true,
      potentially_incomplete: false,
      has_more: false,
      rows,
    };
  };
const appleRow = id => ({
  metadata: {id, name: 'Apple ' + id},
  totalMetrics: {localSpend: {amount: '12.34', currency: 'USD'}, impressions: 100, taps: 5, totalInstalls: 2},
});
const appleRecords = {
  ads: [{id: 701, adGroupId: 601, campaignId: 501, adAccountId: 500}],
  adgroups: [{id: 601, name: 'Group 601', campaignId: 501, adAccountId: 500}],
  campaigns: [{id: 501, name: 'Campaign 501', adAccountId: 500}],
};
const apple =
  (rows = [appleRow(701)], records = appleRecords, extra = {}) =>
  plan => {
    if (plan.path === '/v1/ad-accounts/500') return {result: {id: 500, name: 'Synthetic Apple', currency: 'USD'}};
    if (plan.path.startsWith('/v1/reports/apps/'))
      return {result: {rows: typeof rows === 'function' ? rows() : rows}, ...extra};
    const kind = plan.path.split('/')[2];
    if (records[kind] instanceof MirrorError) return records[kind];
    const ids = plan.body.filters[0].value.map(String);
    return {result: (records[kind] ?? []).filter(r => ids.includes(String(r.id)))};
  };
const redditRow = (extra = {}) => ({
  campaign_id: '11',
  ad_group_id: '22',
  ad_id: '33',
  spend: 1234567,
  impressions: 100,
  clicks: 4,
  ...extra,
});
const redditLists = {
  ad_groups: [{id: '22', name: 'Group 22', campaign_id: '11', ad_account_id: 't2_acct'}],
  ads: [{id: '33', name: 'Ad 33', ad_group_id: '22', campaign_id: '11', ad_account_id: 't2_acct'}],
};
const reddit =
  (report = [redditRow()], lists = redditLists) =>
  plan => {
    if (plan.path === '/api/v3/ad_accounts/t2_acct')
      return {data: {id: 't2_acct', name: 'Synthetic Reddit', currency: 'USD', time_zone_id: 'UTC'}};
    if (plan.path.endsWith('/reports')) return {data: {metrics: report}};
    if (plan.path.endsWith('/campaigns')) return {data: [{id: '11', name: 'Campaign 11', objective: 'CONVERSIONS'}]};
    const kind = plan.path.endsWith('/ad_groups') ? 'ad_groups' : 'ads';
    if (lists[kind] instanceof MirrorError) return lists[kind];
    const ids = String(plan.query.id).split(',');
    return {data: (lists[kind] ?? []).filter(r => ids.includes(r.id))};
  };
const ga4 =
  ({restricted = [], sampled = false, rows, labels, metadata = {}} = {}) =>
  plan => {
    if (plan.path === '/v1beta/properties/123')
      return {name: 'properties/123', displayName: 'Synthetic GA4', currencyCode: 'USD', timeZone: 'America/New_York'};
    const dimensions = plan.body.dimensions.map(d => d.name),
      named = dimensions.length === 2,
      headers = plan.body.metrics.map(m => ({name: m.name}));
    const data = named
      ? (labels ?? [
          [['111', 'Spring'], ['8']],
          [['111', 'spring'], ['2']],
          [['222', 'Summer'], ['5']],
        ])
      : (rows ?? [
          [['111'], ['10', '7', '2', '9.5']],
          [['222'], ['5', '4', '0', '0']],
          [['(not set)'], ['3', '3', '0', '0']],
        ]);
    return {
      dimensionHeaders: dimensions.map(name => ({name})),
      metricHeaders: headers,
      rows: data.map(([dims, values]) => ({
        dimensionValues: dims.map(value => ({value})),
        metricValues: values.map(value => ({value})),
      })),
      rowCount: data.length,
      metadata: {
        currencyCode: 'USD',
        timeZone: 'America/New_York',
        ...(restricted.length
          ? {schemaRestrictionResponse: {activeMetricRestrictions: restricted.map(metricName => ({metricName}))}}
          : {}),
        ...(sampled ? {samplingMetadatas: [{samplesReadCount: '50', samplingSpaceSize: '100'}]} : {}),
        ...metadata,
      },
    };
  };
const gscSite = 'sc-domain:example.com';
const gsc =
  (count = 2) =>
  () => ({
    rows: Array.from({length: count}, (_, i) => ({
      keys: ['https://example.com/p' + i],
      clicks: count - i,
      impressions: 20,
      position: 2.5,
      ctr: 0.1,
    })),
  });
const refused = (status = 403, code = 'PLATFORM_ERROR') => new MirrorError(code, 'Synthetic refusal', {}, status);
const retryable = () => new MirrorError('PLATFORM_UNAVAILABLE', 'Synthetic outage', {}, 503, true);

/** Every scenario: the platform's gateway and account, its provider answers and what the collector is asked. */
export const collectScenarios = [
  // Unsupported platform and invalid native metrics.
  {
    name: 'unsupported platform',
    gateway: 'google_ads_native_action',
    account: '1',
    answer: google([]),
    source: source('other', '1'),
  },
  {
    name: 'google invalid native metric name',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([]),
    source: source('google', '1234567890', {native_metrics: ['bad-name!']}),
  },
  {
    name: 'google too many native metrics',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([]),
    source: source('google', '1234567890', {native_metrics: Array.from({length: 31}, (_, i) => 'm' + i)}),
  },
  {
    name: 'meta google-style native metric is refused',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([]),
    source: source('meta', '100', {native_metrics: ['metrics.all_conversions']}),
  },
  // Google Ads.
  {
    name: 'google campaign with native metrics',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([googleRow('77'), googleRow('78', {metrics: {costMicros: '0', impressions: '0'}})]),
    source: source('google', '1234567890', {native_metrics: ['metrics.all_conversions', 'metrics.misspelled_field']}),
  },
  {
    name: 'google daily',
    mode: 'daily',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([
      googleRow('77', {segments: {date: '2026-08-01'}}),
      googleRow('77', {segments: {date: '2026-08-03'}}),
      googleRow('78', {segments: {date: '2026-08-07'}}),
    ]),
    source: source('google', '1234567890'),
  },
  {
    name: 'google daily row outside the days',
    mode: 'daily',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([googleRow('77', {segments: {date: '2026-08-09'}})]),
    source: source('google', '1234567890'),
  },
  {
    name: 'google truncated report',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google(() => ({$envelope: {success: true, truncated: true, data: {results: []}}})),
    source: source('google', '1234567890'),
  },
  {
    name: 'google provider error envelope',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google(() => ({error: {code: 400, message: 'bad'}})),
    source: source('google', '1234567890'),
  },
  {
    name: 'google dry run',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google(() => ({$envelope: {dry_run: true, success: true, data: {}}})),
    source: source('google', '1234567890'),
  },
  {
    name: 'google report collection is not a list',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google(() => ({results: [1, 2]})),
    source: source('google', '1234567890'),
  },
  {
    name: 'google over 10,000 rows',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google(() => ({results: Array.from({length: 10001}, (_, i) => googleRow(String(i + 1)))})),
    source: source('google', '1234567890'),
  },
  {
    name: 'google two periods share one account lookup, then verify',
    mode: 'twice',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([googleRow('77')]),
    source: source('google', '1234567890'),
  },
  {
    name: 'google account currency changed during collection',
    mode: 'changed',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([googleRow('77')]),
    changed: google([googleRow('77')], {currencyCode: 'USD'}),
    source: source('google', '1234567890'),
  },
  {
    name: 'google ad group level goes to the guided collector',
    gateway: 'google_ads_native_action',
    account: '1234567890',
    answer: google([]),
    source: detailed('google', '1234567890', 'adset'),
  },
  // Meta.
  {
    name: 'meta campaign with the unified attribution setting',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([
      metaRow('1'),
      metaRow('2', {objective: 'OUTCOME_SALES', actions: [{action_type: 'purchase', value: '2'}], impressions: '9'}),
    ]),
    source: source('meta', '100', {native_metrics: ['inline_link_clicks']}),
  },
  {
    name: 'meta campaign with an attribution profile',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([metaRow('1')]),
    source: source('meta', '100', {report_options: {attribution_windows: ['1d_view', '7d_click']}}),
  },
  {
    name: 'meta campaign with an invalid attribution profile',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([metaRow('1')]),
    source: source('meta', '100', {report_options: {attribution_windows: ['7d_click'], extra: true}}),
  },
  {
    name: 'meta daily',
    mode: 'daily',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([
      metaRow('1', {date_start: '2026-08-01', date_stop: '2026-08-01'}),
      metaRow('1', {date_start: '2026-08-02', date_stop: '2026-08-02'}),
    ]),
    source: source('meta', '100'),
  },
  {
    name: 'meta daily row spanning two days',
    mode: 'daily',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([metaRow('1', {date_start: '2026-08-01', date_stop: '2026-08-02'})]),
    source: source('meta', '100'),
  },
  {
    name: 'meta rows of another account',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([metaRow('1', {account_id: '999'})]),
    source: source('meta', '100'),
  },
  {
    name: 'meta ad level goes to the guided collector',
    gateway: 'meta_native_action',
    account: '100',
    answer: meta([]),
    source: source('meta', '100', {
      level: 'ad',
      report_options: {complete_window: true, result_action_type: 'lead', attribution_windows: ['7d_click']},
    }),
  },
  {
    name: 'daily segmentation refused for a TikTok source',
    mode: 'daily',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(),
    source: source('tiktok', '7000'),
  },
  // TikTok.
  {
    name: 'tiktok campaign with optimization events',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(),
    source: source('tiktok', '7000', {native_metrics: ['reach', 'likes']}),
  },
  {
    name: 'tiktok ad group read refused',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(refused()),
    source: source('tiktok', '7000'),
  },
  {
    name: 'tiktok ad group read retryable failure',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(retryable()),
    source: source('tiktok', '7000'),
  },
  {
    name: 'tiktok two periods share the events read',
    mode: 'twice',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(),
    source: source('tiktok', '7000'),
  },
  {
    name: 'tiktok non-zero provider code',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(undefined, {code: 40001, message: 'No permission'}),
    source: source('tiktok', '7000'),
  },
  {
    name: 'tiktok ad group level goes to the guided collector',
    gateway: 'tiktok_native_action',
    account: '7000',
    answer: tiktok(),
    source: detailed('tiktok', '7000', 'adset'),
  },
  // Snapchat.
  {
    name: 'snapchat campaign with the provider default windows',
    gateway: 'snapchat_native_action',
    account: snapAccount,
    answer: snapchat(),
    source: source('snapchat', snapAccount, {native_metrics: ['video_views']}),
  },
  {
    name: 'snapchat campaign with an attribution profile',
    gateway: 'snapchat_native_action',
    account: snapAccount,
    answer: snapchat(),
    source: source('snapchat', snapAccount, {
      report_options: {swipe_up_attribution_window: '7_DAY', view_attribution_window: '1_DAY'},
    }),
  },
  {
    name: 'snapchat account without a timezone',
    gateway: 'snapchat_native_action',
    account: snapAccount,
    answer: snapchat({timezone: undefined}),
    source: source('snapchat', snapAccount),
  },
  // LinkedIn.
  {
    name: 'linkedin group with group metadata',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin(),
    source: source('linkedin', '507', {native_metrics: ['videoViews']}),
  },
  {
    name: 'linkedin group metadata refused',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin({groups: refused()}),
    source: source('linkedin', '507'),
  },
  {
    name: 'linkedin group metadata of another account',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin({groups: [{id: 1, account: 'urn:li:sponsoredAccount:9', name: 'Foreign'}]}),
    source: source('linkedin', '507'),
  },
  {
    name: 'linkedin account id mismatch',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin({account: {id: 999, currency: 'USD'}}),
    source: source('linkedin', '507'),
  },
  {
    name: 'linkedin invalid currency',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin({account: {id: 507, currency: 'usd'}}),
    source: source('linkedin', '507'),
  },
  {
    name: 'linkedin too many metrics',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin(),
    source: source('linkedin', '507', {native_metrics: Array.from({length: 19}, (_, i) => 'metric' + i)}),
  },
  {
    name: 'linkedin two periods read only new groups',
    mode: 'twice',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin(),
    source: source('linkedin', '507'),
  },
  {
    name: 'linkedin creatives with native campaign and group parents',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin(),
    source: detailed('linkedin', '507', 'ad'),
  },
  {
    name: 'linkedin campaigns in the middle position',
    gateway: 'linkedin_native_action',
    account: '507',
    answer: linkedin(),
    source: detailed('linkedin', '507', 'adset'),
  },
  // X.
  {
    name: 'x campaign through the inventory',
    env: {AMCP_X_ACTIVE_ENTITIES: 'off'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x(),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc'),
  },
  {
    name: 'x campaign through active entities',
    env: {AMCP_X_ACTIVE_ENTITIES: 'on'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x(),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc', {native_metrics: ['VIDEO']}),
  },
  {
    name: 'x active campaigns over the whole window',
    env: {AMCP_X_ACTIVE_ENTITIES: 'campaigns'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x(),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc'),
  },
  {
    name: 'x active entities refused, then resumed from the checkpoint',
    mode: 'resume',
    env: {AMCP_X_ACTIVE_ENTITIES: 'on'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x({active: refused(404)}),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc'),
  },
  {
    name: 'x line items refused',
    env: {AMCP_X_ACTIVE_ENTITIES: 'off'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x({lineItems: refused(403)}),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc'),
  },
  {
    name: 'x account without a timezone',
    env: {AMCP_X_ACTIVE_ENTITIES: 'off'},
    gateway: 'x_ads_native_action',
    account: 'abc',
    answer: x({account: {timezone: undefined}}),
    dates: {since: '2026-08-01', until: '2026-08-01'},
    source: source('x', 'abc'),
  },
  // Microsoft Advertising.
  {
    name: 'microsoft campaign',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft(),
    source: source('microsoft', '123', {native_metrics: ['AllConversions']}),
  },
  {
    name: 'microsoft ad groups',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({rows: [msRow({AdGroupId: '41', AdGroupName: 'Group 41'})]}),
    source: detailed('microsoft', '123', 'adset'),
  },
  {
    name: 'microsoft ads',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({rows: [msRow({AdGroupId: '41', AdGroupName: 'Group 41', AdId: '777', AdTitle: 'Ad'})]}),
    source: detailed('microsoft', '123', 'ad'),
  },
  {
    name: 'microsoft unrecognized time zone',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({account: {TimeZone: 'Mars'}}),
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft report pending',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({poll: () => ({ReportRequestStatus: {Status: 'Pending'}})}),
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft download incomplete',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({poll: () => ({ReportRequestStatus: {Status: 'Success'}, download_complete: false})}),
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft paged download',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({
      poll: plan => ({
        ReportRequestStatus: {Status: 'Success'},
        download_complete: true,
        potentially_incomplete: plan.reportDownload?.offset === 0 ? false : true,
        has_more: plan.reportDownload?.offset === 0,
        rows: [msRow({CampaignId: String(9 + (plan.reportDownload?.offset ?? 0))})],
      }),
    }),
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft submission without complete data',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({
      submit: () => new MirrorError('PLATFORM_ERROR', 'Synthetic', {upstream: {OperationErrors: [{Code: 2004}]}}, 400),
    }),
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft resumed with an earlier report and London zone',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft(),
    checkpoint: {report_id: 'r0'},
    source: source('microsoft', '123'),
  },
  {
    name: 'microsoft lost submission is never resubmitted',
    mode: 'uncertain',
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft({submit: () => new MirrorError('PLATFORM_ERROR', 'Synthetic outage', {}, 500)}),
    source: source('microsoft', '123'),
  },
  // Apple Ads.
  {
    name: 'apple campaign with requested native metrics',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple([appleRow(7), appleRow(8)]),
    source: source('apple', '500', {native_metrics: ['newDownloads']}),
  },
  {
    name: 'apple ads',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple(),
    source: detailed('apple', '500', 'ad'),
  },
  {
    name: 'apple ad groups',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple([appleRow(601)]),
    source: detailed('apple', '500', 'adset'),
  },
  {
    name: 'apple parents refused',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple([appleRow(601)], {...appleRecords, adgroups: refused()}),
    source: detailed('apple', '500', 'adset'),
  },
  {
    name: 'apple full detail page',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple(() => Array.from({length: 1000}, (_, i) => appleRow(1000 + i))),
    source: detailed('apple', '500', 'adset'),
  },
  {
    name: 'apple total results disagree',
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple([appleRow(601)], appleRecords, {pagination: {totalResults: 2}}),
    source: detailed('apple', '500', 'adset'),
  },
  // Reddit Ads.
  {
    name: 'reddit campaign with the conversion value',
    gateway: 'reddit_native_action',
    account: 't2_acct',
    answer: reddit([
      {campaign_id: '11', SPEND: 2000000, IMPRESSIONS: 10, CLICKS: 1, CONVERSION_PURCHASE_TOTAL_VALUE: 1999},
    ]),
    source: source('reddit', 't2_acct', {native_metrics: ['CONVERSION_PURCHASE_TOTAL_VALUE']}),
  },
  {
    name: 'reddit ads',
    gateway: 'reddit_native_action',
    account: 't2_acct',
    answer: reddit(),
    source: detailed('reddit', 't2_acct', 'ad'),
  },
  {
    name: 'reddit ad groups',
    gateway: 'reddit_native_action',
    account: 't2_acct',
    answer: reddit([redditRow({ad_id: undefined})]),
    source: detailed('reddit', 't2_acct', 'adset'),
  },
  {
    name: 'reddit names refused',
    gateway: 'reddit_native_action',
    account: 't2_acct',
    answer: reddit([redditRow()], {...redditLists, ad_groups: refused()}),
    source: detailed('reddit', 't2_acct', 'ad'),
  },
  // GA4.
  {
    name: 'ga4 campaigns with unattributed sessions and name drift',
    gateway: 'ga4_native_action',
    account: '123',
    answer: ga4(),
    source: source('ga4', '123', {native_metrics: ['engagementRate']}),
  },
  {
    name: 'ga4 restricted and sampled metrics',
    gateway: 'ga4_native_action',
    account: '123',
    answer: ga4({restricted: ['totalRevenue'], sampled: true, metadata: {subjectToThresholding: true}}),
    source: source('ga4', '123'),
  },
  {
    name: 'ga4 too many metrics',
    gateway: 'ga4_native_action',
    account: '123',
    answer: ga4(),
    source: source('ga4', '123', {native_metrics: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']}),
  },
  {
    name: 'ga4 has no account verification',
    mode: 'twice',
    gateway: 'ga4_native_action',
    account: '123',
    answer: ga4(),
    source: source('ga4', '123'),
  },
  // Search Console.
  {
    name: 'search console pages',
    gateway: 'google_search_console_native_action',
    account: gscSite,
    answer: gsc(),
    source: source('gsc', gscSite),
  },
  {
    name: 'search console at the row limit',
    gateway: 'google_search_console_native_action',
    account: gscSite,
    answer: gsc(10001),
    source: source('gsc', gscSite),
  },
];

/** Runs one scenario and returns what the collector sent, saved and answered. */
export async function runCollectScenario(scenario) {
  const saved = {};
  for (const [key, value] of Object.entries(scenario.env ?? {})) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const f = fixture(scenario.gateway, scenario.account, scenario.answer),
    dates = scenario.dates ?? week,
    save = value => f.saves.push(JSON.parse(recordedText(value))),
    outcome = {};
  try {
    if (scenario.mode === 'daily') outcome.result = await f.native.collectDaily(scenario.source, dates, actor);
    else if (scenario.mode === 'twice' || scenario.mode === 'changed') {
      const lookup = {};
      outcome.first = await f.native.collect(scenario.source, dates, actor, {}, save, lookup);
      outcome.second = await f.native.collect(scenario.source, nextWeek, actor, {}, save, lookup);
      // The account read after collection answers with another currency.
      if (scenario.mode === 'changed') f.provider.answer = scenario.changed;
      outcome.lookup = lookup;
      outcome.verify = await f.native.verifyAccount(scenario.source, actor, lookup);
    } else if (scenario.mode === 'resume') {
      outcome.first = await f.native.collect(scenario.source, dates, actor, {}, save);
      outcome.second = await f.native.collect(scenario.source, dates, actor, f.saves.at(-1) ?? {}, save);
    } else if (scenario.mode === 'uncertain') {
      try {
        await f.native.collect(scenario.source, dates, actor, {}, save);
      } catch (e) {
        outcome.first_error = errorRecord(e);
      }
      outcome.result = await f.native.collect(scenario.source, dates, actor, f.saves.at(-1) ?? {}, save);
    } else outcome.result = await f.native.collect(scenario.source, dates, actor, scenario.checkpoint ?? {}, save);
  } catch (e) {
    outcome.error = errorRecord(e);
  } finally {
    f.store.close();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  return compact(JSON.parse(recordedText({name: scenario.name, requests: f.requests, saves: f.saves, ...outcome})));
}
/** Results with many rows keep two rows and a digest of all of them, so the recording stays small and exact. */
function compact(record) {
  for (const key of ['result', 'first', 'second'])
    for (const result of Array.isArray(record[key]) ? record[key] : [record[key]])
      if (Array.isArray(result?.rows) && result.rows.length > 20)
        result.rows = {
          $rows: result.rows.length,
          sha256: crypto.createHash('sha256').update(JSON.stringify(result.rows)).digest('hex'),
          head: result.rows.slice(0, 2),
        };
  return record;
}

/** Every scenario's recording, in order. */
export async function collectRecordings() {
  const out = [];
  for (const scenario of collectScenarios) out.push(await runCollectScenario(scenario));
  return out;
}
