import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {locales, plainText, reportPage} from './helpers/report-page.mjs';

// What a source says when some, or all, of its levels failed (F-L5-10, F-L5-30): the source is failed only when every
// level it was asked for failed, a partial source names the levels that did, and a failed level says why a comparison
// with it is unavailable.
const rowsFor = level =>
  level === 'ad'
    ? [row('ad', 'a1', {spend: '10'})]
    : level === 'adset'
      ? [row('adset', 's1', {spend: '10'})]
      : [row('campaign', 'c1', {spend: '10'})];
const refused = () => new MirrorError('PLATFORM_ERROR', 'Synthetic refusal', {}, 502, false);
const failing =
  (...levels) =>
  source =>
    levels.includes(source.level) ? refused() : undefined;

test('a source that lost its ad level is partial: it names the level and is not called failed', async t => {
  const e = reportEngine(t, {rowsFor, fail: failing('ad')});
  const {report} = await e.go();
  const source = report.sources[0];
  assert.equal(report.state, 'partial');
  assert.equal(source.error, undefined, 'the source has rows; it did not fail');
  assert.deepEqual(
    source.failed_levels.map(level => [level.level, level.error.code]),
    [['ad', 'PLATFORM_ERROR']],
  );
  assert.equal(source.complete, false);
  assert.equal(source.collection_complete, false);
  assert.deepEqual(
    source.level_results.map(level => [level.level, level.error?.code ?? null, level.row_count]),
    [
      ['campaign', null, 1],
      ['adset', null, 1],
      ['ad', 'PLATFORM_ERROR', 0],
    ],
  );
});

test('a source whose first level failed still states its account facts, from the first level that collected', async t => {
  const e = reportEngine(t, {rowsFor, fail: failing('campaign')});
  const {report} = await e.go();
  const source = report.sources[0];
  assert.equal(source.error, undefined, 'two levels collected: the source is partial');
  assert.deepEqual(
    source.failed_levels.map(level => level.level),
    ['campaign'],
  );
  assert.deepEqual([source.currency, source.timezone], ['USD', 'UTC'], 'a failed first level has no account facts');
  assert.equal(source.attribution, 'Synthetic click window');
  assert.equal(source.row_count, 2);
});

test('a source is failed, with its first failure, only when every level it was asked for failed', async t => {
  const e = reportEngine(t, {rowsFor, fail: failing('campaign', 'adset', 'ad')});
  const {report} = await e.go();
  const source = report.sources[0];
  assert.equal(report.state, 'failed');
  assert.equal(source.error.code, 'PLATFORM_ERROR');
  assert.deepEqual(
    source.failed_levels.map(level => level.level),
    ['campaign', 'adset', 'ad'],
  );
});

test('a field a packet carries is not promoted to its source: the source states its named facts only', async t => {
  const e = reportEngine(t, {rowsFor, packet: {unnamed_future_field: 'x'}});
  const {report} = await e.go();
  const source = report.sources[0];
  assert.equal(source.unnamed_future_field, undefined);
  assert.equal(report.sources[0].level_results[0].unnamed_future_field, 'x', 'the level keeps what it collected');
});

test('a comparison with a failed level says the level failed and names the failure, not a window problem', async t => {
  const e = reportEngine(t, {rowsFor, fail: failing('ad')});
  const {report} = await e.go();
  const byPair = Object.groupBy(
    report.sources[0].cross_level,
    item => item.baseline.level + '>' + item.comparison.level,
  );
  assert.deepEqual(Object.keys(byPair), ['campaign>adset', 'adset>ad']);
  for (const item of byPair['adset>ad']) {
    assert.equal(item.state, 'unavailable');
    assert.equal(item.unavailable_reason, 'level_failed');
    assert.deepEqual(item.failed_levels, [{level: 'ad', code: 'PLATFORM_ERROR'}]);
  }
  assert.ok(
    byPair['campaign>adset'].every(item => item.state === 'agree'),
    'the levels that collected still agree',
  );
  const campaignFailed = await reportEngine(t, {rowsFor, fail: failing('campaign')}).go();
  const reasons = campaignFailed.report.sources[0].cross_level.filter(item => item.baseline.level === 'campaign');
  assert.ok(reasons.every(item => item.unavailable_reason === 'level_failed'));
});

for (const locale of locales) {
  test(`the page draws a partial source with its failed level, and excludes only a wholly failed source (${locale})`, async t => {
    const e = reportEngine(t, {
      accounts: ['100', '200', '300'],
      rowsFor,
      // 100 loses its ad level, 200 every level, 300 only its campaign level.
      fail: source =>
        source.account_id === '200' ||
        (source.account_id === '100' && source.level === 'ad') ||
        (source.account_id === '300' && source.level === 'campaign')
          ? refused()
          : undefined,
    });
    const sources = ['100', '200', '300'].map(account_id => ({
      ...e.config.sources[0],
      account_id,
      levels: ['campaign', 'adset', 'ad'],
      report_options: {complete_window: true},
    }));
    const queued = await e.queue(['campaign'], {sources});
    await e.worker.once();
    const report = await e.overview.handle(
        {action: 'get', id: queued.id, limit: 500, include: {native: true}},
        e.actor,
      ),
      bootstrap = await e.overview.handle({action: 'bootstrap'}, e.actor),
      view = reportPage(locale, bootstrap);
    assert.equal(report.state, 'partial');
    const [partial, failed, campaignLost] = report.sources;
    assert.equal(partial.error, undefined);
    assert.equal(failed.error.code, 'PLATFORM_ERROR');
    const excludes = plainText(view.call('reportSummaryExcludes(report)', {report}));
    assert.match(excludes, /200/, 'the wholly failed account is named');
    assert.doesNotMatch(excludes, /100|300/, 'an account that only lost a level keeps its rows in the totals');
    const platforms = bootstrap.platforms;
    const card = (source, index) =>
      plainText(
        view.call('renderReportSourceHealth(source, platforms, index, range, report)', {
          source,
          platforms,
          index,
          range: report.config.date_range,
          report,
        }),
      );
    const partialCard = card(partial, 0),
      failedCard = card(failed, 1),
      named = view
        .text('These levels could not be collected: {levels}.')
        .replace('{levels}', view.call("reportLevelName('meta', 'ad')"));
    assert.ok(partialCard.includes(named), partialCard);
    assert.match(partialCard, /PLATFORM_ERROR/, 'the failed level carries its own error');
    assert.doesNotMatch(partialCard, new RegExp(view.text('Source failed')));
    assert.match(failedCard, new RegExp(view.text('Source failed')));
    assert.ok(!failedCard.includes(named), 'a failed source shows its error, not a list of levels');
    const lostCard = card(campaignLost, 2);
    assert.match(lostCard, /PLATFORM_ERROR/);
    assert.doesNotMatch(lostCard, new RegExp(view.text('Source failed')));
  });
}
