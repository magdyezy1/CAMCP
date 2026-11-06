import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError} from '../dist/src/errors.js';
import {fingerprint} from '../dist/src/report-quality.js';
import {REPORT_BUDGET_KIND} from '../dist/src/report-checkpoints.js';
import {REPORT_JOB_ATTEMPT_LIMIT} from '../dist/src/job-leases.js';
import {ReportWorker} from '../dist/src/worker.js';
import {Store} from '../dist/src/store.js';
import {row} from './helpers/report-packets.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {tiktokNativeFixture} from './helpers/tiktok-native-fixture.mjs';

// What a failed or abandoned unit does to the rest of a snapshot (F-L5-03, F-L5-04): finished levels stay, the failure
// is named, and a report never stays running after its job has failed.
const levelOf = url =>
  ({AUCTION_CAMPAIGN: 'campaign', AUCTION_ADGROUP: 'adset', AUCTION_AD: 'ad'})[url.searchParams.get('data_level')];
const levelResults = report => report.sources[0].level_results.map(l => [l.level, l.error?.code ?? null, l.row_count]);
const byLevel = report =>
  Object.fromEntries(['campaign', 'adset', 'ad'].map(l => [l, report.rows.filter(r => r.level === l).length]));
const unavailable = () =>
  new MirrorError('UPSTREAM_ERROR', 'Platform returned HTTP 503', {http_status: 503}, 503, true);

test('a unit that keeps failing with a retryable error ends the report partial on the last attempt, with its finished levels', async t => {
  const f = tiktokNativeFixture(t);
  f.state.hook = url => {
    if (url.pathname.endsWith('/report/integrated/get/') && levelOf(url) === 'ad')
      return new Response('upstream down', {status: 503});
  };
  const reads = level =>
    f.requests.filter(url => url.pathname.endsWith('/report/integrated/get/') && levelOf(url) === level).length;
  const queued = await f.queue(f.v4());
  const turns = [];
  let afterFirst;
  for (let turn = 0; turn < REPORT_JOB_ATTEMPT_LIMIT + 3; turn++) {
    f.requeue();
    if (!(await f.worker.once())) break;
    turns.push([f.job(queued.job_id).state, f.stored(queued.id).state]);
    afterFirst ??= {campaign: reads('campaign'), adset: reads('adset')};
  }
  assert.equal(turns.length, REPORT_JOB_ATTEMPT_LIMIT, 'the job runs exactly its allowed attempts');
  assert.deepEqual(
    turns.slice(0, -1),
    Array(REPORT_JOB_ATTEMPT_LIMIT - 1).fill(['queued', 'running']),
    'every earlier attempt is retried, and the report is still being collected',
  );
  assert.deepEqual(turns.at(-1), ['complete', 'partial'], 'the last attempt finishes the job with a partial report');
  const report = await f.get(queued.id);
  assert.equal(report.state, 'partial');
  assert.equal(report.row_count, 6);
  assert.deepEqual(byLevel(report), {campaign: 1, adset: 5, ad: 0});
  assert.deepEqual(levelResults(report), [
    ['campaign', null, 1],
    ['adset', null, 5],
    ['ad', 'UPSTREAM_ERROR', 0],
  ]);
  assert.equal(report.error ?? null, null);
  assert.equal(typeof report.completed_at, 'number');
  assert.deepEqual(
    {campaign: reads('campaign'), adset: reads('adset')},
    afterFirst,
    'a level that finished is never read again by a later attempt',
  );
  assert.ok(reads('ad') >= REPORT_JOB_ATTEMPT_LIMIT, 'the failing level is tried on every attempt');
});

test('a collection yield is saved progress, not a failure, even on the last attempt', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
  t.after(() => store.close());
  const seen = [];
  const worker = new ReportWorker(
    store,
    async () => ({}),
    async (_tenant, _kind, input) => {
      seen.push(input.__last_attempt);
      throw new MirrorError('REPORT_COLLECTION_YIELD', 'Collected periods are saved.', {retry_after_ms: 1}, 503, true);
    },
  );
  const id = store.enqueue('tenant', 'report_overview', {report_id: 'r'}),
    state = () => store.db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id);
  for (let turn = 0; turn < REPORT_JOB_ATTEMPT_LIMIT + 2; turn++) {
    store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
    await worker.once();
  }
  assert.equal(state().state, 'queued', 'the worker keeps retrying a yield');
  assert.ok(state().attempts > REPORT_JOB_ATTEMPT_LIMIT);
  assert.equal(seen[REPORT_JOB_ATTEMPT_LIMIT - 1], true, 'the job is told when it is on its last attempt');
});

