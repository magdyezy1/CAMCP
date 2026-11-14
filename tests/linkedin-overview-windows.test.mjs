import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {ReportCollectionBudget} from '../dist/src/report-collection-budget.js';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {linkedinConnection, linkedinPipeline} from './helpers/linkedin-pipeline.mjs';
import {
  accountRulesNote,
  accountRulesPair,
  analytics,
  campaignUrn,
  delivered,
  fixClock,
  groupUrn,
  owner,
  rulesRead,
  run,
  source,
  stored,
  v4,
  world,
} from './helpers/linkedin-windows-world.mjs';
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
const unverifiedWarning = /attribution windows are not independently verified/;

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
    assert.equal(s.attribution, accountRulesPair(7, 1));
    assert.equal(stored(f, report).rows[0].attribution, accountRulesPair(7, 1));
    assert.equal(report.summary[0].attribution, accountRulesPair(7, 1));
    assert.equal(
      s.warnings.some(w => unverifiedWarning.test(w)),
      false,
      JSON.stringify(s.warnings),
    );
    assert.equal(s.level_results[0].conversion_windows.status, 'single_window');
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
      'The account’s LinkedIn conversion rules state these attribution windows: 30d click / 7d view; 7d click / 1d view.',
      accountRulesNote,
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

// A rule that states no window leaves the windows of the others as they are: different pairs are still different pairs, so
// the source is mixed (never one pair), and the rule without a window is counted in the retained decision.
test('different pairs beside a rule that states no window are still mixed, with the rule counted', async t => {
  const {report, source: s} = await run(t, 'campaign', {
    conversions: [
      linkedinConversionRule('501', 30, 7),
      linkedinConversionRule('502', 7, 1),
      linkedinConversionRuleWithoutWindows('503'),
    ],
  });
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.match(s.attribution, /^LinkedIn conversion rules with mixed windows, no single window: /);
  const windows = s.level_results[0].conversion_windows;
  assert.deepEqual([windows.status, windows.rule_count, windows.unknown_rules, windows.reason], ['mixed', 3, 1, null]);
  assert.deepEqual(windows.distinct_windows, ['30d click / 7d view', '7d click / 1d view']);
});

// An attribution is a retained setting of 200 characters at most (a monitor, a capture, a report option). LinkedIn's
// windows are 1, 7 or 30 days, so an account can hold nine different pairs, whose list is longer than that.
test('the attribution of a source stays within 200 characters when its rules hold every pair, the pairs listed in the notes', async t => {
  const rules = [1, 7, 30].flatMap((click, i) =>
    [1, 7, 30].map((view, j) => linkedinConversionRule(String(i * 3 + j + 1), click, view)),
  );
  const {f, report, source: s} = await run(t, 'campaign', {conversions: rules});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.ok(s.attribution.length <= 200, s.attribution.length + ': ' + s.attribution);
  assert.ok(s.attribution.startsWith('LinkedIn conversion rules with mixed windows, no single window'), s.attribution);
  assert.equal(report.summary[0].attribution, s.attribution);
  assert.equal(stored(f, report).rows[0].attribution, s.attribution);
  const windows = s.level_results[0].conversion_windows;
  assert.equal(windows.status, 'mixed');
  assert.equal(windows.distinct_windows.length, 9);
  assert.ok(
    s.warnings.includes(
      'The account’s LinkedIn conversion rules state these attribution windows: ' +
        windows.distinct_windows.join('; ') +
        '.',
    ),
  );
});

