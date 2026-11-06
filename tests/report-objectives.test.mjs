import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveObjective, objectiveFallbackGroups, mixedObjectiveGroup} from '../dist/src/report-objectives.js';
import {objectiveGroups, campaignRecommendation} from '../dist/src/report-metrics.js';
import {reportSource, reportSourceList} from '../dist/src/report-sources.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';
import {objectiveReportFixture} from './helpers/objective-report.mjs';

const table = {
  name: 'TikTok',
  values: {TRAFFIC: 'traffic', APP_RETARGETING: null},
  missingReason: 'TikTok returned no objective for this campaign.',
};

test('objective precedence keeps explicit choices, native values, inference, mappings and fallbacks distinct', () => {
  const base = {platform: 'tiktok', table, native: 'TRAFFIC', campaignId: '1'};
  assert.deepEqual(resolveObjective({...base, overrides: {'1': 'sales'}, legacy: 'leads', fallback: 'awareness'}), {
    native: 'TRAFFIC',
    group: 'sales',
    source: 'user_override',
    reason: 'Chosen for this campaign in the report.',
  });
  assert.deepEqual(resolveObjective({...base, legacy: 'leads', fallback: 'sales'}), {
    native: 'TRAFFIC',
    group: 'leads',
    source: 'user_override',
    reason: 'Chosen for every campaign of this source in the saved report.',
  });
  assert.deepEqual(resolveObjective({...base, fallback: 'sales'}), {
    native: 'TRAFFIC',
    group: 'traffic',
    source: 'provider',
    reason: null,
  });
  assert.deepEqual(resolveObjective({...base, native: 'NEW_LEADS_THING', fallback: 'sales'}), {
    native: 'NEW_LEADS_THING',
    group: 'leads',
    source: 'provider_inferred',
    reason: 'Inferred from the platform’s value NEW_LEADS_THING.',
  });
  assert.deepEqual(resolveObjective({...base, native: undefined, fallback: 'sales'}), {
    native: null,
    group: 'sales',
    source: 'user_fallback',
    reason: null,
  });
  assert.equal(resolveObjective({...base, legacy: 'unknown'}).source, 'provider');
});

test('unknown values carry the platform-specific reason, and known ungrouped values bypass inference', () => {
  assert.deepEqual(resolveObjective({platform: 'tiktok', table, native: 'APP_RETARGETING'}), {
    native: 'APP_RETARGETING',
    group: 'unknown',
    source: 'unknown',
    reason: 'TikTok’s APP_RETARGETING has no matching AMCP objective; choose one in the report.',
  });
  assert.equal(
    resolveObjective({platform: 'tiktok', table, native: 'FUTURE_THING'}).reason,
    'TikTok returned the objective FUTURE_THING, which AMCP does not group yet; choose one in the report.',
  );
  for (const native of [undefined, null, '', 'unknown'])
    assert.equal(resolveObjective({platform: 'tiktok', table, native}).reason, table.missingReason);
  assert.deepEqual(resolveObjective({platform: 'other', native: 'TRAFFIC'}), {
    native: 'TRAFFIC',
    group: 'unknown',
    source: 'unknown',
    reason: 'This source has no campaign objective.',
  });
});

test('fallback never replaces a native or mapped group; known ungrouped values can use a chosen fallback', () => {
  const mappedTable = {...table, mapped: () => ({group: 'app_installs', reason: 'Mapped.'})};
  assert.equal(
    resolveObjective({platform: 'test', table: mappedTable, native: 'TRAFFIC', fallback: 'sales'}).source,
    'provider',
  );
  assert.deepEqual(resolveObjective({platform: 'test', table: mappedTable, fallback: 'sales'}), {
    native: null,
    group: 'app_installs',
    source: 'provider_mapped',
    reason: 'Mapped.',
  });
  assert.equal(
    resolveObjective({platform: 'test', table, native: 'APP_RETARGETING', fallback: 'sales'}).source,
    'user_fallback',
  );
});

