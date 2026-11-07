// Package meta-results: the objectives the owner's live read of Meta found beyond OUTCOME_* (LINK_CLICKS, MESSAGES, REACH,
// POST_ENGAGEMENT, EVENT_RESPONSES, BRAND_AWARENESS, PAGE_LIKES) are pinned provider values in a v4 report. A v3 report
// resolves every one of them exactly as it always did, since v3 rows must not change (V2-RPT-06): the table that resolves
// an objective is shared by both, so the values are declared for v4 only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource} from '../dist/src/report-sources.js';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';

/** The seven values and the group the live read's documentation of each names. */
const legacy = {
  LINK_CLICKS: 'traffic',
  MESSAGES: 'engagement',
  REACH: 'awareness',
  POST_ENGAGEMENT: 'engagement',
  EVENT_RESPONSES: 'engagement',
  BRAND_AWARENESS: 'awareness',
  PAGE_LIKES: 'engagement',
};
/** What AMCP did with them before this package: the regex inferred four, and three were not grouped at all. */
const before = {
  LINK_CLICKS: ['traffic', 'provider_inferred'],
  REACH: ['awareness', 'provider_inferred'],
  POST_ENGAGEMENT: ['engagement', 'provider_inferred'],
  BRAND_AWARENESS: ['awareness', 'provider_inferred'],
  MESSAGES: ['unknown', 'unknown'],
  EVENT_RESPONSES: ['unknown', 'unknown'],
  PAGE_LIKES: ['unknown', 'unknown'],
};
const table = reportSource('meta').objectives;

test('Meta’s pinned objective table still holds the six OUTCOME_* values, and the legacy values are v4 provider values', () => {
  assert.deepEqual(Object.keys(table.values).sort(), [
    'OUTCOME_APP_PROMOTION',
    'OUTCOME_AWARENESS',
    'OUTCOME_ENGAGEMENT',
    'OUTCOME_LEADS',
    'OUTCOME_SALES',
    'OUTCOME_TRAFFIC',
  ]);
  assert.deepEqual(table.v4Values, legacy);
});

for (const [native, group] of Object.entries(legacy))
  test('a v4 report reads the Meta objective ' + native + ' as the provider’s own value, ' + group, () => {
    const resolved = resolveObjective({platform: 'meta', table, native, v4: true});
    assert.deepEqual(resolved, {native, group, source: 'provider', reason: null});
  });

for (const [native, [group, source]] of Object.entries(before))
  test('a v3 report resolves the Meta objective ' + native + ' as it always did', () => {
    const resolved = resolveObjective({platform: 'meta', table, native});
    assert.equal(resolved.group, group);
    assert.equal(resolved.source, source);
    if (source === 'unknown') assert.equal(resolved.reason_code, 'objective_not_grouped');
    else assert.equal(resolved.reason_code, 'inferred_from_native');
  });

async function objectives(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor);
}
const withObjective = native => (rows, platform) =>
  platform === 'meta' ? rows.map(row => ({...row, objective: native})) : rows;

test('through the queue, a v4 campaign report groups a MESSAGES campaign as engagement, from the provider', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(withObjective('MESSAGES'));
    const {objective, level, report_options, ...source} = granularSource('meta', 'campaign'),
      sources = [{...source, levels: ['campaign']}],
      report = await objectives(f, {
        ...granularConfig(sources[0], 'daily'),
        contract_version: 'overview-config-v4',
        sources,
      });
    assert.equal(report.state, 'complete', JSON.stringify(report.sources?.[0]?.error));
    for (const row of report.rows)
      assert.deepEqual(row.objective, {native: 'MESSAGES', group: 'engagement', source: 'provider', reason: null});
  } finally {
    f.close();
  }
});

test('through the queue, a v4 detail report groups a PAGE_LIKES ad set as engagement, from the provider', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(withObjective('PAGE_LIKES'));
    const {objective, level, report_options, ...source} = granularSource('meta', 'adset'),
      sources = [{...source, levels: ['adset'], report_options: {complete_window: true}}],
      report = await objectives(f, {
        ...granularConfig(sources[0]),
        contract_version: 'overview-config-v4',
        sources,
      });
    assert.equal(report.state, 'complete', JSON.stringify(report.sources?.[0]?.error));
    assert.deepEqual(report.rows[0].objective, {
      native: 'PAGE_LIKES',
      group: 'engagement',
      source: 'provider',
      reason: null,
    });
  } finally {
    f.close();
  }
});

test('through the queue, a v3 campaign report leaves a MESSAGES campaign ungrouped and a LINK_CLICKS one inferred, as before', async () => {
  for (const [native, group, source, code] of [
    ['MESSAGES', 'unknown', 'unknown', 'objective_not_grouped'],
    ['LINK_CLICKS', 'traffic', 'provider_inferred', 'inferred_from_native'],
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate(withObjective(native));
      const {objective, level, report_options, ...campaign} = granularSource('meta', 'campaign'),
        report = await objectives(f, granularConfig(campaign, 'daily'));
      assert.equal(report.state, 'complete', native + JSON.stringify(report.sources?.[0]?.error));
      for (const row of report.rows)
        assert.deepEqual(
          [row.objective, row.objective_group, row.objective_source, row.objective_reason_code],
          [native, group, source, code],
          native,
        );
    } finally {
      f.close();
    }
  }
});
