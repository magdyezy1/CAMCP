// MED-01 (review 2026-10-08): website uploads reserve what they declare, abandoned ones are released early (never past
// the absolute 30-minute deadline), an interrupted completion can be completed again, concurrent completions serialize,
// and an unfinished upload reports the parts it still needs so a resume sends only those.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {MediaSources, SOURCE_CHUNK_BYTES} from '../src/media-sources.js';
import {MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {WEBSITE_UPLOAD_IDLE_MS, WEBSITE_UPLOAD_TTL_MS} from '../src/media-retention.js';
import {sha256} from '../src/security.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {listenForFetch} from './http-listener.js';
import {operationsHealth} from '../src/operations-health.js';
import type {Actor, JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 41).toString('base64'),
  member = (userId: string, tenantId = 't'): Actor => ({tenantId, userId, role: 'operator'}),
  operator = member('u'),
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
const stagedExpiry = (store: Store, id: string) =>
  (store.db.prepare('SELECT expires_at FROM media_staging WHERE id=?').get(id) as {expires_at: number} | undefined)
    ?.expires_at;
/** Moves an upload's start back, so its absolute deadline is `remaining` milliseconds away. */
function age(store: Store, actor: Actor, id: string, remaining: number) {
  const {revision: _revision, id: _id, ...record} = store.document(actor.tenantId, 'media_source', id);
  store.putDocument(actor.tenantId, 'media_source', id, {
    ...record,
    created_at: Date.now() - WEBSITE_UPLOAD_TTL_MS + remaining,
    expires_at: Date.now() + remaining,
  });
}

test('abandoned-upload-quota-lock regression: unfinished website uploads reserve their declared size', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true);
    // Before the fix each begun upload counted the whole media limit: four 1-byte uploads filled the workspace and
    // the fifth begin was refused MEDIA_STAGING_FULL; four more elsewhere locked the whole deployment.
    for (let i = 0; i < 4; i++) sources.begin(operator, {filename: 'small.png', size: 1});
    assert.equal(sources.begin(operator, {filename: 'fifth.png', size: 1}).state, 'receiving');
    for (let i = 0; i < 4; i++) sources.begin(member('x', 'other'), {size: 1});
    assert.equal(sources.begin(member('y', 'third'), {size: 1}).state, 'receiving');
    // Every unfinished upload is listed with its progress and deadlines, so it can be resumed or discarded.
    const listed = sources.list(operator);
    assert.equal(listed.length, 5);
    for (const s of listed) {
      assert.equal(s.state, 'receiving');
      assert.equal(s.received_chunks, 0);
      assert.ok(Date.parse(String(s.released_if_idle_at)) <= Date.parse(String(s.expires_at)));
    }
  } finally {
    store.close();
  }
});

test('four limit-sized declared uploads still fill a workspace, and one workspace cannot exceed its share of AMCP', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      full = {size: MAX_MEDIA_BYTES},
      a = ['a1', 'a2', 'a3', 'a4'].map(id => member(id, 'a')),
      begun = a.map(m => sources.begin(m, full));
    assert.throws(() => sources.begin(member('a5', 'a'), {size: 1}), {code: 'MEDIA_STAGING_FULL', status: 429});
    // A second workspace fills its own share (four of the eight limits AMCP holds), then the deployment is full.
    for (const id of ['b1', 'b2', 'b3', 'b4']) sources.begin(member(id, 'b'), full);
    assert.throws(() => sources.begin(member('b5', 'b'), {size: 1}), {code: 'MEDIA_STAGING_FULL'});
    assert.throws(() => sources.begin(member('c1', 'c'), {size: 1}), {
      code: 'MEDIA_STAGING_FULL',
      message: /AMCP is holding as many uploaded files/,
    });
    // Discarding one unfinished upload frees its place at once.
    assert.equal(sources.remove(a[0]!, begun[0]!.source_id).removed, true);
    assert.equal(sources.begin(member('c1', 'c'), {size: 1}).state, 'receiving');
    // Each workspace's refusals are counted for its owner's operations health; the unauthenticated probe shows none.
    for (const tenant of ['a', 'b', 'c']) assert.equal(store.mediaCounters(tenant).staging_full_refusals, 1);
    assert.equal(operationsHealth(store, 'a').media.events_since_start.staging_full_refusals, 1);
    assert.equal('events_since_start' in store.mediaCleanupHealth, false);
  } finally {
    store.close();
  }
});

