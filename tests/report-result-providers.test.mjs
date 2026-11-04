import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeReportResult} from '../dist/src/report-native.js';
import {reportSource} from '../dist/src/report-sources.js';
import {selectReportResultDefinition, reportResultField} from '../dist/src/report-results.js';
import {tiktokCampaignResultGroups, collectTikTokCampaignResults} from '../dist/src/tiktok-report-results.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/report-result-pairings-v1.json', import.meta.url), 'utf8'));
const context = {level: 'adset', range: {since: '2026-10-01', until: '2026-10-07'}};
const result = (platform, row, extra = {}) => nativeReportResult(platform, row, {...context, ...extra});

for (const platform of ['meta', 'snapchat', 'reddit', 'x']) {
  test(platform + ' pins every declared selector, native field and cost unit', () => {
    const rules = reportSource(platform).resultRules,
      field = ['meta', 'snapchat'].includes(platform) ? 'goal' : 'objective';
    assert.deepEqual(Object.keys(rules.selectors[0].values).sort(), fixture[platform].map(([key]) => key).sort());
    for (const [key, native, multiplier] of fixture[platform]) {
      const selected = selectReportResultDefinition(rules, {[field]: key});
      assert.equal(selected.definition?.native_metric ?? null, native, key);
      assert.equal(selected.definition ? (selected.definition.cost_multiplier ?? 1) : null, multiplier, key);
    }
    assert.equal(selectReportResultDefinition(rules, {[field]: 'NEW_OR_UNKNOWN'}).definition, null);
    assert.equal(selectReportResultDefinition(rules, {}).definition, null);
  });
}

test('mapped providers retain exact native units, field choice and a missing result', () => {
  for (const [platform, raw, overrides, expected] of [
    ['google', {metrics: {conversions: '9007199254740993', costMicros: '18014398509481986000000'}}, {}, '2'],
    ['microsoft', {Conversions: '5.25', Spend: '10.5'}, {}, '2'],
    ['apple', {totalMetrics: {totalInstalls: '4', localSpend: {amount: '9'}}}, {}, '2.25'],
    [
      'snapchat',
      {
        optimization_goal: 'LEAD_FORM_SUBMISSIONS',
        stats: {native_leads: '4', conversion_sign_ups: '900', spend: '10000000'},
      },
      {},
      '2.5',
    ],
    ['reddit', {objective: 'CLICKS', clicks: '4', spend: '10000000'}, {}, '2.5'],
    [
      'x',
      {
        objective: 'WEBSITE_CLICKS',
        native_metrics: {url_clicks: '4', clicks: '900', billed_charge_local_micro: '10000000'},
      },
      {},
      '2.5',
    ],
  ]) {
    assert.equal(result(platform, raw, overrides).result.cost_per_result, expected, platform);
    assert.equal(result(platform, {}, overrides).result.value, null, platform + ' absent');
  }
  assert.equal(result('snapchat', {objective: 'TRAFFIC', stats: {swipes: '99'}}).unavailable_reason, 'missing_goal');
  for (const objective of ['CONVERSIONS', 'CATALOG_SALES', 'LEAD_GENERATION', 'APP_INSTALLS'])
    assert.equal(result('reddit', {objective, CONVERSION_PURCHASE_TOTAL_ITEMS: '900'}).result.value, null);
  assert.equal(
    result('x', {
      objective: 'APP_INSTALLS',
      native_metrics: {mobile_conversion_installs_post_view: '7', mobile_conversion_installs_post_engagement: '8'},
    }).result.value,
    null,
  );
});

test('LinkedIn preserves one-click leads separately from qualified leads and uses bounded non-additive reach', () => {
  const lead = result('linkedin', {
    objectiveType: 'LEAD_GENERATION',
    oneClickLeads: '5',
    qualifiedLeads: '2',
    costInLocalCurrency: '10',
  });
  assert.equal(lead.result.value, '5');
  assert.equal(lead.result.metric, 'oneClickLeads');
  assert.equal(lead.result.cost_per_result, '2');
  const raw = {objectiveType: 'BRAND_AWARENESS', approximateMemberReach: '2000', costInLocalCurrency: '10'};
  assert.equal(result('linkedin', raw).result.cost_per_result, '5');
  assert.equal(result('linkedin', raw).definition.aggregation, 'non_additive');
  assert.equal(result('linkedin', raw, {range: {since: '2026-01-01', until: '2026-04-02'}}).result.value, '2000');
  assert.equal(result('linkedin', raw, {range: {since: '2026-01-01', until: '2026-04-03'}}).result.value, null);
  assert.equal(
    result('linkedin', {
      objectiveType: 'WEBSITE_VISIT',
      type: 'SPONSORED_INMAILS',
      sends: '10',
      landingPageClicks: '3',
    }).result.metric,
    'sends',
  );
  assert.equal(
    result('linkedin', {objectiveType: 'LEAD_GENERATION', oneClickLeads: '2', impressions: 0, clicks: 0}).result
      .cost_per_result,
    '0',
  );
});

