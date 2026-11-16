import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {snapchatEvidenceAccount as account, snapchatEvidenceId as id} from './fixtures/snapchat-evidence-data.mjs';

// Package r12-fix, the lead's ruling on item 1 (decision 2, recency, 2026-11-16). Item 1 accepted an answer with no ad squads
// that leaves out its finalization times as "no rows" (the live shape of a campaign that did not deliver). AMCP's rule is that
// unknown stays unknown, never zero, so such an answer is "no rows" only when the end of its window is covered by a
// finalization time from evidence in the same read: the earliest finalized_data_end_time (and conversion_data_processed_end_time)
// of the answers with ad squads in the same collection. Without that evidence the campaign is "unconfirmed": the report is
// partial, it counts them in quality.population.unconfirmed_empty_campaigns with a reason, and it shows no zero. A read that is
// only one answer (a scoped campaign, the account's ads) has no other answer to be judged by. The account lookups of these paths
// return the ad account, which carries no finalization time, so no provider request is added to find one.
// Every shape is synthetic and follows the live answers: -07:00 offsets (US daylight saving time began on 2023-03-12 and ends on
// 2023-11-05), finalization times in UTC, a campaign that did not deliver answers with no ad squads and no times.
const zone = 'America/Los_Angeles';
const addDays = (date, count) => new Date(Date.parse(date) + count * 86400000).toISOString().slice(0, 10);
const local = date => date + 'T00:00:00.000-07:00';
const iso = ms => new Date(ms).toISOString();
/** A window of closed days, cut into the spans of at most 31 days that the Overview reads it in. */
function windowOf(since, until) {
  const days = [];
  for (let day = since; day <= until; day = addDays(day, 1)) days.push(day);
  const spans = [];
  for (let at = 0; at < days.length; at += 31) spans.push(days.slice(at, at + 31));
  return {since, until, spans};
}
const shortWindow = windowOf('2023-03-13', '2023-04-08'),
  longWindow = windowOf('2023-03-13', '2023-05-07');
/** The instant at which a span closes: the midnight after its last day, in the account's zone. */
const closes = span => Date.parse(local(addDays(span.at(-1), 1)));
const squadIds = (campaign, span) => [id(1000 + campaign * 20 + span * 2 + 1), id(1000 + campaign * 20 + span * 2 + 2)];
const entity = (level, entityId, span) => ({
  id: entityId,
  type: level === 'adsquad' ? 'AD_SQUAD' : level.toUpperCase(),
  granularity: 'DAY',
  start_time: local(span[0]),
  end_time: local(addDays(span.at(-1), 1)),
  timeseries: span.map(day => ({
    start_time: local(day),
    end_time: local(addDays(day, 1)),
    stats: {spend: '10123456', impressions: 1000, swipes: 30, conversion_purchases: 2},
  })),
});
/**
 * One stats answer. `ids` are the entities it holds (none: an answer for something that did not deliver), `finalized` the time
 * Snapchat states for them (left out when undefined, as Snapchat does for an empty answer), `conversion` the conversion time
 * (the same value by default; null leaves it out while the other is stated).
 */
function answer(url, parent, level, span, {ids = [], finalized, conversion} = {}) {
  const stat = {
    id: parent.id,
    type: parent.type,
    granularity: 'DAY',
    start_time: local(span[0]),
    end_time: local(addDays(span.at(-1), 1)),
    swipe_up_attribution_window: url.searchParams.get('swipe_up_attribution_window'),
    view_attribution_window: url.searchParams.get('view_attribution_window'),
    breakdown_stats: {[level]: ids.map(entityId => entity(level, entityId, span))},
    split_results: [],
  };
  if (finalized !== undefined) stat.finalized_data_end_time = finalized;
  if (finalized !== undefined && conversion !== null) stat.conversion_data_processed_end_time = conversion ?? finalized;
  return {
    request_status: 'SUCCESS',
    request_id: 'synthetic-stats',
    paging: {},
    timeseries_stats: [{sub_request_status: 'SUCCESS', timeseries_stat: stat}],
  };
}

/**
 * The account of the live run: `campaigns` campaigns, and `cell(campaign, span)` is what Snapchat answers for that campaign over
 * that span of the window ({} is the answer of a campaign that did not deliver: no ad squads and no times). `level` 'ad' reads
 * the account's ads instead, whose answers are the cells of campaign 0.
 */
