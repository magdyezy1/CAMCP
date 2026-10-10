// MED-02 Stage C (review 2026-10-08): media admission reserves for the file's size instead of one worst-case
// operation, so small operations of different workspaces run together while two maximum-sized videos still take turns;
// one workspace holds at most its share of the operation slots, a large operation that waits is not starved by small
// ones, and a media child process can be held to an address-space limit. Before this one operation of any size held
// the whole budget: a 1 KB image in one workspace refused every other workspace's media work.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {WEBSITE_UPLOAD_TTL_MS} from '../src/media-retention.js';
import {mediaProcessCommand} from '../src/media-variants.js';
import {operationsHealth} from '../src/operations-health.js';
import {sha256} from '../src/security.js';
import type {Actor} from '../src/types.js';

const key = Buffer.alloc(32, 59).toString('base64'),
  mib = 1048576,
  png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
const busy = (fn: () => unknown) => assert.throws(fn, {code: 'MEDIA_MEMORY_BUSY', status: 429, retryable: true});

test('global-media-admission-serialization regression: small operations of two workspaces run together', async () => {
  const store = new Store(':memory:', key);
  try {
    // Another workspace is in the middle of a 1 MiB image operation.
    const held = store.mediaAdmission('first', mib);
    assert.equal(held.bytes, 64 * mib, 'six copies of the file, at least the 64 MiB floor');
    // This workspace prepares its own small image from an upload at the same time; before the fix it got
    // MEDIA_MEMORY_BUSY because every operation reserved six times the media limit.
    const actor: Actor = {tenantId: 'second', userId: 'u', role: 'admin'},
      id = 'src-' + randomUUID(),
      now = Date.now();
    store.ensureTenant(actor.tenantId);
    store.putConnection(
      actor,
      {
        id: 'login',
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        writeAccounts: ['100'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    store.reserveMediaSource(actor.tenantId, id, now + WEBSITE_UPLOAD_TTL_MS);
    store.stageMedia(actor.tenantId, id, png);
    store.putDocument(actor.tenantId, 'media_source', id, {
      user_id: actor.userId,
      filename: 'small.png',
      origin: 'upload',
      state: 'complete',
      size: png.length,
      mime: 'image/png',
      kind: 'image',
      sha256: sha256(png),
      created_at: now,
      expires_at: now + WEBSITE_UPLOAD_TTL_MS,
      inspection: 'unavailable',
    });
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => Response.json({id: 'act_100', account_status: 1, currency: 'USD'})),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    const prepared = await service.call(
      'amcp_media',
      {action: 'prepare', source_id: id, platform: 'meta', account_id: '100', connection_id: 'login'},
      actor,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared));
    held.release();
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM media_admissions WHERE id NOT LIKE 'wait:%'").get()!.n, 0);
  } finally {
    store.close();
  }
});

test('two maximum-sized videos still take turns under the default budget; a file of unknown size reserves the worst case', () => {
  const store = new Store(':memory:', key);
  try {
    const first = store.mediaAdmission('a', MAX_MEDIA_BYTES);
    assert.equal(first.bytes, 6 * MAX_MEDIA_BYTES);
    busy(() => store.mediaAdmission('b', MAX_MEDIA_BYTES));
    busy(() => store.mediaAdmission('c', mib));
    first.release();
    // A link or Drive file not downloaded yet has no known size: it reserves the whole worst case.
    const unknown = store.mediaAdmission('b');
    assert.equal(unknown.bytes, 6 * MAX_MEDIA_BYTES);
    busy(() => store.mediaAdmission('c', 1));
    unknown.release();
    // c is still waiting (for 20 seconds), so its place is left free; then c runs.
    store.mediaAdmission('c', 1).release();
    // Raising the budget by configuration admits two at once.
    const previous = process.env.AMCP_MEDIA_MEMORY_MB;
    process.env.AMCP_MEDIA_MEMORY_MB = String((12 * MAX_MEDIA_BYTES) / mib);
    try {
      const one = store.mediaAdmission('d', MAX_MEDIA_BYTES),
        two = store.mediaAdmission('e', MAX_MEDIA_BYTES);
      busy(() => store.mediaAdmission('f', 1));
      one.release();
      two.release();
    } finally {
      if (previous === undefined) delete process.env.AMCP_MEDIA_MEMORY_MB;
      else process.env.AMCP_MEDIA_MEMORY_MB = previous;
    }
  } finally {
    store.close();
  }
});

test('one workspace holds at most its share of the operation slots, and health shows the shared budget', () => {
  const store = new Store(':memory:', key);
  try {
    const mine = [1, 2, 3, 4].map(() => store.mediaAdmission('busy-workspace', 1024));
    assert.throws(
      () => store.mediaAdmission('busy-workspace', 1024),
      (e: any) =>
        e.code === 'MEDIA_MEMORY_BUSY' &&
        e.details.reason === 'workspace_share' &&
        e.details.workspace_operations === 4,
    );
    // Another workspace still gets a slot (four of the eight remain), up to the deployment's eight.
    const theirs = [1, 2, 3, 4].map(() => store.mediaAdmission('quiet-workspace', 1024));
    assert.throws(
      () => store.mediaAdmission('third-workspace', 1024),
      (e: any) => e.code === 'MEDIA_MEMORY_BUSY' && e.details.reason === 'operation_slots',
    );
    const health = operationsHealth(store, 'busy-workspace').media as Record<string, unknown>;
    assert.equal(health.active_operations, 4);
    assert.equal(health.reserved_bytes, 4 * 64 * mib);
    assert.equal(health.deployment_operations, 8);
    assert.equal(health.operation_slots, 8);
    assert.equal(health.workspace_operation_slots, 4);
    assert.equal(health.limit_bytes, 6 * MAX_MEDIA_BYTES);
    assert.ok(((health.events_since_start as Record<string, number>).memory_busy_refusals ?? 0) >= 1);
    mine[0]!.release();
    store.mediaAdmission('third-workspace', 1024).release();
    [...mine.slice(1), ...theirs].forEach(lease => lease.release());
  } finally {
    store.close();
  }
});

test('a large operation that waits is not starved by small ones, and its place lapses when it stops asking', t => {
  let now = 1_900_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:', key);
  try {
    const small = store.mediaAdmission('small-one', mib);
    // The video does not fit next to the image: it is refused and remembered as waiting.
    busy(() => store.mediaAdmission('video', MAX_MEDIA_BYTES));
    // A later small operation of another workspace would fit the bytes, but must leave the waiting video's place.
    busy(() => store.mediaAdmission('small-two', mib));
    small.release();
    now += 5000;
    const video = store.mediaAdmission('video', MAX_MEDIA_BYTES);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM media_admissions WHERE id='wait:video'").get()!.n, 0);
    busy(() => store.mediaAdmission('small-two', mib));
    video.release();
    // Nothing is waiting ahead of it now, so the small operation runs.
    store.mediaAdmission('small-two', mib).release();
    // A workspace that stops retrying holds its waiting place for 20 seconds only.
    const hold = store.mediaAdmission('small-one', mib);
    busy(() => store.mediaAdmission('video', MAX_MEDIA_BYTES));
    hold.release();
    busy(() => store.mediaAdmission('small-two', mib));
    now += 21000;
    store.mediaAdmission('small-two', mib).release();
  } finally {
    store.close();
  }
});

test('a media child process can be held to an address-space limit on Linux', () => {
  const args = ['-v', 'error', 'input.png'];
  assert.deepEqual(mediaProcessCommand('ffprobe', args, {}, 'linux'), ['ffprobe', args]);
  assert.deepEqual(mediaProcessCommand('ffmpeg', args, {AMCP_MEDIA_PROCESS_MEMORY_MB: '1024'}, 'linux'), [
    'prlimit',
    ['--as=1073741824', '--', 'ffmpeg', ...args],
  ]);
  assert.deepEqual(
    mediaProcessCommand(
      '/usr/bin/ffmpeg',
      args,
      {AMCP_MEDIA_PROCESS_MEMORY_MB: '512', AMCP_PRLIMIT_PATH: '/usr/bin/prlimit'},
      'linux',
    ),
    ['/usr/bin/prlimit', ['--as=536870912', '--', '/usr/bin/ffmpeg', ...args]],
  );
  // Another platform, or a value outside 64–16384 MiB, runs the binary directly as before.
  assert.deepEqual(mediaProcessCommand('ffmpeg', args, {AMCP_MEDIA_PROCESS_MEMORY_MB: '1024'}, 'win32'), [
    'ffmpeg',
    args,
  ]);
  for (const value of ['32', 'lots', '1.5', '20000'])
    assert.deepEqual(mediaProcessCommand('ffmpeg', args, {AMCP_MEDIA_PROCESS_MEMORY_MB: value}, 'linux'), [
      'ffmpeg',
      args,
    ]);
});
