import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {downloadDriveMedia, MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {downloadMediaLink, type LinkRequest} from '../src/media-link.js';
import {downloadPrivateDrive, driveGateway} from '../src/private-drive.js';
import {MEDIA_IDLE_MS, mediaDeadlineMs, readMediaBody, type MediaSink} from '../src/media-buffer.js';
import {MEDIA_LEASE_MS, Store} from '../src/store.js';
import {CredentialProvider} from '../src/auth.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import type {Actor} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
import {confirmationPage, counting, drive, file, html, png, share} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, item 3 (2026-11-19): a download that stops sending data is given up on after an idle
 * time, a download that keeps trickling is given up on at its overall bound, and in every case the lease is released and
 * the staged chunks are removed. The bound is the larger of 45 seconds and the media limit read at 2 MiB a second, at most
 * 15 minutes (MEDIA-SIZE-AND-COMPRESSOR-DESIGN 5.3), so a large file that is arriving is not cut at 45 seconds.
 */
const key = Buffer.alloc(32, 54).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  MiB = 1024 * 1024,
  /** One turn of the event loop that mock timers do not touch. */
  turn = () => new Promise<void>(resolve => setImmediate(resolve));
/**
 * A body the test feeds by hand, one piece at a time. It asks for no more than a reader has asked for (highWaterMark 0), so
 * `waitingForAByte` says the reader is waiting with its idle time running, and `send` answers it.
 */
function controlled() {
  const state = {waiting: false, cancelled: false};
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        state.waiting = true;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    {highWaterMark: 0},
  );
  return {
    response: new Response(body, {headers: {'Content-Type': 'application/octet-stream'}}),
    state,
    async waitingForAByte() {
      for (let i = 0; i < 5000 && !state.waiting; i++) await turn();
      assert.ok(state.waiting, 'the reader never started to wait for a byte');
    },
    send(piece: number | Uint8Array) {
      state.waiting = false;
      controller.enqueue(typeof piece === 'number' ? new Uint8Array(piece) : piece);
    },
    end() {
      controller.close();
    },
  };
}

interface Shape {
  /** The chunks sent at once, before the stream does anything else. */
  first?: number;
  /** After the first chunks: send `trickle` bytes every `every` ms for ever (a slow but moving stream), or nothing (stalled). */
  trickle?: {bytes: number; every: number};
}
/** A body that sends `first` bytes, then stalls, or trickles; it records how much it sent and whether it was cancelled. */
function stream(shape: Shape = {}, headers: Record<string, string> = {}) {
  const state = {sent: 0, cancelled: false, waiting: false, started: Date.now()};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstSent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!firstSent && shape.first !== undefined) {
        firstSent = true;
        state.sent += shape.first;
        controller.enqueue(new Uint8Array(shape.first));
        return;
      }
      state.waiting = true;
      if (!shape.trickle) return new Promise<void>(() => {});
      return new Promise<void>(resolve => {
        timer = setTimeout(() => {
          state.sent += shape.trickle!.bytes;
          controller.enqueue(new Uint8Array(shape.trickle!.bytes));
          resolve();
        }, shape.trickle!.every);
      });
    },
    cancel() {
      state.cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });
  return {response: new Response(body, {headers: {'Content-Type': 'application/octet-stream', ...headers}}), state};
}

test('the idle time is shorter than the 45 seconds a media lease lasts without progress, and the bound scales with the limit', () => {
  assert.equal(MEDIA_IDLE_MS, 30000);
  assert.ok(MEDIA_IDLE_MS < MEDIA_LEASE_MS);
  // 45 seconds at least; the limit read at 2 MiB a second; 15 minutes at most.
  assert.equal(mediaDeadlineMs(32 * MiB), 45000);
  assert.equal(mediaDeadlineMs(90 * MiB), 45000);
  assert.equal(mediaDeadlineMs(128 * MiB), 64000);
  assert.equal(mediaDeadlineMs(256 * MiB), 128000);
  assert.equal(mediaDeadlineMs(512 * MiB), 256000);
  assert.equal(mediaDeadlineMs(4096 * MiB), 900000);
  assert.equal(
    mediaDeadlineMs(MAX_MEDIA_BYTES),
    Math.min(900000, Math.max(45000, (MAX_MEDIA_BYTES / (2 * MiB)) * 1000)),
  );
});