// P2B-08 (c): the account's rule list holds the rules the account owns. A rule shared from or owned by another account, which a
// campaign may count, is not in it, so a joined source claims what it read and never that it verified a rule. (The guided
// preset looks up each conversion it reports, so a conversion without a rule is unknown there: it keeps its words.)
test('a joined source claims only the account’s own rules: nothing it says is a verification per rule, and it says which rules are not read', async t => {
  for (const rules of [
    [linkedinConversionRule('501', 30, 7), linkedinConversionRule('502', 30, 7)],
    [linkedinConversionRule('501', 30, 7), linkedinConversionRule('502', 7, 1)],
  ]) {
    const {report, source: s} = await run(t, 'campaign', {conversions: rules});
    assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
    const said = JSON.stringify([s.attribution, s.warnings, s.level_results[0].conversion_windows]);
    assert.doesNotMatch(said, /verif/i, said);
    assert.ok(s.warnings.includes(accountRulesNote), JSON.stringify(s.warnings));
    assert.ok(
      s.warnings.some(w => /A rule shared from or owned by another account is not read/.test(w)),
      JSON.stringify(s.warnings),
    );
  }
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
// in a snapshot job: the account, the group and campaign analytics, the campaigns, the groups: five requests. `accounts`
// are the accounts the one login lists; `hooks.fetch(path)` runs as LinkedIn is asked, while the request is in flight; `respond(path)`
// may answer a request itself (a response of its own, such as a refusal or a throttle) instead of the synthetic LinkedIn.
function transportFixture(t, conversions, {accounts = ['100'], respond} = {}) {
  const actor = {tenantId: 'synthetic-linkedin-windows', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64')),
    paths = [],
    hooks = {};
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: linkedinConnection,
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts,
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
    // The transport's retry never waits here: a failure that it would retry costs no time.
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async raw => {
          const url = new URL(raw);
          paths.push(url.pathname);
          hooks.fetch?.(url.pathname);
          const answered = respond?.(url.pathname);
          if (answered) return answered;
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
        },
        async () => {},
      ),
    );
  return {
    actor,
    store,
    service,
    paths,
    hooks,
    collect: (lookup = {}, as = actor) =>
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
        as,
        {},
        () => {},
        lookup,
      ),
  };
}

/**
 * A person limited to one client's account (SEC-08), reading through the fixture's real service and transport, so the set is
 * enforced at every request as in production. An administrator narrows the set while the request to `path` is in flight and
 * puts it back as that request ends: the source then sees a refusal that no provider made, and nothing else changes, so what
 * the source does with it shows in what it returns.
 */
function clientNarrowedDuring(f, path) {
  const binding = account => [
    {gateway: 'linkedin_native_action', connection_id: linkedinConnection, account_id: account},
  ];
  let set = saveAccessSet(f.store, f.actor, {name: 'Client', bindings: binding('100')});
  const edit = account => {
      set = saveAccessSet(f.store, f.actor, {
        id: set.id,
        revision: set.revision,
        name: 'Client',
        bindings: binding(account),
      });
    },
    client = f.store.authenticate(
      f.store.createKey({
        tenantId: f.actor.tenantId,
        userId: 'connector/client',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    ),
    runPlan = f.service.runPlan.bind(f.service);
  let narrowed = false;
  f.hooks.fetch = requested => {
    if (requested !== path || narrowed) return;
    narrowed = true;
    edit('200');
  };
  f.service.runPlan = async (...args) => {
    try {
      return await runPlan(...args);
    } finally {
      if (narrowed && set.bindings[0].account_id === '200') edit('100');
    }
  };
  return client;
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
      assert.equal(result.attribution, joined ? accountRulesPair(30, 7) : 'unknown');
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

// The estimate made before any request is a first-page baseline that may be conservative and may not fall short of what
// the run sends (tests/report-status-v4.test.mjs): the rules read is three requests the baseline did not count.
test('the request estimate counts the rules read once per LinkedIn source, for every level it reports and not again for each', async t => {
  const {f, report} = await run(t, 'campaign', {conversions: [linkedinConversionRule('501')]}),
    config = stored(f, report).config,
    estimate = estimateCollectionRequests(config).estimated_requests;
  assert.ok(estimate >= f.requests.length, estimate + ' for ' + f.requests.length + ' sent');
  // Account lookup, group and campaign analytics, campaigns and groups metadata: five reads; the rules read adds three.
  assert.equal(estimate, 5 + 3);
  // A second level of the same source shares the lookup and the rules read: it adds only its own three reads.
  const both = {...config, sources: config.sources.map(entry => ({...entry, levels: ['campaign', 'adset']}))};
  assert.equal(estimateCollectionRequests(both).estimated_requests - estimate, 3);
  // A source that reads no rules is estimated as if it did: the estimate is made before its results are known.
  const lead = await run(t, 'campaign', {conversions: [], ...world('LEAD_GENERATION')});
  assert.equal(rulesRead(lead.f).length, 0);
  assert.ok(
    estimateCollectionRequests(stored(lead.f, lead.report).config).estimated_requests >= lead.f.requests.length,
  );
});

// P2B-08 (a): how many rules an account holds is known only when they are read, a hundred to a request (the account, a page
// each, the account again), so what the estimate counts for the read, its first page, is a minimum. The estimate has one
// word for a figure that depends on what the account holds (`lower_bound` on the entry, as for Snapchat's and Apple's
// unscoped levels), and the entry that pays for the read says it; the entries that do not pay for it do not.
test('the request estimate says the rules read is a minimum: an account with 1,000 rules costs twelve requests for it, and three are counted', async t => {
  const rules = Array.from({length: 1000}, (_, i) => linkedinConversionRule(String(i + 1))),
    {f, report} = await run(t, 'campaign', {conversions: rules});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.warnings)));
  assert.equal(report.sources[0].attribution, accountRulesPair(30, 7));
  // The read sent the account, ten pages of a hundred rules and the account again, beside the source's own five reads.
  assert.equal(rulesRead(f).length, 10);
  assert.equal(f.requests.length, 5 + 2 + 10);
  const config = stored(f, report).config,
    estimate = estimateCollectionRequests(config);
  // The figure is the first page, as for every read of a v4 report, so it is below what a large list sends, and it says so.
  assert.equal(estimate.estimated_requests, 5 + 3);
  assert.ok(estimate.estimated_requests < f.requests.length);
  assert.equal(estimate.sources[0].lower_bound, true);
  // A source's second level shares the read, so only the level that pays for it is a minimum.
  const both = estimateCollectionRequests({
    ...config,
    sources: config.sources.map(entry => ({...entry, levels: ['campaign', 'adset']})),
  });
  assert.deepEqual(
    both.sources.map(entry => [entry.level, entry.lower_bound]),
    [
      ['campaign', true],
      ['adset', undefined],
    ],
  );
  // A v3 report reads no rules, so its estimate is not a minimum on that account.
  const old = linkedinPipeline(t, {analytics, ...world()}),
    v3 = await old.run({sources: [{platform: 'linkedin', account_id: '100', connection_id: 'login'}]});
  assert.equal(v3.state, 'complete');
  assert.equal(estimateCollectionRequests(stored(old, v3).config).sources[0].lower_bound, undefined);
});

