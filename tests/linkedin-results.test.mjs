import test from 'node:test';
import assert from 'node:assert/strict';
import * as linkedin from '../dist/src/linkedin-report-source.js';
import {linkedInSplitRead} from '../dist/src/linkedin-reporting.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {reportSummary} from '../dist/src/report-summary.js';

const expected = {
  BRAND_AWARENESS: [null, 'LinkedIn members reached (not additive)'],
  WEBSITE_VISIT: ['landingPageClicks', 'LinkedIn landing page clicks'],
  WEBSITE_VISITS: ['landingPageClicks', 'LinkedIn landing page clicks'],
  ENGAGEMENT: ['clicks', 'Clicks (engagement result not in the API)'],
  VIDEO_VIEW: ['videoViews', 'LinkedIn video views'],
  VIDEO_VIEWS: ['videoViews', 'LinkedIn video views'],
  LEAD_GENERATION: ['oneClickLeads', 'LinkedIn leads (one-click)'],
  WEBSITE_CONVERSION: ['externalWebsiteConversions', 'LinkedIn website conversions'],
  WEBSITE_CONVERSIONS: ['externalWebsiteConversions', 'LinkedIn website conversions'],
  JOB_APPLICANT: ['landingPageClicks', 'LinkedIn landing page clicks'],
  JOB_APPLICANTS: ['landingPageClicks', 'LinkedIn landing page clicks'],
  TALENT_LEAD: ['talentLeads', 'LinkedIn talent leads'],
};
for (const [objective, [field, label]] of Object.entries(expected))
  test(objective + ' uses its pinned result in campaign and creative rows', () => {
    assert.deepEqual(linkedin.linkedinResults[objective], {field, label});
    const raw = {
      objectiveType: objective,
      pivotValues: ['urn:li:sponsoredCampaignGroup:20'],
      impressions: '100',
      clicks: '5',
      externalWebsiteConversions: '99',
      approximateMemberReach: '80',
      qualifiedLeads: '2',
      ...(field ? {[field]: '7'} : {}),
    };
    const top = normalizeNativeRow('linkedin', raw);
    assert.equal(top.metrics.conversions, field ? 7 : null);
    assert.equal(top.result_definition, label);
    assert.equal(top.metrics.native_linkedin_qualifiedLeads, 2);
    const detail = linkedin.linkedinDetail(
      'ad',
      [{...raw, pivotValues: ['urn:li:sponsoredCreative:40']}],
      {
        campaigns: {'urn:li:sponsoredCampaign:30': {objective_type: objective}},
        groups: {},
        creatives: {
          'urn:li:sponsoredCreative:40': {name: 'Synthetic creative', campaign: 'urn:li:sponsoredCampaign:30'},
        },
      },
      {},
    ).rows[0];
    assert.equal(detail.conversions, field ? '7' : null);
    assert.equal(detail.result_definition, label);
    if (!field) {
      assert.equal(top.metrics.reach, 80);
      assert.equal(detail.reach, '80');
    }
  });
test('all objective fields are requested, with reach only up to 92 days', () => {
  const base = [
    'impressions',
    'clicks',
    'costInLocalCurrency',
    'landingPageClicks',
    'videoViews',
    'oneClickLeads',
    'qualifiedLeads',
    'externalWebsiteConversions',
    'talentLeads',
    'conversionValueInLocalCurrency',
  ];
  assert.deepEqual(new Set(linkedin.linkedinBaseMetrics(92)), new Set([...base, 'approximateMemberReach']));
  assert.deepEqual(new Set(linkedin.linkedinBaseMetrics(93)), new Set(base));
});
test('D3 applies only to absent cost with explicit zero impressions and clicks', () => {
  for (const [extra, spend, omitted] of [
    [{impressions: '0', clicks: '0'}, 0, ['spend']],
    [{impressions: '5', clicks: '0'}, null, undefined],
    [{impressions: '0'}, null, undefined],
    // Clicks without impressions are not zero delivery, so the absent cost stays unknown (Probe 5).
    [{impressions: '0', clicks: '5'}, null, undefined],
    [{clicks: '0'}, null, undefined],
    [{impressions: '0', clicks: '0', costInLocalCurrency: null}, null, undefined],
    [{impressions: '0', clicks: '0', costInLocalCurrency: '2'}, 2, undefined],
  ]) {
    const row = normalizeNativeRow('linkedin', {pivotValues: ['urn:li:sponsoredCampaignGroup:20'], ...extra});
    assert.equal(row.metrics.spend, spend, JSON.stringify(extra));
    assert.deepEqual(row.omitted_as_zero, omitted, JSON.stringify(extra));
    for (const [level, urn] of [
      ['adset', 'urn:li:sponsoredCampaign:30'],
      ['ad', 'urn:li:sponsoredCreative:40'],
    ]) {
      const detail = linkedin.linkedinDetail(
        level,
        [{pivotValues: [urn], ...extra}],
        {
          campaigns: {},
          groups: {},
          creatives: {},
        },
        {},
      ).rows[0];
      assert.equal(detail.spend, spend === null ? null : String(spend), level + ' ' + JSON.stringify(extra));
      assert.deepEqual(detail.omitted_as_zero, omitted, level + ' ' + JSON.stringify(extra));
    }
  }
});

