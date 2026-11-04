// RPT-07 granular parity: Microsoft, Reddit and Apple ad-group and ad levels in the Overview, through their native
// report paths. Synthetic provider answers behind a recording runPlan; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {overviewEntityLevels, overviewSourceLevel} from '../dist/src/overview-granularity.js';
import {nativeDecimal} from '../dist/src/overview-native-detail.js';
import {detailParentsUnavailableWarning} from '../dist/src/overview-parents.js';

const actor = {tenantId: 'native-detail', userId: 'owner', role: 'admin'};
const range = {since: '2026-08-01', until: '2026-08-07'};
function fixture(gateway, account, answer) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const plans = [];
  const service = {
    store,
    runPlan: async plan => {
      plans.push(plan);
      const data = await answer(plan);
      if (data instanceof MirrorError) throw data;
      return {success: true, data};
    },
  };
  return {plans, native: new NativeCampaignReports(service), close: () => store.close()};
}
const source = (platform, account, level, complete = true) => ({
  platform,
  account_id: account,
  connection_id: 'login',
  level,
  report_options: {complete_window: complete, attribution: 'unknown'},
});
const refusal = async (promise, code) => {
  await assert.rejects(promise, e => {
    assert.equal(e.code, code, e.message);
    return true;
  });
};
const currentSource = (...args) => ({...source(...args), reporting_contract: 'overview-config-v4'});

// ---- Microsoft ----
function microsoft(rows) {
  return fixture('microsoft_ads_native_action', '123', plan => {
    if (plan.action === 'GetAccount')
      return {Account: {Id: '123', Name: 'Synthetic', CurrencyCode: 'AED', TimeZone: 'AbuDhabiMuscat'}};
    if (plan.action === 'SubmitGenerateReport') return {ReportRequestId: 'r1'};
    return {
      ReportRequestStatus: {Status: 'Success'},
      download_complete: true,
      potentially_incomplete: false,
      has_more: false,
      rows: typeof rows === 'function' ? rows() : rows,
    };
  });
}
const msGroup = (id, extra = {}) => ({
  AccountId: '123',
  CampaignId: '9',
  CampaignName: 'Search',
  AdGroupId: id,
  AdGroupName: 'Group ' + id,
  CurrencyCode: 'AED',
  Spend: '12.50',
  Impressions: '100',
  Clicks: '7',
  Conversions: '1.5',
  Revenue: '30',
  ...extra,
});

test('Microsoft ad groups use the native ad group report and keep the parent campaign named by each row', async () => {
  const f = microsoft([msGroup('9007199254740993'), msGroup('41', {Spend: '0.1', Conversions: '--'})]);
  try {
    const result = await f.native.collect(source('microsoft', '123', 'adset'), range, actor);
    const submit = f.plans.find(p => p.action === 'SubmitGenerateReport').body.ReportRequest;
    assert.equal(submit.Type, 'AdGroupPerformanceReportRequest');
    assert.deepEqual(submit.Scope, {AccountIds: ['123']});
    assert.ok(['AdGroupId', 'AdGroupName', 'CampaignId'].every(c => submit.Columns.includes(c)));
    assert.equal(submit.Time.ReportTimeZone, 'AbuDhabiMuscat');
    assert.equal(result.detail_contract, 'overview-detail-v3');
    assert.equal(result.complete, true);
    const [big, small] = result.rows;
    assert.equal(big.entity_id, '9007199254740993', 'exact large native ID');
    assert.equal(big.entity_level, 'adset');
    assert.equal(big.native_entity_type, 'ad_group');
    assert.equal(big.entity_name, 'Group 9007199254740993');
    assert.deepEqual(big.parent_ids, {campaign_id: '9', campaign_name: 'Search'});
    assert.equal(big.campaign_id, '9');
    assert.deepEqual(big.native.exact_totals, {
      spend: '12.5',
      impressions: '100',
      clicks: '7',
      conversions: '1.5',
      conversion_value: '30',
    });
    assert.equal(big.metrics.reach, null);
    // A missing native value ('--') stays unknown, never zero.
    assert.equal(small.native.exact_totals.conversions, null);
    assert.equal(small.metrics.conversions, null);
  } finally {
    f.close();
  }
});

