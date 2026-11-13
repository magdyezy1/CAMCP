import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {ReportCollectionBudget} from '../dist/src/report-collection-budget.js';
import {linkedinConnection, linkedinPipeline} from './helpers/linkedin-pipeline.mjs';
import {
  linkedinConversionRule,
  linkedinConversionRulesPage,
  linkedinConversionRuleWithoutWindows,
} from './fixtures/linkedin-conversion-rules-docs.mjs';
import {
  linkedinLevelAccount,
  linkedinLevelAnalytics,
  linkedinLevelCampaign,
  linkedinLevelGroup,
  linkedinLevelRange,
} from './fixtures/linkedin-levels-docs.mjs';

// V2-RPT-04 (plan 4.7): a v4 Overview source of LinkedIn website conversions takes its attribution windows from the
// account's conversion rules. Every case runs the real queue, worker and LinkedIn collector over a synthetic LinkedIn
// that answers from the documented shapes of its reporting, account-structure and conversion-rule references.
const owner = 'urn:li:sponsoredAccount:100',
  groupUrn = 'urn:li:sponsoredCampaignGroup:20',
  campaignUrn = 'urn:li:sponsoredCampaign:30',
  creativeUrn = 'urn:li:sponsoredCreative:40',
  delivered = {impressions: '1000', clicks: '100', costInLocalCurrency: '50', externalWebsiteConversions: '7'},
  source = level => ({
    platform: 'linkedin',
    account_id: '100',
    connection_id: linkedinConnection,
    levels: [level],
    delivered_only: false,
    report_options: {complete_window: true, attribution: 'unknown'},
  }),
  v4 = {contract_version: 'overview-config-v4', metrics: ['spend', 'clicks', 'primary_result', 'cost_per_result']},
  verifiedPair = (click, view) =>
    'LinkedIn conversion rules: ' + click + '-day post-click / ' + view + '-day post-view (verified per rule)',
  unverifiedWarning = /attribution windows are not independently verified/;
const urnOf = {CAMPAIGN_GROUP: groupUrn, CAMPAIGN: campaignUrn, CREATIVE: creativeUrn};
const world = (objectiveType = 'WEBSITE_CONVERSION') => ({
  groups: {20: {id: 20, account: owner, name: 'Group One', status: 'ACTIVE'}},
  campaigns: {
    30: {
      id: 30,
      account: owner,
      campaignGroup: groupUrn,
      name: 'Campaign 30',
      objectiveType,
      status: 'ACTIVE',
      type: 'SPONSORED_UPDATES',
    },
  },
  creatives: {40: {id: creativeUrn, account: owner, campaign: campaignUrn, name: 'Creative 40'}},
});
// The creative level reads only the current and five previous months of the real clock; the report dates are September.
const fixClock = t => {
  t.mock.timers.reset();
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 6)});
};
const analytics = pivot => [{pivotValues: [urnOf[pivot]], ...delivered}];
async function run(t, level, {conversions = [], changes = {}, ...options} = {}) {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions, ...options});
  const report = await f.run({...v4, sources: [source(level)], ...changes});
  return {f, report, source: report.sources[0], row: report.rows[0]};
}
// The conversion rules requests, and the snapshot as stored (whose rows keep the attribution `get` leaves to the source).
const rulesRead = f => f.requests.filter(p => p.path === '/rest/conversions');
const stored = (f, report) => f.store.document(f.actor.tenantId, 'overview_report', report.id);

