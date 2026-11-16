// Round 2.5, package r25-m1-diff (L5-04; lead review S3-1 and S3-5). In a plan of independent uploads (a creative push) one
// upload that is refused as STATE_CHANGED holds none of the others: it goes back to pending, unsent, the other uploads move,
// and the run stops with `state_changed` once nothing else can move. The background worker returns there, never queues the
// run again by itself, and a later run prepares the refused upload again and stops with its new review instead of sending
// it. A media step is refused through the same execute as a write, so this is also the test of a media plan step refused
// for a changed state. The provider is a synthetic Meta ad account whose currency changes between one upload's prepare and
// its execute; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {SOURCE_CHUNK_BYTES, type MediaSources} from '../src/media-sources.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 77).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  admin: Actor = {...operator, role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  accounts = ['101', '102', '103'];

function fixture() {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: 'meta',
      tenantId: 't',
      gateway: 'meta_native_action',
      accounts,
      writeAccounts: accounts,
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let uploads = 0;
  // The currency of each account. `changeAfterPrepare` names an account whose currency changes on the first read made once a
  // review of an upload to it exists, which is the read of the execute that follows its prepare (the prepare itself reads the
  // account before its review is saved).
  const currency: Record<string, string> = {'101': 'USD', '102': 'USD', '103': 'USD'};
  const behaviour: {changeAfterPrepare?: string} = {};
  const transport = new NativeTransport((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    if (method === 'GET' && /\/act_\d+$/.test(url.pathname)) {
      const account = url.pathname.split('_').pop()!;
      if (
        behaviour.changeAfterPrepare === account &&
        store.documents('t', 'media_review').some(r => String(r.plan?.account_id) === account)
      )
        currency[account] = 'EUR';
      return Response.json({id: url.pathname.split('/').pop(), account_status: 1, currency: currency[account]});
    }
    if (method === 'POST' && url.pathname.endsWith('/adimages'))
      return Response.json({images: {one: {hash: 'synthetic_hash_' + ++uploads}}});
    // The availability read after each upload.
    if (method === 'GET' && url.pathname.endsWith('/adimages'))
      return Response.json({
        data: Array.from({length: uploads}, (_, i) => 'synthetic_hash_' + (i + 1))
          .filter(hash => String(url.searchParams.get('hashes') ?? '').includes(hash))
          .map(hash => ({hash})),
      });
    throw Error('Unexpected provider request ' + method + ' ' + url.pathname);
  }) as typeof fetch);
  const service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  const campaign = (input: JsonObject, actor = operator) => service.call('amcp_campaign', input, actor);
  return {
    store,
    service,
    worker,
    campaign,
    behaviour,
    uploads: () => uploads,
    sources: service.mediaSources(),
    reviews: () => store.documents('t', 'media_review').length,
  };
}
async function upload(sources: MediaSources, filename: string) {
  const started = sources.begin(operator, {filename, size: png.length, type: ''});
  for (let index = 0; index < started.chunks; index++)
    sources.put(
      operator,
      started.source_id,
      index,
      png.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
    );
  return (await sources.complete(operator, started.source_id)) as JsonObject;
}
const pushStep = (id: string, source: JsonObject, account: string) => ({
  id,
  kind: 'media',
  description: source.filename + ' → Meta · ' + account,
  connection_id: 'meta',
  account_id: account,
  arguments: {
    platform: 'meta',
    account_id: account,
    connection_id: 'meta',
    source_id: source.source_id,
    name: 'Push',
    fit_to_platform: false,
    expected_sha256: source.sha256,
  },
  depends_on: [],
});
async function approvedPush(f: ReturnType<typeof fixture>, steps: JsonObject[]) {
  const saved = await f.campaign({
    action: 'create',
    name: 'Creative push · ' + steps.length + ' uploads',
    brief: 'Upload only the previewed files to the selected accounts.',
    acknowledge_temporary_sources: true,
    steps,
  });
  assert.equal(saved.success, true, JSON.stringify(saved));
  const id = saved.data.id,
    summary = await f.campaign({action: 'approve', id});
  assert.equal(summary.success, true, JSON.stringify(summary));
  const approved = await f.campaign({
    action: 'approve',
    id,
    plan_hash: summary.data.approval.plan_hash,
    summary_hash: summary.data.approval.summary_hash,
    confirmed: true,
  });
  assert.equal(approved.success, true, JSON.stringify(approved));
  return id as string;
}
const plan = (f: ReturnType<typeof fixture>, id: string) => f.store.document('t', 'campaign_run', id);
const statuses = (f: ReturnType<typeof fixture>, id: string) =>
  plan(f, id).steps.map((s: JsonObject) => [s.id, s.status]);