test('the worker tells a report job whether this is its last attempt, from the one attempt limit', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 8).toString('base64'));
  t.after(() => store.close());
  const seen = [];
  const worker = new ReportWorker(
    store,
    async () => ({}),
    async (_tenant, _kind, input) => {
      seen.push(input.__last_attempt);
      throw unavailable();
    },
  );
  const id = store.enqueue('tenant', 'report_overview', {report_id: 'r'});
  for (let turn = 0; turn < REPORT_JOB_ATTEMPT_LIMIT + 2; turn++) {
    store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
    await worker.once();
  }
  assert.deepEqual(seen, [...Array(REPORT_JOB_ATTEMPT_LIMIT - 1).fill(false), true]);
  const job = store.db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id);
  assert.deepEqual([job.state, job.attempts], ['failed', REPORT_JOB_ATTEMPT_LIMIT]);
});

const levelRows = {
  campaign: [row('campaign', 'c1', {spend: '10'})],
  adset: [row('adset', 's1', {spend: '10'})],
};

test('duplicate rows from one level fail that level, not the job: the other levels stay and the failure is named', async t => {
  const e = reportEngine(t, {
    rowsFor: level =>
      level === 'ad'
        ? [row('ad', 'a1', {spend: '5'}), row('ad', 'a1', {spend: '5'})]
        : level === 'adset'
          ? levelRows.adset
          : levelRows.campaign,
  });
  const {report, stored, job} = await e.go();
  assert.equal(stored.state, 'partial');
  assert.equal(report.state, 'partial');
  assert.deepEqual(byLevel(report), {campaign: 1, adset: 1, ad: 0});
  assert.deepEqual(levelResults(report), [
    ['campaign', null, 1],
    ['adset', null, 1],
    ['ad', 'DUPLICATE_ENTITY_ROWS', 0],
  ]);
  assert.equal(job.state, 'complete');
  assert.equal(report.sources.length, 1);
});

test('duplicate rows at the level a scope measures through fail it before any total is derived from them', async t => {
  const adRows = [
      row('ad', 'a1', {spend: '5'}, {parent_ids: {campaign_id: 'c1', adset_id: 's1'}}),
      row('ad', 'a1', {spend: '5'}, {parent_ids: {campaign_id: 'c1', adset_id: 's1'}}),
    ],
    e = reportEngine(t, {
      rowsFor: level => (level === 'ad' ? adRows : level === 'adset' ? levelRows.adset : levelRows.campaign),
    });
  const {report, stored, job} = await e.go(['campaign', 'adset', 'ad'], {}, {ad_ids: ['a1']});
  assert.equal(stored.state, 'partial');
  assert.equal(job.state, 'complete');
  assert.deepEqual(
    levelResults(report).map(([level, code]) => [level, code]),
    [
      ['campaign', null],
      ['adset', null],
      ['ad', 'DUPLICATE_ENTITY_ROWS'],
    ],
  );
  // The ad rows would have been summed twice into the campaign and the ad set: no total is built from a failed level.
  assert.deepEqual(byLevel(report), {campaign: 0, adset: 0, ad: 0});
  assert.equal(
    report.sources[0].level_results.find(l => l.level === 'campaign').scope.rollup.available,
    false,
    'the campaign says its rollup was not available',
  );
});

test('a middle level under two campaigns fails that rollup, not the job, and the other levels keep their rows', async t => {
  const e = reportEngine(t, {
    rowsFor: level =>
      level === 'ad'
        ? [
            row('ad', 'a1', {spend: '5'}, {parent_ids: {campaign_id: 'c1', adset_id: 's1'}}),
            row('ad', 'a2', {spend: '5'}, {parent_ids: {campaign_id: 'c2', adset_id: 's1'}}),
          ]
        : level === 'adset'
          ? levelRows.adset
          : levelRows.campaign,
  });
  const {report, stored, job} = await e.go(['campaign', 'adset', 'ad'], {}, {ad_ids: ['a1', 'a2']});
  assert.equal(stored.state, 'partial');
  assert.equal(job.state, 'complete');
  assert.deepEqual(
    levelResults(report).map(([level, code]) => [level, code]),
    [
      ['campaign', null],
      ['adset', 'REPORT_ACCOUNT_MISMATCH'],
      ['ad', null],
    ],
  );
  assert.deepEqual(byLevel(report), {campaign: 2, adset: 0, ad: 2});
});

