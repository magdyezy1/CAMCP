import test from 'node:test';
import assert from 'node:assert/strict';
import * as linkedin from '../dist/src/linkedin-report-source.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {estimateCollectionRequests, sourceRequestModel} from '../dist/src/report-request-estimate.js';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {linkedinPipeline} from './helpers/linkedin-pipeline.mjs';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const groupUrn = 'urn:li:sponsoredCampaignGroup:20',
  range = {since: '2026-09-01', until: '2026-09-02'};
const period = {start: {year: 2026, month: 9, day: 1}, end: {year: 2026, month: 9, day: 2}};
async function collectGroup({own, campaigns = [], missingMetadata = []} = {}) {
  const requests = [];
  const c = {
    account: '100',
    metadata: {id: 100},
    currency: 'USD',
    range,
    extra: [],
    warnings: [],
    lineage: [],
    lookup: {},
    detailRounding: {},
    context: {},
    quality: {},
    raw: [],
    plan: (path, query) => ({path, query}),
    run: async plan => {
      requests.push(plan);
      if (plan.path === '/rest/adAnalytics')
        return {
          elements:
            plan.query.pivot === 'CAMPAIGN_GROUP'
              ? [
                  {
                    pivotValues: [groupUrn],
                    dateRange: period,
                    impressions: '100',
                    clicks: '10',
                    costInLocalCurrency: '5.5',
                    externalWebsiteConversions: '99',
                  },
                ]
              : campaigns.map((row, index) => ({
                  pivotValues: ['urn:li:sponsoredCampaign:' + (30 + index)],
                  dateRange: period,
                  ...row,
                })),
        };
      if (plan.path.endsWith('/adCampaignGroups'))
        return {
          elements: [{id: 20, account: 'urn:li:sponsoredAccount:100', name: 'Synthetic group', objectiveType: own}],
          metadata: {},
        };
      if (plan.path.endsWith('/adCampaigns'))
        return {
          elements: campaigns
            .map((row, index) => ({
              id: 30 + index,
              account: 'urn:li:sponsoredAccount:100',
              name: 'Campaign ' + index,
              campaignGroup: groupUrn,
              objectiveType: row.objective_type,
            }))
            .filter(row => !missingMetadata.includes(row.id)),
          metadata: {},
        };
      throw new Error('Unexpected synthetic path ' + plan.path);
    },
  };
  await linkedin.linkedinReportSource.collect(c);
  return {c, requests, rows: c.raw.map(row => normalizeNativeRow('linkedin', row))};
}