test('the rules are read once per source and job, however many periods and levels the source reports, and a refusal is not asked twice', async t => {
  for (const [refused, attribution] of [
    [[], accountRulesPair(30, 7)],
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
    'LinkedIn conversion rules for this account could not be read, so attribution windows stay unknown.',
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

// P2B-08 (b): the rules read is held to the login and permissions the source started under, not only to those it found when it
// began: a login replaced, or permissions changed, after the source's analytics and metadata reads gives the rules of the same
// account as the other login sees them, which are not the rules of the reads they would describe. The guided preset keeps one
// bracket over its analytics and its rules (src/linkedin-conversion-windows.ts); so does the Overview source. The change comes
// as the last read before the rules returns, so the rules read itself starts under the new login and cannot see it.
const loginRecord = (f, scopes = ['r_ads', 'r_ads_reporting']) => ({
  id: linkedinConnection,
  tenantId: f.actor.tenantId,
  gateway: 'linkedin_native_action',
  accounts: ['100'],
  enabled: true,
  scopes,
  label: 'Synthetic',
});
/** Runs `change` once, as the read of the path ending with `suffix` returns: between that read and whatever comes next. */
function changeAfter(f, suffix, change) {
  const read = f.service.runPlan;
  let done = false;
  f.service.runPlan = async plan => {
    const answer = await read(plan);
    if (!done && plan.path.endsWith(suffix)) {
      done = true;
      change();
    }
    return answer;
  };
}
for (const [change, replace] of [
  ['a login replaced', f => f.store.putConnection(f.actor, loginRecord(f), {accessToken: 'replaced'})],
  ['permissions narrowed', f => f.store.updateConnection(f.actor, loginRecord(f, ['r_ads']))],
])
  test(
    change + ' between the analytics reads and the rules read fails the source, and no rule is read after it',
    async t => {
      fixClock(t);
      const f = linkedinPipeline(t, {analytics, ...world(), conversions: [linkedinConversionRule('501')]});
      changeAfter(f, '/adCampaignGroups', () => replace(f));
      const report = await f.run({...v4, sources: [source('campaign')]});
      assert.equal(report.state, 'failed', JSON.stringify(report.sources.map(x => x.attribution)));
      assert.equal(report.sources[0].error.code, 'CONNECTION_AUTHORITY_CHANGED');
      assert.equal(rulesRead(f).length, 0);
      assert.equal(
        f.requests.filter(p => p.path === '/rest/adAccounts/100').length,
        1,
        'the account lookup only: the rules read sent no account check either',
      );
    },
  );

test('a token refresh between the analytics reads and the rules read is the same login: the windows are joined', async t => {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), conversions: [linkedinConversionRule('501')]});
  changeAfter(f, '/adCampaignGroups', () => {
    const connection = f.store.resolveConnection(f.actor, 'linkedin_native_action', '100', linkedinConnection),
      held = f.store.connectionCredentials(connection);
    f.store.completeCredentialRefresh(connection, held, {...held, accessToken: 'refreshed'});
  });
  const report = await f.run({...v4, sources: [source('campaign')]});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(x => x.error ?? x.warnings)));
  assert.equal(report.sources[0].attribution, accountRulesPair(30, 7));
  assert.equal(rulesRead(f).length, 1);
});

