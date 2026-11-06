import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCollectionRequests} from '../dist/src/report-request-estimate.js';
import {snapchatAccount, campaignOf, squadOf} from './helpers/snapchat-account.mjs';

// V2-RPT-07 / F-L7-01. The v4 Snapchat ad-squad level reads every campaign of the account. Before, each campaign cost eight
// provider requests (two account reads, two campaign reads, a scan of the campaign list, two by-ID parent reads and the
// stats), so an account of 144 campaigns used the whole 1,200 request allowance and 150 failed with no rows at all.
const stats = a => a.count(/\/stats$/),
  byIds = a => a.count(/_by_ids$/),
  campaignReads = a => a.count(/^\/v1\/campaigns\/[^/]+$/),
  accountReads = a => a.count(/^\/v1\/adaccounts\/[^/]+$/),
  lists = a => a.count(/\/adaccounts\/[^/]+\/campaigns$/);

test('200 campaigns fit the request allowance at one stats request each, plus a handful', async t => {
  const a = snapchatAccount({campaigns: 200});
  t.after(() => a.close());
  const {report} = await a.run();
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 200);
  assert.equal(stats(a), 200, 'one stats request per campaign');
  assert.equal(campaignReads(a), 0, 'the population proved each campaign, so none is read again');
  assert.equal(lists(a), 2, 'the population is two pages of 100');
  assert.ok(byIds(a) <= 8, 'parents are read in batches across campaigns, not per campaign: ' + byIds(a));
  assert.ok(
    accountReads(a) <= 3,
    'the account is read before and after, not around every campaign: ' + accountReads(a),
  );
  assert.ok(a.f.requests.length <= 200 + 16, 'about one request per campaign: ' + a.f.requests.length);
  const population = report.sources[0].quality.population;
  assert.equal(population.campaigns_observed, 200);
  assert.equal(population.campaigns_selected, 200);
  assert.equal(population.campaigns_collected, 200);
  assert.equal(population.complete, true);
  assert.equal(population.collection_complete, true);
});

test('a weekly grain over 40 campaigns lists the population once and reads each campaign once a week', async t => {
  const a = snapchatAccount({campaigns: 40});
  t.after(() => a.close());
  const {report} = await a.run({grain: 'weekly', range: {since: '2026-09-01', until: '2026-09-28'}});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 5 * 40, 'five calendar weeks of 40 ad squads');
  assert.equal(stats(a), 5 * 40);
  assert.equal(lists(a), 1, 'the proven population is kept for the job, so later weeks do not list it again');
  assert.equal(campaignReads(a), 0);
  assert.ok(a.f.requests.length <= 5 * 40 + 5 * 8, 'a handful beyond the stats: ' + a.f.requests.length);
});

test('an account of 1,300 campaigns ends partial with the campaigns it read, never failed and never complete', async t => {
  const a = snapchatAccount({campaigns: 1300});
  t.after(() => a.close());
  const {report} = await a.run();
  assert.equal(report.state, 'partial', JSON.stringify(report.sources));
  const source = report.sources[0];
  assert.equal(source.error, undefined);
  assert.equal(source.complete, false);
  const population = source.quality.population;
  assert.equal(population.campaigns_observed, 1300);
  assert.equal(population.campaigns_selected, 1300);
  assert.ok(
    population.campaigns_collected > 1000 && population.campaigns_collected < 1300,
    population.campaigns_collected,
  );
  assert.equal(population.complete, true, 'the population itself is proven');
  assert.equal(population.collection_complete, false);
  assert.equal(
    source.row_count,
    population.campaigns_collected,
    'one squad each, and no row of a campaign that was not read',
  );
  const rows = await a.rows(report.id);
  assert.equal(rows.length, population.campaigns_collected);
  const reason = source.warnings.find(message => / of 1300 campaigns read/.test(message));
  assert.ok(reason, JSON.stringify(source.warnings));
  assert.ok(reason.startsWith(population.campaigns_collected + ' of 1300 campaigns read'), reason);
  assert.match(reason, /campaign IDs/, 'it tells the user to scope by campaign IDs');
  assert.ok(a.f.requests.length <= 1200, 'the allowance is never exceeded: ' + a.f.requests.length);
  assert.ok(accountReads(a) >= 2, 'the account is read again at the end, inside the allowance');
  // The goal comes from the by-ID read of the squad, so every kept row has its result, beyond the first thousand too.
  assert.ok(
    rows.every(row => row.result.value !== null),
    'a squad past the first 1,000 still has its goal and result',
  );
});

test('the queue-time estimate follows the campaigns a scope names, and an unscoped estimate says it is a lower bound', async t => {
  const a = snapchatAccount({campaigns: 60});
  t.after(() => a.close());
  const scope = Array.from({length: 5}, (_, i) => campaignOf(i * 7)),
    scoped = await a.run({campaign_ids: scope});
  assert.equal(scoped.report.state, 'complete', JSON.stringify(scoped.report.sources));
  assert.equal(scoped.report.rows.length, 5);
  const actual = a.f.requests.length;
  assert.ok(
    scoped.queued.estimated_requests >= actual / 2,
    `estimate ${scoped.queued.estimated_requests} for ${actual}`,
  );
  assert.ok(
    scoped.queued.estimated_requests <= actual * 2,
    `estimate ${scoped.queued.estimated_requests} for ${actual}`,
  );
  const entry = estimateCollectionRequests(scoped.report.config).sources.find(source => source.platform === 'snapchat');
  assert.equal(entry.lower_bound, undefined, 'a scoped estimate is not a lower bound');
  // Unscoped: the account's size is unknown until the list is read, so the estimate is a lower bound and says so; the
  // figure after the population read is recorded.
  const before = a.f.requests.length,
    unscoped = await a.run();
  assert.equal(unscoped.report.state, 'complete', JSON.stringify(unscoped.report.sources));
  const unscopedEntry = estimateCollectionRequests(unscoped.report.config).sources.find(
    source => source.platform === 'snapchat',
  );
  assert.equal(unscopedEntry.lower_bound, true);
  const used = a.f.requests.length - before - 1; // the account read before collection is counted apart
  const population = unscoped.report.sources[0].quality.population;
  assert.ok(
    Math.abs(population.requests_estimated - used) <= 2,
    `re-estimated ${population.requests_estimated}, used ${used}`,
  );
  assert.ok(unscoped.queued.estimated_requests < used, 'the queue-time figure is below the real one, as flagged');
});