test('a group’s own native objective wins over its campaigns', () => {
  assert.deepEqual(
    linkedin.linkedinGroupObjective({objective_type: 'BRAND_AWARENESS'}, [
      {objective_type: 'LEAD_GENERATION', delivered: true},
      {objective_type: 'VIDEO_VIEW', delivered: true},
    ]),
    {native: 'BRAND_AWARENESS', mixed: false, objectives: ['BRAND_AWARENESS']},
  );
});
test('without its own objective a group uses the objective shared by every delivered campaign', () => {
  assert.deepEqual(
    linkedin.linkedinGroupObjective(undefined, [
      {objective_type: 'LEAD_GENERATION', delivered: true},
      {objective_type: 'LEAD_GENERATION', delivered: true},
    ]),
    {native: 'LEAD_GENERATION', mixed: false, objectives: ['LEAD_GENERATION']},
  );
});
test('different delivered campaign objectives give Mixed in a deterministic order', () => {
  assert.deepEqual(
    linkedin.linkedinGroupObjective({}, [
      {objective_type: 'VIDEO_VIEW', delivered: true},
      {objective_type: 'LEAD_GENERATION', delivered: true},
    ]),
    {native: 'MIXED', mixed: true, objectives: ['LEAD_GENERATION', 'VIDEO_VIEW']},
  );
});
test('campaigns without delivery do not make a group Mixed', () => {
  assert.deepEqual(
    linkedin.linkedinGroupObjective({}, [
      {objective_type: 'LEAD_GENERATION', delivered: true},
      {objective_type: 'VIDEO_VIEW', delivered: false},
    ]),
    {native: 'LEAD_GENERATION', mixed: false, objectives: ['LEAD_GENERATION']},
  );
});
test('no delivery leaves the group objective unknown and an unknown delivered objective is not silently discarded', () => {
  assert.deepEqual(linkedin.linkedinGroupObjective({}, [{objective_type: 'VIDEO_VIEW', delivered: false}]), {
    native: null,
    mixed: false,
    objectives: [],
  });
  assert.deepEqual(
    linkedin.linkedinGroupObjective({}, [
      {objective_type: 'LEAD_GENERATION', delivered: true},
      {objective_type: null, delivered: true},
    ]),
    {native: 'MIXED', mixed: true, objectives: ['LEAD_GENERATION', 'unknown']},
  );
});
test('the group collector reads both ALL pivots and uses campaign metadata for a shared objective', async () => {
  const {rows, requests} = await collectGroup({
    campaigns: [{objective_type: 'LEAD_GENERATION', impressions: '10', clicks: '1', oneClickLeads: '3'}],
  });
  assert.deepEqual(
    requests.filter(p => p.path === '/rest/adAnalytics').map(p => [p.query.pivot, p.query.timeGranularity]),
    [
      ['CAMPAIGN_GROUP', 'ALL'],
      ['CAMPAIGN', 'ALL'],
    ],
  );
  assert.equal(rows[0].objective, 'LEAD_GENERATION');
  assert.equal(rows[0].objective_group, 'leads');
});
test('mixed results retain exact sums for each objective and are never summed into conversions', async t => {
  const {rows, c} = await collectGroup({
    campaigns: [
      {objective_type: 'LEAD_GENERATION', impressions: '10', clicks: '1', oneClickLeads: '1.1'},
      {objective_type: 'VIDEO_VIEW', impressions: '20', clicks: '2', videoViews: '7'},
      {objective_type: 'LEAD_GENERATION', impressions: '30', clicks: '3', oneClickLeads: '2.2'},
      {
        objective_type: 'WEBSITE_CONVERSION',
        impressions: '0',
        clicks: '0',
        costInLocalCurrency: '0',
        externalWebsiteConversions: '100',
      },
    ],
  });
  const row = rows[0];
  assert.equal(row.objective, 'MIXED');
  assert.equal(row.metrics.conversions, null);
  assert.equal(row.result_definition, 'Mixed');
  assert.deepEqual(row.results_by_objective, [
    {objective: 'LEAD_GENERATION', group: 'leads', result_definition: 'LinkedIn leads (one-click)', value: '3.3'},
    {objective: 'VIDEO_VIEW', group: 'video_views', result_definition: 'LinkedIn video views', value: '7'},
  ]);
  const f = objectiveReportFixture(t, {platform: 'linkedin', rows});
  const report = await f.run();
  assert.equal(report.rows[0].objective_group, 'mixed');
  assert.equal(report.rows[0].objective_source, 'provider');
  assert.equal(
    report.rows[0].objective_reason,
    'This campaign group’s campaigns have different objectives: LEAD_GENERATION, VIDEO_VIEW.',
  );
  assert.deepEqual(report.rows[0].results_by_objective, row.results_by_objective);
  assert.equal(report.summary[0].metrics.conversions, null);
  assert.equal(report.summary[0].metrics.cpa, null);
  assert.equal(c.raw[0].objectiveType, 'MIXED');
});
test('a mixed objective still respects an explicit saved override while retaining separate results', () => {
  const resolved = resolveObjective({
    platform: 'linkedin',
    table: linkedin.linkedinReportSource.objectives,
    native: 'MIXED',
    legacy: 'leads',
    mappedInputs: {},
  });
  assert.equal(resolved.group, 'leads');
  assert.equal(resolved.source, 'user_override');
});