const unreadReason = {
  refused: 'AMCP could not read this campaign’s objective because the platform refused the read',
  limited:
    'AMCP could not read this campaign’s objective because this report has more entities than AMCP reads campaign details for',
};
for (const cause of ['refused', 'limited'])
  test('an objective AMCP could not read (' + cause + ') is never reported as one the platform did not return', () => {
    const base = {platform: 'tiktok', table, campaignId: '1', unread: cause};
    // Without a fallback the reason says what happened, not that the platform returned nothing.
    assert.deepEqual(resolveObjective(base), {
      native: null,
      group: 'unknown',
      source: 'unknown',
      reason: unreadReason[cause] + '; choose one in the report.',
    });
    // A fallback that covers the unread value says so; it is not the plain "Your fallback".
    assert.deepEqual(resolveObjective({...base, fallback: 'sales'}), {
      native: null,
      group: 'sales',
      source: 'user_fallback',
      reason: unreadReason[cause] + ', so your fallback is used.',
    });
    // Explicit choices still win and are labelled as theirs, and a value the platform did give is never unread.
    assert.equal(resolveObjective({...base, overrides: {'1': 'leads'}, fallback: 'sales'}).source, 'user_override');
    assert.equal(resolveObjective({...base, legacy: 'leads'}).source, 'user_override');
    assert.deepEqual(resolveObjective({...base, native: 'TRAFFIC', fallback: 'sales'}), {
      native: 'TRAFFIC',
      group: 'traffic',
      source: 'provider',
      reason: null,
    });
    // The unread cause is data from collectors: anything else changes nothing.
    assert.equal(resolveObjective({...base, unread: 'constructor'}).reason, table.missingReason);
  });

test('a fallback stays unlabelled when the platform answered with no objective', () => {
  assert.deepEqual(resolveObjective({platform: 'tiktok', table, fallback: 'sales'}), {
    native: null,
    group: 'sales',
    source: 'user_fallback',
    reason: null,
  });
});

test('prototype properties cannot become an objective or a campaign override', () => {
  assert.equal(resolveObjective({platform: 'tiktok', table, native: 'constructor'}).source, 'unknown');
  assert.equal(
    resolveObjective({
      platform: 'tiktok',
      table,
      native: 'TRAFFIC',
      campaignId: '1',
      overrides: Object.create({'1': 'sales'}),
    }).group,
    'traffic',
  );
});

test('native objective text is preserved literally in the explanation', () => {
  const native = 'NEW_LEADS_$&_{platform}';
  assert.equal(
    resolveObjective({platform: 'tiktok', table, native}).reason,
    'Inferred from the platform’s value ' + native + '.',
  );
});

const pinned = {
  tiktok: {
    REACH: 'awareness',
    RF_REACH: 'awareness',
    TRAFFIC: 'traffic',
    VIDEO_VIEWS: 'video_views',
    LEAD_GENERATION: 'leads',
    ENGAGEMENT: 'engagement',
    APP_PROMOTION: 'app_installs',
    APP_INSTALL: 'app_installs',
    WEB_CONVERSIONS: 'sales',
    PRODUCT_SALES: 'sales',
    APP_RETARGETING: null,
  },
  meta: {
    OUTCOME_AWARENESS: 'awareness',
    OUTCOME_TRAFFIC: 'traffic',
    OUTCOME_ENGAGEMENT: 'engagement',
    OUTCOME_LEADS: 'leads',
    OUTCOME_SALES: 'sales',
    OUTCOME_APP_PROMOTION: 'app_installs',
  },
  linkedin: {
    BRAND_AWARENESS: 'awareness',
    WEBSITE_VISIT: 'traffic',
    WEBSITE_VISITS: 'traffic',
    ENGAGEMENT: 'engagement',
    VIDEO_VIEW: 'video_views',
    VIDEO_VIEWS: 'video_views',
    LEAD_GENERATION: 'leads',
    WEBSITE_CONVERSION: 'sales',
    WEBSITE_CONVERSIONS: 'sales',
    JOB_APPLICANT: 'traffic',
    JOB_APPLICANTS: 'traffic',
    TALENT_LEAD: 'leads',
    MIXED: 'mixed',
  },
  snapchat: {
    BRAND_AWARENESS: 'awareness',
    ENGAGEMENT: 'engagement',
    PROMOTE_STORIES: 'engagement',
    PROMOTE_PLACES: 'engagement',
    VIDEO_VIEW: 'video_views',
    LEAD_GENERATION: 'leads',
    WEB_CONVERSION: 'sales',
    CATALOG_SALES: 'sales',
    APP_CONVERSION: 'sales',
    APP_INSTALL: 'app_installs',
    AWARENESS_AND_ENGAGEMENT: 'awareness',
    TRAFFIC: 'traffic',
    LEADS: 'leads',
    SALES: 'sales',
    APP_PROMOTION: 'app_installs',
  },
  reddit: {
    IMPRESSIONS: 'awareness',
    CLICKS: 'traffic',
    VIDEO_VIEWABLE_IMPRESSIONS: 'video_views',
    LEAD_GENERATION: 'leads',
    CONVERSIONS: 'sales',
    CATALOG_SALES: 'sales',
    APP_INSTALLS: 'app_installs',
  },
};
for (const [platform, values] of Object.entries(pinned))
  test(platform + ' resolves every pinned native value through its declared table', () => {
    const table = reportSource(platform).objectives;
    assert.deepEqual(table.values, values);
    for (const [native, group] of Object.entries(values)) {
      const resolved = resolveObjective({platform, table, native});
      assert.equal(resolved.group, group ?? 'unknown', native);
      assert.equal(resolved.source, group === null ? 'unknown' : 'provider', native);
    }
  });

