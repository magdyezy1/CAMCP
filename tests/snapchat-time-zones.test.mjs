import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {
  snapchatEvidenceAccount,
  snapchatEvidenceCampaign,
  snapchatEvidenceEntity,
  snapchatEvidenceResponse,
} from './fixtures/snapchat-evidence-data.mjs';
import {snapchatReportSource} from '../dist/src/snapchat-report-source.js';

/**
 * F-L5-24, through the Snapchat collectors: a day whose local midnight is skipped by a clock change starts at its first
 * valid instant instead of failing the unit. Snapchat's stats take whole-hour instants, so these zones are all whole-hour.
 */
const skipped = [
  ['Africa/Cairo', '2026-04-24', '2026-04-23T22:00:00.000Z', '2026-04-24T21:00:00.000Z'],
  ['Asia/Beirut', '2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z'],
  ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
];

// The account-wide stats collector (the campaign level): one TOTAL read, then the account's campaigns.
function collection(timezone, range) {
  const requests = [];
  return {
    requests,
    c: {
      account: snapchatEvidenceAccount,
      timezone,
      range,
      extra: [],
      source: {reporting_contract: 'overview-config-v4'},
      raw: [],
      warnings: [],
      attributionProfile: () => undefined,
      plan: (path, query) => ({path, query}),
      run: async plan => {
        requests.push(plan);
        return plan.path.endsWith('/stats')
          ? {total_stats: []}
          : {campaigns: [{campaign: {id: snapchatEvidenceCampaign, name: 'Synthetic campaign', objective: 'SALES'}}]};
      },
    },
  };
}
for (const [zone, day, start, end] of skipped)
  test('the Snapchat campaign read of ' + day + ' in ' + zone + ' starts at its first valid instant', async () => {
    const {c, requests} = collection(zone, {since: day, until: day});
    await snapchatReportSource.collect(c);
    const stats = requests.find(plan => plan.path.endsWith('/stats'));
    assert.equal(stats.query.start_time, start);
    assert.equal(stats.query.end_time, end);
    assert.equal(stats.query.granularity, 'TOTAL');
  });

// The ad level, through the real queue, worker and evidence collector, against a provider that answers in the zone.
async function adLevel(t, zone, range) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const sem = {currency: 'USD', timezone: zone, date_from: range.since, date_to: range.until};
  f.hook(url => {
    if (url.hostname !== 'adsapi.snapchat.com' || url.pathname.endsWith('_by_ids')) return;
    const breakdown = url.searchParams.get('breakdown');
    return Response.json(
      snapchatEvidenceResponse(
        url.href,
        breakdown ? [snapchatEvidenceEntity(breakdown, undefined, sem)] : undefined,
        sem,
      ),
    );
  });
  const {objective, level, ...source} = granularSource('snapchat', 'ad'),
    config = {
      ...granularConfig(source),
      date_range: range,
      contract_version: 'overview-config-v4',
      sources: [{...source, levels: ['ad']}],
    };
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  await f.worker.once();
  const report = await f.overview.handle({action: 'get', id: queued.id, limit: 500}, f.actor);
  return {
    report,
    windows: f.requests
      .filter(request => /\/stats$/.test(request.url.pathname))
      .map(request => [request.url.searchParams.get('start_time'), request.url.searchParams.get('end_time')]),
  };
}
for (const [zone, day, start, end] of skipped)
  test('the Snapchat ad level of ' + day + ' in ' + zone + ' reads from its first valid instant', async t => {
    const {report, windows} = await adLevel(t, zone, {since: day, until: day});
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.deepEqual(windows, [[start, end]]);
    assert.deepEqual(
      report.rows.map(row => row.metrics.spend),
      ['10.123456'],
    );
  });

test('a half-hour zone is still refused by Snapchat, whose stats take whole-hour instants (control)', async t => {
  const {report} = await adLevel(t, 'Asia/Kolkata', {since: '2026-09-01', until: '2026-09-02'});
  assert.equal(report.state, 'failed');
  assert.equal(report.sources[0].level_results[0].error.code, 'UNSUPPORTED_TIMEZONE_OFFSET');
});