test('Microsoft ads use the native ad report and name their ad group and campaign', async () => {
  const f = microsoft([
    {...msGroup('41'), AdId: '777', AdTitle: ''},
    {...msGroup('41'), AdId: '778', AdTitle: 'Spring <sale>'},
  ]);
  try {
    const result = await f.native.collect(source('microsoft', '123', 'ad'), range, actor);
    const submit = f.plans.find(p => p.action === 'SubmitGenerateReport').body.ReportRequest;
    assert.equal(submit.Type, 'AdPerformanceReportRequest');
    assert.ok(['AdId', 'AdTitle', 'AdGroupId'].every(c => submit.Columns.includes(c)));
    assert.deepEqual(
      result.rows.map(r => [r.entity_id, r.entity_name, r.parent_ids]),
      [
        ['777', '777', {campaign_id: '9', campaign_name: 'Search', adset_id: '41', adset_name: 'Group 41'}],
        ['778', 'Spring <sale>', {campaign_id: '9', campaign_name: 'Search', adset_id: '41', adset_name: 'Group 41'}],
      ],
    );
  } finally {
    f.close();
  }
});

test('Microsoft detail refuses foreign, duplicate, parentless, other-currency and non-decimal rows', async () => {
  for (const [rows, code] of [
    [[msGroup('41', {AccountId: '999'})], 'REPORT_ACCOUNT_MISMATCH'],
    [[msGroup('41'), msGroup('41')], 'REPORT_SHAPE_CHANGED'],
    [[msGroup('41', {CampaignId: ''})], 'REPORT_SHAPE_CHANGED'],
    [[msGroup('41', {CurrencyCode: 'USD'})], 'REPORT_CURRENCY_MISMATCH'],
    [[msGroup('41', {Spend: '1,234.00'})], 'REPORT_SHAPE_CHANGED'],
  ]) {
    const f = microsoft(rows);
    try {
      await refusal(f.native.collect(source('microsoft', '123', 'adset'), range, actor), code);
    } finally {
      f.close();
    }
  }
});

test('a declared-incomplete detailed window keeps the source partial and its measurement incomplete', async () => {
  const f = microsoft([msGroup('41')]);
  try {
    const result = await f.native.collect(source('microsoft', '123', 'adset', false), range, actor);
    assert.equal(result.complete, false);
    assert.equal(result.quality.measurement_complete, false);
    assert.match(result.warnings.join(' '), /declared incomplete/);
  } finally {
    f.close();
  }
});

test('provider values beyond nine decimal places are rounded half to even and recorded (D10)', async () => {
  const rounding = {};
  assert.equal(nativeDecimal('0.0000000015', 'spend', rounding), '0.000000002');
  assert.equal(nativeDecimal('0.0000000025', 'spend', rounding), '0.000000002');
  assert.equal(nativeDecimal('1234567', 'spend', rounding, 1000000), '1.234567');
  assert.equal(nativeDecimal('--', 'spend', rounding), null);
  assert.equal(nativeDecimal('', 'spend', rounding), null);
  assert.deepEqual(rounding, {spend: 2});
  const f = microsoft([msGroup('41', {Spend: '0.0000000015'})]);
  try {
    const result = await f.native.collect(source('microsoft', '123', 'adset'), range, actor);
    assert.equal(result.rows[0].native.exact_totals.spend, '0.000000002');
    assert.deepEqual(result.quality.metric_rounding, {spend: {places: 9, rule: 'half_even', rows_rounded: 1}});
  } finally {
    f.close();
  }
});

// ---- Reddit ----
function reddit(report, lists = {}) {
  return fixture('reddit_native_action', 't2_acct', plan => {
    if (plan.path === '/api/v3/ad_accounts/t2_acct')
      return {data: {id: 't2_acct', name: 'Synthetic Reddit', currency: 'USD', time_zone_id: 'UTC'}};
    if (plan.path.endsWith('/reports')) return {data: {metrics: report}};
    if (plan.path.endsWith('/campaigns')) return {data: [{id: '11', name: 'Campaign 11', objective: 'CONVERSIONS'}]};
    const kind = plan.path.endsWith('/ad_groups') ? 'adGroups' : 'ads';
    if (lists[kind] instanceof MirrorError) return lists[kind];
    const ids = String(plan.query.id).split(',');
    return {data: (lists[kind] ?? []).filter(r => ids.includes(r.id))};
  });
}
const redditRow = (extra = {}) => ({
  campaign_id: '11',
  ad_group_id: '22',
  ad_id: '33',
  spend: 1234567,
  impressions: 100,
  clicks: 4,
  ...extra,
});
const redditGroups = [{id: '22', name: 'Group 22', campaign_id: '11', ad_account_id: 't2_acct'}],
  redditAds = [{id: '33', name: 'Ad 33', ad_group_id: '22', campaign_id: '11', ad_account_id: 't2_acct'}];