test('Meta optional exact action override and delivered omitted-action policy do not fabricate a native result shape', () => {
  const raw = {
    optimization_goal: 'LINK_CLICKS',
    inline_link_clicks: '3',
    impressions: '10',
    spend: '6',
    results: [{unverified: '999'}],
  };
  assert.equal(result('meta', raw).result.value, '3');
  assert.equal(result('meta', raw).source, 'mapped');
  assert.equal(result('meta', {results: [{value: '999'}]}).unavailable_reason, 'unverified_native_shape');
  const options = {report_options: {result_action_type: 'offsite_conversion.fb_pixel_purchase'}};
  const selected = result(
    'meta',
    {
      ...raw,
      actions: [
        {action_type: 'offsite_conversion.fb_pixel_purchase', value: '2'},
        {action_type: 'omni_purchase', value: '100'},
      ],
    },
    options,
  );
  assert.equal(selected.result.value, '2');
  assert.equal(selected.result.cost_per_result, '3');
  const omitted = result('meta', raw, options);
  assert.equal(omitted.result.value, '0');
  assert.equal(omitted.provider_omitted, true);
  assert.equal(result('meta', {...raw, impressions: '0'}, options).result.value, null);
  const alias = result('meta', {
    ...raw,
    optimization_goal: 'LEAD_GENERATION',
    actions: [
      {action_type: 'onsite_conversion.lead_grouped', value: '5'},
      {action_type: 'offsite_conversion.fb_pixel_lead', value: '50'},
    ],
  });
  assert.equal(alias.result.value, '5');
  assert.equal(alias.provider_omitted, undefined);
  assert.equal(alias.definition.native_metric, 'actions.onsite_conversion.lead_grouped');
  assert.throws(
    () => result('meta', {...raw, actions: [null]}, options),
    error => error.code === 'REPORT_SHAPE_CHANGED',
  );
  assert.equal(
    result('meta', {...raw, actions: [{action_type: 'offsite_conversion.fb_pixel_purchase', value: null}]}, options)
      .result.value,
    null,
  );
  assert.throws(
    () =>
      result(
        'meta',
        {
          ...raw,
          actions: [
            {action_type: 'lead', value: '1'},
            {action_type: 'lead', value: '2'},
          ],
        },
        {goal: 'LEAD_GENERATION'},
      ),
    e => e.code === 'REPORT_SHAPE_CHANGED',
  );
  assert.throws(
    () => result('meta', raw, {report_options: {result_action_type: '__proto__'}}),
    e => e.code === 'INVALID_REPORT_SOURCE',
  );
  assert.equal(reportResultField(Object.create({metrics: {value: '9'}}), 'metrics.value'), undefined);
});

test('TikTok uses native result and cost, never a campaign dash or legacy conversion substitute', () => {
  const raw = {
    optimization_goal: 'CONVERT',
    optimization_event: 'COMPLETE_PAYMENT',
    metrics: {result: '4', conversion: '999', cost_per_result: '1.25', spend: '10'},
  };
  const native = result('tiktok', raw);
  assert.equal(native.result.value, '4');
  assert.equal(native.result.cost_per_result, '1.25');
  assert.equal(native.cost_source, 'provider');
  assert.equal(result('tiktok', raw, {level: 'campaign'}).result.value, null);
  assert.equal(result('tiktok', {...raw, metrics: {conversion: '999', result: '-'}}).result.value, null);
  assert.equal(result('tiktok', {...raw, optimization_goal: undefined}).unavailable_reason, 'missing_goal');
  assert.equal(result('tiktok', {...raw, optimization_goal: 'FUTURE_GOAL'}).definition.aggregation, 'non_additive');
  const future = result('tiktok', {...raw, optimization_goal: 'FUTURE_GOAL'});
  assert.equal(future.result.value, '4', 'retain the native row figure without inventing its meaning');
  assert.equal(future.result.cost_per_result, '1.25', 'native cost remains native evidence');
  assert.equal(future.unavailable_reason, 'unsupported_goal');
  assert.equal(
    result('tiktok', {...raw, optimization_goal: 'FUTURE_GOAL', metrics: {result: '4', spend: '10'}}).result
      .cost_per_result,
    null,
    'an unpinned result never acquires an invented derived cost',
  );
});