test('deleted campaigns the list shows are skipped when the statuses cannot select archived rows', async t => {
  const a = snapchatAccount({campaigns: 10, deleted: i => i % 3 === 0});
  t.after(() => a.close());
  const live = await a.run({statuses: ['active', 'paused']});
  assert.equal(live.report.state, 'complete', JSON.stringify(live.report.sources));
  assert.equal(stats(a), 6, 'the four deleted campaigns are not read');
  assert.equal(live.report.rows.length, 6);
  const population = live.report.sources[0].quality.population;
  assert.equal(population.campaigns_observed, 10);
  assert.equal(population.campaigns_selected, 6);
  assert.equal(population.campaigns_skipped_deleted, 4);
  const before = stats(a),
    everything = await a.run();
  assert.equal(stats(a) - before, 10, 'with every status, deleted campaigns are read');
  assert.equal(everything.report.rows.length, 10);
  assert.equal(everything.report.rows.filter(row => row.status === 'archived').length, 4);
  const archived = stats(a),
    only = await a.run({statuses: ['archived']});
  assert.equal(stats(a) - archived, 10, 'archived rows can be in a live campaign, so none is skipped');
  assert.equal(only.report.rows.length, 4);
});

test('a campaign’s status never prunes the population: an active ad squad of a paused campaign keeps its row', async t => {
  const a = snapchatAccount({campaigns: 4, status: i => (i % 2 ? 'PAUSED' : 'ACTIVE')});
  t.after(() => a.close());
  const {report} = await a.run({statuses: ['active']});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(stats(a), 4, 'the ad squad’s own status, not its campaign’s, decides');
  assert.equal(report.rows.length, 4);
  assert.ok(report.rows.every(row => row.status === 'active'));
});

test('ad squad rows are named from the by-ID read, and a campaign scope that matches nothing is counted and warned about', async t => {
  const a = snapchatAccount({campaigns: 3});
  t.after(() => a.close());
  const ghost = 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    {report} = await a.run({campaign_ids: [campaignOf(1), ghost]});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.rows.map(row => [row.entity_id, row.entity_name]),
    [[squadOf(1), 'Squad 1-0']],
  );
  const source = report.sources[0];
  assert.deepEqual(source.quality.population.unmatched, {campaign_ids: [ghost]});
  assert.equal(source.quality.population.unmatched_count, 1);
  assert.ok(source.warnings.includes('1 requested ID matched no entity in this account.'));
  const none = await a.run({campaign_ids: [ghost]});
  assert.equal(none.report.state, 'complete', JSON.stringify(none.report.sources));
  assert.equal(none.report.rows.length, 0);
  assert.ok(none.report.sources[0].warnings.includes('1 requested ID matched no entity in this account.'));
});

// F-L7-13: Snapchat's stats are daily, so a window of any length is read in spans of at most 31 days and the rows add.
test('a 40-day window is read in two spans at the ad squad level and its daily rows add exactly', async t => {
  const a = snapchatAccount({campaigns: 3});
  t.after(() => a.close());
  const {report} = await a.run({range: {since: '2026-08-01', until: '2026-09-09'}});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(stats(a), 3 * 2, 'two spans of at most 31 days for each campaign');
  const spans = a.f.requests
    .filter(request => /\/stats$/.test(request.url.pathname))
    .map(request => request.url.searchParams.get('start_time') + '/' + request.url.searchParams.get('end_time'));
  assert.deepEqual([...new Set(spans)].sort(), [
    '2026-07-31T21:00:00.000Z/2026-08-31T21:00:00.000Z',
    '2026-08-31T21:00:00.000Z/2026-09-09T21:00:00.000Z',
  ]);
  assert.equal(report.rows.length, 3);
  for (const row of report.rows) {
    assert.equal(row.native.daily_rows.length, 40);
    // Each day is 10.123456 spend, 1,000 impressions, 30 swipes and 2 purchases for the synthetic squad.
    assert.equal(row.native.exact_totals.impressions, '40000');
    assert.equal(row.native.exact_totals.spend, '404.93824');
    assert.equal(row.native.exact_totals.conversions, '80');
  }
});

test('a 40-day window is read in two spans at the ad level too', async t => {
  const a = snapchatAccount({campaigns: 3});
  t.after(() => a.close());
  const {report} = await a.run({
    range: {since: '2026-08-01', until: '2026-09-09'},
    levels: ['ad'],
  });
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(a.count(/\/adaccounts\/[^/]+\/stats$/), 2, 'two spans of the account stats');
  assert.equal(report.rows.length, 3);
  for (const row of report.rows) {
    assert.equal(row.native.daily_rows.length, 40);
    assert.equal(row.native.exact_totals.impressions, '40000');
  }
});
