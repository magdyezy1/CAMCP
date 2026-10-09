// MED-01 Stages C and D (review 2026-10-08): a transfer that cannot finish before its deadline is refused before any
// claim or provider request (UPLOAD_DEADLINE_TOO_CLOSE), and a claimed transfer gets its own window, so a qualified
// resume continues after the five-minute review but never after a website upload's absolute 30-minute deadline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256} from '../dist/src/security.js';
import {WEBSITE_UPLOAD_TTL_MS} from '../dist/src/media-retention.js';
import {
  MEDIA_TRANSFER_WINDOW_MS,
  mediaTransferDeadline,
  mediaTransferEstimateMs,
  mediaTransferSteps,
} from '../dist/src/media-upload.js';

const key = Buffer.alloc(32, 53).toString('base64'),
  actor = {tenantId: 'transfer-window', userId: 'owner', role: 'admin'},
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
  video = Buffer.alloc(5 * 1024 * 1024);
video.write('ftypisom', 4);

/** A completed website upload (`origin: upload`) started now, as media-sources.ts leaves it. */
function websiteSource(store, bytes, mime, kind) {
  const id = 'src-' + randomUUID(),
    now = Date.now();
  store.ensureTenant(actor.tenantId);
  store.reserveMediaSource(actor.tenantId, id, now + WEBSITE_UPLOAD_TTL_MS);
  store.stageMedia(actor.tenantId, id, bytes);
  store.putDocument(actor.tenantId, 'media_source', id, {
    user_id: actor.userId,
    filename: 'deadline.' + (kind === 'image' ? 'png' : 'mp4'),
    origin: 'upload',
    state: 'complete',
    size: bytes.length,
    mime,
    kind,
    sha256: sha256(bytes),
    created_at: now,
    expires_at: now + WEBSITE_UPLOAD_TTL_MS,
    inspection: 'unavailable',
  });
  return id;
}
function connect(store, gateway, account) {
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      label: 'Synthetic',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
}

test('a website upload too close to its deadline is refused before any claim or provider request', async t => {
  let now = 1900000000000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', key),
    requests = [];
  try {
    connect(store, 'meta_native_action', '100');
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async (url, init) => {
        requests.push({url: String(url), method: init?.method ?? 'GET'});
        if ((init?.method ?? 'GET') === 'GET')
          return Response.json({id: 'act_100', account_status: 1, currency: 'USD'});
        return Response.json({images: {one: {hash: 'fixturehash'}}});
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    const call = input => service.call('amcp_media', input, actor),
      prepare = id =>
        call({action: 'prepare', source_id: id, platform: 'meta', account_id: '100', connection_id: 'login'});
    const late = websiteSource(store, png, 'image/png', 'image'),
      deadline = now + WEBSITE_UPLOAD_TTL_MS;
    now = deadline - 12000;
    const prepared = await prepare(late);
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    const id = prepared.data.review_id,
      refused = await call({action: 'execute', review_id: id, idempotency_key: id, confirmed: true});
    assert.equal(refused.error.code, 'UPLOAD_DEADLINE_TOO_CLOSE', JSON.stringify(refused));
    assert.equal(refused.error.details.provider_requests_sent, false);
    assert.ok(refused.error.details.estimated_ms > refused.error.details.remaining_ms);
    assert.equal(requests.filter(r => r.method !== 'GET').length, 0, 'zero provider POSTs');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0, 'no claim');
    const recovery = await call({action: 'recovery', review_id: id});
    assert.equal(recovery.data.state, 'unsubmitted');
    assert.ok(store.mediaCounters(actor.tenantId).deadline_too_close_refusals >= 1);
    // A small image with ample time is unaffected, and its measured transfer is journaled without URLs or bytes.
    const early = websiteSource(store, png, 'image/png', 'image'),
      fresh = await prepare(early);
    assert.equal(fresh.success, true, JSON.stringify(fresh));
    const done = await call({
      action: 'execute',
      review_id: fresh.data.review_id,
      idempotency_key: fresh.data.review_id,
      confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(requests.filter(r => r.method !== 'GET').length, 1);
    const journal = store.operationJournal(actor.tenantId, fresh.data.review_id),
      responded = journal.events.find(e => e.phase === 'responded');
    assert.equal(typeof responded.transfer_ms, 'number');
    assert.equal(responded.total_bytes, png.length);
    assert.ok(!JSON.stringify(journal).includes('http'));
  } finally {
    store.close();
  }
});

test('transfer estimates count each platform’s provider requests and the window never outlasts a website deadline', () => {
  const mib = 1024 * 1024;
  assert.equal(mediaTransferSteps({platform: 'meta', kind: 'image'}, 100), 1);
  assert.equal(mediaTransferSteps({platform: 'snapchat', kind: 'image'}, 100), 2);
  assert.equal(mediaTransferSteps({platform: 'snapchat', kind: 'video', existing_media_id: 'm'}, 100), 1);
  assert.equal(mediaTransferSteps({platform: 'snapchat', kind: 'video'}, 64 * mib), 1 + 2 + 4);
  assert.equal(mediaTransferSteps({platform: 'x_ads', kind: 'video'}, 10 * mib), 3 + 3);
  assert.equal(mediaTransferSteps({platform: 'linkedin', kind: 'video'}, 128 * mib), 2 + 32);
  assert.equal(mediaTransferSteps({platform: 'google_ads', kind: 'video'}, 9 * mib), 1 + 3);
  assert.ok(
    mediaTransferEstimateMs({platform: 'linkedin', kind: 'video'}, 128 * mib) >
      mediaTransferEstimateMs({platform: 'linkedin', kind: 'video'}, mib),
  );
  const now = 1900000000000;
  assert.equal(mediaTransferDeadline({}, now), now + MEDIA_TRANSFER_WINDOW_MS);
  assert.equal(mediaTransferDeadline({upload_expires_at: now + 60000}, now), now + 60000);
});

/** A Google video transfer whose first attempt loses a nonfinal reply, leaving a resumable session. */
function googleVideo(store) {
  const counts = {starts: 0, finals: 0};
  let phase = 'initial';
  connect(store, 'google_ads_native_action', '123');
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        h = new Headers(init.headers);
      if (u.pathname.endsWith('/googleAds:search'))
        return Response.json({results: [{customer: {id: '123', currencyCode: 'USD'}}]});
      if (h.get('X-Goog-Upload-Command') === 'start') {
        counts.starts++;
        return new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://googleads.googleapis.com/resumable/upload/v25/session?upload_id=private',
            'x-goog-upload-chunk-granularity': '262144',
          },
        });
      }
      if (h.get('X-Goog-Upload-Command') === 'query') {
        if (phase === 'initial') throw Error('connection lost');
        return new Response(null, {headers: {'x-goog-upload-size-received': '4194304'}});
      }
      if (phase === 'initial') throw Error('lost nonfinal upload reply');
      counts.finals++;
      return Response.json({resourceName: 'customers/123/youTubeVideoUploads/456'});
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    async () => new Response(video),
  );
  return {
    service,
    counts,
    succeed: () => {
      phase = 'success';
    },
    call: input => service.call('amcp_media', input, actor),
  };
}

