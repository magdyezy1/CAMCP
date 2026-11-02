import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource} from '../dist/src/report-sources.js';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {redditDetail, nativeDetailResult} from '../dist/src/overview-native-detail.js';
import {detailedOverviewRows} from '../dist/src/overview-levels.js';
import {objectiveReportFixture} from './helpers/objective-report.mjs';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';
import {
  overviewGranularityFixture,
  granularSource,
  granularConfig,
  granularRange,
} from './fixtures/overview-granularity-data.mjs';

const native = {tiktok: 'TRAFFIC', meta: 'OUTCOME_LEADS', snapchat: 'LEADS', reddit: 'CLICKS'};
const groups = {tiktok: 'traffic', meta: 'leads', snapchat: 'leads', reddit: 'traffic'};
const run = async (f, source) => {
  const queued = await f.overview.handle({action: 'run', config: granularConfig(source), confirmed: true}, f.actor);
  await f.worker.once();
  return f.overview.handle({action: 'get', id: queued.id}, f.actor);
};
function inheritanceFixture(t, platform, withObjective = true) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((rows, kind) =>
    kind === 'meta' && withObjective ? rows.map(row => ({...row, objective: native.meta})) : rows,
  );
  f.parents((kind, url, body) => {
    if (!withObjective) return body;
    if (kind === 'tiktok' && url.pathname.endsWith('/campaign/get/'))
      return {
        ...body,
        data: {...body.data, list: body.data.list.map(row => ({...row, objective_type: native.tiktok}))},
      };
    if (kind === 'snapchat' && Array.isArray(body.campaigns))
      return {
        ...body,
        campaigns: body.campaigns.map(wrapped => ({
          ...wrapped,
          campaign: {
            ...wrapped.campaign,
            objective: 'WEB_CONVERSION',
            objective_v2_properties: {objective_v2_type: native.snapchat},
          },
        })),
      };
    return body;
  });
  return f;
}

for (const platform of ['tiktok', 'meta', 'snapchat']) {
  test(platform + ' middle-level and ad rows inherit their campaign’s native objective', async t => {
    for (const level of ['adset', 'ad']) {
      const f = inheritanceFixture(t, platform);
      const {objective, ...source} = granularSource(platform, level);
      const result = await run(f, source);
      assert.equal(result.state, 'complete', JSON.stringify(result.sources));
      assert.ok(result.rows.length > 0);
      for (const row of result.rows) {
        assert.equal(row.objective, native[platform]);
        assert.equal(row.objective_group, groups[platform]);
        assert.equal(row.objective_source, 'provider');
        assert.equal(row.objective_reason, null);
        assert.equal(Object.hasOwn(row.parent_ids, 'objective'), false);
      }
      if (platform === 'tiktok') {
        const reads = f.requests.filter(r => r.url.pathname.endsWith('/campaign/get/'));
        assert.equal(reads.length, 1);
        assert.ok(JSON.parse(reads[0].url.searchParams.get('fields')).includes('objective_type'));
        assert.equal(JSON.parse(reads[0].url.searchParams.get('filtering')).primary_status, 'STATUS_ALL');
      }
      if (platform === 'meta')
        assert.ok(
          f.requests
            .filter(r => r.url.pathname.endsWith('/insights'))
            .every(r => r.url.searchParams.get('fields').split(',').includes('objective')),
        );
      if (platform === 'snapchat' && level === 'adset') {
        // Reuse the campaign read the scoped evidence already verifies, rather than asking again for its objective.
        assert.equal(f.requests.filter(r => r.url.pathname.endsWith('get_campaigns_by_ids')).length, 0);
        assert.equal(f.requests.filter(r => /^\/v1\/campaigns\/[^/]+$/.test(r.url.pathname)).length, 2);
      }
    }
  });
  test(platform + ' detail without a campaign objective shows its specific missing reason', async t => {
    const f = inheritanceFixture(t, platform, false),
      {objective, ...source} = granularSource(platform, 'ad');
    const result = await run(f, source);
    assert.equal(result.state, 'complete', JSON.stringify(result.sources));
    assert.equal(result.rows[0].objective_source, 'unknown');
    assert.equal(result.rows[0].objective_reason, reportSource(platform).objectives.missingReason);
  });
}

test('TikTok campaign inventory includes deleted objects so their historical objectives remain available', async () => {
  const requests = [];
  const c = {
    account: '100',
    range: granularRange,
    extra: [],
    warnings: [],
    lineage: [],
    lookup: {},
    complete: true,
    collectionComplete: true,
    plan: (path, query) => ({path, query}),
    run: async plan => {
      requests.push(plan);
      return {
        code: 0,
        data: plan.path.includes('/report/integrated/')
          ? {
              list: [
                {dimensions: {campaign_id: '1'}, metrics: {spend: '1', impressions: '1', clicks: '1', conversion: '1'}},
              ],
              page_info: {total_number: 1},
            }
          : {list: plan.path.includes('/campaign/get/') ? [{campaign_id: '1', objective_type: 'TRAFFIC'}] : []},
      };
    },
  };
  await reportSource('tiktok').collect(c);
  assert.deepEqual(requests.find(r => r.path.endsWith('/campaign/get/')).query.filtering, {
    primary_status: 'STATUS_ALL',
  });
  assert.equal(c.raw[0].objective_type, 'TRAFFIC');
});