test('Reddit ads break down by campaign, ad group and ad, with names from the account lists and exact micros', async () => {
  const f = reddit([redditRow()], {adGroups: redditGroups, ads: redditAds});
  try {
    const result = await f.native.collect(source('reddit', 't2_acct', 'ad'), range, actor);
    const report = f.plans.find(p => p.path.endsWith('/reports'));
    assert.deepEqual(report.body.data.breakdowns, ['CAMPAIGN_ID', 'AD_GROUP_ID', 'AD_ID']);
    const lists = f.plans.filter(p => /\/(ad_groups|ads)$/.test(p.path));
    assert.deepEqual(
      lists.map(p => [p.path, p.query.id]),
      [
        ['/api/v3/ad_accounts/t2_acct/ad_groups', '22'],
        ['/api/v3/ad_accounts/t2_acct/ads', '33'],
      ],
    );
    const [row] = result.rows;
    assert.equal(row.entity_id, '33');
    assert.equal(row.entity_name, 'Ad 33');
    assert.deepEqual(row.parent_ids, {
      campaign_id: '11',
      campaign_name: 'Campaign 11',
      adset_id: '22',
      adset_name: 'Group 22',
    });
    assert.equal(row.native.exact_totals.spend, '1.234567', 'Reddit microcurrency divided exactly');
    assert.equal(row.native_entity_type, 'ad');
  } finally {
    f.close();
  }
  const groups = reddit([redditRow({ad_id: undefined})], {adGroups: redditGroups});
  try {
    const result = await groups.native.collect(source('reddit', 't2_acct', 'adset'), range, actor);
    assert.deepEqual(groups.plans.find(p => p.path.endsWith('/reports')).body.data.breakdowns, [
      'CAMPAIGN_ID',
      'AD_GROUP_ID',
    ]);
    assert.deepEqual(result.rows[0].parent_ids, {campaign_id: '11', campaign_name: 'Campaign 11'});
    assert.equal(result.rows[0].entity_name, 'Group 22');
  } finally {
    groups.close();
  }
});

test('Reddit refuses changed hierarchies and foreign records; a refused name read keeps IDs with a warning', async () => {
  for (const [report, lists] of [
    [[redditRow()], {adGroups: redditGroups, ads: [{...redditAds[0], ad_group_id: '99'}]}],
    [[redditRow()], {adGroups: [{...redditGroups[0], campaign_id: '12'}], ads: redditAds}],
    [[redditRow()], {adGroups: redditGroups, ads: [{...redditAds[0], ad_account_id: 't2_other'}]}],
  ]) {
    const f = reddit(report, lists);
    try {
      await refusal(f.native.collect(source('reddit', 't2_acct', 'ad'), range, actor), 'REPORT_ACCOUNT_MISMATCH');
    } finally {
      f.close();
    }
  }
  for (const report of [[redditRow(), redditRow()], [redditRow({ad_group_id: undefined})]]) {
    const f = reddit(report, {adGroups: redditGroups, ads: redditAds});
    try {
      await refusal(f.native.collect(source('reddit', 't2_acct', 'ad'), range, actor), 'REPORT_SHAPE_CHANGED');
    } finally {
      f.close();
    }
  }
  const denied = reddit([redditRow()], {
    adGroups: new MirrorError('PLATFORM_ERROR', 'Forbidden', {}, 403),
    ads: redditAds,
  });
  try {
    const result = await denied.native.collect(source('reddit', 't2_acct', 'ad'), range, actor);
    assert.equal(result.rows[0].entity_name, '33', 'the ID stands in for the unread name');
    assert.equal(result.rows[0].parent_ids.adset_id, '22', 'parents still come from the report');
    assert.match(result.warnings.join(' '), /names could not be read/);
  } finally {
    denied.close();
  }
});