// The campaign and creative positions read their own native rows, so they take the pair as the campaign-group position does,
// in place of the attribution a detailed source otherwise declares in its report options.
for (const level of ['adset', 'ad'])
  test('a v4 ' + level + ' source of website conversions carries the pair, not its declared attribution', async t => {
    const {
      f,
      report,
      source: s,
    } = await run(t, level, {
      conversions: [linkedinConversionRule('501', 7, 1)],
      changes: {
        sources: [{...source(level), report_options: {complete_window: true, attribution: 'declared by the owner'}}],
      },
    });
    assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
    assert.equal(s.attribution, verifiedPair(7, 1));
    assert.equal(stored(f, report).rows[0].attribution, verifiedPair(7, 1));
    assert.equal(report.summary[0].attribution, verifiedPair(7, 1));
    assert.equal(
      s.warnings.some(w => unverifiedWarning.test(w)),
      false,
      JSON.stringify(s.warnings),
    );
    assert.equal(s.level_results[0].conversion_windows.status, 'verified_per_rule');
    assert.equal(rulesRead(f).length, 1);
  });

test('rules with different windows make a source mixed: the pairs are listed, the total is kept and said to combine them', async t => {
  const {
    f,
    report,
    source: s,
  } = await run(t, 'campaign', {
    conversions: [
      linkedinConversionRule('501', 30, 7),
      linkedinConversionRule('502', 7, 1),
      linkedinConversionRule('503', 30, 7),
    ],
  });
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  const mixed =
    'LinkedIn conversion rules with mixed windows, no single window: 30d click / 7d view; 7d click / 1d view';
  assert.equal(s.attribution, mixed);
  assert.equal(stored(f, report).rows[0].attribution, mixed);
  assert.equal(report.summary[0].attribution, mixed);
  // The total is the one the source reports, untouched by the join.
  assert.equal(report.rows[0].result.value, '7');
  assert.equal(report.rows[0].result.label, 'LinkedIn website conversions');
  assert.deepEqual(
    s.warnings.filter(w => /conversion rules|conversion-rule|current metadata/.test(w)),
    [
      'LinkedIn conversion rules with different attribution windows may count toward this result, so its total can combine them and no single attribution window describes it.',
      'The account’s LinkedIn conversion rules use these attribution windows: 30d click / 7d view; 7d click / 1d view.',
      'LinkedIn attribution windows come from the account’s own conversion rules. AMCP does not read which campaigns a rule counts for, so every rule of the account is used, and rule settings are current, not the settings at delivery time.',
      'LinkedIn entity names and objectives are current metadata, not the values at delivery time.',
    ],
  );
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.rule_count, windows.single_window, windows.unknown_rules, windows.reason],
    ['mixed', 3, null, 0, null],
  );
  assert.deepEqual(windows.distinct_windows, ['30d click / 7d view', '7d click / 1d view']);
});

// What an unknown attribution says: the warning it always carried, then why the account's rules could not settle it.
const staysUnknown = (report, s, reason) => {
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.equal(s.attribution, 'unknown');
  assert.equal(report.summary[0].attribution, 'unknown');
  assert.deepEqual(
    s.warnings.filter(w => /conversion[ -]rules?|attribution windows/.test(w)),
    [
      'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Entity names and objectives are current metadata, not the values at delivery time.',
      reason,
    ],
  );
};

test('an account without conversion rules leaves the windows unknown, says so and keeps the report complete', async t => {
  const {report, source: s} = await run(t, 'campaign', {conversions: []});
  staysUnknown(
    report,
    s,
    'LinkedIn returned no conversion rules for this account, so attribution windows stay unknown.',
  );
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.basis, windows.rule_count, windows.reason, windows.single_window],
    ['unknown', 'account_rules', 0, 'no_rules', null],
  );
});

test('a rule that states no window leaves the windows unknown, even beside rules that state one', async t => {
  const {report, source: s} = await run(t, 'campaign', {
    conversions: [linkedinConversionRule('501', 30, 7), linkedinConversionRuleWithoutWindows('502')],
  });
  staysUnknown(
    report,
    s,
    'LinkedIn states no attribution window for at least one of the account’s conversion rules, so attribution windows stay unknown.',
  );
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.rule_count, windows.unknown_rules, windows.reason, windows.single_window],
    ['unknown', 2, 1, 'rule_window_missing', null],
  );
});