function fixture(t, {range = shortWindow, campaigns = 3, cell = () => ({}), level = 'adset', scope} = {}) {
  const f = overviewGranularityFixture(),
    campaignIds = Array.from({length: campaigns}, (_, index) => id(501 + index)),
    list = campaignIds.map((campaignId, index) => ({
      id: campaignId,
      ad_account_id: account,
      name: 'Synthetic campaign ' + index,
      status: 'ACTIVE',
      objective: 'WEB_CONVERSION',
    })),
    owner = new Map();
  campaignIds.forEach((campaignId, index) =>
    range.spans.forEach((_, span) => {
      for (const entityId of cell(index, span).ids ?? []) owner.set(entityId, campaignId);
    }),
  );
  t.after(() => f.close());
  f.parents((_platform, _url, body) => {
    for (const entry of body.adsquads ?? [])
      if (owner.has(entry.adsquad.id))
        Object.assign(entry.adsquad, {
          campaign_id: owner.get(entry.adsquad.id),
          status: 'ACTIVE',
          optimization_goal: 'PIXEL_PURCHASE',
        });
    for (const entry of body.campaigns ?? [])
      Object.assign(
        entry.campaign,
        list.find(campaign => campaign.id === entry.campaign.id),
      );
    return body;
  });
  const spanOf = url =>
    range.spans.findIndex(span => url.searchParams.get('start_time') === iso(Date.parse(local(span[0]))));
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
        campaigns: list.map(campaign => ({sub_request_status: 'SUCCESS', campaign})),
        paging: {},
      });
    const one = /^\/v1\/campaigns\/([^/]+)$/.exec(url.pathname);
    if (one)
      return Response.json({
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'SUCCESS', campaign: list.find(campaign => campaign.id === one[1])}],
      });
    const stats = /^\/v1\/campaigns\/([^/]+)\/stats$/.exec(url.pathname);
    if (stats) {
      const index = campaignIds.indexOf(stats[1]),
        span = spanOf(url);
      assert.ok(index >= 0 && span >= 0);
      return Response.json(
        answer(url, {id: stats[1], type: 'CAMPAIGN'}, 'adsquad', range.spans[span], cell(index, span)),
      );
    }
    if (url.pathname === '/v1/adaccounts/' + account + '/stats') {
      const span = spanOf(url);
      assert.ok(span >= 0);
      return Response.json(
        answer(
          url,
          {id: account, type: 'AD_ACCOUNT'},
          url.searchParams.get('breakdown'),
          range.spans[span],
          cell(0, span),
        ),
      );
    }
    throw Error('Unexpected synthetic Snapchat path: ' + url.pathname);
  });
  // `scope` 'campaign_ids' names the first campaign in the v4 contract (the all-campaign read, narrowed to it); 'campaign_id' is the
  // legacy v3 scope, which reads that one campaign's answer alone and has no population to judge it by.
  const {campaign_id, ...base} = granularSource('snapchat', level),
    options = {complete_window: true, swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'};
  const config =
    scope === 'campaign_id'
      ? {
          ...granularConfig({...base, campaign_id: campaignIds[0], report_options: options}),
          date_range: {since: range.since, until: range.until},
        }
      : {
          ...granularConfig({
            ...base,
            ...(scope === 'campaign_ids' ? {campaign_ids: [campaignIds[0]]} : {}),
            levels: [level],
            report_options: options,
          }),
          contract_version: 'overview-config-v4',
          date_range: {since: range.since, until: range.until},
        };
  const run = async () => {
    const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
    assert.equal(await f.worker.once(), true);
    return f.overview.handle({action: 'get', id: queued.id, include: {native: true, lineage: true}}, f.actor);
  };
  const statsReads = () => f.requests.filter(request => /\/stats$/.test(request.url.pathname)).length;
  return {...f, run, statsReads, campaignIds};
}

const reason =
  /^For part of this source, Snapchat returned no rows and did not say that its data is final through the end of the window, so AMCP cannot tell no delivery from data Snapchat has not processed yet\. That part is left out and never counted as zero, so this source is partial\. Run the report again once Snapchat has finalized the window, or choose an earlier window\.$/;
