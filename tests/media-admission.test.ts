// MED-02 (review 2026-10-08): a queued media upload that meets contention before any claim is retried by the worker
// until its review expires, recovery reports a job that failed unsent as not_submitted (never "queued") and lets it be
// queued again, and nothing is retried once a claim exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker, mediaContentionRetry} from '../src/worker.js';
import {MirrorError} from '../src/errors.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 47).toString('base64'),
  actor: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );

function fixture(options: {lose?: boolean} = {}) {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: 'c',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let writes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json({id: 'act_123', account_status: 1, currency: 'USD'});
      writes++;
      if (options.lose) throw Error('lost upload response');
      return Response.json({images: {one: {hash: 'fixturehash'}}});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    async () => new Response(new Uint8Array(png)),
  );
  const overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    ),
    call = async (input: JsonObject) => service.call('amcp_media', input, actor);
  const queue = async () => {
    const p = await call({
      action: 'prepare',
      platform: 'meta',
      account_id: '123',
      drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view',
    });
    assert.equal(p.success, true, JSON.stringify(p));
    const id = p.data.review_id,
      args = {review_id: id, idempotency_key: id, confirmed: true},
      queued = await call({action: 'execute_async', ...args});
    assert.equal(queued.success, true, JSON.stringify(queued));
    return {id, args, job: queued.data.job_id as string};
  };
  const due = () => store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
  return {store, service, worker, call, queue, due, writes: () => writes};
}