test('rollup rows over the whole-job row limit fail those levels, not the job', async t => {
  const e = reportEngine(t, {
    rowsFor: level =>
      level === 'ad'
        ? [row('ad', 'a1', {spend: '5'}, {parent_ids: {campaign_id: 'c1', adset_id: 's1'}})]
        : level === 'adset'
          ? levelRows.adset
          : levelRows.campaign,
  });
  const queued = await e.queue(['campaign', 'adset', 'ad'], {metrics: ['spend']}, {ad_ids: ['a1']});
  // As after a large earlier attempt: the budget has room for the three collected levels and not for the rollups.
  e.store.putDocument(e.actor.tenantId, REPORT_BUDGET_KIND, queued.id, {
    report_id: queued.id,
    version: 1,
    definition: fingerprint(e.stored(queued.id).config),
    requests: 1,
    rows: 24997,
    bytes: 0,
    elapsed_ms: 0,
    row_counts: {seed: 24997},
    active_since: null,
  });
  await e.worker.once();
  const report = await e.get(queued.id);
  assert.equal(e.stored(queued.id).state, 'partial');
  assert.equal(e.job(queued.job_id).state, 'complete');
  assert.deepEqual(
    levelResults(report).map(([level, code]) => [level, code]),
    [
      ['campaign', 'REPORT_COLLECTION_LIMIT'],
      ['adset', 'REPORT_COLLECTION_LIMIT'],
      ['ad', null],
    ],
  );
  assert.deepEqual(byLevel(report), {campaign: 0, adset: 0, ad: 1});
});

test('an error that still escapes after collection ends the report failed with its reason, never running', async t => {
  const e = reportEngine(t, {
    rowsFor: level => (level === 'campaign' ? [row('campaign', 'c1', {spend: 'not a number'})] : []),
  });
  const {stored, job} = await e.go(['campaign']);
  assert.equal(job.state, 'failed');
  assert.equal(JSON.parse(job.error).code, 'REPORT_SHAPE_CHANGED');
  assert.equal(stored.state, 'failed');
  assert.equal(stored.error.code, 'REPORT_SHAPE_CHANGED');
  assert.equal(typeof stored.error.message, 'string');
});

test('a stored v3 report whose one account repeats a campaign loses that account only', async t => {
  const e = reportEngine(t, {accounts: ['100', '200']}),
    campaign = {campaign_id: '1', campaign_name: 'One', objective: 'OUTCOME_LEADS', metrics: {spend: 10, clicks: 2}};
  // The v3 form: no contract version, one level per source, plain numbers.
  e.overview.native.collect = async (source, dates) => ({
    source,
    rows: source.account_id === '100' ? [campaign, campaign] : [campaign],
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    source_kind: 'ads',
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'Synthetic results',
    attribution: 'Synthetic click window',
    quality: {version: 1},
  });
  const queued = await e.overview.handle(
    {
      action: 'run',
      confirmed: true,
      config: {
        ...e.config,
        sources: ['100', '200'].map(account_id => ({platform: 'meta', account_id, connection_id: 'login'})),
      },
    },
    e.actor,
  );
  await e.worker.once();
  const report = e.stored(queued.id);
  assert.equal(report.state, 'partial');
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].account_id, '200');
  assert.deepEqual(
    report.sources.map(s => [s.source.account_id, s.error?.code ?? null]),
    [
      ['100', 'DUPLICATE_CAMPAIGN_ROWS'],
      ['200', null],
    ],
  );
  assert.equal(e.job(queued.job_id).state, 'complete');
});

test('a worker that lost its lease does not fail the report its replacement is collecting', async t => {
  const e = reportEngine(t, {rowsFor: () => levelRows.campaign});
  const queued = await e.queue(['campaign']);
  const collect = e.overview.native.collect;
  e.overview.native.collect = async (...args) => {
    e.store.db.prepare("UPDATE jobs SET lease_token='another-worker' WHERE id=?").run(queued.job_id);
    return collect(...args);
  };
  await e.worker.once();
  assert.equal(e.job(queued.job_id).state, 'running', 'the other worker still holds the job');
  assert.equal(e.stored(queued.id).state, 'running', 'its report is not failed underneath it');
});

