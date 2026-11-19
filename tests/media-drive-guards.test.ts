import test, {after, before, mock} from 'node:test';
import assert from 'node:assert/strict';
import {createGzip, gzipSync} from 'node:zlib';
import {Readable} from 'node:stream';
import {downloadDriveMedia, MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import type {Actor} from '../src/types.js';
import {listenForFetch} from './http-listener.js';
import {assertRefused} from './helpers/assert-refused.js';
import {confirmationPage, counting, drive, hosts, html, noOutboundFetch, png, share} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, item 6 (2026-11-19): the guards of the download that the fix must not loosen.
 * They are the ones tests/media-upload.test.ts pins without a code (a sign-in page, the metadata address, both oversized
 * streams), now with the refusal each must carry and the one request it may cost; the limit's exact edge; a gzip body that
 * expands past the limit; and a redirect after the confirmation to a host outside the allow-list, with nothing left staged.
 */
// Nothing in this file may reach Drive or the internet: any host but this machine fails the test (the gzip server is local).
before(() => noOutboundFetch());
after(() => mock.restoreAll());
const key = Buffer.alloc(32, 58).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  MiB = 1024 * 1024;
async function refusal(run: Promise<unknown>): Promise<MirrorError> {
  try {
    await run;
  } catch (e) {
    assert.ok(e instanceof MirrorError, 'a refusal (MirrorError), not ' + String(e));
    return e;
  }
  return assert.fail('expected a refusal');
}
/** `total` bytes that begin like a PNG, in 1 MiB pieces, with no declared length; it records what was pulled. */
function image(total: number) {
  const sent = {pulled: 0, cancelled: false},
    piece = new Uint8Array(MiB);
  piece.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent.pulled >= total) return controller.close();
      const n = Math.min(MiB, total - sent.pulled);
      controller.enqueue(sent.pulled === 0 ? piece.subarray(0, n) : new Uint8Array(n));
      sent.pulled += n;
    },
    cancel() {
      sent.cancelled = true;
    },
  });
  return {response: () => new Response(stream, {headers: {'Content-Type': 'application/octet-stream'}}), sent};
}

test('the four guards of the old test still refuse, each with its own code and after one request', async () => {
  const cases: [string, () => Response, string][] = [
    ['a sign-in page', () => new Response('<html>Login</html>', html), 'DRIVE_FILE_UNAVAILABLE'],
    [
      'a redirect to the metadata address',
      () => new Response(null, {status: 302, headers: {Location: 'http://169.254.169.254/latest/meta-data/'}}),
      'UNAPPROVED_MEDIA_SOURCE',
    ],
    [
      'a declared length over the limit',
      () => new Response('x', {headers: {'Content-Length': String(MAX_MEDIA_BYTES + 1)}}),
      'MEDIA_TOO_LARGE',
    ],
    ['a stream over the limit', () => image(MAX_MEDIA_BYTES + 1).response(), 'MEDIA_TOO_LARGE'],
  ];
  for (const [name, reply, code] of cases) {
    const {fetcher, requests} = drive(reply);
    assertRefused(await refusal(downloadDriveMedia(share, fetcher)), code);
    assert.equal(requests.length, 1, name);
  }
});

test('the limit is exact: a file of the limit’s size imports, and one byte more is cut at the limit', async () => {
  const exact = image(MAX_MEDIA_BYTES),
    kept = counting(),
    got = await downloadDriveMedia(share, drive(() => exact.response()).fetcher, kept.sink);
  assert.equal(got.kind, 'image');
  assert.equal(kept.written(), MAX_MEDIA_BYTES);
  const over = image(MAX_MEDIA_BYTES + 1),
    cut = counting(),
    e = await refusal(downloadDriveMedia(share, drive(() => over.response()).fetcher, cut.sink));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
  assert.ok(cut.written() <= MAX_MEDIA_BYTES, 'the sink held ' + cut.written() + ' bytes');
  // The byte over the limit is the stream's last: it is refused before it is written, and there is nothing left to cancel
  // (a stream far past the limit is cancelled, in the next test).
  assert.equal(over.sent.pulled, MAX_MEDIA_BYTES + 1);
});
test('a stream far past the limit is cut where it passes it, not read to its end', async () => {
  const long = image(MAX_MEDIA_BYTES + 64 * MiB),
    cut = counting(),
    e = await refusal(downloadDriveMedia(share, drive(() => long.response()).fetcher, cut.sink));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.ok(cut.written() <= MAX_MEDIA_BYTES);
  assert.ok(long.sent.pulled <= MAX_MEDIA_BYTES + 3 * MiB, 'pulled ' + long.sent.pulled);
  assert.equal(long.sent.cancelled, true);
});

/** A local server that answers every request with a gzip body, standing in for Drive's host under the real fetch. */
async function gzipServer(body: () => Readable | Buffer) {
  const listener = await listenForFetch((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip'});
      const content = body();
      if (Buffer.isBuffer(content)) res.end(content);
      else content.pipe(createGzip()).pipe(res);
    }),
    port = (listener.address() as {port: number}).port;
  return {
    // The real fetch, which decodes Content-Encoding, against the local address.
    fetcher: ((_input: unknown, init?: RequestInit) => fetch('http://127.0.0.1:' + port + '/', init)) as typeof fetch,
    close: async () => {
      const closed = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closed;
    },
  };
}
test('the limit counts decoded bytes: a gzip body that expands past it is cut, and a small gzip file still imports', async () => {
  const bomb = await gzipServer(() =>
    Readable.from(
      (function* () {
        const zeros = Buffer.alloc(MiB);
        for (let sent = 0; sent < MAX_MEDIA_BYTES + 64 * MiB; sent += MiB) yield zeros;
      })(),
    ),
  );
  try {
    const cut = counting(),
      e = await refusal(downloadDriveMedia(share, bomb.fetcher, cut.sink));
    assertRefused(e, 'MEDIA_TOO_LARGE');
    assert.ok(cut.written() > 0 && cut.written() <= MAX_MEDIA_BYTES, 'the sink held ' + cut.written() + ' bytes');
  } finally {
    await bomb.close();
  }
  // The control: the same server and the same fetch decode a small gzip body into the file it holds.
  const small = await gzipServer(() => gzipSync(png));
  try {
    assert.deepEqual((await downloadDriveMedia(share, small.fetcher)).bytes, png);
  } finally {
    await small.close();
  }
});

test('prepare with a redirect after the confirmation to a host outside the allow-list is refused, and nothing is staged', async () => {
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
    const stand = drive(
        confirmationPage,
        () => new Response(null, {status: 302, headers: {Location: 'https://attacker.invalid/file.mp4'}}),
      ),
      svc = new MirrorService(
        new Registry(),
        store,
        new NativeTransport((async input => {
          providerCalls.push(String(input));
          throw Error('no provider request is expected');
        }) as typeof fetch),
        undefined,
        {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
        stand.fetcher,
      ),
      out = await svc.call(
        'amcp_media',
        {action: 'prepare', platform: 'meta', account_id: '123', drive_url: share},
        operator,
      ),
      rows = (table: string) => (store.db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n;
    assertRefused(out, 'UNAPPROVED_MEDIA_SOURCE', {writes: () => providerCalls.length});
    assert.deepEqual(hosts(stand.requests), [
      'https://drive.usercontent.google.com',
      'https://drive.usercontent.google.com',
    ]);
    assert.deepEqual(
      {staging: rows('media_staging'), chunks: rows('media_chunks'), admissions: rows('media_admissions')},
      {staging: 0, chunks: 0, admissions: 0},
    );
  } finally {
    store.close();
  }
});