test('one member’s unfinished uploads hold at most their share, so a colleague can still upload', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true);
    sources.begin(operator, {size: MAX_MEDIA_BYTES});
    sources.begin(operator, {size: MAX_MEDIA_BYTES});
    assert.throws(() => sources.begin(operator, {size: 1}), {
      code: 'MEDIA_STAGING_FULL',
      details: {retry_after_ms: 60000, member_share: true},
    });
    assert.equal(sources.begin(member('colleague'), {size: MAX_MEDIA_BYTES}).state, 'receiving');
    // At most ten unfinished files per member, whatever their size.
    const other = member('many');
    for (let i = 0; i < 10; i++) sources.begin(other, {size: 1});
    assert.throws(() => sources.begin(other, {size: 1}), {
      code: 'MEDIA_STAGING_FULL',
      details: {retry_after_ms: 60000, member_share: true},
    });
  } finally {
    store.close();
  }
});

test('an unreadable reservation fails closed to the whole media limit', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      tampered = sources.begin(member('m1'), {size: 1});
    store.db.prepare('UPDATE media_staging SET reservation=? WHERE id=?').run('not-a-sealed-value', tampered.source_id);
    for (const id of ['m2', 'm3', 'm4']) sources.begin(member(id), {size: MAX_MEDIA_BYTES});
    // With the reservation readable this would fit (three limits and two bytes); unreadable, it counts the limit.
    assert.throws(() => sources.begin(member('m5'), {size: 1}), {code: 'MEDIA_STAGING_FULL'});
  } finally {
    store.close();
  }
});

test('an idle unfinished upload is released before its deadline, and parts never keep it past the deadline', () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      size = SOURCE_CHUNK_BYTES * 2,
      started = sources.begin(operator, {filename: 'big.png', size}),
      deadline = Date.parse(String(started.expires_at));
    const idle = stagedExpiry(store, started.source_id)!;
    assert.ok(idle <= Date.now() + WEBSITE_UPLOAD_IDLE_MS && idle < deadline);
    // A part is activity: the idle release moves on, but only up to the absolute deadline.
    age(store, operator, started.source_id, 60000);
    sources.put(operator, started.source_id, 0, Buffer.concat([png, randomBytes(SOURCE_CHUNK_BYTES - png.length)]));
    const record = store.document('t', 'media_source', started.source_id);
    assert.equal(stagedExpiry(store, started.source_id), record.created_at + WEBSITE_UPLOAD_TTL_MS);
    // Nothing more arrives: the idle release passes and the upload is gone, before its 30 minutes.
    store.db.prepare('UPDATE media_staging SET expires_at=? WHERE id=?').run(Date.now() - 1, started.source_id);
    assert.deepEqual(sources.list(operator), []);
    assert.throws(() => sources.status(operator, started.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.equal(store.documents('t', 'media_source').length, 0);
    assert.ok(store.mediaCounters('t').unfinished_uploads_released! >= 1);
  } finally {
    store.close();
  }
});

test('upload-resume regression: an unfinished upload reports its missing parts and refuses resume after the deadline', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      file = Buffer.concat([png, randomBytes(SOURCE_CHUNK_BYTES * 2 + 10 - png.length)]),
      part = (index: number) => file.subarray(index * SOURCE_CHUNK_BYTES, (index + 1) * SOURCE_CHUNK_BYTES),
      started = sources.begin(operator, {filename: 'three.png', size: file.length});
    sources.put(operator, started.source_id, 0, part(0));
    sources.put(operator, started.source_id, 2, part(2));
    const status = sources.status(operator, started.source_id);
    assert.deepEqual(status.received_parts, [0, 2]);
    assert.deepEqual(status.missing_parts, [1]);
    assert.equal(status.parts_sealed, false);
    assert.equal(status.first_part_sha256, sha256(part(0)));
    assert.equal(status.expires_at, started.expires_at, 'a resume never extends the deadline');
    // Only the missing part is sent; the completed file is byte-identical.
    sources.put(operator, started.source_id, 1, part(1));
    const done = await sources.complete(operator, started.source_id);
    assert.equal(done.sha256, sha256(file));
    assert.equal(sources.status(operator, started.source_id).state, 'complete');
    // A colleague cannot read another member's resume state.
    assert.throws(() => sources.status(member('colleague'), started.source_id), {code: 'FORBIDDEN'});
    // After the absolute deadline the upload cannot be resumed.
    const late = sources.begin(operator, {filename: 'late.png', size: file.length});
    sources.put(operator, late.source_id, 0, part(0));
    age(store, operator, late.source_id, -1);
    assert.throws(() => sources.status(operator, late.source_id), {code: 'MEDIA_SOURCE_NOT_FOUND'});
    assert.throws(() => sources.put(operator, late.source_id, 1, part(1)), {code: 'MEDIA_SOURCE_NOT_FOUND'});
  } finally {
    store.close();
  }
});

