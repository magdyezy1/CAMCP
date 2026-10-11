// MED-03 B (review 2026-10-08): an approved plan of independent uploads runs on the server (amcp_campaign
// run_background), so leaving the website stops nothing; one failed upload does not hold the others; busy media capacity
// waits instead of failing; a plan must leave five minutes before its temporary files are deleted (its run-by time);
// and an upload whose file expired gets a "replace source" amendment that reviews the new file. Before this the push ran
// in the open tab: leaving the page stopped the remaining rows and lost their status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import {SOURCE_CHUNK_BYTES, type MediaSources} from '../src/media-sources.js';
import {WEBSITE_UPLOAD_TTL_MS} from '../src/media-retention.js';
import {sha256} from '../src/security.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 59).toString('base64'),
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
  const transport = new NativeTransport((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    if (method === 'GET' && /\/act_\d+$/.test(url.pathname))
      return Response.json({id: url.pathname.split('/').pop(), account_status: 1, currency: 'USD'});
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
  const due = () => store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
  return {store, service, worker, campaign, due, uploads: () => uploads, sources: service.mediaSources()};
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
/** One upload of the push as the website saves it: "file → platform · account", bound to the planned SHA-256. */
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
/** Saves and approves a push plan exactly as the website does: approve, then confirm that plan_hash and summary_hash. */
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
  assert.ok(summary.data.approval, JSON.stringify(summary.data));
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

test('an approved push runs on the server: queued once, run by the worker, and its progress shows in get', async () => {
  const f = fixture();
  try {
    const sources = [await upload(f.sources, 'a.png'), await upload(f.sources, 'b.png')],
      id = await approvedPush(
        f,
        sources.map((s, i) => pushStep('upload-' + (i + 1), s, accounts[i]!)),
      );
    // The preflight of the approval checked each planned file against its original without preparing it.
    const preflight = plan(f, id).preflight;
    assert.deepEqual(
      preflight.checks.map((c: JsonObject) => [c.step, c.status, c.sha256]),
      [
        ['upload-1', 'media_checked', sources[0]!.sha256],
        ['upload-2', 'media_checked', sources[1]!.sha256],
      ],
    );
    assert.equal(f.store.documents('t', 'media_review').length, 0, 'the preflight staged no review');
    const queued = await f.campaign({action: 'run_background', id});
    assert.equal(queued.success, true, JSON.stringify(queued));
    assert.equal(queued.data.background.state, 'queued');
    assert.deepEqual(queued.data.next_call, {tool: 'amcp_campaign', arguments: {action: 'get', id}});
    // Asking again while it is queued returns the same run; nothing is queued twice.
    const again = await f.campaign({action: 'run_background', id});
    assert.equal(again.data.background.job_id, queued.data.background.job_id);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='campaign_run'").get()!.n, 1);
    assert.equal(f.uploads(), 0, 'queueing sends nothing');
    // The website is gone; the worker runs the plan under its approval, as the person who queued it.
    assert.equal(await f.worker.once(), true);
    assert.equal(f.uploads(), 2);
    const job = f.store.job('t', queued.data.background.job_id);
    assert.equal(job.state, 'complete', JSON.stringify(job));
    assert.equal(job.result.stopped, 'complete');
    const view = await f.campaign({action: 'get', id});
    assert.equal(view.data.state, 'complete');
    assert.equal(view.data.background.state, 'complete');
    assert.deepEqual(
      view.data.steps.map((s: JsonObject) => s.status),
      ['verified', 'verified'],
    );
    // Each upload kept its own frozen review and receipt; the full plan names each "file → platform · account".
    const full = await f.campaign({action: 'get', id, detail: 'full'});
    assert.equal(full.data.steps[0].description, 'a.png → Meta · 101');
    assert.equal(new Set(full.data.steps.map((s: JsonObject) => s.review_id)).size, 2);
    // A finished plan is not queued again.
    const done = await f.campaign({action: 'run_background', id});
    assert.equal(done.data.state, 'complete');
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='campaign_run'").get()!.n, 1);
  } finally {
    f.store.close();
  }
});

test('one failed upload holds none of the others, and a replacement file is reviewed again before it is sent', async () => {
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
    // The second file is gone before the run (deleted, or past its 30 minutes).
    await f.service.call('amcp_media', {action: 'remove_source', source_id: sources[1]!.source_id}, operator);
    const queued = await f.campaign({action: 'run_background', id});
    await f.worker.once();
    assert.equal(f.uploads(), 2, 'the first and third uploads were sent');
    const stored = plan(f, id);
    assert.deepEqual(
      stored.steps.map((s: JsonObject) => s.status),
      ['verified', 'failed', 'verified'],
    );
    assert.equal(stored.steps[1].error.code, 'MEDIA_SOURCE_NOT_FOUND');
    assert.equal(stored.state, 'attention');
    const job = f.store.job('t', queued.data.background.job_id);
    assert.equal(job.state, 'complete');
    assert.equal(job.result.attention, 1);
    assert.equal(job.result.remaining, 0);
    // The refusal's next call is the "replace source" amendment: plan the new file for this destination, then patch.
    const prepared = await f.campaign({action: 'prepare_next', id});
    assert.equal(prepared.data.blocked, true);
    const next = prepared.data.next_call;
    assert.equal(next.arguments.action, 'recover_step');
    assert.equal(next.arguments.step_id, 'upload-2');
    assert.equal(next.replace_source.current_source_id, sources[1]!.source_id);
    assert.equal(next.replace_source.plan_call.arguments.action, 'plan');
    assert.deepEqual(next.replace_source.plan_call.arguments.destinations, [
      {platform: 'meta', account_id: '102', connection_id: 'meta'},
    ]);
    assert.deepEqual(
      next.add_after_user_choice.patch.map((p: JsonObject) => p.path),
      ['/source_id', '/expected_sha256'],
    );
    // A placeholder or malformed value is refused; nothing changes.
    const placeholder = await f.campaign({
      ...next.arguments,
      patch: next.add_after_user_choice.patch,
    });
    assert.equal(placeholder.error.code, 'INVALID_ARGUMENT');
    // The member uploads the file again and plans it for this destination.
    const fresh = await upload(f.sources, 'b-again.png'),
      planned = await f.service.call(
        'amcp_media',
        {...next.replace_source.plan_call.arguments, source_id: fresh.source_id},
        operator,
      );
    assert.equal(planned.success, true, JSON.stringify(planned));
    // A temporary replacement in a plan that already acknowledged temporary files moves its run-by time.
    const replaced = await f.campaign({
      ...next.arguments,
      patch: [
        {path: '/source_id', value: fresh.source_id},
        {path: '/expected_sha256', value: planned.data.destinations[0].file.sha256},
      ],
    });
    assert.equal(replaced.success, true, JSON.stringify(replaced));
    const amended = plan(f, id);
    assert.equal(amended.steps[1].status, 'pending');
    assert.equal(amended.steps[1].arguments.source_id, fresh.source_id);
    assert.equal(amended.steps[1].previous_attempts.at(-1).error.code, 'MEDIA_SOURCE_NOT_FOUND');
    assert.ok(amended.temporary_sources.sources.some((s: JsonObject) => s.source_id === fresh.source_id));
    // The amendment voided the approval: the plan is reviewed again before anything is sent.
    assert.equal((await f.campaign({action: 'run_background', id})).error.code, 'APPROVAL_REQUIRED');
    const summary = await f.campaign({action: 'approve', id});
    await f.campaign({
      action: 'approve',
      id,
      plan_hash: summary.data.approval.plan_hash,
      summary_hash: summary.data.approval.summary_hash,
      confirmed: true,
    });
    assert.equal((await f.campaign({action: 'run_background', id})).success, true);
    await f.worker.once();
    assert.equal(f.uploads(), 3);
    const finished = plan(f, id);
    assert.equal(finished.state, 'complete');
    const review = f.store.document('t', 'media_review', finished.steps[1].review_id);
    assert.equal(review.plan.origin.source_id, fresh.source_id, 'the new file was reviewed and sent, not the old one');
  } finally {
    f.store.close();
  }
});

test('busy media capacity leaves the upload pending and the run waits; it continues once the capacity is free', async () => {
  const f = fixture();
  try {
    const source = await upload(f.sources, 'a.png'),
      id = await approvedPush(f, [pushStep('upload-1', source, '101')]);
    // Two reviews already fill this workspace's review staging (another push, or the member's own page).
    const later = Date.now() + 60000;
    f.store.reserveMedia('t', 'review-a', later);
    f.store.reserveMedia('t', 'review-b', later);
    const queued = await f.campaign({action: 'run_background', id});
    await f.worker.once();
    assert.equal(f.uploads(), 0);
    const waiting = f.store.job('t', queued.data.background.job_id);
    assert.equal(waiting.state, 'queued', 'a busy turn yields; it is not a failure');
    assert.equal(waiting.error.code, 'CAMPAIGN_RUN_CONTINUES');
    assert.ok(waiting.available_at > Date.now());
    const view = await f.campaign({action: 'get', id});
    assert.equal(view.data.background.state, 'running');
    assert.deepEqual(view.data.steps[0], {
      id: 'upload-1',
      kind: 'media',
      status: 'pending',
      waiting: 'MEDIA_STAGING_FULL',
    });
    assert.equal(
      (f.store.db.prepare('SELECT event FROM audit').all() as {event: string}[])
        .map(r => JSON.parse(r.event))
        .filter((e: JsonObject) => e.event === 'report_failed').length,
      0,
      'a yield is not audited as a failure',
    );
    f.store.removeStagedMedia('t', 'review-a');
    f.store.removeStagedMedia('t', 'review-b');
    f.due();
    await f.worker.once();
    assert.equal(f.uploads(), 1);
    assert.equal(plan(f, id).state, 'complete');
    assert.equal(plan(f, id).steps[0].busy, undefined);
    assert.equal(f.store.job('t', queued.data.background.job_id).state, 'complete');
  } finally {
    f.store.close();
  }
});

test('one background run per person at a time: a second plan waits for the first instead of staging beside it', async () => {
  const f = fixture();
  try {
    const first = await approvedPush(f, [pushStep('upload-1', await upload(f.sources, 'a.png'), '101')]),
      second = await approvedPush(f, [pushStep('upload-1', await upload(f.sources, 'b.png'), '102')]);
    // Another worker is running this person's first push.
    assert.equal(f.store.acquireLock('campaign-background:t:u', 'other-worker', 60000), true);
    const queued = await f.campaign({action: 'run_background', id: second});
    await f.worker.once();
    assert.equal(f.uploads(), 0);
    const job = f.store.job('t', queued.data.background.job_id);
    assert.equal(job.state, 'queued');
    assert.equal(job.error.details.reason, 'another_background_run');
    f.store.releaseLock('campaign-background:t:u', 'other-worker');
    f.due();
    await f.worker.once();
    assert.equal(f.uploads(), 1);
    assert.equal(plan(f, second).state, 'complete');
    assert.equal(plan(f, first).steps[0].status, 'pending', 'the first plan was not run by this job');
  } finally {
    f.store.close();
  }
});

test('run_background refuses an unapproved plan, a plan with other steps, and a deployment that turned it off', async () => {
  const f = fixture();
  try {
    const source = await upload(f.sources, 'a.png'),
      saved = await f.campaign({
        action: 'create',
        name: 'Unapproved push',
        brief: 'Upload only the previewed files.',
        acknowledge_temporary_sources: true,
        steps: [pushStep('upload-1', source, '101')],
      }),
      unapproved = await f.campaign({action: 'run_background', id: saved.data.id});
    assert.equal(unapproved.error.code, 'APPROVAL_REQUIRED');
    const mixed = await f.campaign({
      action: 'create',
      name: 'Upload and ad',
      brief: 'Upload, then create an ad.',
      acknowledge_temporary_sources: true,
      steps: [
        pushStep('upload-1', source, '101'),
        {
          id: 'ad',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: 'meta',
          account_id: '101',
          arguments: {action: 'meta_v25_ad_account_post_ads', payload: {name: 'Ad'}},
          depends_on: ['upload-1'],
        },
      ],
    });
    assert.equal(mixed.success, true, JSON.stringify(mixed));
    const refused = await f.campaign({action: 'run_background', id: mixed.data.id});
    assert.equal(refused.error.code, 'BACKGROUND_RUN_UNSUPPORTED');
    const id = await approvedPush(f, [pushStep('upload-1', source, '102')]);
    process.env.AMCP_SERVER_PUSH = 'false';
    try {
      const off = await f.campaign({action: 'run_background', id});
      assert.equal(off.error.code, 'BACKGROUND_RUN_DISABLED');
      assert.deepEqual(off.error.details.next_call, {tool: 'amcp_campaign', arguments: {action: 'run', id}});
      const list = await f.service.call('amcp_media', {action: 'list'}, operator);
      assert.equal(list.data.server_push, false, 'the website drives each row itself');
    } finally {
      delete process.env.AMCP_SERVER_PUSH;
    }
    assert.equal((await f.service.call('amcp_media', {action: 'list'}, operator)).data.server_push, true);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='campaign_run'").get()!.n, 0);
    assert.equal(f.uploads(), 0);
  } finally {
    f.store.close();
  }
});

/** A completed website upload that started `ago` milliseconds before now (MED-01 deadlines apply). */
function websiteSource(store: Store, ago: number): JsonObject {
  const id = 'src-' + randomUUID(),
    created = Date.now() - ago;
  store.reserveMediaSource('t', id, created + WEBSITE_UPLOAD_TTL_MS);
  store.stageMedia('t', id, png);
  store.putDocument('t', 'media_source', id, {
    user_id: operator.userId,
    filename: 'late.png',
    origin: 'upload',
    state: 'complete',
    size: png.length,
    mime: 'image/png',
    kind: 'image',
    sha256: sha256(png),
    created_at: created,
    expires_at: created + WEBSITE_UPLOAD_TTL_MS,
    inspection: 'unavailable',
  });
  return {source_id: id, sha256: sha256(png), filename: 'late.png', deadline: created + WEBSITE_UPLOAD_TTL_MS};
}

test('a plan must leave five minutes before its temporary files are deleted, and shows when it must run by', async () => {
  const f = fixture();
  try {
    const late = websiteSource(f.store, 26 * 60000),
      refused = await f.campaign({
        action: 'create',
        name: 'Late push',
        brief: 'Upload only the previewed files.',
        acknowledge_temporary_sources: true,
        steps: [pushStep('upload-1', late, '101')],
      });
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'TEMPORARY_SOURCES_EXPIRING');
    assert.equal(refused.error.details.minimum_minutes, 5);
    assert.equal(refused.error.details.temporary_sources[0].source_id, late.source_id);
    assert.equal(f.store.documents('t', 'campaign_run').length, 0);
    const timely = websiteSource(f.store, 10 * 60000),
      saved = await f.campaign({
        action: 'create',
        name: 'Timely push',
        brief: 'Upload only the previewed files.',
        acknowledge_temporary_sources: true,
        steps: [pushStep('upload-1', timely, '101')],
      });
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.run_by, new Date(timely.deadline).toISOString());
    // A replacement that would expire within five minutes is refused the same way.
    const {id: _id, revision, ...stored} = plan(f, saved.data.id);
    f.store.putDocument(
      't',
      'campaign_run',
      saved.data.id,
      {
        ...stored,
        steps: stored.steps.map((s: JsonObject) => ({...s, status: 'failed', error: {code: 'MEDIA_SOURCE_NOT_FOUND'}})),
      },
      revision,
    );
    const stillLate = await f.campaign({
      action: 'recover_step',
      id: saved.data.id,
      step_id: 'upload-1',
      confirmed: true,
      patch: [{path: '/source_id', value: websiteSource(f.store, 27 * 60000).source_id}],
    });
    assert.equal(stillLate.error.code, 'TEMPORARY_SOURCES_EXPIRING');
  } finally {
    f.store.close();
  }
});