const hasReason = source => source.warnings.some(warning => reason.test(warning));
/** What the source of a report says of the empty answers that nothing confirms. */
function assertUnconfirmed(report, count) {
  const source = report.sources[0],
    population = source.quality.population;
  assert.equal(report.state, 'partial', JSON.stringify(source.warnings));
  assert.equal(source.complete, false);
  assert.equal(source.collection_complete, false);
  assert.equal(population.unconfirmed_empty_campaigns, count);
  assert.match(population.unconfirmed_reason, reason);
  assert.ok(hasReason(source), JSON.stringify(source.warnings));
}
/** What it says when every empty answer is confirmed (or there is none). */
function assertConfirmed(report) {
  const source = report.sources[0];
  assert.equal(report.state, 'complete', JSON.stringify(source.warnings));
  assert.equal(source.complete, true);
  assert.equal(source.collection_complete, true);
  assert.equal(source.quality.population.unconfirmed_empty_campaigns, 0);
  assert.equal(Object.hasOwn(source.quality.population, 'unconfirmed_reason'), false);
  assert.equal(hasReason(source), false);
}

for (const delivering of [0, 1, 2])
  test(
    'an empty Snapchat campaign beside a delivering one whose finalization time covers the window is no rows, and the report is complete (campaign ' +
      (delivering + 1) +
      ' of 3 delivers)',
    async t => {
      // The delivering campaign may be read before or after the empty ones: the evidence is the whole collection's.
      const f = fixture(t, {
          cell: (index, span) =>
            index === delivering && span === 0 ? {ids: squadIds(index, 0), finalized: '2026-11-15T23:00:00.000Z'} : {},
        }),
        report = await f.run();
      assertConfirmed(report);
      assert.deepEqual(report.rows.map(row => row.entity_id).sort(), squadIds(delivering, 0).sort());
      assert.equal(report.sources[0].quality.population.campaigns_collected, 3);
    },
  );

test('when every Snapchat campaign is empty and nothing says its data is final, the report is partial, counts them, and shows no zero', async t => {
  const f = fixture(t),
    report = await f.run();
  assertUnconfirmed(report, 3);
  assert.equal(report.rows.length, 0, 'no row, so no zero');
  assert.equal(report.sources[0].row_count, 0);
  // Each campaign was read once and the report did not fail: unconfirmed is not a refusal.
  assert.equal(report.sources[0].quality.population.campaigns_collected, 3);
  assert.equal(f.statsReads(), 3);
});

test('an empty Snapchat campaign that states both of its own finalization times is no rows without other evidence', async t => {
  const f = fixture(t, {cell: () => ({finalized: '2026-11-15T23:00:00.000Z'})}),
    report = await f.run();
  assertConfirmed(report);
  assert.equal(report.rows.length, 0);
});

test('an empty Snapchat campaign that states only one of its two finalization times is unconfirmed without other evidence', async t => {
  const f = fixture(t, {cell: () => ({finalized: '2026-11-15T23:00:00.000Z', conversion: null})}),
    report = await f.run();
  assertUnconfirmed(report, 3);
  assert.equal(report.rows.length, 0);
});

// A long window is read in spans of at most 31 days. An answer with ad squads in the first span states a finalization time that
// is later than the first span but may be earlier than the end of the window; the empty answers of the later span are judged
// against it. Campaign 1 delivers only in the first span; campaigns 2 and 3 never deliver.
const firstSpanOnly = finalized => (index, span) => (index === 0 && span === 0 ? {ids: squadIds(0, 0), finalized} : {});
const longWindowCloses = iso(closes(longWindow.spans.at(-1)));
test('the end of the window after the finalization time that the collection knows leaves the empty answers unconfirmed, and the report partial', async t => {
  assert.equal(longWindow.spans.length, 2, 'the window is read in two spans');
  const finalized = '2023-04-20T00:00:00.000Z';
  assert.ok(
    Date.parse(finalized) >= closes(longWindow.spans[0]) && Date.parse(finalized) < closes(longWindow.spans[1]),
  );
  const f = fixture(t, {range: longWindow, cell: firstSpanOnly(finalized)}),
    report = await f.run();
  // Every campaign has an empty answer for the second span that nothing confirms (the first campaign's too: it delivered only in
  // the first); each counts once. The rows that were read stay, and the empty first-span answers of the others were confirmed.
  assertUnconfirmed(report, 3);
  assert.deepEqual(report.rows.map(row => row.entity_id).sort(), squadIds(0, 0).sort());
  assert.equal(f.statsReads(), 6, 'three campaigns, two spans');
});

test('a finalization time that is exactly the end of the window confirms the empty answers, and one millisecond short does not', async t => {
  const covered = fixture(t, {range: longWindow, cell: firstSpanOnly(longWindowCloses)});
  assertConfirmed(await covered.run());
  const short = fixture(t, {range: longWindow, cell: firstSpanOnly(iso(Date.parse(longWindowCloses) - 1))});
  assertUnconfirmed(await short.run(), 3);
});