test('async-media-job-contention regression: a queued upload waits out another tenant’s media work and runs once', async () => {
  const f = fixture();
  try {
    const {id, job} = await f.queue(),
      other = f.store.mediaAdmission('another-workspace');
    // Before the fix the job failed permanently with MEDIA_MEMORY_BUSY and recovery still said "queued".
    await f.worker.once();
    assert.equal(f.writes(), 0);
    const waiting = f.store.job('t', job);
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.error.code, 'MEDIA_MEMORY_BUSY');
    assert.ok(waiting.available_at > Date.now(), 'the retry waits for the server’s retry_after_ms');
    assert.equal((await f.call({action: 'recovery', review_id: id})).data.state, 'queued');
    other.release();
    f.due();
    await f.worker.once();
    assert.equal(f.writes(), 1);
    const done = await f.call({action: 'job_status', review_id: id});
    assert.equal(done.data.state, 'complete', JSON.stringify(done));
    assert.equal(done.data.not_submitted, false);
    // Nothing more runs and nothing is sent twice.
    f.due();
    assert.equal(await f.worker.once(), false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a job that failed before any claim is not_submitted, can be queued again and then uploads once', async () => {
  const f = fixture();
  try {
    const {id, args, job} = await f.queue(),
      other = f.store.mediaAdmission('another-workspace'),
      review = f.store.document('t', 'media_review', id);
    // The review expires before a retry could start, so the worker stops retrying and fails the job unsent.
    f.store.putDocument('t', 'media_review', id, {...review, expires_at: Date.now() + 4000});
    await f.worker.once();
    assert.equal(f.store.job('t', job).state, 'failed');
    const status = await f.call({action: 'job_status', review_id: id});
    assert.equal(status.data.not_submitted, true);
    const recovery = await f.call({action: 'recovery', review_id: id});
    assert.equal(recovery.data.state, 'not_submitted');
    assert.equal(recovery.data.can_execute, true);
    assert.deepEqual(recovery.data.not_submitted, {
      job_error_code: 'MEDIA_MEMORY_BUSY',
      provider_requests_sent: false,
      busy: true,
    });
    // Queueing again creates a new job for the same frozen review instead of returning the failed one.
    const again = await f.call({action: 'execute_async', ...args});
    assert.equal(again.success, true, JSON.stringify(again));
    assert.notEqual(again.data.job_id, job);
    assert.equal(again.data.state, 'queued');
    assert.ok(
      f.store.db
        .prepare('SELECT event FROM audit')
        .all()
        .some(r => JSON.parse(String(r.event)).event === 'media_upload_requeued'),
    );
    other.release();
    await f.worker.once();
    assert.equal(f.writes(), 1);
    assert.equal((await f.call({action: 'recovery', review_id: id})).data.state, 'complete');
  } finally {
    f.store.close();
  }
});

test('a pre-claim refusal that would repeat is not_submitted but cannot be queued again as it is', async () => {
  const f = fixture();
  try {
    const {id, args, job} = await f.queue();
    // The worker refused the transfer before any claim because too little time was left: queueing the same review
    // again would stop the same way (MED-01 Stage C).
    f.store.db
      .prepare("UPDATE jobs SET state='failed',error=? WHERE id=?")
      .run(
        JSON.stringify({
          code: 'UPLOAD_DEADLINE_TOO_CLOSE',
          message: 'Too little time is left.',
          details: {claimed: false},
        }),
        job,
      );
    assert.equal(f.writes(), 0);
    const status = await f.call({action: 'job_status', review_id: id});
    assert.equal(status.data.not_submitted, true);
    assert.equal(status.data.busy, false);
    assert.equal(status.data.retry_available, false);
    const recovery = await f.call({action: 'recovery', review_id: id});
    assert.equal(recovery.data.state, 'not_submitted');
    assert.equal(recovery.data.can_execute, false);
    assert.equal(recovery.data.not_submitted.busy, false);
    const again = await f.call({action: 'execute_async', ...args});
    assert.equal(again.error.code, 'MEDIA_RETRY_UNAVAILABLE');
    assert.equal(again.error.details.previous_error_code, 'UPLOAD_DEADLINE_TOO_CLOSE');
    assert.equal(f.store.document('t', 'media_review', id).job_id, job, 'no new job was queued');
  } finally {
    f.store.close();
  }
});

test('once a claim exists a queued upload is never retried or queued again', async () => {
  const f = fixture({lose: true});
  try {
    const {id, args, job} = await f.queue();
    await f.worker.once();
    assert.equal(f.writes(), 1);
    assert.equal(f.store.job('t', job).state, 'failed');
    const recovery = await f.call({action: 'recovery', review_id: id});
    assert.equal(recovery.data.state, 'uncertain');
    assert.equal(recovery.data.can_execute, false);
    assert.equal((await f.call({action: 'job_status', review_id: id})).data.not_submitted, false);
    assert.equal((await f.call({action: 'execute_async', ...args})).error.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.due();
    assert.equal(await f.worker.once(), false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('the worker retries only pre-claim media contention, with jitter, and never past the review expiry', () => {
  const now = 1_000_000,
    job = {kind: 'media_upload', input: {review_id: 'r', review_expires_at: now + 300000}},
    busy = (code: string, details: JsonObject = {}) =>
      new MirrorError(code, 'busy', {retry_after_ms: 5000, claimed: false, ...details}, 409, true);
  for (const code of ['MEDIA_MEMORY_BUSY', 'MEDIA_UPLOAD_BUSY', 'MEDIA_PROCESSOR_BUSY']) {
    assert.equal(
      mediaContentionRetry(job, busy(code), now, () => 0),
      5000,
    );
    assert.equal(
      mediaContentionRetry(job, busy(code), now, () => 0.999),
      7997,
    );
  }
  assert.equal(mediaContentionRetry(job, busy('MEDIA_MEMORY_BUSY', {claimed: true}), now), undefined);
  assert.equal(mediaContentionRetry(job, busy('MEDIA_STAGING_FULL'), now), undefined);
  assert.equal(mediaContentionRetry({...job, kind: 'sheets_export'}, busy('MEDIA_MEMORY_BUSY'), now), undefined);
  assert.equal(
    mediaContentionRetry(job, new MirrorError('MEDIA_MEMORY_BUSY', 'x', {claimed: false}, 409, false), now),
    undefined,
  );
  assert.equal(
    mediaContentionRetry(job, busy('MEDIA_MEMORY_BUSY', {review_expires_at: now + 4000}), now, () => 0),
    undefined,
  );
  assert.equal(mediaContentionRetry({kind: 'media_upload', input: {}}, busy('MEDIA_MEMORY_BUSY'), now), undefined);
});
