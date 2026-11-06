import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource} from '../dist/src/report-sources.js';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {normalizeNativeRow, normalizeNativeRowV4} from '../dist/src/report-native.js';
import {redditDetail, nativeDetailResult} from '../dist/src/overview-native-detail.js';
import {detailedOverviewRows} from '../dist/src/overview-levels.js';
import {detailParents, detailParentLimit} from '../dist/src/overview-parents.js';
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

// The platform refuses the read of the parent campaigns while the report itself succeeds.
const refusals = {
  tiktok: url =>
    url.pathname.endsWith('/campaign/get/')
      ? new Response(JSON.stringify({code: 40002, message: 'No permission'}), {status: 403})
      : undefined,
  snapchat: url =>
    /get_campaigns_by_ids$/.test(url.pathname)
      ? new Response(JSON.stringify({request_status: 'ERROR', error_code: 'E1001'}), {status: 403})
      : undefined,
};
for (const platform of ['tiktok', 'snapchat'])
  test(platform + ' rows whose parent campaigns could not be read say so instead of claiming no objective', async t => {
    const {objective, ...source} = granularSource(platform, 'ad'),
      unread = 'AMCP could not read this campaign’s objective because the platform refused the read';
    const f = inheritanceFixture(t, platform);
    f.hook(refusals[platform]);
    const plain = await run(f, source);
    assert.equal(plain.state, 'complete', JSON.stringify(plain.sources));
    assert.ok(plain.rows.length > 0);
    for (const row of plain.rows) {
      assert.equal(row.objective_source, 'unknown');
      assert.equal(row.objective_reason, unread + '; choose one in the report.');
      assert.notEqual(row.objective_reason, reportSource(platform).objectives.missingReason);
    }
    // A fallback covers the unread campaign, and the row says that this is what it did.
    const g = inheritanceFixture(t, platform);
    g.hook(refusals[platform]);
    const covered = await run(g, {...source, objective_fallback: 'leads'});
    for (const row of covered.rows) {
      assert.equal(row.objective_group, 'leads');
      assert.equal(row.objective_source, 'user_fallback');
      assert.equal(row.objective_reason, unread + ', so your fallback is used.');
    }
    // The same fallback beside a campaign the platform did read stays the plain provider value.
    const h = inheritanceFixture(t, platform);
    const read = await run(h, {...source, objective_fallback: 'leads'});
    for (const row of read.rows) assert.deepEqual([row.objective_source, row.objective_reason], ['provider', null]);
  });

test('parents AMCP did not read are marked with why, apart from parents it read or the platform left without a record', async () => {
  const source = {platform: 'tiktok', account_id: '100', reporting_contract: 'overview-config-v4'},
    read = {'1': {campaign_id: '10'}, '2': {}},
    full = Object.fromEntries(Array.from({length: detailParentLimit}, (_, i) => ['9' + (100000 + i), {}]));
  for (const [cache, cause] of [
    [{parents: {...read}, lineage: [], unavailable: true}, 'refused'],
    [{parents: {...read, ...full}, lineage: []}, 'limited'],
  ]) {
    const out = await detailParents(undefined, source, 'ad', ['1', '2', '3'], undefined, cache);
    assert.deepEqual(out.parents, read, 'an unread entity is never given a parent');
    assert.deepEqual(out.unread, {'3': cause});
  }
  const rows = detailedOverviewRows(
    {platform: 'tiktok', level: 'ad', report_options: {complete_window: true, attribution: 'unknown'}},
    {rows: [{entity_id: '3'}], native_rows: [{}], semantics: {currency: 'USD'}},
    {'3': {objective_unread: 'limited'}},
    reportSource('tiktok').objectives,
  );
  assert.equal(rows[0].objective_unread, 'limited');
  assert.equal(Object.hasOwn(rows[0].parent_ids, 'objective_unread'), false);
});

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