test('every registered source declares a table and a unique specific missing reason', () => {
  const reasons = reportSourceList.map(source => source.objectives?.missingReason);
  assert.ok(reasons.every(reason => typeof reason === 'string' && reason.endsWith('.')));
  assert.equal(new Set(reasons).size, reasons.length);
  assert.deepEqual(
    objectiveFallbackGroups,
    objectiveGroups.filter(group => group !== 'unknown'),
  );
  assert.equal(objectiveGroups.includes(mixedObjectiveGroup), false);
  assert.equal(mixedObjectiveGroup, 'mixed');
});

test('Google maps only the documented channel and bidding signals; Apple mapping is not claimed as a native objective', () => {
  const google = reportSource('google').objectives;
  for (const [key, value, group] of [
    ['advertisingChannelType', 'SHOPPING', 'sales'],
    ['advertisingChannelType', 'HOTEL', 'sales'],
    ['advertisingChannelType', 'MULTI_CHANNEL', 'app_installs'],
    ['biddingStrategyType', 'MAXIMIZE_CONVERSION_VALUE', 'sales'],
    ['biddingStrategyType', 'TARGET_ROAS', 'sales'],
  ]) {
    const resolved = resolveObjective({platform: 'google', table: google, mappedInputs: {campaign: {[key]: value}}});
    assert.equal(resolved.group, group);
    assert.equal(resolved.source, 'provider_mapped');
  }
  for (const inputs of [
    {},
    {campaign: {advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS'}},
  ]) {
    const resolved = resolveObjective({platform: 'google', table: google, mappedInputs: inputs});
    assert.equal(resolved.source, 'unknown');
    assert.equal(resolved.reason, 'Google Ads has no objective field; choose one in the report.');
  }
  const apple = reportSource('apple');
  const row = normalizeNativeRow('apple', {metadata: {id: '1'}, totalMetrics: {}});
  assert.deepEqual(resolveObjective({platform: 'apple', table: apple.objectives, native: row.objective}), {
    native: null,
    group: 'app_installs',
    source: 'provider_mapped',
    reason: 'Apple Ads campaigns promote apps.',
  });
  for (const platform of ['x', 'microsoft', 'ga4', 'gsc']) {
    const resolved = resolveObjective({platform, table: reportSource(platform).objectives});
    assert.equal(resolved.source, 'unknown');
    assert.equal(resolved.reason, reportSource(platform).objectives.missingReason);
  }
  // X's line item objectives are pinned from its documentation (tests/x-objective-table.test.mjs); a value that
  // documentation does not list is only inferred.
  assert.equal(
    resolveObjective({platform: 'x', table: reportSource('x').objectives, native: 'WEBSITE_CLICKS'}).source,
    'provider',
  );
  assert.equal(
    resolveObjective({platform: 'x', table: reportSource('x').objectives, native: 'WEBSITE_CONVERSIONS'}).source,
    'provider_inferred',
  );
});

test('Google requests objective-mapping attributes without changing its campaign grain', async () => {
  let request;
  await reportSource('google').collect({
    account: '100',
    range: {since: '2026-09-01', until: '2026-09-02'},
    extra: [],
    plan: (path, query, body) => ({path, query, body}),
    run: async plan => {
      request = plan;
      return {results: []};
    },
  });
  assert.match(request.body.query, /campaign\.advertising_channel_type/);
  assert.match(request.body.query, /campaign\.bidding_strategy_type/);
  assert.match(request.body.query, /FROM campaign WHERE/);
});

test('Snapchat campaign collection prefers its v2 objective when supplied', async () => {
  const campaigns = [
    {id: '1', objective: 'WEB_CONVERSION', objective_v2_properties: {objective_v2_type: 'LEADS'}},
    {id: '2', objective: 'APP_INSTALL'},
  ];
  const c = {
    account: '100',
    timezone: 'UTC',
    range: {since: '2026-09-01', until: '2026-09-02'},
    extra: [],
    attributionProfile: () => undefined,
    plan: (path, query) => ({path, query}),
    run: async plan =>
      plan.path.endsWith('/campaigns')
        ? {campaigns: campaigns.map(campaign => ({campaign}))}
        : {
            total_stats: [
              {
                total_stat: {
                  breakdown_stats: {
                    campaign: [
                      {id: '1', stats: {}},
                      {id: '2', stats: {}},
                    ],
                  },
                },
              },
            ],
          },
  };
  await reportSource('snapchat').collect(c);
  assert.equal(c.raw[0].objective, 'LEADS');
  assert.equal(c.raw[1].objective, 'APP_INSTALL');
});

test('mixed campaign rows hold recommendations just as unknown objectives do', () => {
  const row = {
    source_kind: 'paid',
    complete: true,
    currency: 'USD',
    timezone: 'UTC',
    captured_at: Date.now(),
    metrics: {spend: 100},
  };
  const result = campaignRecommendation({...row, objective_group: 'mixed'});
  assert.equal(result.decision, 'needs_review');
  assert.equal(result.reason, 'Confirm this campaign’s objective and primary result metric.');
});

test('overview rows retain native objectives and explain provider, fallback and legacy choices', async t => {
  const rows = [
    normalizeNativeRow('meta', {campaign_id: '1', objective: 'OUTCOME_TRAFFIC'}),
    normalizeNativeRow('meta', {campaign_id: '2'}),
  ];
  const f = objectiveReportFixture(t, {rows});
  let result = await f.run({sources: [{...f.config.sources[0], objective_fallback: 'sales'}]});
  assert.equal(result.state, 'complete');
  assert.deepEqual(
    result.rows.map(row => [row.objective, row.objective_group, row.objective_source, row.objective_reason]),
    [
      ['OUTCOME_TRAFFIC', 'traffic', 'provider', null],
      ['unknown', 'sales', 'user_fallback', null],
    ],
  );
  result = await f.run({sources: [{...f.config.sources[0], objective: 'leads'}]});
  assert.ok(
    result.rows.every(
      row =>
        row.objective_group === 'leads' &&
        row.objective_source === 'user_override' &&
        row.objective_reason === 'Chosen for every campaign of this source in the saved report.',
    ),
  );
  result = await f.run();
  assert.equal(result.rows[1].objective_source, 'unknown');
  assert.equal(result.rows[1].objective_reason, reportSource('meta').objectives.missingReason);
});

test('overview passes native campaign settings into the conservative Google mapping', async t => {
  const rows = [normalizeNativeRow('google', {campaign: {id: '1', advertisingChannelType: 'SHOPPING'}, metrics: {}})];
  const f = objectiveReportFixture(t, {platform: 'google', rows});
  const result = await f.run();
  assert.equal(result.rows[0].objective_group, 'sales');
  assert.equal(result.rows[0].objective_source, 'provider_mapped');
});

test('the shared objective resolver names no provider gateway and imports no provider module', () =>
  assertNamesNoProvider('src/report-objectives.ts'));