// ---- Apple ----
function apple(rows, records = {}) {
  return fixture('apple_ads_native_action', '500', plan => {
    if (plan.path === '/v1/ad-accounts/500') return {result: {id: 500, name: 'Synthetic Apple', currency: 'USD'}};
    if (plan.path.startsWith('/v1/reports/apps/')) return {result: {rows: typeof rows === 'function' ? rows() : rows}};
    const kind = plan.path.split('/')[2];
    if (records[kind] instanceof MirrorError) return records[kind];
    const ids = plan.body.filters[0].value.map(String);
    return {result: (records[kind] ?? []).filter(r => ids.includes(String(r.id)))};
  });
}
const appleRow = id => ({
  metadata: {id, name: 'Entity ' + id},
  totalMetrics: {localSpend: {amount: '12.34', currency: 'USD'}, impressions: 100, taps: 5, totalInstalls: 2},
});
const appleRecords = {
  ads: [{id: 701, adGroupId: 601, campaignId: 501, adAccountId: 500}],
  adgroups: [{id: 601, name: 'Group 601', campaignId: 501, adAccountId: 500}],
  campaigns: [{id: 501, name: 'Campaign 501', adAccountId: 500}],
};

test('Apple ad groups and ads take their parents from the account’s own records', async () => {
  const f = apple([appleRow(701)], appleRecords);
  try {
    const result = await f.native.collect(source('apple', '500', 'ad'), range, actor);
    assert.ok(
      f.plans.some(p => p.path === '/v1/reports/apps/ads/query' && p.action === 'apple_ads_v1_reports_apps_ads'),
    );
    assert.deepEqual(
      f.plans.filter(p => p.path.endsWith('/query') && !p.path.includes('/reports/')).map(p => p.action),
      ['apple_ads_v1_ads_query', 'apple_ads_v1_adgroups_query', 'apple_ads_v1_campaigns_query'],
    );
    const [row] = result.rows;
    assert.equal(row.entity_id, '701');
    assert.deepEqual(row.parent_ids, {
      campaign_id: '501',
      campaign_name: 'Campaign 501',
      adset_id: '601',
      adset_name: 'Group 601',
    });
    assert.deepEqual(row.native.exact_totals, {
      spend: '12.34',
      impressions: '100',
      clicks: '5',
      conversions: '2',
      conversion_value: null,
    });
  } finally {
    f.close();
  }
  const groups = apple([appleRow(601)], appleRecords);
  try {
    const result = await groups.native.collect(source('apple', '500', 'adset'), range, actor);
    assert.deepEqual(result.rows[0].parent_ids, {campaign_id: '501', campaign_name: 'Campaign 501'});
    assert.equal(result.rows[0].native_entity_type, 'adgroup');
  } finally {
    groups.close();
  }
});

test('Apple refuses conflicting parents, another currency and a full report page; a refused parent read is unknown', async () => {
  const conflicting = apple([appleRow(701)], {
    ...appleRecords,
    adgroups: [{...appleRecords.adgroups[0], campaignId: 502}],
  });
  try {
    await refusal(conflicting.native.collect(source('apple', '500', 'ad'), range, actor), 'REPORT_ACCOUNT_MISMATCH');
  } finally {
    conflicting.close();
  }
  const currency = apple(
    [{...appleRow(601), totalMetrics: {localSpend: {amount: '1', currency: 'EUR'}}}],
    appleRecords,
  );
  try {
    await refusal(currency.native.collect(source('apple', '500', 'adset'), range, actor), 'REPORT_CURRENCY_MISMATCH');
  } finally {
    currency.close();
  }
  const full = apple(() => Array.from({length: 1000}, (_, i) => appleRow(1000 + i)), appleRecords);
  try {
    await refusal(full.native.collect(source('apple', '500', 'adset'), range, actor), 'INCOMPLETE_REPORT');
  } finally {
    full.close();
  }
  const denied = apple([appleRow(601)], {...appleRecords, adgroups: new MirrorError('PLATFORM_ERROR', 'No', {}, 403)});
  try {
    const result = await denied.native.collect(source('apple', '500', 'adset'), range, actor);
    assert.deepEqual(result.rows[0].parent_ids, {});
    assert.equal(result.rows[0].campaign_id, null);
    assert.ok(result.warnings.includes(detailParentsUnavailableWarning));
  } finally {
    denied.close();
  }
});

