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

// r25-mf-jobs item 3, and its fix round (F2, F3): a daily report of a provider that prepares each day's report
// (Microsoft) needs a worker turn or more per day. The job's 8 attempts are for turns in a row that settle nothing: a turn
// that settled a period or a source starts them again (F2), so a report of any number of days finishes while its days
// keep arriving. On the last attempt a retryable error ends the unit as before: with its own error when no period
// finished (F3), with REPORT_PERIODS_FAILED when some did, and then the finished periods stay in the checkpoint and Retry
// resumes them (F2). Not confirmed against the live provider: the collection below is a fake that behaves as its
// collector does (src/microsoft-report-source.ts): the first call of a day saves its report id and is "not ready yet";
// a later one reads once the report is ready.
const pending = () =>
  new MirrorError('REPORT_PENDING', 'Microsoft is preparing the report.', {retry_after_ms: 1}, 503, true);
const range = (days, since = '2026-09-01') => ({
  since,
  until: new Date(Date.parse(since) + (days - 1) * 86400000).toISOString().slice(0, 10),
});

/**
 * A Microsoft-style daily source. `waits` is how many polls of a day's report come back not ready before it is ready;
 * `stuck` maps a day to the error its every poll answers with (it is never ready until the entry is deleted).
 */
function microsoftDaily(t, days, {waits = 0, stuck = new Map()} = {}) {
  const f = rollbackFixture(t, {platforms: ['microsoft']}),
    calls = [],
    polls = new Map(),
    raw = {
      CampaignId: '4001',
      CampaignName: 'Synthetic campaign',
      CurrencyCode: 'USD',
      Spend: '10',
      Impressions: '100',
    };
  f.overview.native.collect = async (source, period, _actor, native, save) => {
    const day = period.since;
    if (!native.report_id) {
      calls.push(day + ':submit');
      save({report_id: 'job-' + day});
      throw stuck.has(day) ? stuck.get(day)() : pending();
    }
    calls.push(day + ':poll');
    polls.set(day, (polls.get(day) ?? 0) + 1);
    if (stuck.has(day)) throw stuck.get(day)();
    if (polls.get(day) <= waits) throw pending();
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
  const drive = async queued => {
    const turns = [];
    for (let turn = 0; turn < 120; turn++) {
      f.store.sql().prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
      if (!(await f.worker.once())) break;
      turns.push(f.store.job(f.actor.tenantId, queued.job_id).state);
    }
    return {report: f.document('overview_report', queued.id), job: f.store.job(f.actor.tenantId, queued.job_id), turns};
  };
  const run = async () => drive(await f.handle({action: 'run', config, confirmed: true}));
  return {f, calls, run, drive, stuck};
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

test('the attempt limit is for turns in a row that settle nothing: days that each wait for several polls still complete', async t => {
  // Every day is not ready for two polls after its submission: two turns a day settle nothing, 24 in all, and never more
  // than three in a row. The limit counted them across the whole report, so the fifth day failed it.
  const days = 12,
    x = microsoftDaily(t, days, {waits: 2}),
    {report, job, turns} = await x.run();
  assert.ok(turns.length > 3 * REPORT_JOB_ATTEMPT_LIMIT);
  assert.equal(job.state, 'complete');
  assert.equal(report.state, 'complete', JSON.stringify(report.error ?? report.sources?.[0]?.error));
  assert.equal(report.rows.length, days);
  assert.ok(job.attempts <= 3, 'a turn that settled a day starts the count again: ' + job.attempts);
});

test('a day that never gets ready fails the report on the last attempt with the finished days saved, and Retry resumes them', async t => {
  const stuck = '2026-09-05',
    x = microsoftDaily(t, 10, {stuck: new Map([[stuck, pending]])}),
    {report, job} = await x.run();
  assert.equal(job.state, 'failed', 'the last attempt fails the job, as before (a finished snapshot is never resumed)');
  assert.equal(report.state, 'failed');
  const source = report.sources[0];
  assert.equal(source.error.code, 'REPORT_PERIODS_FAILED');
  assert.equal(source.error.retryable, true);
  assert.deepEqual(
    source.error.period_errors.map(e => e.date_range.since),
    ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'],
    'the stuck day and the days after it are named',
  );
  assert.match(source.error.message, /6 calendar period.*4 that finished are saved/);
  assert.deepEqual(
    x.calls.filter(call => /:submit$/.test(call) && call.slice(0, 10) > stuck),
    [],
    'the last attempt asks the provider for no report of a day after the stuck one',
  );
  // The provider's report is ready now. Retry resumes: no finished day and no submitted report is asked for again.
  const before = x.calls.length;
  x.stuck.delete(stuck);
  const retried = await x.f.handle({action: 'retry', id: job.id, confirmed: true});
  assert.equal(retried.state, 'queued');
  const resumed = await x.drive({id: report.id, job_id: job.id});
  assert.equal(resumed.job.state, 'complete');
  assert.equal(resumed.report.state, 'complete', JSON.stringify(resumed.report.sources?.[0]?.error));
  assert.equal(resumed.report.rows.length, 10, 'every day, the four that were saved and the six that were not');
  const after = x.calls.slice(before);
  assert.equal(after[0], stuck + ':poll', 'it continues with the report of the stuck day');
  assert.deepEqual(
    after.filter(
      call =>
        ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', stuck].includes(call.slice(0, 10)) &&
        call.endsWith(':submit'),
    ),
    [],
    'the saved days and the stuck day’s report are not submitted again',
  );
});

test('a report none of whose days is ever read fails with the provider’s own error, its code, hint and request, as before', async t => {
  const limited = () =>
    new MirrorError(
      'PLATFORM_RATE_LIMIT',
      'Provider cooldown is active; wait until the reported reset time.',
      {retry_after_ms: 90000, request_id: 'req-abc-123'},
      429,
      true,
    );
  const x = microsoftDaily(t, 5, {stuck: new Map([['2026-09-01', limited]])}),
    {report, job, turns} = await x.run();
  // The first day is never read, so no turn settles anything: the submission is an attempt like the polls.
  assert.equal(turns.length, REPORT_JOB_ATTEMPT_LIMIT, 'the job’s attempts and no more');
  assert.equal(job.state, 'failed');
  assert.equal(report.state, 'failed');
  const error = report.sources[0].error;
  assert.equal(error.code, 'PLATFORM_RATE_LIMIT', 'not REPORT_PERIODS_FAILED: no period was read');
  assert.equal(error.retryable, true);
  assert.equal(error.category, 'rate_limit');
  assert.equal(error.retry_after_ms, 90000);
  assert.equal(error.provider.request_id, 'req-abc-123');
  assert.match(error.next_action, /provider cooldown/);
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

test('on the last attempt a retryable error after finished periods is REPORT_PERIODS_FAILED, with no request after it; earlier it is thrown as it is', async () => {
  const last = {lastAttempt: true, progressed: false},
    c = collector('2026-09-03', pending());
  await assert.rejects(
    collectReportPeriods({platform: 'microsoft'}, dates, 'daily', {}, c.collect, () => {}, last),
    error => {
      assert.equal(error.code, 'REPORT_PERIODS_FAILED');
      assert.equal(error.retryable, true);
      assert.equal(error.details.finished, 2);
      assert.deepEqual(
        error.details.periods.map(p => [p.date_range.since, p.error.code]),
        [
          ['2026-09-03', 'REPORT_PENDING'],
          ['2026-09-04', 'REPORT_PENDING'],
          ['2026-09-05', 'REPORT_PENDING'],
        ],
      );
      assert.match(error.message, /3 calendar period.*2 that finished are saved/);
      return true;
    },
  );
  assert.deepEqual(c.seen, ['2026-09-01', '2026-09-02', '2026-09-03'], 'no request after the failing period');
  // The finished periods are saved as they finish, so a later run resumes them.
  const saved = [];
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-03', pending()).collect,
      v => saved.push(JSON.parse(JSON.stringify(v))),
      {lastAttempt: true, progressed: false},
    ),
    {code: 'REPORT_PERIODS_FAILED'},
  );
  assert.deepEqual(Object.keys(saved.at(-1).periods), ['0', '1'], 'the failed period is not saved as an answer');
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

test('on the last attempt a retryable error when no period was read is thrown as it is, never as REPORT_PERIODS_FAILED', async () => {
  const original = new MirrorError(
    'PLATFORM_RATE_LIMIT',
    'Provider cooldown is active.',
    {retry_after_ms: 1000, request_id: 'req-1'},
    429,
    true,
  );
  await assert.rejects(
    collectReportPeriods(
      {platform: 'microsoft'},
      dates,
      'daily',
      {},
      collector('2026-09-01', original).collect,
      () => {},
      {lastAttempt: true, progressed: false},
    ),
    error => error === original,
  );
  // Periods that failed for good before it are no period read.
  const c = {
    seen: [],
    collect: async period => {
      c.seen.push(period.since);
      if (period.since === '2026-09-01') throw new MirrorError('INSUFFICIENT_SCOPE', 'Denied.', {}, 403);
      throw original;
    },
  };
  await assert.rejects(
    collectReportPeriods({platform: 'microsoft'}, dates, 'daily', {}, c.collect, () => {}, {
      lastAttempt: true,
      progressed: false,
    }),
    error => error === original,
  );
  assert.deepEqual(c.seen, ['2026-09-01', '2026-09-02']);
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

test('the worker starts the attempts again after a retry that kept progress, and still counts every turn that kept none', async t => {
  // One job and a script of turns: a turn that keeps progress is `true`. The state is read after each turn.
  const store = new Store(':memory:', Buffer.alloc(32, 9).toString('base64'));
  t.after(() => store.close());
  const script = [false, false, false, false, false, true, ...Array(REPORT_JOB_ATTEMPT_LIMIT).fill(false)],
    worker = new ReportWorker(
      store,
      async () => ({}),
      async () => {
        const kept = script.shift();
        throw new MirrorError(
          'REPORT_PENDING',
          'Still working.',
          {retry_after_ms: 1, ...(kept ? {progress_saved: true} : {})},
          503,
          true,
        );
      },
    ),
    id = store.enqueue('tenant', 'report_overview', {report_id: 'r'}),
    seen = [];
  // Bounded: a job that failed early leaves the script unspent, and no turn is left to spend it.
  for (let turn = 0; script.length && turn < 40; turn++) {
    store.sql().prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
    if (!(await worker.once())) break;
    seen.push(store.sql().prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id));
  }
  assert.deepEqual(
    seen.map(row => row.attempts),
    [1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 6, 7, 8],
    'five turns that settled nothing, one that did (the count starts again), then the limit',
  );
  assert.deepEqual(
    seen.map(row => row.state),
    [...Array(13).fill('queued'), 'failed'],
    'five unproductive turns before the progress do not count against the eight after it',
  );
});
