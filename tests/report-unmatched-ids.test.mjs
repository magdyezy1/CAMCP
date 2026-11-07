import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewV4Scope} from '../dist/src/overview-v4.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {locales, plainText, reportPage} from './helpers/report-page.mjs';

// A selected ID that matched nothing is named (F-L5-27): a mistyped or stale ID narrows a total, and the reader has to
// be able to tell. The levels answer for the lists they can: an ad ID is matched by ad rows alone.
const capabilities = {delivery_metrics: ['spend', 'impressions', 'clicks'], status_basis: 'current_configuration'};
const scoped = (source, rows) =>
  overviewV4Scope({statuses: ['all'], delivered_only: false, ...source}, rows, capabilities);
const parents = (campaign, adset) => ({parent_ids: {campaign_id: campaign, adset_id: adset}});

test('a level names the selected IDs none of its rows carries, for the lists it can answer', () => {
  const ads = [row('ad', 'a1', {}, parents('c1', 's1')), row('ad', 'a2', {}, parents('c1', 's1'))];
  const result = scoped({level: 'ad', ad_ids: ['a1', 'mistyped'], adset_ids: ['s1', 's9'], campaign_ids: ['c1']}, ads);
  assert.deepEqual(result.scope.unmatched_ids, {adset_ids: ['s9'], ad_ids: ['mistyped']});
  assert.equal(result.rows.length, 1, 'the selection itself is unchanged');
  // A campaign row cannot answer for ad IDs, so it never calls them unmatched.
  const campaign = scoped({level: 'campaign', ad_ids: ['a1'], campaign_ids: ['c1', 'c9']}, [row('campaign', 'c1')]);
  assert.deepEqual(campaign.scope.unmatched_ids, {campaign_ids: ['c9']});
  assert.equal(scoped({level: 'campaign', ad_ids: ['a1']}, [row('campaign', 'c1')]).scope.unmatched_ids, undefined);
  assert.equal(scoped({level: 'ad'}, ads).scope.unmatched_ids, undefined, 'no selection, nothing to match');
  assert.deepEqual(scoped({level: 'ad', ad_ids: ['a1']}, []).scope.unmatched_ids, {ad_ids: ['a1']}, 'no rows at all');
});

test('an ID that exists is matched even when its row is excluded for another reason', () => {
  const paused = row('ad', 'a1', {}, {...parents('c1', 's1'), status: 'paused'}),
    result = scoped({level: 'ad', ad_ids: ['a1'], statuses: ['active']}, [paused]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.scope.excluded_status_rows, 1);
  assert.equal(result.scope.unmatched_ids, undefined, 'the ad was returned; a status filter took it out');
  const idle = row('ad', 'a1', {spend: '0', impressions: '0', clicks: '0'}, {...parents('c1', 's1'), native: {}});
  assert.equal(scoped({level: 'ad', ad_ids: ['a1'], delivered_only: true}, [idle]).scope.unmatched_ids, undefined);
});

const rowsFor = level =>
  level === 'campaign'
    ? [row('campaign', 'c1', {spend: '100'}), row('campaign', 'c2', {spend: '5'})]
    : level === 'ad'
      ? [row('ad', 'a1', {spend: '60'}, parents('c1', 's1')), row('ad', 'a2', {spend: '40'}, parents('c1', 's1'))]
      : [];

test('the audit’s mistyped ad ID is listed on the level that measures it, on the source and in a warning', async t => {
  const e = reportEngine(t, {rowsFor});
  const {report, stored} = await e.go(['campaign', 'ad'], {}, {ad_ids: ['a1', 'mistyped-id']});
  assert.equal(report.state, 'complete', 'the selection still runs: the reader is told, nothing is refused');
  assert.deepEqual(
    report.rows.map(r => [r.level, r.metrics.spend, r.aggregation?.label ?? null]),
    [
      ['campaign', '60', 'Rolled up from selected ads'],
      ['ad', '60', null],
    ],
  );
  const source = report.sources[0];
  assert.deepEqual(source.unmatched_ids, {ad_ids: ['mistyped-id']});
  assert.ok(source.warnings.includes('1 selected ID matched no returned row.'), JSON.stringify(source.warnings));
  const levels = Object.fromEntries(source.level_results.map(l => [l.level, l.scope.unmatched_ids]));
  assert.deepEqual(levels.ad, {ad_ids: ['mistyped-id']});
  assert.equal(levels.campaign, undefined, 'a rolled-up campaign level cannot answer for ad IDs');
  assert.ok(JSON.stringify(stored.sources).includes('mistyped-id'));
});

test('an ID that some level found is not unmatched: only an ID no answering level carries is', async t => {
  const e = reportEngine(t, {rowsFor});
  // c2 is a real campaign with no ad in the selection or in the data; c9 does not exist anywhere.
  const {report} = await e.go(['campaign', 'ad'], {}, {campaign_ids: ['c1', 'c2', 'c9']});
  assert.deepEqual(report.sources[0].unmatched_ids, {campaign_ids: ['c9']});
  assert.ok(report.sources[0].warnings.includes('1 selected ID matched no returned row.'));
});

test('a source with every selected ID matched carries no unmatched IDs and no warning', async t => {
  const e = reportEngine(t, {rowsFor});
  const {report} = await e.go(['campaign', 'ad'], {}, {ad_ids: ['a1', 'a2'], campaign_ids: ['c1']});
  assert.equal(report.sources[0].unmatched_ids, undefined);
  assert.deepEqual(
    report.sources[0].warnings.filter(w => /selected ID/.test(w)),
    [],
  );
});

for (const locale of locales) {
  test(`the source card says how many selected IDs matched nothing, and which (${locale})`, async t => {
    const e = reportEngine(t, {rowsFor});
    const queued = await e.queue(['campaign', 'ad'], {}, {ad_ids: ['a1', 'mistyped-id', 'stale-id']});
    await e.worker.once();
    const report = await e.overview.handle(
        {action: 'get', id: queued.id, limit: 500, include: {native: true}},
        e.actor,
      ),
      bootstrap = await e.overview.handle({action: 'bootstrap'}, e.actor),
      view = reportPage(locale, bootstrap),
      card = plainText(
        view.call('renderReportSourceHealth(source, platforms, 0, range, report)', {
          source: report.sources[0],
          platforms: bootstrap.platforms,
          range: report.config.date_range,
          report,
        }),
      );
    const label = view.call("uiText('Selected IDs that matched no returned row ({count}):', {count: uiNumber(2)})");
    assert.ok(card.includes(label), card);
    assert.match(card, /mistyped-id/);
    assert.match(card, /stale-id/);
    assert.doesNotMatch(card, /a1/, 'an ID that matched is not listed');
    assert.ok(
      !card.includes(view.call("uiSourceWarning('2 selected IDs matched no returned row.')")),
      'the server sentence is not repeated beside the line that shows the IDs',
    );
  });
}