test('unassigned delivered campaigns prevent inferring a shared group objective from only the known subset', async () => {
  const {rows} = await collectGroup({
    missingMetadata: [31],
    campaigns: [
      {objective_type: 'LEAD_GENERATION', impressions: '10'},
      {objective_type: 'VIDEO_VIEW', impressions: '20'},
    ],
  });
  assert.equal(rows[0].objective, 'unknown');
  assert.equal(rows[0].objective_group, 'unknown');
  assert.equal(rows[0].results_by_objective, undefined);
});

test('rounded mixed-result values retain the half-even rounding qualifier', async () => {
  const {c, rows} = await collectGroup({
    campaigns: [
      {objective_type: 'LEAD_GENERATION', impressions: '10', oneClickLeads: '1.1234567895'},
      {objective_type: 'VIDEO_VIEW', impressions: '20', videoViews: '7'},
    ],
  });
  assert.equal(rows[0].results_by_objective[0].value, '1.12345679');
  assert.deepEqual(c.quality.metric_rounding.conversions, {places: 9, rule: 'half_even', rows_rounded: 1});
});
test('request estimates count two data reads only in LinkedIn’s campaign position', () => {
  for (const [level, data] of [
    ['campaign', 2],
    ['adset', 1],
    ['ad', 1],
  ]) {
    const source = {
      platform: 'linkedin',
      account_id: '100',
      connection_id: 'login',
      level,
      ...(level === 'campaign' ? {} : {report_options: {complete_window: true, attribution: 'unknown'}}),
    };
    const estimate = estimateCollectionRequests({date_range: range, sources: [source]});
    assert.equal(estimate.estimated_requests, 1 + data);
    assert.equal(linkedin.linkedinReportSource.requestsPerPeriod(level), data);
  }
  assert.equal(sourceRequestModel('linkedin').minimum_requests_per_period, 2);
  assert.equal(sourceRequestModel('google').minimum_requests_per_period, 1);
  assertNamesNoProvider('src/report-request-estimate.ts');
});

// One campaign group with the given member campaigns, read through the real queue, worker and LinkedIn collector.
const owner = 'urn:li:sponsoredAccount:100',
  linkedinSource = {platform: 'linkedin', account_id: '100', connection_id: 'login'},
  v4Source = {
    ...linkedinSource,
    levels: ['campaign'],
    delivered_only: false,
    report_options: {complete_window: true, attribution: 'unknown'},
  };
// The group's own analytics row is the sum of its members' rows, as LinkedIn aggregates them.
const groupRow = members => {
  const total = {};
  for (const {metrics} of members)
    for (const [key, value] of Object.entries(metrics)) total[key] = String(Number(total[key] ?? 0) + Number(value));
  return {pivotValues: [groupUrn], ...total};
};
async function runGroup(t, members, changes) {
  const f = linkedinPipeline(t, {
    analytics: pivot =>
      pivot === 'CAMPAIGN_GROUP'
        ? [groupRow(members)]
        : members.map(({id, metrics}) => ({pivotValues: ['urn:li:sponsoredCampaign:' + id], ...metrics})),
    groups: {20: {id: 20, account: owner, name: 'Group One', status: 'ACTIVE'}},
    campaigns: Object.fromEntries(
      members.map(({id, objectiveType, status = 'ACTIVE'}) => [
        id,
        {
          id,
          account: owner,
          campaignGroup: groupUrn,
          name: 'Campaign ' + id,
          objectiveType,
          status,
          type: 'SPONSORED_UPDATES',
        },
      ]),
    ),
  });
  const report = await f.run(changes);
  return {f, report, row: report.rows[0]};
}
const delivering = (id, objectiveType, metrics) => ({
  id,
  objectiveType,
  metrics: {impressions: '1000', clicks: '100', costInLocalCurrency: '50', ...metrics},
});
// The shape of a campaign that stopped delivering but still has attributed results (12 of 28 rows in a live probe).
const attributedOnly = (id, objectiveType, metrics) => ({
  id,
  objectiveType,
  status: 'PAUSED',
  metrics: {impressions: '0', clicks: '0', ...metrics},
});
const v4Run = {
  contract_version: 'overview-config-v4',
  metrics: ['spend', 'clicks', 'primary_result', 'cost_per_result'],
};
const conversions = (value, objective = 'WEBSITE_CONVERSION') => ({
  objective,
  group: 'sales',
  result_definition: 'LinkedIn website conversions',
  value,
});

