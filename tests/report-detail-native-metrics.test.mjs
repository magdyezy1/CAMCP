// Found by package web-report: a detail level takes the preset's metrics. In v3 a source of an ad or ad set level that also
// names native metrics is refused (INVALID_NATIVE_METRICS); in v4 `overviewSourceLevel` returned before that check, so
// such a source was accepted, the provider request's `fields` gained the name, no row carried it and the report listed
// no native metric: silently unused, and an invalid name could fail at the provider. The v4 boundary now refuses it with
// the same code and sentence, before any provider request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const sentence =
    'Detailed reporting uses the preset metrics. Clear additional native metrics before selecting this level.',
  one = {since: '2026-09-01', until: '2026-09-01'},
  names = ['inline_link_clicks'];

/** A v4 run request of one Meta source, through the real boundary, and what reached the provider. */
async function run(t, source, more = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const base = granularSource('meta', 'ad'),
    {campaign_id, level, objective, report_options, ...plain} = base,
    config = {
      ...granularConfig(base),
      date_range: one,
      contract_version: 'overview-config-v4',
      sources: [{...plain, ...source}],
      ...more,
    };
  return {f, outcome: f.overview.handle({action: 'run', confirmed: true, config}, f.actor)};
}
const detail = {report_options: {complete_window: true, result_action_type: 'purchase'}};

for (const levels of [['ad'], ['adset'], ['campaign', 'ad'], ['campaign', 'adset', 'ad']])
  test(`a v4 source of ${levels.join(' + ')} with native metrics is refused before any provider request`, async t => {
    const {f, outcome} = await run(t, {levels, native_metrics: names, ...detail});
    await assert.rejects(outcome, error => {
      assertRefused(error, 'INVALID_NATIVE_METRICS');
      assert.equal(error.message, sentence);
      return true;
    });
    assert.equal(f.requests.length, 0, 'nothing was sent to the provider');
  });

test('a v4 campaign-level source keeps its native metrics, and a detail level without them is accepted', async t => {
  const campaign = await run(t, {levels: ['campaign'], native_metrics: names, report_options: {}}),
    queued = await campaign.outcome;
  assert.equal(queued.state, 'queued');
  await campaign.f.worker.once();
  const report = await campaign.f.overview.handle({action: 'get', id: queued.id, limit: 50}, campaign.f.actor);
  assert.deepEqual(report.config.sources[0].native_metrics, names);
  const plain = await run(t, {levels: ['ad'], ...detail});
  assert.equal((await plain.outcome).state, 'queued');
});

test('a v4 template default that names native metrics for a detail level is refused too', async t => {
  const {f, outcome} = await run(
    t,
    {levels: ['campaign']},
    {source_defaults: {meta: {levels: ['ad'], native_metrics: names, ...detail}}},
  );
  await assert.rejects(outcome, error => assertRefused(error, 'INVALID_NATIVE_METRICS') && error.message === sentence);
  assert.equal(f.requests.length, 0);
});

test('a v3 definition keeps its own refusal, with the same code and sentence', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const source = {...granularSource('meta', 'ad'), native_metrics: names},
    config = {...granularConfig(source), date_range: one, sources: [source]};
  await assert.rejects(f.overview.handle({action: 'run', confirmed: true, config}, f.actor), error => {
    assertRefused(error, 'INVALID_NATIVE_METRICS');
    assert.equal(error.message, sentence);
    return true;
  });
  assert.equal(f.requests.length, 0);
});
