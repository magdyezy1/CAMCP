import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {Store} from '../dist/src/store.js';
import {ReportWorker} from '../dist/src/worker.js';
import {REPORT_JOB_ATTEMPT_LIMIT} from '../dist/src/job-leases.js';
import {collectReportPeriods} from '../dist/src/report-periods.js';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {rollbackFixture} from './helpers/rollback-fixture.mjs';

// r25-mf-jobs item 3: a daily report of a provider that prepares each day's report (Microsoft) needs one worker turn per
// day, and every turn used one of the job's 8 attempts, so a report of more than 7 days failed on its 8th. A turn that
// settled a period or a source is no longer an attempt; on the last attempt the days that finished stay and the report is
// partial. Not confirmed against the live provider: the collection below is a fake that behaves as its collector does
// (src/microsoft-report-source.ts): the first call of a day saves its report id and is "not ready yet"; a later one reads.
const pending = () =>
  new MirrorError('REPORT_PENDING', 'Microsoft is preparing the report.', {retry_after_ms: 1}, 503, true);
const range = (days, since = '2026-09-01') => ({
  since,
  until: new Date(Date.parse(since) + (days - 1) * 86400000).toISOString().slice(0, 10),
});

function microsoftDaily(t, days, stuck) {
  const f = rollbackFixture(t, {platforms: ['microsoft']}),
    calls = [],
    raw = {
      CampaignId: '4001',
      CampaignName: 'Synthetic campaign',
      CurrencyCode: 'USD',
      Spend: '10',
      Impressions: '100',
    };
  f.overview.native.collect = async (source, period, _actor, native, save) => {
    const stage = native.report_id && period.since !== stuck ? 'poll' : 'submit';
    calls.push(period.since + ':' + stage);
    if (stage === 'submit' || period.since === stuck) {
      if (stage === 'submit') save({report_id: 'job-' + period.since});
      throw pending();
    }
    return {
      source,
      rows: [normalizeNativeRow('microsoft', {...raw, Clicks: '5', Conversions: '1', Revenue: '20'})],
      currency: 'USD',
      timezone: 'UTC',
      complete: true,
      collection_complete: true,
      source_kind: reportPlatforms.microsoft.kind,
      date_range: period,
      warnings: [],
      lineage: [],
      captured_at: Date.now(),
      result_definition: 'Synthetic results',
      attribution: 'Synthetic click window',
    };
  };
  const config = f.body([f.source('microsoft')], {
    grain: 'daily',
    date_range: range(days),
    metrics: ['spend', 'impressions', 'clicks', 'conversions'],
  });
  const run = async () => {
    const queued = await f.handle({action: 'run', config, confirmed: true}),
      turns = [];
    for (let turn = 0; turn < 60; turn++) {
      f.store.sql().prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
      if (!(await f.worker.once())) break;
      turns.push(f.store.job(f.actor.tenantId, queued.job_id).state);
    }
    return {report: f.document('overview_report', queued.id), job: f.store.job(f.actor.tenantId, queued.job_id), turns};
  };
  return {f, calls, run};
}

test('a daily report of more days than the job has attempts completes when each day waits for its provider report', async t => {
  const days = REPORT_JOB_ATTEMPT_LIMIT + 4,
    x = microsoftDaily(t, days),
    {report, job, turns} = await x.run();
  assert.ok(turns.length > REPORT_JOB_ATTEMPT_LIMIT, 'it needs a turn per day, more than the job has attempts');
  assert.equal(job.state, 'complete');
  assert.equal(report.state, 'complete', JSON.stringify(report.error ?? report.sources?.[0]?.period_errors));
  assert.equal(report.rows.length, days, 'every day has its row');
  assert.deepEqual(report.sources[0].period_errors ?? [], []);
  assert.equal(
    x.calls.filter(call => call.endsWith(':submit')).length,
    days,
    'each day’s report was asked for once, never again after a retry',
  );
});

test('a day that never gets ready ends the report partial on the last attempt, with the days that finished', async t => {
  const stuck = '2026-09-05',
    x = microsoftDaily(t, 10, stuck),
    {report, job} = await x.run();
  assert.equal(job.state, 'complete', 'the last attempt finishes the job');
  assert.equal(report.state, 'partial');
  assert.deepEqual(
    [...new Set(report.rows.map(row => row.date_from))],
    ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
    'the days that finished are kept',
  );
  const errors = report.sources[0].period_errors;
  assert.deepEqual(
    errors.map(e => e.date_range.since),
    ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
    'the stuck day and the days after it are named as failed periods',
  );
  assert.ok(errors.every(e => e.error.code === 'REPORT_PENDING'));
  assert.deepEqual(
    x.calls.filter(call => /:submit$/.test(call) && call.slice(0, 10) > stuck),
    [],
    'the last attempt asks the provider for no report of a day after the stuck one',
  );
});

test('a report that settles nothing still has the job’s attempts and no more, and then fails', async t => {
  const x = microsoftDaily(t, 5, '2026-09-01'),
    {report, job, turns} = await x.run();
  // The first day never gets ready, so no turn after the first settles anything.
  assert.equal(turns.length, REPORT_JOB_ATTEMPT_LIMIT);
  assert.equal(job.state, 'failed');
  assert.equal(report.state, 'failed');
});