test('v4: a member without delivery and another objective neither makes the group Mixed nor cancels its result', async t => {
  const {report, row} = await runGroup(
    t,
    [
      delivering(11, 'WEBSITE_VISIT', {landingPageClicks: 40}),
      attributedOnly(12, 'WEBSITE_CONVERSION', {externalWebsiteConversions: 7}),
    ],
    {...v4Run, sources: [v4Source]},
  );
  assert.equal(report.state, 'complete');
  assert.deepEqual(
    [row.objective.native, row.objective.group, row.objective.source],
    ['WEBSITE_VISIT', 'traffic', 'provider'],
  );
  assert.equal(row.result.label, 'LinkedIn landing page clicks');
  assert.equal(row.metrics.primary_result, '40');
  assert.equal(row.metrics.cost_per_result, '1.25');
  assert.equal(row.result_context.unavailable_reason, undefined);
  assert.equal(row.result_groups, undefined, 'one result group, so no mixed-result listing');
  assert.doesNotMatch(row.recommendation.reason, /different result definitions/);
  assert.equal(report.summary[0].metrics.primary_result, '40');
  assert.equal(report.summary[0].metrics.cost_per_result, '1.25');
  assert.deepEqual(
    row.other_results,
    [conversions('7')],
    'the attributed results are listed apart from the primary one',
  );
});

test('v4: Mixed lists one result group per delivering objective and keeps a member without delivery apart', async t => {
  const {f, report, row} = await runGroup(
    t,
    [
      delivering(11, 'LEAD_GENERATION', {oneClickLeads: 3}),
      delivering(12, 'VIDEO_VIEW', {videoViews: 7}),
      attributedOnly(13, 'WEBSITE_CONVERSION', {externalWebsiteConversions: 100}),
    ],
    {...v4Run, sources: [v4Source]},
  );
  assert.equal(row.objective.native, 'MIXED');
  assert.deepEqual(
    row.result_groups.map(group => [group.result.label, group.result.value]),
    [
      ['LinkedIn leads (one-click)', '3'],
      ['LinkedIn video views', '7'],
    ],
  );
  assert.deepEqual(row.other_results, [conversions('100')]);
  // The same member set feeds the v3 listing of the very same row.
  const full = await f.overview.handle({action: 'get', id: report.id, include: {native: true}}, f.actor);
  assert.deepEqual(
    full.rows[0].results_by_objective.map(result => result.objective),
    ['LEAD_GENERATION', 'VIDEO_VIEW'],
  );
});

test('v3: the same member set decides the objective, the results by objective and the listing of other results', async t => {
  const {rows} = await collectGroup({
    campaigns: [
      {
        objective_type: 'WEBSITE_VISIT',
        impressions: '100',
        clicks: '10',
        costInLocalCurrency: '5',
        landingPageClicks: '4',
      },
      {objective_type: 'WEBSITE_CONVERSION', impressions: '0', clicks: '0', externalWebsiteConversions: '7'},
    ],
  });
  assert.equal(rows[0].objective, 'WEBSITE_VISIT');
  assert.equal(rows[0].results_by_objective, undefined);
  assert.deepEqual(rows[0].other_results, [conversions('7')]);
  const {rows: mixed} = await collectGroup({
    campaigns: [
      {objective_type: 'LEAD_GENERATION', impressions: '10', clicks: '1', oneClickLeads: '1.1'},
      {objective_type: 'VIDEO_VIEW', impressions: '20', clicks: '2', videoViews: '7'},
      {
        objective_type: 'WEBSITE_CONVERSION',
        impressions: '0',
        clicks: '0',
        costInLocalCurrency: '0',
        externalWebsiteConversions: '100',
      },
    ],
  });
  assert.deepEqual(
    mixed[0].results_by_objective.map(result => result.objective),
    ['LEAD_GENERATION', 'VIDEO_VIEW'],
  );
  assert.deepEqual(mixed[0].other_results, [conversions('100')]);
});