// The collector alone, over the real transport, so that every request is counted against a whole-job allowance as it is
// in a snapshot job: the account, the group and campaign analytics, the campaigns, the groups: five requests.
function transportFixture(t, conversions) {
  const actor = {tenantId: 'synthetic-linkedin-windows', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64')),
    paths = [];
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: linkedinConnection,
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: ['r_ads', 'r_ads_reporting'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const records = {
      group: {...linkedinLevelGroup, objectiveType: 'WEBSITE_CONVERSION'},
      campaign: {...linkedinLevelCampaign, objectiveType: 'WEBSITE_CONVERSION'},
    },
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async raw => {
        const url = new URL(raw);
        paths.push(url.pathname);
        if (url.pathname === '/rest/adAccounts/100') return Response.json(linkedinLevelAccount);
        if (url.pathname === '/rest/adAnalytics')
          return Response.json(linkedinLevelAnalytics(url.searchParams.get('pivot')));
        if (url.pathname === '/rest/conversions')
          return Response.json(
            linkedinConversionRulesPage(conversions, Number(url.searchParams.get('start') ?? 0), 100),
          );
        return Response.json({
          elements: [url.pathname.endsWith('/adCampaignGroups') ? records.group : records.campaign],
          metadata: {},
        });
      }),
    );
  return {
    actor,
    paths,
    collect: (lookup = {}) =>
      new NativeCampaignReports(service).collect(
        {
          platform: 'linkedin',
          account_id: '100',
          connection_id: linkedinConnection,
          level: 'campaign',
          reporting_contract: 'overview-config-v4',
          report_options: {complete_window: true, attribution: 'unknown'},
        },
        linkedinLevelRange,
        actor,
        {},
        () => {},
        lookup,
      ),
  };
}

test('the rules read is counted in the job’s collection allowance: it fits exactly, is not started one short, and a limit met inside it ends it', async t => {
  const rules = count => Array.from({length: count}, (_, i) => linkedinConversionRule(String(i + 1)));
  for (const [allowed, count, started, joined] of [
    [8, 1, true, true],
    [7, 1, false, false],
    // The allowance holds the first three requests, then ends before the account is checked again: two pages of rules.
    [8, 101, true, false],
  ]) {
    const f = transportFixture(t, rules(count));
    let usage;
    const budget = new ReportCollectionBudget(
      undefined,
      'synthetic-linkedin-windows',
      state => {
        usage = state;
      },
      {requests: allowed, rows: 1000, elapsed_ms: 600000, bytes: 1e9},
    );
    try {
      const result = await budget.run(() => f.collect());
      assert.equal(result.complete, true, 'the source completes either way');
      assert.equal(f.paths.includes('/rest/conversions'), started, 'allowed ' + allowed + ': ' + f.paths.join(' '));
      assert.equal(result.attribution, joined ? verifiedPair(30, 7) : 'unknown');
      assert.equal(
        result.warnings.includes(
          'LinkedIn conversion rules were not read because this report’s collection allowance could not hold the read, so attribution windows stay unknown.',
        ),
        !joined,
      );
      assert.equal(result.conversion_windows.reason, joined ? null : 'budget');
      assert.equal(result.rows[0].result.value, '20');
    } finally {
      budget.close();
    }
    assert.equal(usage.requests, started ? 8 : 5, 'the rules read’s requests are the job’s own');
  }
});

// Two campaigns in the account: one counts website conversions, the other leads or whatever the test gives it.
const campaignRecord = (id, objectiveType) => ({
  id,
  account: owner,
  campaignGroup: groupUrn,
  name: 'Campaign ' + id,
  objectiveType,
  status: 'ACTIVE',
  type: 'SPONSORED_UPDATES',
});
const twoCampaigns = second => ({
  campaigns: {30: campaignRecord(30, 'WEBSITE_CONVERSION'), 31: campaignRecord(31, second)},
  analytics: pivot =>
    pivot === 'CAMPAIGN'
      ? [
          {pivotValues: [campaignUrn], ...delivered},
          {
            pivotValues: ['urn:li:sponsoredCampaign:31'],
            impressions: '500',
            clicks: '50',
            costInLocalCurrency: '20',
            oneClickLeads: '3',
          },
        ]
      : analytics(pivot),
});