// P2B-08 (d): a client access set narrowed during a read is AMCP's refusal of the account (ACCOUNT_SCOPE_RESTRICTED, SEC-08),
// like a removed connection or a changed login. Only the provider may refuse an optional read, so it fails the source at the
// read; before, it passed for LinkedIn's refusal, and a source whose set was restored a moment later completed with it.
for (const [read, path] of [
  ['the conversion rules', '/rest/conversions'],
  ['the campaigns’ names and objectives', '/rest/adAccounts/100/adCampaigns'],
])
  test(
    'a client access set narrowed while ' + read + ' are read fails the source with that refusal, never as LinkedIn’s',
    async t => {
      const f = transportFixture(t, [linkedinConversionRule('501')], {accounts: ['100', '200']}),
        client = clientNarrowedDuring(f, path),
        lookup = {},
        outcome = await f.collect(lookup, client).then(
          result => ({result}),
          error => ({error}),
        );
      assert.ok(
        outcome.error,
        'the source completed, taking the refusal for LinkedIn’s: ' + JSON.stringify(outcome.result?.warnings),
      );
      assertRefused(outcome.error, 'ACCOUNT_SCOPE_RESTRICTED');
      // Nothing is remembered as a refusal of LinkedIn's, and no request is sent after the read that was refused.
      assert.equal(lookup.linkedinConversionRules, undefined);
      assert.equal(lookup.linkedinCampaigns?.unavailable, undefined);
      assert.equal(f.paths.at(-1), path, f.paths.join(' '));
    },
  );

// P2C-02 (differential review, wave 5 round 2 part 2c): only LinkedIn may refuse or fail the rules read and leave the windows
// unknown. The catch of the rules read kept every error that was not AMCP's own access refusal as LinkedIn's: the conversion
// evidence read turns a failed answer into a new error that was never retryable and always had status 400, and the catch took it
// for a refusal. A worker that lost the job's lease, a report that was cancelled, counters found invalid, and a transient failure of
// LinkedIn's (a 429, a 503) all ended the source complete, with unknown windows, a reason that was not true and a refusal
// remembered for the rest of the job, where every other optional read (optionalReadRefused) fails the source, or retries the job,
// and the period collector fails it for the first three.
//
// A lost lease, a cancelled job and invalid counters come as the job's own check gives them: its allowance's save callback throws
// as a request is counted: the 6th request of the source is the rules read's account check, the 7th its rules page, the 8th the
// account check after them.
for (const [code, status] of [
  ['STALE_JOB_LEASE', 409],
  ['JOB_CANCELLED', 400],
  ['REPORT_BUDGET_INVALID', 400],
])
  for (const [during, counted] of [
    ['the account check before the rules', 6],
    ['the rules page', 7],
    ['the account check after the rules', 8],
  ])
    test(code + ' during ' + during + ' ends the source with that error, never as LinkedIn’s refusal', async t => {
      const f = transportFixture(t, [linkedinConversionRule('501')]),
        lookup = {};
      let thrown = false;
      const budget = new ReportCollectionBudget(
        undefined,
        'synthetic-linkedin-windows',
        state => {
          if (thrown || state.requests !== counted) return;
          thrown = true;
          throw new MirrorError(code, 'Synthetic job control.', {}, status);
        },
        {requests: 1200, rows: 1000, elapsed_ms: 600000, bytes: 1e9},
      );
      try {
        const outcome = await budget
          .run(() => f.collect(lookup))
          .then(
            result => ({result}),
            error => ({error}),
          );
        assert.ok(
          outcome.error,
          'the source completed, taking ' +
            code +
            ' for LinkedIn’s refusal: ' +
            JSON.stringify(outcome.result?.warnings),
        );
        assertRefused(outcome.error, code);
        assert.equal(lookup.linkedinConversionRules, undefined, 'nothing is remembered as a refusal of LinkedIn’s');
        assert.equal(
          f.paths.length,
          counted - 1,
          'no request is sent after the one that was stopped: ' + f.paths.join(' '),
        );
      } finally {
        budget.close();
      }
    });