test('interrupted-completion regression: an upload whose completion stopped after sealing completes again', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      started = sources.begin(operator, {filename: 'creative.png', size: png.length});
    sources.put(operator, started.source_id, 0, png);
    // A completion that wrote the manifest and then stopped (deploy, crash) before inspection and finish.
    store.finalizeMediaChunks('t', started.source_id, {chunks: 1, size: png.length, chunkBytes: SOURCE_CHUNK_BYTES});
    const status = sources.status(operator, started.source_id);
    assert.equal(status.state, 'receiving');
    assert.equal(status.parts_sealed, true);
    assert.throws(() => sources.file(operator, started.source_id), {code: 'MEDIA_UPLOAD_INCOMPLETE'});
    // Before the fix a part or a completion then returned MEDIA_UPLOAD_COMPLETE for the rest of the 30 minutes.
    assert.throws(() => sources.put(operator, started.source_id, 0, png), {code: 'MEDIA_UPLOAD_COMPLETING'});
    const done = await sources.complete(operator, started.source_id);
    assert.equal(done.state, 'complete');
    assert.equal(done.sha256, sha256(png));
    assert.deepEqual(sources.file(operator, started.source_id).bytes, png);
  } finally {
    store.close();
  }
});

test('concurrent completions of one upload serialize: one checks the file, the other is told to complete again', async () => {
  const store = new Store(':memory:', key);
  try {
    const sources = new MediaSources(store, true),
      started = sources.begin(operator, {filename: 'creative.png', size: png.length});
    sources.put(operator, started.source_id, 0, png);
    const [first, second] = await Promise.allSettled([
      sources.complete(operator, started.source_id),
      sources.complete(operator, started.source_id),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.equal((second as PromiseRejectedResult).reason.code, 'MEDIA_UPLOAD_COMPLETING');
    assert.equal((second as PromiseRejectedResult).reason.retryable, true);
    // Completing again afterwards returns the finished upload; it was added once.
    assert.equal((await sources.complete(operator, started.source_id)).state, 'complete');
    const added = store.db
      .prepare('SELECT event FROM audit')
      .all()
      .map(r => JSON.parse(String(r.event)) as JsonObject)
      .filter(e => e.event === 'media_source_added');
    assert.equal(added.length, 1);
  } finally {
    store.close();
  }
});

test('the website reports an unfinished upload’s received parts behind the session, with the server clock', async () => {
  const master = Buffer.alloc(32, 43).toString('base64'),
    password = 'synthetic-test-password-only',
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    listener = await listenForFetch(
      createHttpApp(service, store, {website: {origin, masterKey: master, adminPassword: password}}),
    ),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    const login = await fetch(base + '/api/session', {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({password}),
      }),
      cookie = login.headers.get('set-cookie')!.split(';')[0]!,
      csrf = (await login.json()).csrf,
      json = {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': csrf},
      file = Buffer.concat([png, randomBytes(SOURCE_CHUNK_BYTES * 2 - png.length + 5)]);
    const started = await (
      await fetch(base + '/api/media/sources', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({filename: 'resume.png', size: file.length, type: 'image/png'}),
      })
    ).json();
    assert.ok(Math.abs(Date.parse(started.server_time) - Date.now()) < 60000);
    const sent = await fetch(base + '/api/media/sources/' + started.source_id + '/parts/1', {
      method: 'PUT',
      headers: {...json, 'Content-Type': 'application/octet-stream'},
      body: new Uint8Array(file.subarray(SOURCE_CHUNK_BYTES, SOURCE_CHUNK_BYTES * 2)),
    });
    assert.equal(sent.status, 200);
    const status = await fetch(base + '/api/media/sources/' + started.source_id, {headers: {Cookie: cookie}}),
      body = await status.json();
    assert.equal(status.status, 200, JSON.stringify(body));
    assert.deepEqual(body.received_parts, [1]);
    assert.deepEqual(body.missing_parts, [0, 2]);
    assert.equal(body.first_part_sha256, null);
    assert.ok(body.server_time);
    // Without the session the state is not readable; discarding uses the ordinary CSRF-checked removal.
    assert.equal((await fetch(base + '/api/media/sources/' + started.source_id)).status, 401);
    const discarded = await fetch(base + '/api/media/sources/' + started.source_id, {
      method: 'DELETE',
      headers: json,
      body: '{}',
    });
    assert.equal(discarded.status, 200);
    assert.equal(
      (await fetch(base + '/api/media/sources/' + started.source_id, {headers: {Cookie: cookie}})).status,
      404,
    );
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