for (const origin of ['drive', 'website'])
  test('a ' + origin + ' video resumes after its five-minute review, within its transfer window only', async t => {
    let now = 1900000000000;
    t.mock.method(Date, 'now', () => now);
    for (const when of ['inside', 'after']) {
      const store = new Store(':memory:', key);
      try {
        const f = googleVideo(store),
          start = now,
          source =
            origin === 'drive'
              ? {drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view'}
              : {source_id: websiteSource(store, video, 'video/mp4', 'video')},
          prepared = await f.call({
            action: 'prepare',
            platform: 'google_ads',
            account_id: '123',
            connection_id: 'login',
            ...source,
          });
        assert.equal(prepared.success, true, JSON.stringify(prepared));
        const id = prepared.data.review_id,
          args = {review_id: id, idempotency_key: id, confirmed: true};
        assert.equal((await f.call({action: 'execute', ...args})).error.code, 'WRITE_OUTCOME_UNCERTAIN');
        const review = store.document(actor.tenantId, 'media_review', id),
          window = origin === 'drive' ? MEDIA_TRANSFER_WINDOW_MS : WEBSITE_UPLOAD_TTL_MS;
        assert.equal(review.transfer_expires_at, start + window);
        // Six minutes later the review itself has expired; before MED-01 Stage D the resume was refused here.
        now = when === 'inside' ? start + 6 * 60000 : start + window + 1;
        f.succeed();
        const recovery = await f.call({action: 'recovery', review_id: id});
        assert.equal(recovery.data.resume_available, when === 'inside', JSON.stringify(recovery.data));
        const resumed = await f.call({action: 'resume', ...args});
        if (when === 'inside') {
          assert.equal(resumed.success, true, JSON.stringify(resumed));
          assert.equal(resumed.data.media_id, 'customers/123/youTubeVideoUploads/456');
          assert.equal(f.counts.finals, 1);
        } else {
          assert.equal(resumed.success, false);
          // The window has passed: the review and its retained session are both refused.
          assert.ok(['REVIEW_EXPIRED', 'RECOVERY_NOT_SAFE'].includes(resumed.error.code), JSON.stringify(resumed));
          assert.equal(f.counts.finals, 0);
        }
        assert.equal(f.counts.starts, 1);
      } finally {
        store.close();
        now = 1900000000000;
      }
    }
  });