// A failure that LinkedIn says a retry may fix keeps its flag and its status, so the job is retried and not finished with unknown
// windows; a refusal (HTTP 400, 403 or 404) and an answer that is not the rules leave the windows unknown, as before.
for (const [what, answer] of [
  [
    'a 429 with a Retry-After',
    () => Response.json({message: 'Throttled'}, {status: 429, headers: {'retry-after': '3'}}),
  ],
  [
    'a 503 with a Retry-After',
    () => Response.json({message: 'Unavailable'}, {status: 503, headers: {'retry-after': '3'}}),
  ],
])
  test(
    'a transient failure of LinkedIn during the rules read (' +
      what +
      ') ends the source retryable, never as a refusal',
    async t => {
      const f = transportFixture(t, [linkedinConversionRule('501')], {
          respond: path => (path === '/rest/conversions' ? answer() : undefined),
        }),
        lookup = {},
        outcome = await f.collect(lookup).then(
          result => ({result}),
          error => ({error}),
        );
      assert.ok(
        outcome.error,
        'the source completed, taking a transient failure for LinkedIn’s refusal: ' +
          JSON.stringify(outcome.result?.warnings),
      );
      assert.equal(outcome.error.retryable, true, outcome.error.code);
      assert.ok(outcome.error.status >= 429, 'the status of LinkedIn’s answer is kept: ' + outcome.error.status);
      assert.equal(lookup.linkedinConversionRules, undefined, 'nothing is remembered as a refusal of LinkedIn’s');
      assert.equal(
        f.paths.at(-1),
        '/rest/conversions',
        'no request is sent after the one that failed: ' + f.paths.join(' '),
      );
    },
  );

for (const status of [400, 403, 404])
  test(
    'a refusal of LinkedIn’s (HTTP ' +
      status +
      ') of the rules read leaves the windows unknown, once, and the source complete',
    async t => {
      const f = transportFixture(t, [linkedinConversionRule('501')], {
          respond: path => (path === '/rest/conversions' ? Response.json({message: 'Refused'}, {status}) : undefined),
        }),
        lookup = {},
        result = await f.collect(lookup);
      assert.equal(result.complete, true);
      assert.equal(result.attribution, 'unknown');
      assert.equal(result.conversion_windows.reason, 'refused');
      assert.deepEqual(
        lookup.linkedinConversionRules,
        {lineage: []},
        'the refusal is remembered, so the job asks once',
      );
      assert.equal(f.paths.filter(p => p === '/rest/conversions').length, 1);
    },
  );

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
  assert.equal(s.attribution, accountRulesPair(30, 7));
  assert.equal(stored(f, report).rows[0].attribution, accountRulesPair(30, 7));
  assert.equal(report.summary[0].attribution, accountRulesPair(30, 7));
  // The old "not independently verified" line goes; what stays true is said on its own.
  assert.equal(
    s.warnings.some(w => unverifiedWarning.test(w)),
    false,
    JSON.stringify(s.warnings),
  );
  assert.ok(s.warnings.includes(accountRulesNote));
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
    ['single_window', 'account_rules', 2, null],
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