test('a retryable error outside any unit is retried, and ends the report failed only when the last attempt has failed', async t => {
  const e = reportEngine(t, {rowsFor: () => levelRows.campaign});
  const queued = await e.queue(['campaign']);
  // The authorization check at the start of every attempt fails with a temporary error.
  e.overview.access = () => {
    throw unavailable();
  };
  const states = [];
  for (let turn = 0; turn < REPORT_JOB_ATTEMPT_LIMIT; turn++) {
    e.requeue();
    await e.worker.once();
    states.push([e.job(queued.job_id).state, e.stored(queued.id).state]);
  }
  assert.deepEqual(
    states.slice(0, -1),
    Array(REPORT_JOB_ATTEMPT_LIMIT - 1).fill(['queued', 'queued']),
    'a report that will be tried again is not failed',
  );
  assert.deepEqual(states.at(-1), ['failed', 'failed']);
  assert.equal(e.stored(queued.id).error.code, 'UPSTREAM_ERROR');
});

test('a failure while delivering a collected snapshot leaves the snapshot as it was collected', async t => {
  const e = reportEngine(t, {rowsFor: level => (level === 'adset' ? levelRows.adset : levelRows.campaign)});
  const destination = await e.overview.handle(
    {
      action: 'bind_file_destination',
      idempotency_key: 'failure-paths-delivery',
      confirmed: true,
      file_destination: {name: 'Failure paths', formats: ['xlsx']},
    },
    e.actor,
  );
  const scheduled = await e.overview.handle(
    {
      action: 'schedule',
      idempotency_key: 'failure-paths-delivery-schedule',
      config: e.definition(['campaign', 'adset'], {
        date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      }),
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
      confirmed: true,
    },
    e.actor,
  );
  const saved = e.store.document(e.actor.tenantId, 'overview_schedule', scheduled.id);
  e.store.putDocument(e.actor.tenantId, 'overview_schedule', saved.id, {...saved, next_run_at: Date.now() - 1000});
  e.overview.files.queue = () => {
    throw new Error('Synthetic delivery crash');
  };
  e.overview.tick();
  const reportId = e.store.document(e.actor.tenantId, 'overview_schedule', saved.id).last_report_id;
  await e.worker.once();
  const report = e.stored(reportId);
  assert.equal(e.job(report.job_id).state, 'failed', 'the job fails: its delivery crashed');
  assert.equal(report.state, 'complete', 'the collected snapshot is not turned into a failed report');
  assert.equal(report.rows.length, 2);
  assert.equal(report.error ?? null, null);
});

test('a scheduled report whose last unit keeps failing still delivers its partial snapshot', async t => {
  const e = reportEngine(t, {
    rowsFor: level => (level === 'ad' ? [] : level === 'adset' ? levelRows.adset : levelRows.campaign),
    fail: source => (source.level === 'ad' ? unavailable() : undefined),
  });
  const destination = await e.overview.handle(
    {
      action: 'bind_file_destination',
      idempotency_key: 'failure-paths-files',
      confirmed: true,
      file_destination: {name: 'Failure paths', formats: ['xlsx']},
    },
    e.actor,
  );
  const scheduled = await e.overview.handle(
    {
      action: 'schedule',
      idempotency_key: 'failure-paths-schedule',
      config: e.definition(['campaign', 'adset', 'ad'], {
        date_range: {preset: 'last_complete_days', days: 7, timezone: 'UTC'},
      }),
      schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destination.id},
      confirmed: true,
    },
    e.actor,
  );
  const saved = e.store.document(e.actor.tenantId, 'overview_schedule', scheduled.id);
  e.store.putDocument(e.actor.tenantId, 'overview_schedule', saved.id, {...saved, next_run_at: Date.now() - 1000});
  e.overview.tick();
  const reportId = e.store.document(e.actor.tenantId, 'overview_schedule', saved.id).last_report_id;
  for (let turn = 0; turn < REPORT_JOB_ATTEMPT_LIMIT; turn++) {
    e.requeue();
    await e.worker.once();
  }
  const report = e.stored(reportId);
  assert.equal(report.state, 'partial', JSON.stringify(report.sources.map(s => s.error ?? null)));
  assert.equal(report.rows.length, 2);
  assert.equal(report.export?.state, 'queued', 'the partial snapshot goes to its destination');
  const schedule = e.store.document(e.actor.tenantId, 'overview_schedule', saved.id);
  assert.equal(schedule.last_delivery.state, 'queued');
});