test('Reddit detail parents carry the campaign objective, including when names are unavailable', () => {
  for (const level of ['adset', 'ad']) {
    const rows = [
      {
        campaign_id: '1',
        ad_group_id: '2',
        ...(level === 'ad' ? {ad_id: '3'} : {}),
        spend: '1000000',
        impressions: '10',
        clicks: '1',
      },
    ];
    const detail = redditDetail(
      level,
      rows,
      {campaigns: [{id: '1', objective: 'CLICKS'}], adGroups: [], ads: []},
      '100',
      {},
    );
    const source = {platform: 'reddit', level, report_options: {complete_window: true, attribution: 'unknown'}};
    const result = nativeDetailResult(source, detail, rows, {
      lineage: [],
      metadata: {},
      currency: 'USD',
      timezone: 'UTC',
      range: granularRange,
      providerComplete: true,
      resultDefinition: 'unknown',
      warnings: [],
      context: {},
      rounding: {},
      objectives: reportSource('reddit').objectives,
    });
    assert.equal(result.rows[0].objective, 'CLICKS');
    assert.equal(result.rows[0].objective_group, 'traffic');
    assert.equal(result.rows[0].objective_source, 'provider');
    assert.equal(Object.hasOwn(result.rows[0].parent_ids, 'objective'), false);
  }
});

test('campaign and detailed positions use the same pinned native objective meanings', () => {
  const rows = {
    tiktok: {dimensions: {campaign_id: '1'}, metrics: {}, objective_type: native.tiktok},
    meta: {campaign_id: '1', objective: native.meta},
    snapchat: {id: '1', objective: native.snapchat},
    reddit: {campaign_id: '1', objective: native.reddit},
  };
  for (const [platform, raw] of Object.entries(rows)) {
    const row = normalizeNativeRow(platform, raw);
    const resolved = resolveObjective({platform, table: reportSource(platform).objectives, native: row.objective});
    assert.equal(resolved.group, groups[platform]);
    assert.equal(resolved.source, 'provider');
  }
});

test('a campaign override governs its ads, while an ad ID never substitutes for the parent campaign', async t => {
  const f = inheritanceFixture(t, 'tiktok');
  const {objective, ...source} = granularSource('tiktok', 'ad');
  source.objective_overrides = {'9007199254740001': 'leads', '9007199254740993': 'sales'};
  const result = await run(f, source);
  assert.equal(result.state, 'complete', JSON.stringify(result.sources));
  assert.equal(result.rows[0].objective, 'TRAFFIC');
  assert.equal(result.rows[0].objective_group, 'leads');
  assert.equal(result.rows[0].objective_source, 'user_override');
  assert.ok(
    result.sources[0].warnings.includes('Objective overrides matched no campaign in this snapshot: 9007199254740993.'),
  );
});

test('scoped detail cannot borrow an objective from another campaign or account', () => {
  const {objective, ...source} = granularSource('snapchat', 'adset');
  for (const parent of [
    {id: 'other', account_id: source.account_id},
    {id: source.campaign_id, account_id: 'other'},
  ]) {
    assert.throws(
      () =>
        detailedOverviewRows(
          source,
          {
            rows: [{entity_id: '1'}],
            native_rows: [{}],
            semantics: {currency: 'USD'},
            native_account_evidence: {parent_campaign: {...parent, objective: 'LEADS'}},
          },
          {},
          reportSource('snapchat').objectives,
        ),
      error => error.code === 'REPORT_ACCOUNT_MISMATCH',
    );
  }
});

test('native mapping inputs survive final assembly of detailed rows', async t => {
  const source = {platform: 'google', level: 'adset', report_options: {complete_window: true, attribution: 'unknown'}};
  const rows = detailedOverviewRows(
    source,
    {
      rows: [
        {entity_id: '2', entity_name: 'Synthetic group', spend: '1', impressions: '10', clicks: '1', conversions: '1'},
      ],
      native_rows: [
        {campaign: {id: '1', name: 'Synthetic campaign', advertisingChannelType: 'SHOPPING'}, adGroup: {id: '2'}},
      ],
      semantics: {currency: 'USD'},
    },
    {},
    reportSource('google').objectives,
  );
  const f = objectiveReportFixture(t, {platform: 'google', rows});
  const result = await f.run({sources: [{...f.config.sources[0], ...source}]});
  assert.equal(result.rows[0].objective, 'unknown');
  assert.equal(result.rows[0].objective_group, 'sales');
  assert.equal(result.rows[0].objective_source, 'provider_mapped');
});

test('shared detail collection and row mapping still import no provider module', () => {
  for (const file of [
    'src/report-native.ts',
    'src/overview-granularity.ts',
    'src/overview-levels.ts',
    'src/overview-native-detail.ts',
  ])
    assertNamesNoProvider(file);
});