test('a source that also reports results that are not website conversions cannot take one pair, and says so without reading the rules', async t => {
  const {
    f,
    report,
    source: s,
  } = await run(t, 'adset', {
    conversions: [linkedinConversionRule('501')],
    ...twoCampaigns('LEAD_GENERATION'),
  });
  staysUnknown(
    report,
    s,
    'LinkedIn conversion-rule windows were not joined because this source also reports results that are not website conversions, or whose objective is unknown, so no single set of windows describes it.',
  );
  assert.equal(report.rows.length, 2);
  assert.deepEqual(
    report.summary.map(x => x.attribution),
    ['unknown', 'unknown'],
  );
  assert.equal(rulesRead(f).length, 0);
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.reason, windows.rule_count, windows.rules_source_hash],
    ['unknown', 'not_conversion_only', null, null],
  );
});

test('a source with no website conversion result is untouched: no rules read, the attribution line it always had, no windows record', async t => {
  for (const [level, objective] of [
    ['campaign', 'LEAD_GENERATION'],
    ['adset', 'WEBSITE_VISIT'],
    ['ad', 'BRAND_AWARENESS'],
    ['adset', 'ENGAGEMENT'],
  ]) {
    const {
      f,
      report,
      source: s,
    } = await run(t, level, {
      conversions: [linkedinConversionRule('501')],
      ...world(objective),
    });
    assert.equal(report.state, 'complete', level + ' ' + objective);
    assert.equal(s.attribution, 'unknown', level + ' ' + objective);
    assert.deepEqual(
      s.warnings.filter(w => /conversion[ -]rules?|attribution windows/.test(w)),
      [
        'LinkedIn conversion-rule attribution windows are not independently verified; the verified-window preset is linkedin_campaign_conversion. Entity names and objectives are current metadata, not the values at delivery time.',
      ],
      level + ' ' + objective,
    );
    assert.equal(rulesRead(f).length, 0, level + ' ' + objective);
    assert.equal(s.level_results[0].conversion_windows, undefined, level + ' ' + objective);
  }
});

test('the rules are read once per source and job, however many periods and levels the source reports, and a refusal is not asked twice', async t => {
  for (const [refused, attribution] of [
    [[], verifiedPair(30, 7)],
    [['/conversions'], 'unknown'],
  ]) {
    fixClock(t);
    const f = linkedinPipeline(t, {
        analytics,
        ...world(),
        conversions: [linkedinConversionRule('501')],
        refused,
      }),
      report = await f.run({...v4, grain: 'daily', sources: [{...source('campaign'), levels: ['campaign', 'adset']}]});
    assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
    const rows = stored(f, report).rows;
    assert.equal(rows.length, 4, 'two days at two levels');
    assert.deepEqual([...new Set(rows.map(row => row.attribution))], [attribution]);
    assert.equal(rulesRead(f).length, 1, 'refused: ' + refused.length);
    if (refused.length) continue;
    // The later periods and the second level replay the read, marked as cached, in the source's lineage.
    const lineage = (await f.overview.handle({action: 'get', id: report.id, include: {lineage: true}}, f.actor))
      .sources[0].lineage;
    assert.equal(lineage.filter(l => l.stage === 'conversion_rules' && !l.cached).length, 1);
    assert.ok(lineage.filter(l => l.stage === 'conversion_rules' && l.cached).length >= 1);
  }
});

test('a refused rules read leaves the windows unknown, keeps every number and leaves the report complete', async t => {
  const {report, source: s} = await run(t, 'campaign', {
    conversions: [linkedinConversionRule('501')],
    refused: ['/conversions'],
  });
  staysUnknown(
    report,
    s,
    'LinkedIn did not return the account’s conversion rules, so attribution windows stay unknown.',
  );
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.basis, windows.reason, windows.rule_count, windows.rules_source_hash],
    ['unknown', 'account_rules', 'refused', null, null],
  );
  assert.equal(report.rows[0].result.value, '7');
  assert.equal(report.rows[0].result.label, 'LinkedIn website conversions');
});