// The main and the split reader apply D3 to the same rows, so they must read a count the same way, however it is spelt.
test('the main and the split reader agree on which rows state zero impressions and zero clicks', async () => {
  // Spellings of a count that both readers can parse: a malformed count is refused by its own check, not by D3.
  const counts = ['0', 0, '0.0', '0.00', '00', ' 0 ', '5', 5, '0.5', '', null, undefined, '--'],
    window = {since: '2026-09-01', until: '2026-09-07'},
    day = text => {
      const [year, month, date] = text.split('-').map(Number);
      return {year, month, day: date};
    };
  const inMain = extra =>
    normalizeNativeRow('linkedin', {
      pivotValues: ['urn:li:sponsoredCampaignGroup:20'],
      ...extra,
    }).omitted_as_zero?.includes('spend') === true;
  const inSplit = async extra =>
    (
      await linkedInSplitRead(window, async r =>
        r.since === window.since && r.until === window.until
          ? Array.from({length: 15000}, (_, i) => ({pivotValues: ['urn:li:sponsoredCampaign:' + (i + 1)]}))
          : [
              {
                pivotValues: ['urn:li:sponsoredCampaign:30'],
                dateRange: {start: day(r.since), end: day(r.until)},
                ...extra,
              },
            ],
      )
    ).rows[0].omitted_as_zero?.includes('spend') === true;
  for (const impressions of counts)
    for (const clicks of ['0', impressions]) {
      const extra = {impressions, clicks};
      assert.equal(await inSplit(extra), inMain(extra), JSON.stringify(extra));
    }
  // Zero stated as a decimal is still zero; a count that is missing, unreadable or not zero is not.
  for (const [extra, omitted] of [
    [{impressions: '0.0', clicks: '0'}, true],
    [{impressions: 0, clicks: '0.00'}, true],
    [{impressions: '0', clicks: '0.5'}, false],
    [{impressions: '', clicks: '0'}, false],
    [{impressions: '0', clicks: '--'}, false],
  ])
    assert.equal(inMain(extra), omitted, JSON.stringify(extra));
});

async function collection({extra = [], mismatch = false, dateMismatch = false, days = 2} = {}) {
  const since = '2026-07-01',
    until = new Date(Date.parse(since) + (days - 1) * 86400000).toISOString().slice(0, 10),
    requests = [];
  const date = s => {
    const [year, month, day] = s.split('-').map(Number);
    return {year, month, day};
  };
  const c = {
    account: '100',
    metadata: {id: 100},
    currency: 'USD',
    range: {since, until},
    extra,
    warnings: [],
    lineage: [],
    lookup: {},
    detailRounding: {},
    context: {},
    raw: [],
    plan: (path, query) => ({path, query}),
    run: async plan => {
      requests.push(plan);
      if (plan.path === '/rest/adAnalytics') {
        const analyticsCalls = requests.filter(
          p => p.path === '/rest/adAnalytics' && p.query.pivot === plan.query.pivot,
        ).length;
        const type = plan.query.pivot === 'CAMPAIGN_GROUP' ? 'sponsoredCampaignGroup' : 'sponsoredCampaign';
        const fields = Object.fromEntries(
          plan.query.fields
            .split(',')
            .filter(k => !['pivotValues', 'dateRange'].includes(k))
            .map(k => [k, '1']),
        );
        return {
          elements: [
            {
              pivotValues: [
                'urn:li:' +
                  type +
                  ':' +
                  (mismatch && analyticsCalls === 2 ? '99' : type === 'sponsoredCampaignGroup' ? '20' : '30'),
              ],
              dateRange: {
                start: date(since),
                end: date(
                  dateMismatch && analyticsCalls === 2
                    ? new Date(Date.parse(until) + 86400000).toISOString().slice(0, 10)
                    : until,
                ),
              },
              ...fields,
            },
          ],
        };
      }
      if (plan.path.endsWith('/adCampaignGroups'))
        return {
          elements: [{id: 20, account: 'urn:li:sponsoredAccount:100', objectiveType: 'BRAND_AWARENESS'}],
          metadata: {},
        };
      if (plan.path.endsWith('/adCampaigns'))
        return {
          elements: [
            {
              id: 30,
              account: 'urn:li:sponsoredAccount:100',
              campaignGroup: 'urn:li:sponsoredCampaignGroup:20',
              objectiveType: 'BRAND_AWARENESS',
            },
          ],
          metadata: {},
        };
      throw new Error('Unexpected synthetic LinkedIn path ' + plan.path);
    },
  };
  await linkedin.linkedinReportSource.collect(c);
  return {c, requests};
}
test('metrics beyond 18 use two reads per pivot and join exact native keys', async () => {
  const {c, requests} = await collection({extra: Array.from({length: 9}, (_, i) => 'syntheticMetric' + i)});
  for (const pivot of ['CAMPAIGN_GROUP', 'CAMPAIGN']) {
    const reads = requests.filter(p => p.path === '/rest/adAnalytics' && p.query.pivot === pivot);
    assert.equal(reads.length, 2);
    assert.ok(reads.every(p => p.query.fields.split(',').length <= 20));
  }
  for (let i = 0; i < 9; i++) assert.equal(c.raw[0]['syntheticMetric' + i], '1');
  assert.equal(c.raw[0].costInLocalCurrency, '1');
  assert.equal(c.raw[0].approximateMemberReach, '1');
});
test('metric fragments with different pivots refuse the join', async () => {
  await assert.rejects(
    () => collection({extra: Array.from({length: 9}, (_, i) => 'syntheticMetric' + i), mismatch: true}),
    error => error.code === 'REPORT_SHAPE_CHANGED',
  );
});
test('more than 18 requested native metrics is refused', async () => {
  await assert.rejects(
    () => collection({extra: Array.from({length: 19}, (_, i) => 'syntheticMetric' + i)}),
    error => error.code === 'INVALID_REPORT_SOURCE',
  );
});

