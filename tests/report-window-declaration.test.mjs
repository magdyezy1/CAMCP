// F-L5-22 and F-L5-34: what a source says about its reporting window. A window the user declared incomplete keeps the
// source partial and holds recommendations on every platform, at the campaign level too; a detailed source whose window
// was never declared says that, not a generic refresh request. Real runs through the worker with synthetic provider
// responses (tests/fixtures/overview-granularity-data.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {tiktokNativeFixture} from './helpers/tiktok-native-fixture.mjs';

const one = {since: '2026-09-01', until: '2026-09-01'},
  declaredIncomplete = /declared incomplete/,
  declaredReason = 'The reporting window was declared incomplete or its measurement is incomplete.';

/** One v4 report of one level and one `complete_window` choice (undefined: none given), through run, worker and get. */
async function report(t, platform, level, options) {
  if (platform === 'tiktok') {
    const f = tiktokNativeFixture(t, {groupsPerCampaign: 1, adsPerGroup: 1});
    const queued = await f.overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: f.v4({}, {levels: [level], report_options: {attribution: 'unknown', ...options}}),
      },
      f.actor,
    );
    await f.worker.once();
    return f.get(queued.id, {include: {native: false}});
  }
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const source = granularSource(platform, 'ad');
  const {campaign_id, level: _level, objective, report_options, ...plain} = source;
  const config = {
    ...granularConfig(source),
    ...(platform === 'meta' ? {date_range: one} : {}),
    contract_version: 'overview-config-v4',
    metrics: ['spend', 'impressions', 'clicks', 'primary_result'],
    sources: [{...plain, levels: [level], ...(options ? {report_options: options} : {})}],
  };
  const queued = await f.overview.handle({action: 'run', confirmed: true, config}, f.actor);
  await f.worker.once();
  return f.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: false}}, f.actor);
}
const windowWarnings = r => (r.sources?.[0]?.warnings ?? []).filter(warning => /reporting window/.test(warning));

for (const platform of ['meta', 'linkedin', 'x', 'tiktok'])
  test(
    platform + ': a campaign-level source whose window is declared incomplete is partial and holds advice (F-L5-22)',
    async t => {
      const incomplete = await report(t, platform, 'campaign', {complete_window: false});
      assert.equal(incomplete.state, 'partial', JSON.stringify(incomplete.sources?.[0]?.warnings));
      assert.equal(incomplete.sources[0].complete, false);
      assert.equal(incomplete.sources[0].level_results[0].quality.measurement_complete, false);
      assert.ok(incomplete.rows.length > 0 && incomplete.rows.every(row => row.complete === false));
      assert.equal(windowWarnings(incomplete).filter(warning => declaredIncomplete.test(warning)).length, 1);
      for (const row of incomplete.rows) {
        assert.equal(row.recommendation.decision, 'needs_review');
        assert.ok(row.recommendation.reason.startsWith(declaredReason), row.recommendation.reason);
      }
      // No declaration, or a complete one, never needed one at this level: the source is complete, as it was.
      for (const options of [undefined, {complete_window: null}, {complete_window: true}]) {
        const complete = await report(t, platform, 'campaign', options);
        assert.equal(complete.state, 'complete', JSON.stringify(options) + ' ' + JSON.stringify(complete.sources?.[0]));
        assert.equal(complete.sources[0].complete, true);
        assert.notEqual(complete.sources[0].level_results[0].quality.measurement_complete, false);
        assert.deepEqual(windowWarnings(complete), []);
      }
    },
  );

for (const platform of ['linkedin', 'x'])
  test(
    platform + ': an undeclared window on a detailed source says so, not a generic refresh request (F-L5-34)',
    async t => {
      const undeclared = await report(t, platform, 'ad'),
        declared = await report(t, platform, 'ad', {complete_window: true});
      assert.equal(undeclared.state, 'partial');
      assert.equal(undeclared.sources[0].level_results[0].quality.measurement_complete, false);
      assert.equal(undeclared.sources[0].level_results[0].quality.reporting_window_declared_complete, null);
      for (const row of undeclared.rows) {
        assert.equal(row.recommendation.decision, 'needs_review');
        assert.ok(row.recommendation.reason.startsWith(declaredReason), row.recommendation.reason);
      }
      assert.ok(windowWarnings(undeclared).some(warning => /not declared complete/.test(warning)));
      // Declared complete, the window holds nothing back and measurement is not marked incomplete.
      assert.equal(declared.state, 'complete');
      assert.notEqual(declared.sources[0].level_results[0].quality.measurement_complete, false);
      assert.deepEqual(windowWarnings(declared), []);
    },
  );

/** A v3 definition (no contract version) of one level and one window choice. */
async function v3(t, platform, level, options) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const source = {...granularSource(platform, level), report_options: options};
  const queued = await f.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {...granularConfig(source), ...(platform === 'meta' ? {date_range: one} : {}), sources: [source]},
    },
    f.actor,
  );
  await f.worker.once();
  return f.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: false}}, f.actor);
}

test('v3 definitions keep the state they had (F-L5-22 and F-L5-34 change v4 only)', async t => {
  // A v3 campaign source cannot declare a window at all, so there is no v3 campaign state for the change to touch.
  for (const platform of ['meta', 'linkedin', 'x']) {
    await assert.rejects(() => v3(t, platform, 'campaign', {complete_window: false}), {code: 'INVALID_REPORT_LEVEL'});
    const plain = await v3(t, platform, 'campaign', undefined);
    assert.equal(plain.state, 'complete', platform);
    assert.deepEqual(windowWarnings(plain), [], platform);
  }
  // A v3 detailed source must declare its window, and holds exactly as before.
  for (const platform of ['linkedin', 'x']) {
    const incomplete = await v3(t, platform, 'ad', {attribution: 'unknown', complete_window: false}),
      complete = await v3(t, platform, 'ad', {attribution: 'unknown', complete_window: true});
    assert.equal(incomplete.state, 'partial', platform);
    assert.equal(complete.state, 'complete', platform);
    assert.deepEqual(windowWarnings(complete), [], platform);
    assert.ok(incomplete.rows.every(row => row.recommendation.reason.startsWith(declaredReason)));
  }
});