// ---- the pieces ----
const day = since => ({rows: [{campaign_id: 'one', metrics: {reach: 10}}], complete: true, date_range: {since}});
const dates = {since: '2026-09-01', until: '2026-09-05'};
const collector = (failAt, error) => {
  const seen = [];
  return {
    seen,
    collect: async period => {
      seen.push(period.since);
      if (period.since === failAt) throw error;
      return day(period.since);
    },
  };
};

test('collectReportPeriods marks a turn that settled a period, and not one that settled none', async () => {
  const progressed = {lastAttempt: false, progressed: false},
    c = collector('2026-09-03', pending());
  await assert.rejects(
    collectReportPeriods({platform: 'microsoft'}, dates, 'daily', {}, c.collect, () => {}, progressed),
    {code: 'REPORT_PENDING'},
  );
  assert.equal(progressed.progressed, true);
  const idle = {lastAttempt: false, progressed: false};
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-01', pending()).collect,
      () => {},
      idle,
    ),
    {code: 'REPORT_PENDING'},
  );
  assert.equal(idle.progressed, false);
});

test('on the last attempt a retryable error ends its period and the rest without more requests; earlier it is thrown', async () => {
  const last = {lastAttempt: true, progressed: false},
    c = collector('2026-09-03', pending());
  const out = await collectReportPeriods({platform: 'microsoft'}, dates, 'daily', {}, c.collect, () => {}, last);
  assert.deepEqual(c.seen, ['2026-09-01', '2026-09-02', '2026-09-03'], 'no request after the failing period');
  assert.equal(out.rows.length, 2);
  assert.equal(out.complete, false);
  assert.deepEqual(
    out.period_errors.map(e => [e.date_range.since, e.error.code]),
    [
      ['2026-09-03', 'REPORT_PENDING'],
      ['2026-09-04', 'REPORT_PENDING'],
      ['2026-09-05', 'REPORT_PENDING'],
    ],
  );
  // Not the last attempt: the same error is thrown, as before.
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-03', pending()).collect,
      () => {},
      {lastAttempt: false, progressed: false},
    ),
    {code: 'REPORT_PENDING'},
  );
  // Without a turn (every other caller) a retryable error is thrown, as before.
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-03', pending()).collect,
      () => {},
    ),
    {code: 'REPORT_PENDING'},
  );
});

test('on the last attempt a collection yield is still saved progress, and a refusal or a lost lease still stops the unit', async () => {
  const yielded = new MirrorError('REPORT_COLLECTION_YIELD', 'Saved.', {retry_after_ms: 1000}, 503, true);
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-02', yielded).collect,
      () => {},
      {lastAttempt: true, progressed: false},
    ),
    {code: 'REPORT_COLLECTION_YIELD'},
  );
  for (const code of ['JOB_CANCELLED', 'STALE_JOB_LEASE', 'ACCOUNT_ACCESS_REVOKED'])
    await assert.rejects(
      collectReportPeriods(
        {platform: 'microsoft'},
        dates,
        'daily',
        {},
        collector('2026-09-02', new MirrorError(code, 'Stop.')).collect,
        () => {},
        {lastAttempt: true, progressed: false},
      ),
      {code},
    );
  // A refusal that is not retryable fails its period as before, and the later periods are still read.
  const c = collector('2026-09-02', new MirrorError('INSUFFICIENT_SCOPE', 'Denied.', {}, 403));
  const out = await collectReportPeriods({platform: 'microsoft'}, dates, 'daily', {}, c.collect, () => {}, {
    lastAttempt: true,
    progressed: false,
  });
  assert.deepEqual(c.seen, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
  assert.deepEqual(
    out.period_errors.map(e => e.date_range.since),
    ['2026-09-02'],
  );
});

test('the worker does not count a retry that kept progress, and still counts one that kept none', async t => {
  // One job at a time: the worker takes the oldest job first, so two jobs would not share its turns.
  const turns = async details => {
    const store = new Store(':memory:', Buffer.alloc(32, 9).toString('base64'));
    t.after(() => store.close());
    const worker = new ReportWorker(
        store,
        async () => ({}),
        async () => {
          throw new MirrorError('REPORT_PENDING', 'Still working.', {retry_after_ms: 1, ...details}, 503, true);
        },
      ),
      id = store.enqueue('tenant', 'report_overview', {report_id: 'r'});
    for (let turn = 0; turn < 3 * REPORT_JOB_ATTEMPT_LIMIT; turn++) {
      store.sql().prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
      await worker.once();
    }
    return store.sql().prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id);
  };
  const kept = await turns({progress_saved: true}),
    lost = await turns({});
  assert.equal(kept.state, 'queued', 'a job whose turns keep settling things is never out of attempts');
  assert.ok(kept.attempts <= 1);
  assert.deepEqual(
    [lost.state, lost.attempts],
    ['failed', REPORT_JOB_ATTEMPT_LIMIT],
    'a job whose turns settle nothing fails on its last attempt',
  );
});