test('repeating a selected native metric keeps the existing deduplication behavior', async () => {
  const {requests} = await collection({extra: Array(19).fill('videoViews')});
  const reads = requests.filter(p => p.path === '/rest/adAnalytics');
  assert.equal(reads.length, 2, 'one read per pivot');
  assert.ok(reads.every(p => p.query.fields.split(',').filter(field => field === 'videoViews').length === 1));
});

test('metric fragments with different dates refuse the join', async () => {
  await assert.rejects(
    () => collection({extra: Array.from({length: 9}, (_, i) => 'syntheticMetric' + i), dateMismatch: true}),
    error => error.code === 'REPORT_SHAPE_CHANGED',
  );
});
test('a 93-day awareness window has unknown reach and a translated warning', async () => {
  const {c, requests} = await collection({days: 93});
  assert.ok(
    requests.filter(p => p.path === '/rest/adAnalytics').every(p => !p.query.fields.includes('approximateMemberReach')),
  );
  assert.equal(normalizeNativeRow('linkedin', c.raw[0]).metrics.reach, null);
  assert.ok(c.warnings.includes('LinkedIn reports reach only for windows of 92 days or less.'));
});
test('qualified leads remain beside one-click leads and are not added to them', () => {
  const row = normalizeNativeRow('linkedin', {
    pivotValues: ['urn:li:sponsoredCampaignGroup:20'],
    objectiveType: 'LEAD_GENERATION',
    oneClickLeads: '3',
    qualifiedLeads: '2',
  });
  assert.equal(row.metrics.conversions, 3);
  assert.equal(row.metrics.native_linkedin_qualifiedLeads, 2);
});
test('summary CPC, CPM and CPA use totals within each currency', () => {
  const common = {
    platform: 'linkedin',
    account_id: '100',
    timezone: 'UTC',
    objective_group: 'leads',
    result_definition: 'LinkedIn leads (one-click)',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    complete: true,
    recommendation: {decision: 'needs_review'},
  };
  const rows = [
    {...common, currency: 'SAR', metrics: {spend: 100, clicks: 50, impressions: 10000, conversions: 4}},
    {...common, currency: 'USD', metrics: {spend: 30, clicks: 10, impressions: 2000, conversions: 2}},
  ];
  const groups = reportSummary(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map(g => [g.currency, g.metrics.cpc, g.metrics.cpm, g.metrics.cpa]),
    [
      ['SAR', 2, 10, 25],
      ['USD', 3, 15, 15],
    ],
  );
  const absent = reportSummary([
    {...common, currency: 'SAR', metrics: {spend: null, clicks: 0, impressions: 0, conversions: 0}},
  ])[0];
  assert.deepEqual([absent.metrics.cpc, absent.metrics.cpm, absent.metrics.cpa], [null, null, null]);
});