test('TikTok campaign results combine only the same known goal and event; reach and missing values stay explicit', () => {
  const row = (goal, event, value, spend = '10') => ({goal, event, raw: {metrics: {result: value, spend}}});
  const groups = tiktokCampaignResultGroups(
    [
      row('CONVERT', 'COMPLETE_PAYMENT', '4'),
      row('CONVERT', 'COMPLETE_PAYMENT', '6'),
      row('CONVERT', 'SUBMIT_FORM', '2'),
      row('CLICK', undefined, '10'),
      row('REACH', undefined, '100'),
      row('REACH', undefined, '200'),
      row(undefined, undefined, '99'),
      row('CONVERT', undefined, '8'),
      row('CONVERT', undefined, '9'),
      row('CONVERT', 'COMPLETE_PAYMENT', '-'),
    ],
    {...context, currency: 'SAR', scope: 'campaign:123:2026-10-01/2026-10-07:default-attribution'},
  );
  assert.equal(groups.length, 6);
  const purchases = groups.find(g => g.definition?.id === 'tiktok:CONVERT:COMPLETE_PAYMENT');
  assert.equal(purchases.result.value, '10');
  assert.equal(purchases.result.cost_per_result, '2');
  assert.deepEqual(purchases.coverage, {known: 2, total: 3});
  assert.equal(groups.find(g => g.definition?.id === 'tiktok:CONVERT:SUBMIT_FORM').result.value, '2');
  assert.equal(groups.find(g => g.definition?.id.startsWith('tiktok:REACH')).unavailable_reason, 'non_additive');
  assert.equal(groups.find(g => g.definition?.id === 'tiktok:CONVERT:unspecified').result.value, null);
  assert.equal(groups.find(g => !g.definition).unavailable_reason, 'missing_goal');
});

const campaignResultFixture = (overrides = {}) => {
  const rows = [
      {
        dimensions: {adgroup_id: '1'},
        metrics: {
          result: '4',
          cost_per_result: '1',
          result_rate: '10',
          spend: '10',
          impressions: '100',
          clicks: '2',
          conversion: '999',
        },
      },
      {
        dimensions: {adgroup_id: '2'},
        metrics: {
          result: '6',
          cost_per_result: '2',
          result_rate: '10',
          spend: '20',
          impressions: '100',
          clicks: '2',
          conversion: '999',
        },
      },
    ],
    calls = [],
    collection = {
      account: '500',
      lookup: {},
      currency: 'SAR',
      range: context.range,
      attribution: 'Synthetic window',
      raw: [{dimensions: {campaign_id: '123'}, metrics: {result: '-', spend: '30'}}],
      complete: true,
      collectionComplete: true,
      warnings: [],
      plan: (path, query) => ({path, query}),
      run: async plan => {
        calls.push(plan);
        return {
          data: {
            list: rows,
            page_info: {total_number: 2},
            total_metrics: {spend: '30', impressions: '200', clicks: '4', conversion: '1998'},
            ...overrides,
          },
        };
      },
    },
    metadata = Object.fromEntries(
      ['1', '2'].map(id => [
        id,
        {campaign_id: '123', optimization_goal: 'CONVERT', optimization_event: 'COMPLETE_PAYMENT'},
      ]),
    );
  return {collection, metadata, calls, rows};
};
test('TikTok campaign collector requests native ad-group result fields and combines same-goal results exactly', async () => {
  const f = campaignResultFixture();
  await collectTikTokCampaignResults(f.collection, f.metadata);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].query.data_level, 'AUCTION_ADGROUP');
  assert.equal(
    ['result', 'cost_per_result', 'result_rate'].every(metric => f.calls[0].query.metrics.includes(metric)),
    true,
  );
  const native = result('tiktok', f.collection.raw[0], {level: 'campaign'});
  assert.equal(native.result.value, '10');
  assert.equal(native.result.cost_per_result, '3');
  assert.equal(native.cost_source, 'derived');
  assert.equal(f.collection.raw[0].amcp_result_groups[0].coverage.known, 2);
  assert.equal(f.collection.complete, true);
});
test('TikTok campaign collection holds mixed goals, partial pages and unbound native entities', async () => {
  const mixed = campaignResultFixture();
  mixed.metadata['2'].optimization_event = 'SUBMIT_FORM';
  await collectTikTokCampaignResults(mixed.collection, mixed.metadata);
  assert.equal(mixed.collection.raw[0].amcp_result_groups.length, 2);
  assert.equal(result('tiktok', mixed.collection.raw[0], {level: 'campaign'}).unavailable_reason, 'mixed_goals');
  const partial = campaignResultFixture({
    page_info: {total_number: 3},
    total_metrics: {spend: '31', impressions: '200', clicks: '4', conversion: '1998'},
  });
  await collectTikTokCampaignResults(partial.collection, partial.metadata);
  assert.equal(partial.collection.complete, false);
  assert.equal(partial.collection.collectionComplete, false);
  const countsOnly = campaignResultFixture({page_info: {total_number: 3}});
  await collectTikTokCampaignResults(countsOnly.collection, countsOnly.metadata);
  assert.equal(
    countsOnly.collection.complete,
    true,
    'approved native totals proof can resolve inconsistent page counts',
  );
  assert.equal(
    countsOnly.collection.warnings.some(warning => warning.includes('totals match')),
    true,
  );
  const foreign = campaignResultFixture();
  foreign.rows[1].dimensions.adgroup_id = '999';
  await assert.rejects(
    collectTikTokCampaignResults(foreign.collection, foreign.metadata),
    error => error.code === 'REPORT_SHAPE_CHANGED',
  );
});