test('a stream that stops sending is given up on after the idle time, with the bytes already staged left to the caller to remove', async () => {
  const stalled = stream({first: 4096}),
    {sink, written} = counting(),
    began = Date.now(),
    e = await refusal(readMediaBody(stalled.response, MAX_MEDIA_BYTES, sink, {idleMs: 40}));
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /stopped sending data/);
  assert.equal(stalled.state.cancelled, true);
  assert.equal(written(), 4096);
  assert.ok(Date.now() - began < 5000, 'took ' + (Date.now() - began) + ' ms');
});
test('every chunk restarts the idle time: gaps that are each under it are not idle, though the whole is over it', async () => {
  // Mock timers, so no real time decides it: four chunks 25 seconds apart take 100 seconds, over the 30-second idle time.
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const moving = controlled(),
      received: number[] = [],
      sink: MediaSink = {write: bytes => void received.push(bytes.length), finish: () => Buffer.alloc(0)},
      done = readMediaBody(moving.response, 10_000, sink);
    for (let i = 0; i < 4; i++) {
      await moving.waitingForAByte();
      mock.timers.tick(25_000);
      moving.send(100);
    }
    await moving.waitingForAByte();
    moving.end();
    await done;
    assert.deepEqual(received, [100, 100, 100, 100]);
    // And the same stream, left to wait the whole idle time, is given up on: the clock above was real, not skipped.
    const idle = controlled(),
      given = refusal(readMediaBody(idle.response, 10_000));
    await idle.waitingForAByte();
    mock.timers.tick(MEDIA_IDLE_MS);
    assertRefused(await given, 'MEDIA_DOWNLOAD_FAILED');
  } finally {
    mock.timers.reset();
  }
});
test('a stream that keeps trickling is given up on at its overall bound, which is its own sentence', async () => {
  const trickling = stream({trickle: {bytes: 10, every: 10}}),
    began = Date.now(),
    e = await refusal(
      readMediaBody(trickling.response, MAX_MEDIA_BYTES, undefined, {idleMs: 5000, signal: AbortSignal.timeout(150)}),
    );
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /took too long/);
  assert.equal(trickling.state.cancelled, true);
  assert.ok(Date.now() - began < 5000, 'took ' + (Date.now() - began) + ' ms');
});
test('the overall bound also ends a stream that has stopped, before its idle time passes', async () => {
  const stalled = stream({first: 10}),
    began = Date.now(),
    e = await refusal(
      readMediaBody(stalled.response, MAX_MEDIA_BYTES, undefined, {idleMs: 5000, signal: AbortSignal.timeout(80)}),
    );
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /took too long/);
  assert.equal(stalled.state.cancelled, true);
  assert.ok(Date.now() - began < 2500, 'took ' + (Date.now() - began) + ' ms');
});
test('a bound that has already passed ends the download before a byte is read', async () => {
  const e = await refusal(readMediaBody(new Response(png), MAX_MEDIA_BYTES, undefined, {signal: AbortSignal.abort()}));
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /took too long/);
});
test('a source that never answers its cancel does not hold the download open', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel: () => new Promise<void>(() => {}),
    }),
  );
  const began = Date.now(),
    e = await refusal(readMediaBody(response, MAX_MEDIA_BYTES, undefined, {idleMs: 40}));
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /stopped sending data/);
  assert.ok(Date.now() - began < 2500, 'took ' + (Date.now() - began) + ' ms');
});
test('a body that fails while it is read is a failed download, not a crash', async () => {
  const broken = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'));
      },
    }),
  );
  const e = await refusal(readMediaBody(broken, MAX_MEDIA_BYTES));
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /stopped before the whole file arrived/);
});