test('the three providers expose ad-group and ad levels with the guided detailed-source rules', () => {
  for (const platform of ['microsoft', 'reddit', 'apple']) {
    assert.deepEqual(
      overviewEntityLevels[platform].map(l => l.id),
      ['campaign', 'adset', 'ad'],
    );
    const account = platform === 'reddit' ? 't2_acct' : '1';
    for (const level of ['adset', 'ad']) {
      assert.equal(overviewSourceLevel(source(platform, account, level)).id, level);
      assert.throws(
        () => overviewSourceLevel({...source(platform, account, level), native_metrics: ['AllConversions']}),
        e => e.code === 'INVALID_NATIVE_METRICS',
      );
      assert.throws(
        () => overviewSourceLevel({...source(platform, account, level), report_options: {complete_window: true}}),
        /Declare the detailed report attribution/,
      );
    }
    // Campaign sources keep their original shape: no detailed settings.
    assert.equal(overviewSourceLevel({platform, account_id: account, connection_id: 'login'}).id, 'campaign');
  }
});

test('Microsoft v4 selects and retains the current status column for each native detail level', async () => {
  for (const level of ['adset', 'ad']) {
    const f = microsoft([msGroup('41', {AdId: '51', AdGroupStatus: 'Paused', AdStatus: 'Deleted'})]);
    try {
      const result = await f.native.collect(currentSource('microsoft', '123', level), range, actor),
        submit = f.plans.find(plan => plan.action === 'SubmitGenerateReport');
      assert.equal(result.rows[0].status, level === 'ad' ? 'archived' : 'paused');
      assert.ok(JSON.stringify(submit).includes(level === 'ad' ? 'AdStatus' : 'AdGroupStatus'));
    } finally {
      f.close();
    }
  }
});

test('Reddit v4 uses current configured child status even when effective status or parent status differs', async () => {
  for (const level of ['adset', 'ad']) {
    const f = reddit([redditRow(level === 'adset' ? {ad_id: undefined} : {})], {
      adGroups: redditGroups.map(row => ({...row, configured_status: 'ACTIVE'})),
      ads: redditAds.map(row => ({...row, configured_status: 'PAUSED', effective_status: 'ACTIVE'})),
    });
    try {
      const result = await f.native.collect(currentSource('reddit', 't2_acct', level), range, actor);
      assert.equal(result.rows[0].status, level === 'ad' ? 'paused' : 'active');
      assert.equal(result.rows[0].parent_ids.entity_metadata, undefined);
    } finally {
      f.close();
    }
  }
});

test('Apple v4 reads advertiser-controlled current status rather than the report display label', async () => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const entity = {campaign: 501, adset: 601, ad: 701}[level],
      row = {...appleRow(entity), metadata: {id: entity, name: 'Synthetic', status: 'RUNNING'}},
      records = Object.fromEntries(
        Object.entries(appleRecords).map(([key, values]) => [
          key,
          values.map(value => ({...value, status: 'PAUSED', systemStatus: 'RUNNING'})),
        ]),
      ),
      f = apple([row], records);
    try {
      const result = await f.native.collect(currentSource('apple', '500', level), range, actor);
      assert.equal(result.rows[0].status, 'paused');
      assert.equal(result.rows[0].native.status_evidence.native_status, 'PAUSED');
      assert.ok(f.plans.some(plan => plan.action === 'apple_ads_v1_campaigns_query'));
    } finally {
      f.close();
    }
  }
});

test('Apple v4 refuses foreign current metadata at campaign and ad levels', async () => {
  for (const level of ['campaign', 'ad']) {
    const records = structuredClone(appleRecords),
      key = level === 'ad' ? 'ads' : 'campaigns';
    records[key][0].adAccountId = 999;
    const f = apple([appleRow(level === 'ad' ? 701 : 501)], records);
    try {
      await refusal(f.native.collect(currentSource('apple', '500', level), range, actor), 'REPORT_ACCOUNT_MISMATCH');
    } finally {
      f.close();
    }
  }
});
