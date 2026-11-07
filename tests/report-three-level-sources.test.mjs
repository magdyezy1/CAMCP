// F-L5-29. Target section 9 asks for "a resume test across every collection unit of a multi-level source", and no test
// ran Microsoft, Reddit or Apple through three levels. These do both, through the real queue, worker and collectors; only
// the provider's answers are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {REPORT_BUDGET_KIND} from '../dist/src/report-checkpoints.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {tiktokNativeFixture} from './helpers/tiktok-native-fixture.mjs';

const levels = ['campaign', 'adset', 'ad'],
  nativeLevel = url =>
    ({AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adset', AUCTION_AD: 'ad'})[url.searchParams.get('data_level')],
  isReport = url => url.pathname.endsWith('/report/integrated/get/'),
  daily = url => url.searchParams.get('dimensions')?.includes('stat_time_day') === true,
  /**
   * The report read that belongs to one unit alone. A TikTok campaign unit also reads its ad groups' totals to learn what
   * they optimize for (a daily read it is not), so the ad group unit is told by its day-segmented report.
   */
  marker = {
    campaign: url => isReport(url) && nativeLevel(url) === 'campaign',
    adset: url => isReport(url) && nativeLevel(url) === 'adset' && daily(url),
    ad: url => isReport(url) && nativeLevel(url) === 'ad',
  };

// A source interrupted at each of its collection units (campaign, ad group, ad) by a temporary provider failure ends
// as the uninterrupted run does: the finished units are not read again, the failed one is read again, the later ones are
// read once, and the whole-job counters count what was sent, once.
for (const failing of levels)
  test(`a three-level source interrupted at its ${failing} unit resumes to the uninterrupted result without rereading finished units`, async t => {
    const clean = tiktokNativeFixture(t, {groupsPerCampaign: 2, adsPerGroup: 2}),
      cleanQueued = await clean.queue(clean.v4());
    await clean.worker.once();
    const reference = await clean.get(cleanQueued.id),
      cleanReads = level => clean.requests.filter(marker[level]).length;
    assert.equal(reference.state, 'complete');
    assert.equal(reference.row_count, 1 + 2 + 4);

    const f = tiktokNativeFixture(t, {groupsPerCampaign: 2, adsPerGroup: 2});
    // The provider is down for this unit's report while the first attempt runs (the transport retries a single failure
    // itself, so one failed answer would not interrupt the job).
    let outage = true,
      failedReads = 0;
    f.state.hook = url => {
      if (outage && marker[failing](url)) {
        failedReads++;
        return new Response('upstream down', {status: 503});
      }
    };
    const reads = level => f.requests.filter(marker[level]).length,
      queued = await f.queue(f.v4());
    await f.worker.once();
    assert.deepEqual([f.job(queued.job_id).state, f.stored(queued.id).state], ['queued', 'running']);
    const interrupted = Object.fromEntries(levels.map(level => [level, reads(level)]));
    assert.ok(failedReads >= 1);
    outage = false;
    f.requeue();
    await f.worker.once();
    const report = await f.get(queued.id);
    assert.equal(report.state, 'complete', JSON.stringify(report.sources[0].level_results.map(l => l.error)));
    assert.equal(f.job(queued.job_id).state, 'complete');
    // The same rows, in every level, as the run nothing interrupted.
    const shape = r => r.rows.map(row => [row.level, row.entity_id, row.metrics.spend, row.row_key]).sort();
    assert.deepEqual(shape(report), shape(reference));
    // Units finished before the interruption are not read again; the failed unit is read again, after the reads that
    // failed; the units after it are read once, as in the uninterrupted run.
    for (const level of levels) {
      assert.equal(reads(level), cleanReads(level) + (level === failing ? failedReads : 0), level + ' report reads');
      if (levels.indexOf(level) < levels.indexOf(failing))
        assert.equal(reads(level), interrupted[level], level + ' was finished and is not read again');
    }
    // The counters count every request that was sent, once, and the rows once.
    const counters = f.store.repo(REPORT_BUDGET_KIND, f.actor.tenantId).find(queued.id),
      cleanCounters = clean.store.repo(REPORT_BUDGET_KIND, clean.actor.tenantId).find(cleanQueued.id);
    assert.equal(counters.requests, f.requests.length, 'requests counted equal requests sent');
    assert.equal(counters.rows, cleanCounters.rows, 'the rows of a unit are not counted twice');
    assert.deepEqual(
      report.sources[0].cross_level.map(item => [item.metric, item.state]),
      reference.sources[0].cross_level.map(item => [item.metric, item.state]),
    );
  });
// The synthetic answers of Microsoft, Reddit and Apple, in the shapes their collectors read (the same shapes the
// repository's collector scenarios use), one campaign, one ad group and one ad, each with the same spend.
const microsoftRow = (extra = {}) => ({
  AccountId: '123',
  CampaignId: '9',
  CampaignName: 'Search',
  CurrencyCode: 'AED',
  Spend: '12.50',
  Impressions: '100',
  Clicks: '7',
  Conversions: '1.5',
  Revenue: '30',
  CampaignStatus: 'Active',
  AdGroupStatus: 'Active',
  AdStatus: 'Active',
  ...extra,
});
const microsoft = () => {
  let type = null;
  return plan => {
    if (plan.action === 'GetAccount')
      return {Account: {Id: '123', Name: 'Synthetic account', CurrencyCode: 'AED', TimeZone: 'AbuDhabiMuscat'}};
    if (plan.action === 'SubmitGenerateReport') {
      type = plan.body.ReportRequest.Type;
      return {ReportRequestId: 'r1'};
    }
    const rows = type.startsWith('Campaign')
      ? [microsoftRow()]
      : type.startsWith('AdGroup')
        ? [microsoftRow({AdGroupId: '41', AdGroupName: 'Group 41'})]
        : [microsoftRow({AdGroupId: '41', AdGroupName: 'Group 41', AdId: '777', AdTitle: 'Ad'})];
    return {
      ReportRequestStatus: {Status: 'Success'},
      download_complete: true,
      potentially_incomplete: false,
      has_more: false,
      rows,
    };
  };
};
const redditLists = {
  ad_groups: [{id: '22', name: 'Group 22', campaign_id: '11', ad_account_id: 't2_acct', configured_status: 'ACTIVE'}],
  ads: [
    {
      id: '33',
      name: 'Ad 33',
      ad_group_id: '22',
      campaign_id: '11',
      ad_account_id: 't2_acct',
      configured_status: 'ACTIVE',
    },
  ],
};
const reddit = plan => {
  if (plan.path === '/api/v3/ad_accounts/t2_acct')
    return {data: {id: 't2_acct', name: 'Synthetic account', currency: 'USD', time_zone_id: 'UTC'}};
  if (plan.path.endsWith('/reports')) {
    const breakdowns = plan.body.data.breakdowns ?? [];
    return {
      data: {
        metrics: [
          {
            campaign_id: '11',
            ...(breakdowns.includes('AD_GROUP_ID') ? {ad_group_id: '22'} : {}),
            ...(breakdowns.includes('AD_ID') ? {ad_id: '33'} : {}),
            spend: 1234567,
            impressions: 100,
            clicks: 4,
          },
        ],
      },
    };
  }
  if (plan.path.endsWith('/campaigns'))
    return {data: [{id: '11', name: 'Campaign 11', objective: 'CONVERSIONS', configured_status: 'ACTIVE'}]};
  const kind = plan.path.endsWith('/ad_groups') ? 'ad_groups' : 'ads',
    ids = String(plan.query.id).split(',');
  return {data: redditLists[kind].filter(row => ids.includes(row.id))};
};
const appleRecords = {
  ads: [{id: 701, adGroupId: 601, campaignId: 501, adAccountId: 500, status: 'ENABLED'}],
  adgroups: [{id: 601, name: 'Group 601', campaignId: 501, adAccountId: 500, status: 'ENABLED'}],
  campaigns: [{id: 501, name: 'Campaign 501', adAccountId: 500, status: 'ENABLED'}],
};
const appleRow = id => ({
  metadata: {id, name: 'Apple ' + id, campaignId: 501, campaignName: 'Campaign 501', status: 'ENABLED'},
  totalMetrics: {localSpend: {amount: '12.34', currency: 'USD'}, impressions: 100, taps: 5, totalInstalls: 2},
});
const apple = plan => {
  if (plan.path === '/v1/ad-accounts/500') return {result: {id: 500, name: 'Synthetic account', currency: 'USD'}};
  // Apple's pages carry `pagination` beside `result`; a list without it cannot be proven complete.
  const {offset, pageSize} = plan.body.pagination,
    page = (list, report) => {
      const part = list.slice(offset, offset + pageSize),
        pagination = {totalCount: list.length, offset, pageSize};
      return report ? {result: {rows: part}, pagination} : {result: part, pagination};
    };
  if (plan.path === '/v1/reports/apps/campaigns/query') return page([appleRow(501)], true);
  if (plan.path.startsWith('/v1/reports/apps/')) {
    const id = plan.path.includes('/ads/') ? 701 : 601;
    return page([appleRow(id)], true);
  }
  const kind = plan.path.split('/')[2],
    ids = plan.body.filters[0].value.map(String);
  return page(
    (appleRecords[kind] ?? []).filter(row => ids.includes(String(row.id))),
    false,
  );
};

const others = {
  microsoft: {
    gateway: 'microsoft_ads_native_action',
    account: '123',
    answer: microsoft(),
    ids: ['9', '41', '777'],
    spend: '12.5',
    ad: '777',
  },
  reddit: {
    gateway: 'reddit_native_action',
    account: 't2_acct',
    answer: reddit,
    ids: ['11', '22', '33'],
    spend: '1.234567',
    ad: '33',
  },
  apple: {
    gateway: 'apple_ads_native_action',
    account: '500',
    answer: apple,
    ids: ['501', '601', '701'],
    spend: '12.34',
    ad: '701',
  },
};
for (const [platform, {gateway, account, answer, ids, spend, ad}] of Object.entries(others))
  test(`${platform} is collected at three levels in one snapshot, and a selected ad rolls up with its status`, async t => {
    const f = objectiveReportFixture(t, {platform});
    f.store.putConnection(
      f.actor,
      {
        id: 'login2',
        tenantId: f.actor.tenantId,
        gateway,
        accounts: [account],
        enabled: true,
        scopes: [],
        label: 'Synthetic',
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const real = new NativeCampaignReports({
      store: f.store,
      runPlan: async plan => ({success: true, data: await answer(plan)}),
    });
    f.overview.native.collect = (...args) => real.collect(...args);
    f.overview.native.verifyAccount = (...args) => real.verifyAccount(...args);
    const run = async (name, source) => {
      const queued = await f.overview.handle(
        {
          action: 'run',
          confirmed: true,
          config: {
            name,
            contract_version: 'overview-config-v4',
            sources: [
              {
                platform,
                account_id: account,
                connection_id: 'login2',
                ...source,
                report_options: {complete_window: true, attribution: 'unknown'},
              },
            ],
            date_range: {since: '2026-08-01', until: '2026-08-07'},
            metrics: ['spend', 'impressions', 'clicks'],
          },
        },
        f.actor,
      );
      await f.worker.once();
      return f.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: true}}, f.actor);
    };
    const report = await run('Three levels', {levels});
    assert.equal(report.state, 'complete', JSON.stringify(report.sources[0].level_results.map(l => l.error)));
    assert.deepEqual(
      report.rows.map(row => [row.level, row.entity_id ?? row.campaign_id, row.status, row.metrics.spend]),
      levels.map((level, index) => [level, ids[index], 'active', spend]),
      'one row per level, the same spend at each',
    );
    assert.deepEqual(
      report.sources[0].cross_level
        .filter(item => item.metric === 'spend')
        .map(item => [item.baseline.level, item.comparison.level, item.state]),
      [
        ['campaign', 'adset', 'agree'],
        ['adset', 'ad', 'agree'],
      ],
    );
    // A selected ad: the campaign is measured through it, labelled so, and keeps the status its parent has.
    for (const statuses of [undefined, ['active']]) {
      const scoped = await run('Selected ad', {
        levels: ['campaign', 'ad'],
        ad_ids: [ad],
        ...(statuses ? {statuses} : {}),
      });
      assert.equal(scoped.state, 'complete', JSON.stringify(statuses));
      assert.deepEqual(
        scoped.rows.map(row => [row.level, row.status, row.metrics.spend, row.aggregation?.label ?? null]),
        [
          ['campaign', 'active', spend, 'Rolled up from selected ads'],
          ['ad', 'active', spend, null],
        ],
        JSON.stringify(statuses ?? 'default statuses'),
      );
    }
  });