test('a public Drive download that stalls is given up on, and so is one that trickles past the bound', async () => {
  const stalled = stream({first: 2048}),
    a = await refusal(
      downloadDriveMedia(share, drive(confirmationPage, () => stalled.response).fetcher, counting().sink, {
        idleMs: 40,
        overallMs: 250,
      }),
    );
  assertRefused(a, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(a.message, /stopped sending data/);
  assert.equal(stalled.state.cancelled, true);
  // A trickle every 10 ms is far inside a 5-second idle time, so only the overall bound can end it.
  const trickling = stream({trickle: {bytes: 10, every: 10}}),
    b = await refusal(
      downloadDriveMedia(share, drive(confirmationPage, () => trickling.response).fetcher, counting().sink, {
        idleMs: 5000,
        overallMs: 250,
      }),
    );
  assertRefused(b, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(b.message, /took too long/);
  assert.equal(trickling.state.cancelled, true);
});
test('a confirmation page that stalls while it is read is given up on too', async () => {
  const stalled = new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    }),
    html,
  );
  const e = await refusal(
    downloadDriveMedia(share, drive(() => stalled).fetcher, undefined, {idleMs: 40, overallMs: 250}),
  );
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /stopped sending data/);
});
test('a public Drive file that keeps arriving is not cut while its pieces keep coming, though the whole takes longer than the idle time', async () => {
  // Mock timers: the two pieces arrive 25 seconds apart, so the whole takes 50 seconds, over the 30-second idle time.
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const slow = controlled(),
      done = downloadDriveMedia(share, drive(() => slow.response).fetcher);
    for (const piece of [png.subarray(0, 40), png.subarray(40)]) {
      await slow.waitingForAByte();
      mock.timers.tick(25_000);
      slow.send(new Uint8Array(piece));
    }
    await slow.waitingForAByte();
    slow.end();
    assert.deepEqual((await done).bytes, png);
  } finally {
    mock.timers.reset();
  }
});

