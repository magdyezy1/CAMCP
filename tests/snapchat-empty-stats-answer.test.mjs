import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {snapchatEvidenceAccount, snapchatEvidenceId as id} from './fixtures/snapchat-evidence-data.mjs';
import {providerDataAction} from '../dist/src/errors.js';
import {providerRemedy} from '../dist/src/provider-remedies.js';

// Package r12-fix, item 1 (V2-RPT-07; O-4 of the live checks of 2026-11-16). The all-campaign ad squad read of an account
// with a campaign that did not deliver in the window failed as a whole with REPORT_DATE_MISMATCH. For such a campaign
// Snapchat's stats answer has no ad squads and leaves out finalized_data_end_time and conversion_data_processed_end_time,
// and the collector demanded both before it looked at the entity list. An answer with no ad squads may now omit them and
// counts as that campaign having no rows; an answer with rows still needs both, with an offset. Every shape below is
// synthetic and follows the live answer: offsets are -07:00 (US daylight saving time began on 2023-03-12, the day before
// the window opens), the two finalization times are UTC, and the account's own midnights bound the window.
const window = {since: '2023-03-13', until: '2023-04-08'},
  zone = 'America/Los_Angeles',
  account = snapchatEvidenceAccount;
const addDays = (date, count) => new Date(Date.parse(date) + count * 86400000).toISOString().slice(0, 10);
const days = Array.from({length: 27}, (_, index) => addDays(window.since, index));
const local = (date, offset = '-07:00') => date + 'T00:00:00.000' + offset;
const campaignIds = [id(501), id(502), id(503)];
/** The two ad squads of campaign `index`, when it delivers. */
const squadIdsOf = index => [id(600 + index * 2 + 1), id(600 + index * 2 + 2)];
const campaigns = campaignIds.map((campaignId, index) => ({
  id: campaignId,
  ad_account_id: account,
  name: 'Synthetic campaign ' + index,
  status: 'ACTIVE',
  objective: 'WEB_CONVERSION',
}));
const squad = (squadId, offset) => ({
  id: squadId,
  type: 'AD_SQUAD',
  granularity: 'DAY',
  start_time: local(days[0], offset),
  end_time: local(addDays(days.at(-1), 1), offset),
  timeseries: days.map(date => ({
    start_time: local(date, offset),
    end_time: local(addDays(date, 1), offset),
    stats: {spend: '10123456', impressions: 1000, swipes: 30, conversion_purchases: 2},
  })),
});
/**
 * One campaign's daily stats answer by ad squad, as Snapchat sends it when there are rows. `entities` empty is the answer
 * of a campaign that did not deliver, which `plain` below leaves the two finalization times out of (the key is absent, not null).
 */
function statsAnswer(url, campaignId, entities) {
  return {
    request_status: 'SUCCESS',
    request_id: 'synthetic-stats',
    paging: {},
    timeseries_stats: [
      {
        sub_request_status: 'SUCCESS',
        timeseries_stat: {
          id: campaignId,
          type: 'CAMPAIGN',
          granularity: 'DAY',
          start_time: local(days[0]),
          end_time: local(addDays(days.at(-1), 1)),
          swipe_up_attribution_window: url.searchParams.get('swipe_up_attribution_window'),
          view_attribution_window: url.searchParams.get('view_attribution_window'),
          finalized_data_end_time: '2026-11-15T23:00:00.000Z',
          conversion_data_processed_end_time: '2026-11-15T00:00:00.000Z',
          breakdown_stats: {adsquad: entities},
          split_results: [],
        },
      },
    ],
  };
}
/** The live shape of every answer: the two finalization times only where there are ad squads. */
function plain(url, index, entities) {
  const answer = statsAnswer(url, campaignIds[index], entities);
  if (!entities.length) {
    delete answer.timeseries_stats[0].timeseries_stat.finalized_data_end_time;
    delete answer.timeseries_stats[0].timeseries_stat.conversion_data_processed_end_time;
  }
  return answer;
}
/** `plain`, with `change(stat, answer, url)` applied to the answer of campaign `at` alone. */
const changed = (at, change) => (url, index, entities) => {
  const answer = plain(url, index, entities);
  if (index === at) change(answer.timeseries_stats[0].timeseries_stat, answer, url);
  return answer;
};

/**
 * The three-campaign account of the live run: the campaign(s) in `delivering` have two ad squads each, the others have none
 * in the window. `answer(url, index, entities)` builds the answer of campaign `index` (the live shape by default).
 */