test('a change of the login during the rules read still fails the source: only LinkedIn may refuse it', async t => {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions: [linkedinConversionRule('501')]}),
    read = f.service.runPlan;
  f.service.runPlan = async plan => {
    const answer = await read(plan);
    if (plan.path === '/rest/conversions')
      f.store.putConnection(
        f.actor,
        {
          id: linkedinConnection,
          tenantId: f.actor.tenantId,
          gateway: 'linkedin_native_action',
          accounts: ['100'],
          enabled: true,
          scopes: ['r_ads', 'r_ads_reporting'],
          label: 'Synthetic',
        },
        {accessToken: 'replaced'},
      );
    return answer;
  };
  const report = await f.run({...v4, sources: [source('campaign')]});
  assert.equal(report.state, 'failed');
  assert.equal(report.sources[0].error.code, 'CONNECTION_AUTHORITY_CHANGED');
});

test('a v4 campaign-group source of website conversions takes the one window pair its account’s rules share', async t => {
  const {
    f,
    report,
    source: s,
    row,
  } = await run(t, 'campaign', {
    conversions: [linkedinConversionRule('501', 30, 7), linkedinConversionRule('502', 30, 7)],
  });
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.equal(row.objective.native, 'WEBSITE_CONVERSION');
  // The pair, in words, on the source, the stored row and the summary every consumer reads.
  assert.equal(s.attribution, verifiedPair(30, 7));
  assert.equal(stored(f, report).rows[0].attribution, verifiedPair(30, 7));
  assert.equal(report.summary[0].attribution, verifiedPair(30, 7));
  // The old "not independently verified" line goes; what stays true is said on its own.
  assert.equal(
    s.warnings.some(w => unverifiedWarning.test(w)),
    false,
    JSON.stringify(s.warnings),
  );
  assert.ok(
    s.warnings.includes(
      'LinkedIn attribution windows come from the account’s own conversion rules. AMCP does not read which campaigns a rule counts for, so every rule of the account is used, and rule settings are current, not the settings at delivery time.',
    ),
  );
  assert.ok(
    s.warnings.includes('LinkedIn entity names and objectives are current metadata, not the values at delivery time.'),
  );
  // What was read, how, and after the analytics response: the account, the rules (one page), the account again.
  assert.equal(rulesRead(f).length, 1);
  assert.deepEqual(f.requests.map(p => p.path).slice(-3), [
    '/rest/adAccounts/100',
    '/rest/conversions',
    '/rest/adAccounts/100',
  ]);
  assert.equal(
    f.requests.findIndex(p => p.path === '/rest/conversions') >
      f.requests.findLastIndex(p => p.path === '/rest/adAnalytics'),
    true,
    'the rules are read after the analytics response',
  );
  assert.deepEqual(rulesRead(f)[0].query, {q: 'account', account: owner, start: 0, count: 100});
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual(
    [windows.status, windows.basis, windows.rule_count, windows.reason],
    ['verified_per_rule', 'account_rules', 2, null],
  );
  assert.deepEqual(windows.single_window, {post_click_days: 30, post_view_days: 7});
  assert.deepEqual(windows.distinct_windows, ['30d click / 7d view']);
  const lineage = (await f.overview.handle({action: 'get', id: report.id, include: {lineage: true}}, f.actor))
    .sources[0].lineage;
  assert.deepEqual(
    lineage.map(l => l.stage).slice(-3),
    ['conversion_rules_account', 'conversion_rules', 'conversion_rules_account_verify'],
    'the rules read is part of the source’s lineage, request by request',
  );
  assert.ok(lineage.slice(-3).every(l => l.method === 'GET' && l.api_version === '202609' && l.query_fingerprint));
});