test('each download asks for the overall bound its limit gives, not a flat 45 seconds (the private Drive metadata keeps 45)', async () => {
  const asked: number[] = [],
    original = AbortSignal.timeout.bind(AbortSignal),
    store = new Store(':memory:', key),
    fileId = 'synPrivateIdAbcdef12',
    bound = mediaDeadlineMs(MAX_MEDIA_BYTES);
  mock.method(AbortSignal, 'timeout', (ms: number) => {
    asked.push(ms);
    return original(ms);
  });
  try {
    store.putConnection(
      {...operator, role: 'admin'},
      {
        id: 'drive',
        tenantId: operator.tenantId,
        gateway: driveGateway,
        accounts: [fileId],
        enabled: true,
        label: 'Synthetic Drive',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
      {accessToken: 'synthetic-drive'},
    );
    await downloadDriveMedia(share, drive(file).fetcher);
    assert.deepEqual(asked.splice(0), [bound]);
    await downloadMediaLink('https://cdn.example.com/a.png', {request: async () => new Response(png)});
    assert.deepEqual(asked.splice(0), [bound]);
    await downloadPrivateDrive(
      store,
      new CredentialProvider(store),
      operator,
      'drive',
      'https://drive.google.com/file/d/' + fileId + '/view',
      async u =>
        new URL(String(u)).searchParams.get('alt') === 'media'
          ? new Response(png)
          : new Response(
              JSON.stringify({
                id: fileId,
                size: String(png.length),
                mimeType: 'image/png',
                capabilities: {canDownload: true},
              }),
            ),
    );
    assert.deepEqual(asked.splice(0), [45000, bound]);
  } finally {
    mock.restoreAll();
    store.close();
  }
});
test('the private Drive file is read within its overall bound too: when the bound passes, a body that keeps moving is cut', async () => {
  const store = new Store(':memory:', key),
    fileId = 'synPrivateIdAbcdef12',
    original = AbortSignal.timeout.bind(AbortSignal),
    bound = new AbortController();
  let asked = 0;
  // The metadata's 45 seconds are the real signal; the file's bound is the one this test ends.
  mock.method(AbortSignal, 'timeout', (ms: number) => (++asked === 1 ? original(ms) : bound.signal));
  try {
    store.putConnection(
      {...operator, role: 'admin'},
      {
        id: 'drive',
        tenantId: operator.tenantId,
        gateway: driveGateway,
        accounts: [fileId],
        enabled: true,
        label: 'Synthetic Drive',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
      {accessToken: 'synthetic-drive'},
    );
    const trickling = stream({trickle: {bytes: 10, every: 10}}),
      fetcher: typeof fetch = async u =>
        new URL(String(u)).searchParams.get('alt') === 'media'
          ? trickling.response
          : new Response(
              JSON.stringify({id: fileId, size: String(MiB), mimeType: 'video/mp4', capabilities: {canDownload: true}}),
            );
    const ending = setTimeout(() => bound.abort(), 120),
      e = await refusal(
        downloadPrivateDrive(
          store,
          new CredentialProvider(store),
          operator,
          'drive',
          'https://drive.google.com/file/d/' + fileId + '/view',
          fetcher,
        ),
      );
    clearTimeout(ending);
    assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
    assert.match(e.message, /took too long/);
    assert.equal(trickling.state.cancelled, true);
  } finally {
    mock.restoreAll();
    store.close();
  }
});
test('a link import that stalls is given up on too', async () => {
  const stalled = stream({first: 1024}),
    request: LinkRequest = async () => stalled.response,
    e = await refusal(downloadMediaLink('https://cdn.example.com/a.mp4', {request, idleMs: 40, overallMs: 250}));
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.equal(stalled.state.cancelled, true);
});

/** The refusal a promise ends in; anything else, including success, fails the test. */
async function refusal(run: Promise<unknown>): Promise<MirrorError> {
  try {
    await run;
  } catch (e) {
    assert.ok(e instanceof MirrorError, 'a refusal (MirrorError), not ' + String(e));
    return e;
  }
  return assert.fail('expected a refusal');
}
/** Runs `action` under mock timers until `armed()` says the code under test is waiting, then lets the idle time pass. */
async function afterIdle<T>(action: Promise<T>, armed: () => boolean, ms = MEDIA_IDLE_MS): Promise<T> {
  for (let i = 0; i < 2000 && !armed(); i++) await turn();
  assert.ok(armed(), 'the download never started to wait');
  mock.timers.tick(ms);
  return action;
}

test('with the real idle time, a public Drive download through prepare that stalls leaves no staging, no chunk and no lease', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  const store = new Store(':memory:', key),
    providerCalls: string[] = [];
  try {
    store.putConnection(
      {...operator, role: 'admin'},
      {
        id: 'c',
        tenantId: operator.tenantId,
        gateway: 'meta_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    // Five MiB arrive first, so the encrypted staging holds a chunk when the stream stalls.
    const stalled = stream({first: 5 * MiB}),
      svc = new MirrorService(
        new Registry(),
        store,
        new NativeTransport((async input => {
          providerCalls.push(String(input));
          throw Error('no provider request is expected');
        }) as typeof fetch),
        undefined,
        {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
        drive(confirmationPage, () => stalled.response).fetcher,
      ),
      rows = (table: string) => (store.db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n,
      out = await afterIdle(
        svc.call('amcp_media', {action: 'prepare', platform: 'meta', account_id: '123', drive_url: share}, operator),
        () => stalled.state.waiting,
      );
    assertRefused(out, 'MEDIA_DOWNLOAD_FAILED', {writes: () => providerCalls.length});
    assert.match(out.error.message, /stopped sending data/);
    assert.equal(stalled.state.cancelled, true);
    assert.deepEqual(
      {staging: rows('media_staging'), chunks: rows('media_chunks'), admissions: rows('media_admissions')},
      {staging: 0, chunks: 0, admissions: 0},
    );
  } finally {
    mock.timers.reset();
    store.close();
  }
});
test('with the real idle time, a private Drive download that stalls is given up on', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  const store = new Store(':memory:', key),
    fileId = 'synPrivateIdAbcdef12',
    admin: Actor = {...operator, role: 'admin'};
  try {
    store.putConnection(
      admin,
      {
        id: 'drive',
        tenantId: operator.tenantId,
        gateway: driveGateway,
        accounts: [fileId],
        enabled: true,
        label: 'Synthetic Drive',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
      {accessToken: 'synthetic-drive'},
    );
    const stalled = stream({first: 1024}),
      fetcher: typeof fetch = async u =>
        new URL(String(u)).searchParams.get('alt') === 'media'
          ? stalled.response
          : new Response(
              JSON.stringify({id: fileId, size: String(MiB), mimeType: 'video/mp4', capabilities: {canDownload: true}}),
            ),
      e = await refusal(
        afterIdle(
          downloadPrivateDrive(
            store,
            new CredentialProvider(store),
            operator,
            'drive',
            'https://drive.google.com/file/d/' + fileId + '/view',
            fetcher,
          ),
          () => stalled.state.waiting,
        ),
      );
    assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
    assert.equal(stalled.state.cancelled, true);
  } finally {
    mock.timers.reset();
    store.close();
  }
});
test('with the real idle time, a link import that stalls is given up on', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const stalled = stream({first: 1024}),
      request: LinkRequest = async () => stalled.response,
      e = await refusal(
        afterIdle(downloadMediaLink('https://cdn.example.com/a.mp4', {request}), () => stalled.state.waiting),
      );
    assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
    assert.equal(stalled.state.cancelled, true);
  } finally {
    mock.timers.reset();
  }
});