function fixture(t, {delivering = 0, answer = plain} = {}) {
  const f = overviewGranularityFixture(),
    delivers = new Set([delivering].flat()),
    ownerOf = new Map([...delivers].flatMap(index => squadIdsOf(index).map(squadId => [squadId, campaignIds[index]])));
  t.after(() => f.close());
  f.parents((_platform, _url, body) => {
    for (const entry of body.adsquads ?? [])
      Object.assign(entry.adsquad, {
        campaign_id: ownerOf.get(entry.adsquad.id),
        status: 'ACTIVE',
        optimization_goal: 'PIXEL_PURCHASE',
      });
    for (const entry of body.campaigns ?? [])
      Object.assign(
        entry.campaign,
        campaigns.find(campaign => campaign.id === entry.campaign.id),
      );
    return body;
  });
  f.hook(url => {
    if (url.hostname !== 'adsapi.snapchat.com') throw Error('Unexpected synthetic host');
    if (url.pathname.endsWith('_by_ids')) return undefined;
    if (url.pathname === '/v1/adaccounts/' + account)
      return Response.json({
        request_status: 'SUCCESS',
        adaccounts: [{sub_request_status: 'SUCCESS', adaccount: {id: account, currency: 'USD', timezone: zone}}],
      });
    if (url.pathname === '/v1/adaccounts/' + account + '/campaigns')
      return Response.json({
        request_status: 'SUCCESS',
        campaigns: campaigns.map(campaign => ({sub_request_status: 'SUCCESS', campaign})),
        paging: {},
      });
    const stats = /^\/v1\/campaigns\/([^/]+)\/stats$/.exec(url.pathname);
    assert.ok(stats, 'Unexpected synthetic Snapchat path: ' + url.pathname);
    const index = campaignIds.indexOf(stats[1]);
    assert.ok(index >= 0);
    const entities = delivers.has(index) ? squadIdsOf(index).map(squadId => squad(squadId)) : [];
    return Response.json(answer(url, index, entities));
  });
  const {campaign_id, ...source} = granularSource('snapchat', 'adset');
  // The window, levels and options of the live run: all campaigns, the 28-day swipe and 1-day view windows.
  const config = {
    ...granularConfig({
      ...source,
      levels: ['adset'],
      report_options: {complete_window: true, swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'},
    }),
    contract_version: 'overview-config-v4',
    date_range: window,
  };
  const run = async () => {
    const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
    assert.equal(await f.worker.once(), true);
    return f.overview.handle({action: 'get', id: queued.id, include: {native: true, lineage: true}}, f.actor);
  };
  const statsReads = campaignId =>
    f.requests.filter(request => request.url.pathname === '/v1/campaigns/' + campaignId + '/stats').length;
  /** Campaigns are read in list order, so a refusal by campaign `last` means every campaign before it passed. */
  const readThrough = last =>
    campaignIds.forEach((campaignId, index) =>
      assert.equal(statsReads(campaignId), index <= last ? 1 : 0, 'stats reads of campaign ' + index),
    );
  return {...f, run, statsReads, readThrough};
}
const refusal = report => {
  assert.equal(report.state, 'failed', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 0);
  return report.sources[0].error;
};

for (const delivering of [0, 1, 2])
  test(
    'a Snapchat all-campaign ad squad report completes when the campaigns without delivery leave out the finalization times (campaign ' +
      (delivering + 1) +
      ' of 3 delivers)',
    async t => {
      const f = fixture(t, {delivering}),
        report = await f.run();
      assert.equal(report.state, 'complete', JSON.stringify(report.sources));
      // The delivering campaign's ad squads and nothing from the other two: they contribute no data, and no refusal.
      assert.deepEqual(report.rows.map(row => row.entity_id).sort(), squadIdsOf(delivering).sort());
      for (const row of report.rows) {
        assert.equal(row.parent_ids.campaign_id, campaignIds[delivering]);
        assert.equal(row.metrics.spend, '273.333312', 'exactly 27 days of 10.123456');
        assert.equal(row.metrics.impressions, '27000');
      }
      const population = report.sources[0].quality.population;
      assert.equal(population.campaigns_observed, 3);
      assert.equal(population.campaigns_collected, 3);
      assert.equal(population.collection_complete, true);
      // Each campaign's stats were read once: a campaign without rows was neither skipped nor read again.
      f.readThrough(2);
    },
  );

test('the DST window of the live run (2023-03-13 to 2023-04-08, -07:00 all through) passes when every answer has rows', async t => {
  // US daylight saving time began on 2023-03-12: the window opens on the first PDT midnight. Neither the window nor its
  // offsets is what failed the live run, and an answer with rows in this window was never refused.
  const f = fixture(t, {delivering: [0, 1, 2]}),
    report = await f.run();
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(report.rows.map(row => row.entity_id).sort(), [0, 1, 2].flatMap(squadIdsOf).sort());
  f.readThrough(2);
});

test('the same window with the previous standard-time offset is still refused as a different window', async t => {
  // The twin of the test above: an hour off at the boundaries of the window is another window, so the offset check is real.
  const f = fixture(t, {
      answer: changed(0, (stat, _answer) => {
        stat.start_time = local(days[0], '-08:00');
        stat.end_time = local(addDays(days.at(-1), 1), '-08:00');
      }),
    }),
    error = refusal(await f.run());
  assert.equal(error.code, 'REPORT_DATE_MISMATCH');
  assert.match(error.message, /different reporting window or grain/);
  f.readThrough(0);
});

// An answer with ad squads keeps both finalization times, each with an offset. The delivering campaign is the last of the
// three, so the two empty campaigns before it are read and pass, and the refusal can only come from the answer with rows.
for (const [label, change, code, message] of [
  [
    'finalized_data_end_time is missing',
    stat => delete stat.finalized_data_end_time,
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'conversion_data_processed_end_time is missing',
    stat => delete stat.conversion_data_processed_end_time,
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'finalized_data_end_time has no offset',
    stat => (stat.finalized_data_end_time = '2026-11-15T23:00:00'),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'conversion_data_processed_end_time has no offset',
    stat => (stat.conversion_data_processed_end_time = '2026-11-15T00:00:00'),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'finalized_data_end_time is null',
    stat => (stat.finalized_data_end_time = null),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'finalized_data_end_time is an impossible date',
    stat => (stat.finalized_data_end_time = '2026-02-30T00:00:00.000Z'),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'an ad squad start_time has no offset',
    stat => (stat.breakdown_stats.adsquad[0].start_time = '2023-03-13T00:00:00.000'),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'a daily row end_time has no offset',
    stat => (stat.breakdown_stats.adsquad[0].timeseries[3].end_time = '2023-03-17T00:00:00.000'),
    'REPORT_DATE_MISMATCH',
    /invalid native report timestamp/,
  ],
  [
    'finalized_data_end_time is before the end of the window',
    stat => (stat.finalized_data_end_time = '2023-04-01T00:00:00.000Z'),
    'REPORT_INCOMPLETE',
    /has not finalized non-conversion metrics/,
  ],
])
  test('a Snapchat answer with ad squads is still refused when ' + label, async t => {
    const f = fixture(t, {delivering: 2, answer: changed(2, change)}),
      error = refusal(await f.run());
    assert.equal(error.code, code);
    assert.match(error.message, message);
    f.readThrough(2);
  });

// Only the absence of a time is newly accepted, and only where there are no ad squads: a time that an empty answer does
// carry is checked as ever. The second of the three campaigns is the one that carries it, so the first (a plain empty answer)
// must pass before it is refused.
for (const [label, stat, code] of [
  [
    'a finalized_data_end_time without an offset',
    {finalized_data_end_time: '2026-11-15T23:00:00'},
    'REPORT_DATE_MISMATCH',
  ],
  ['a finalized_data_end_time that is null', {finalized_data_end_time: null}, 'REPORT_DATE_MISMATCH'],
  [
    'a finalized_data_end_time before the window ends',
    {finalized_data_end_time: '2023-04-01T00:00:00.000Z'},
    'REPORT_INCOMPLETE',
  ],
  [
    'a conversion_data_processed_end_time before the window ends',
    {conversion_data_processed_end_time: '2023-04-01T00:00:00.000Z'},
    'REPORT_INCOMPLETE',
  ],
  [
    'a conversion_data_processed_end_time that is not a date',
    {conversion_data_processed_end_time: 'yesterday'},
    'REPORT_DATE_MISMATCH',
  ],
])
  test('an empty Snapchat answer that carries ' + label + ' is still refused', async t => {
    const f = fixture(t, {delivering: 2, answer: changed(1, existing => Object.assign(existing, stat))}),
      error = refusal(await f.run());
    assert.equal(error.code, code);
    f.readThrough(1);
  });

// What an empty answer may leave out is the two finalization times and nothing else: it still names the requested campaign and
// the requested window, so it proves what it is an answer for.
for (const [label, stat, code] of [
  ['another window', {start_time: local('2023-03-14')}, 'REPORT_DATE_MISMATCH'],
  ['another campaign', {id: campaignIds[0]}, 'REPORT_ACCOUNT_MISMATCH'],
])
  test('an empty Snapchat answer that is for ' + label + ' is still refused', async t => {
    const f = fixture(t, {delivering: 2, answer: changed(1, existing => Object.assign(existing, stat))}),
      error = refusal(await f.run());
    assert.equal(error.code, code);
    f.readThrough(1);
  });

test('an empty Snapchat answer that continues on another page is not taken for a campaign without rows', async t => {
  const f = fixture(t, {
      delivering: 2,
      answer: changed(1, (_stat, answer, url) => {
        const next = new URL(url);
        next.searchParams.set('cursor', '200');
        answer.paging = {next_link: next.href};
      }),
    }),
    error = refusal(await f.run());
  assert.equal(error.code, 'REPORT_INCOMPLETE');
  assert.match(error.message, /continuation is empty, repeats or exceeds/);
  f.readThrough(1);
});

// Package r12-fix, item 3 (V2-RPT-05; error 1 of the live checks of 2026-11-16): the source error the Overview keeps names the
// timestamp that failed (a closed set), and its next action is that timestamp's remedy, which says a retry returns the same
// answer. A refusal that names no timestamp keeps the shared retry advice.
for (const [label, change, field] of [
  ['finalized_data_end_time is missing', stat => delete stat.finalized_data_end_time, 'finalized_data_end_time'],
  [
    'conversion_data_processed_end_time is missing',
    stat => delete stat.conversion_data_processed_end_time,
    'conversion_data_processed_end_time',
  ],
  [
    'an ad squad start_time has no offset',
    stat => (stat.breakdown_stats.adsquad[0].start_time = '2023-03-13T00:00:00.000'),
    'start_time',
  ],
  [
    'a daily row end_time has no offset',
    stat => (stat.breakdown_stats.adsquad[0].timeseries[3].end_time = '2023-03-17T00:00:00.000'),
    'end_time',
  ],
])
  test('the Overview names the timestamp that failed, and says what to do, when ' + label, async t => {
    const f = fixture(t, {delivering: 2, answer: changed(2, change)}),
      error = refusal(await f.run());
    assert.equal(error.code, 'REPORT_DATE_MISMATCH');
    assert.equal(error.timestamp_field, field);
    const remedy = providerRemedy('REPORT_DATE_MISMATCH', {timestamp_field: field});
    assert.ok(remedy, 'a remedy for ' + field);
    assert.equal(error.next_action, remedy.action);
    assert.notEqual(error.next_action, providerDataAction);
    assert.match(error.next_action, /Retrying the same report returns the same answer/);
  });

test('an empty Snapchat answer whose finalization time is not valid is named by it, like an answer with rows', async t => {
  const f = fixture(t, {
      delivering: 2,
      answer: changed(1, stat => Object.assign(stat, {finalized_data_end_time: '2026-11-15T23:00:00'})),
    }),
    error = refusal(await f.run());
  assert.equal(error.code, 'REPORT_DATE_MISMATCH');
  assert.equal(error.timestamp_field, 'finalized_data_end_time');
  assert.equal(
    error.next_action,
    providerRemedy('REPORT_DATE_MISMATCH', {timestamp_field: 'finalized_data_end_time'}).action,
  );
});

for (const [label, answer, code] of [
  [
    'a window that is not the requested one',
    changed(0, stat => (stat.start_time = local('2023-03-14'))),
    'REPORT_DATE_MISMATCH',
  ],
  [
    'finalization before the end of the window',
    changed(2, stat => (stat.finalized_data_end_time = '2023-04-01T00:00:00.000Z')),
    'REPORT_INCOMPLETE',
  ],
])
  test('the Overview names no timestamp for ' + label + ', and keeps the shared retry advice', async t => {
    const f = fixture(t, {delivering: 2, answer}),
      error = refusal(await f.run());
    assert.equal(error.code, code);
    assert.equal(error.timestamp_field, undefined);
    assert.equal(error.next_action, providerDataAction);
  });