// Two accounts of one platform report the same campaign ID. A source's overrides are its own: they never reach the
// other account's row, whichever way the definition is shaped (without levels, or with them).
const sharedCampaign = account => ({
  dimensions: {campaign_id: '555'},
  metrics: {campaign_name: 'Campaign of ' + account, spend: '10', impressions: '100', clicks: '5', conversion: '1'},
  objective_type: 'TRAFFIC',
});
const accountSource = (account, overrides, levels) => ({
  platform: 'tiktok',
  account_id: account,
  connection_id: 'login',
  ...(levels ? {levels, delivered_only: false, report_options: {complete_window: true, attribution: 'unknown'}} : {}),
  ...(overrides ? {objective_overrides: overrides} : {}),
});
for (const [shape, levels] of [
  ['without levels', undefined],
  ['with levels', ['campaign']],
])
  test('an objective override applies only to the account that names it, definition ' + shape, async t => {
    const normalize = levels ? normalizeNativeRowV4 : normalizeNativeRow,
      f = objectiveReportFixture(t, {
        platform: 'tiktok',
        accounts: ['100', '200'],
        rowsFor: source => [normalize('tiktok', sharedCampaign(source.account_id))],
      }),
      changes = sources => ({...(levels ? {contract_version: 'overview-config-v4'} : {}), sources}),
      objectiveOf = (result, account) => {
        const row = result.rows.find(
          candidate => (candidate.account_id ?? ['100', '200'][candidate.source_ref]) === account,
        );
        return [row.objective_group ?? row.objective.group, row.objective_source ?? row.objective.source];
      };
    for (const [overrides, expected] of [
      [{'100': {'555': 'sales'}}, {'100': ['sales', 'user_override'], '200': ['traffic', 'provider']}],
      [{'200': {'555': 'leads'}}, {'100': ['traffic', 'provider'], '200': ['leads', 'user_override']}],
      [
        {'100': {'555': 'sales'}, '200': {'555': 'engagement'}},
        {'100': ['sales', 'user_override'], '200': ['engagement', 'user_override']},
      ],
    ]) {
      const result = await f.run(
        changes(['100', '200'].map(account => accountSource(account, overrides[account], levels))),
      );
      assert.equal(result.state, 'complete', JSON.stringify(result.sources));
      assert.deepEqual(
        {'100': objectiveOf(result, '100'), '200': objectiveOf(result, '200')},
        expected,
        JSON.stringify(overrides),
      );
    }
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

const googleMappingFields = ['campaign.advertising_channel_type', 'campaign.bidding_strategy_type'];
const googleSelected = query =>
  /^SELECT (.+) FROM (\w+) WHERE /s
    .exec(query)[1]
    .split(', ')
    .filter(field => !/[\s()]/.test(field));
for (const [preset, resource] of [
  ['google_adset', 'ad_group'],
  ['google_ad', 'ad_group_ad'],
])
  test('the Google ' + preset + ' request selects the campaign attributes the objective mapping reads', () => {
    const guided = reportSource('google').guided,
      input = {account_id: '1234567890', connection_id: 'login', semantics: {timezone: 'UTC', currency: 'USD'}};
    for (const context of [{overviewV4: true}, undefined]) {
      const request = guided.presetRequest(
          guided.presets.find(p => p.id === preset),
          input,
          granularRange,
          context,
        ),
        query = request.arguments.payload.query,
        fields = googleSelected(query);
      assert.match(query, new RegExp(' FROM ' + resource + ' WHERE '));
      for (const field of googleMappingFields) assert.equal(fields.filter(f => f === field).length, 1, field);
      // GAQL refuses a repeated field, and the grain stays the entity's own: no campaign segment is added.
      assert.equal(new Set(fields).size, fields.length);
      assert.doesNotMatch(query, /segments\.(?!date)/);
    }
    // The campaign grain of the same guided reports is unchanged.
    const campaign = guided.presetRequest(
      guided.presets.find(p => p.id === 'google_campaign'),
      input,
      granularRange,
    );
    assert.deepEqual(
      googleSelected(campaign.arguments.payload.query).filter(f => googleMappingFields.includes(f)),
      [],
    );
  });

for (const level of ['adset', 'ad'])
  test(
    'Google ' + level + ' rows of a Shopping campaign resolve their mapped objective through the real request',
    async t => {
      const f = overviewGranularityFixture();
      t.after(() => f.close());
      // A provider that answers only with the fields the request selected.
      let query = '';
      f.hook(() => {
        query = f.requests.at(-1).body?.query ?? query;
      });
      f.mutate((rows, kind) =>
        kind === 'google'
          ? rows.map(row => ({
              ...row,
              campaign: {
                ...row.campaign,
                ...(query.includes('campaign.advertising_channel_type') ? {advertisingChannelType: 'SHOPPING'} : {}),
              },
            }))
          : rows,
      );
      const {objective, ...source} = granularSource('google', level);
      const result = await run(f, source);
      assert.equal(result.state, 'complete', JSON.stringify(result.sources));
      assert.ok(result.rows.length > 0);
      for (const row of result.rows) {
        assert.equal(row.objective_group, 'sales');
        assert.equal(row.objective_source, 'provider_mapped');
      }
    },
  );

test('shared detail collection and row mapping still import no provider module', () => {
  for (const file of [
    'src/report-native.ts',
    'src/overview-granularity.ts',
    'src/overview-levels.ts',
    'src/overview-native-detail.ts',
  ])
    assertNamesNoProvider(file);
});