test('the earliest finalization time of the collection is the evidence, not the latest or the first', async t => {
  // Two campaigns deliver in the first span: one states a time that covers the window, the other one a millisecond short. The
  // earliest is the evidence, whichever is read first.
  for (const early of [0, 1]) {
    const f = fixture(t, {
        range: longWindow,
        cell: (index, span) =>
          span === 0 && index <= 1
            ? {
                ids: squadIds(index, 0),
                finalized: index === early ? iso(Date.parse(longWindowCloses) - 1) : longWindowCloses,
              }
            : {},
      }),
      report = await f.run();
    assertUnconfirmed(report, 3);
  }
});

test('a conversion processing time that is earlier than the end of the window is evidence too, for a source that reads conversions', async t => {
  // The finalized time covers the window; the conversion time of the same answer does not. An empty answer of the later span has
  // the same two things to be confirmed by, so it is not.
  const f = fixture(t, {
      range: longWindow,
      cell: (index, span) =>
        index === 0 && span === 0
          ? {ids: squadIds(0, 0), finalized: longWindowCloses, conversion: '2023-04-20T00:00:00.000Z'}
          : {},
    }),
    report = await f.run();
  assertUnconfirmed(report, 3);
});

// A scope narrows the read, and so the evidence: the campaigns it leaves out are not read, so their answers prove nothing.
test('a Snapchat source scoped to an empty campaign is not confirmed by a delivering campaign that its scope leaves out', async t => {
  const f = fixture(t, {
      scope: 'campaign_ids',
      cell: (index, span) =>
        index === 1 && span === 0 ? {ids: squadIds(1, 0), finalized: '2026-11-15T23:00:00.000Z'} : {},
    }),
    report = await f.run();
  assertUnconfirmed(report, 1);
  assert.equal(report.rows.length, 0);
  assert.equal(f.statsReads(), 1, 'only the scoped campaign was read');
});

// The legacy contract reads one campaign's answer alone: there is no collection, so no other answer to be judged by.
test('a Snapchat source of the legacy contract for one campaign is partial when that campaign answers with no rows and no finalization time', async t => {
  const f = fixture(t, {scope: 'campaign_id'}),
    report = await f.run(),
    source = report.sources[0];
  assert.equal(report.state, 'partial', JSON.stringify(source.warnings));
  assert.equal(source.complete, false);
  assert.equal(source.collection_complete, false);
  assert.ok(hasReason(source), JSON.stringify(source.warnings));
  assert.equal(report.rows.length, 0);
});

test('a Snapchat source of the legacy contract for one campaign that states its finalization times is complete with no rows', async t => {
  const f = fixture(t, {scope: 'campaign_id', cell: () => ({finalized: '2026-11-15T23:00:00.000Z'})}),
    report = await f.run(),
    source = report.sources[0];
  assert.equal(report.state, 'complete', JSON.stringify(source.warnings));
  assert.equal(source.complete, true);
  assert.equal(hasReason(source), false);
  assert.equal(report.rows.length, 0);
});

test('the account’s ads are partial when Snapchat answers with no ads and no finalization time', async t => {
  const f = fixture(t, {level: 'ad'}),
    report = await f.run(),
    source = report.sources[0];
  assert.equal(report.state, 'partial', JSON.stringify(source.warnings));
  assert.equal(source.complete, false);
  assert.equal(source.collection_complete, false);
  assert.ok(hasReason(source), JSON.stringify(source.warnings));
  assert.equal(report.rows.length, 0);
});

test('the account’s ads read in two spans keep the reason of the span that Snapchat did not confirm', async t => {
  // The first span has ads and states its time; the second is empty with none. The spans are merged into one capture, which
  // must keep the reason that only the second one carries.
  const f = fixture(t, {
      level: 'ad',
      range: longWindow,
      cell: (_, span) => (span === 0 ? {ids: [id(4001), id(4002)], finalized: '2023-04-20T00:00:00.000Z'} : {}),
    }),
    report = await f.run(),
    source = report.sources[0];
  assert.equal(report.state, 'partial', JSON.stringify(source.warnings));
  assert.equal(source.complete, false);
  assert.ok(hasReason(source), JSON.stringify(source.warnings));
  assert.deepEqual(report.rows.map(row => row.entity_id).sort(), [id(4001), id(4002)]);
});