test('a member without delivery and without any result is not listed as another result', async t => {
  const {rows} = await collectGroup({
    campaigns: [
      {
        objective_type: 'WEBSITE_VISIT',
        impressions: '100',
        clicks: '10',
        costInLocalCurrency: '5',
        landingPageClicks: '4',
      },
      {objective_type: 'WEBSITE_CONVERSION', impressions: '0', clicks: '0', externalWebsiteConversions: '0'},
      {objective_type: 'BRAND_AWARENESS', impressions: '0', clicks: '0'},
    ],
  });
  assert.equal(rows[0].other_results, undefined);
});

test('the website shows separate Mixed results and translates the explanation and labels while escaping native text', () => {
  for (const locale of ['en', 'ar']) {
    const context = createContext({
      document: {addEventListener() {}},
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
      row: {
        objective_source: 'provider',
        objective_reason: 'This campaign group’s campaigns have different objectives: LEAD_GENERATION, VIDEO_VIEW.',
        results_by_objective: [
          {objective: 'LEAD_GENERATION', result_definition: 'LinkedIn leads (one-click)', value: '3.3'},
          {objective: 'VIDEO_VIEW', result_definition: 'LinkedIn video views', value: '7'},
          {objective: '<img src=x>', result_definition: 'LinkedIn video views', value: null},
        ],
      },
    });
    const run = source => new Script(source).runInContext(context);
    for (const file of ['localization', 'report-quality', 'reporting-overview'])
      run(readFileSync('web/' + file + '.js', 'utf8'));
    run(`uiLocale = '${locale}'; uiMessages = new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
    const output = String(run('reportObjectiveResults(row)'));
    assert.match(output, /3\.3/);
    assert.match(output, /&lt;img src=x&gt;/);
    assert.doesNotMatch(output, /<img src=x>|10\.3/);
    const explanation = run('reportObjectiveSource(row)');
    assert.match(explanation, /LEAD_GENERATION, VIDEO_VIEW/);
    if (locale === 'ar') {
      assert.match(explanation, /[\u0600-\u06ff]/u);
      assert.match(output, /[\u0600-\u06ff]/u);
      assert.doesNotMatch(output, /LinkedIn leads|LinkedIn video views/);
    } else assert.match(output, /LinkedIn leads \(one-click\)/);
    assert.equal(String(run('reportObjectiveResults({})')), '');
  }
});

test('the website lists other results apart from the primary one, translated and with native text escaped', () => {
  for (const locale of ['en', 'ar']) {
    const context = createContext({
      document: {addEventListener() {}},
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
      row: {
        other_results: [
          {
            objective: '<img src=x>',
            group: 'sales',
            result_definition: 'LinkedIn website conversions',
            value: '7',
          },
        ],
      },
    });
    const run = source => new Script(source).runInContext(context);
    for (const file of ['localization', 'report-quality', 'reporting-overview'])
      run(readFileSync('web/' + file + '.js', 'utf8'));
    run(`uiLocale = '${locale}'; uiMessages = new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
    const output = String(run('reportObjectiveResults(row)'));
    assert.match(output, /&lt;img src=x&gt;/);
    assert.doesNotMatch(output, /<img src=x>/);
    assert.match(output, /7/);
    if (locale === 'ar') {
      assert.match(output, /[\u0600-\u06ff]/u);
      assert.doesNotMatch(output, /Other results|LinkedIn website conversions/);
    } else
      assert.match(
        output,
        /Other results, from campaigns with no activity in this window.*LinkedIn website conversions/,
      );
  }
});