test('one upload refused as STATE_CHANGED holds none of the others: the worker moves them and returns at state_changed', async () => {
  const f = fixture();
  try {
    const sources = [
        await upload(f.sources, 'a.png'),
        await upload(f.sources, 'b.png'),
        await upload(f.sources, 'c.png'),
      ],
      id = await approvedPush(
        f,
        sources.map((s, i) => pushStep('upload-' + (i + 1), s, accounts[i]!)),
      );
    // The second account changes currency between the run's prepare of its upload and the execute that follows.
    f.behaviour.changeAfterPrepare = '102';
    const queued = await f.campaign({action: 'run_background', id});
    assert.equal(queued.success, true, JSON.stringify(queued));
    assert.equal(await f.worker.once(), true);
    // The first and third uploads were sent; the second was refused before anything was claimed or sent.
    assert.equal(f.uploads(), 2, 'the other two uploads were sent');
    assert.deepEqual(statuses(f, id), [
      ['upload-1', 'verified'],
      ['upload-2', 'pending'],
      ['upload-3', 'verified'],
    ]);
    const refused = plan(f, id).steps[1];
    assert.equal(refused.error.code, 'STATE_CHANGED');
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.ok(refused.error.details.changed_fields.length > 0);
    assert.deepEqual(refused.error.details.next_call, {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
    // The worker returned: the job is complete (never queued again by itself), and the push says what is left.
    const job = f.store.job('t', queued.data.background.job_id);
    assert.equal(job.state, 'complete', JSON.stringify(job));
    assert.equal(job.result.stopped, 'state_changed');
    assert.equal(job.result.remaining, 1);
    assert.equal(job.result.attention, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='campaign_run'").get()!.n, 1);
    assert.equal(await f.worker.once(), false, 'nothing is queued behind it');
    assert.equal(f.reviews(), 3, 'no review was prepared again');
  } finally {
    f.store.close();
  }
});

test('a later run prepares the refused upload again and stops with its new review, and only an explicit execute_next sends it', async () => {
  const f = fixture();
  try {
    const sources = [await upload(f.sources, 'a.png'), await upload(f.sources, 'b.png')],
      id = await approvedPush(
        f,
        sources.map((s, i) => pushStep('upload-' + (i + 1), s, accounts[i]!)),
      );
    f.behaviour.changeAfterPrepare = '102';
    const first = await f.campaign({action: 'run', id});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 1200));
    assert.equal(first.data.run.stopped, 'state_changed');
    assert.equal(f.uploads(), 1, 'the first upload was sent');
    assert.deepEqual(statuses(f, id), [
      ['upload-1', 'verified'],
      ['upload-2', 'pending'],
    ]);
    // Called again: nothing else can move, so the refused upload is prepared again over the state as it is, and shown.
    const shown = await f.campaign({action: 'run', id});
    assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 1200));
    assert.equal(shown.data.run.stopped, 'state_changed');
    assert.deepEqual(shown.data.run.executed, [], 'nothing was executed in this call');
    assert.equal(f.uploads(), 1, 'the second run sent nothing');
    assert.equal(shown.data.step_id, 'upload-2');
    const review = shown.data.review;
    assert.ok(review?.review_id);
    assert.deepEqual(statuses(f, id), [
      ['upload-1', 'verified'],
      ['upload-2', 'review_ready'],
    ]);
    // Only an explicit execute_next with that review sends it, once.
    const done = await f.campaign({
      action: 'execute_next',
      id,
      review_id: review.review_id,
      idempotency_key: review.idempotency_key,
      confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.uploads(), 2);
  } finally {
    f.store.close();
  }
});

test('a push whose only remaining upload was refused for a changed state stops at once, and the refusal carries no claim', async () => {
  const f = fixture();
  try {
    const sources = [await upload(f.sources, 'a.png')],
      id = await approvedPush(f, [pushStep('upload-1', sources[0]!, accounts[0]!)]);
    f.behaviour.changeAfterPrepare = '101';
    const stopped = await f.campaign({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped).slice(0, 1200));
    assert.equal(stopped.data.run.stopped, 'state_changed');
    assert.deepEqual(stopped.data.run.next_call, {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
    assert.equal(f.uploads(), 0, 'nothing was sent');
    assert.equal(f.reviews(), 1, 'the upload was not prepared again by the run that met the refusal');
  } finally {
    f.store.close();
  }
});
