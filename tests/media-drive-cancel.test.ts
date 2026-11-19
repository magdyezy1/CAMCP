import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadDriveMedia, MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {readMediaBody, type MediaSink} from '../src/media-buffer.js';
import {MirrorError} from '../src/errors.js';
import {assertRefused} from './helpers/assert-refused.js';
import {drive, html, share, within} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, fix round 2, item 2 (S3-1 of the lead's security review, 2026-11-20): a download never
 * waits for its source to answer a cancel. Node's own fetch settles a cancel at once, but a fetch that is not Node's may hand
 * back a body whose source never does, and a download that waits for it holds its place in the shared media budget and its
 * connection for ever: neither the idle time nor the overall bound reaches a wait on a cancel. Each test below gives a body
 * whose cancel never settles to one place that cancels, and the download must end without it.
 *
 * Every wait is bounded: `within` turns a download that is still pending into a failed test, so a download that hangs fails
 * quickly and does not leave the run stuck.
 */
const KiB = 1024,
  /** The most a download that ends at once may take here; the idle and overall bounds of these tests are far longer. */
  quickly = 2000;

/** What the tests ask of a body: how many times it was cancelled, and how much was pulled from it. */
interface Pulled {
  cancels: number;
  pulled: number;
}
/**
 * A body whose source never answers a cancel (the promise `cancel()` returns never settles). With `chunk` it sends that many
 * bytes of text whenever it is asked; without, it sends nothing and never answers a read either.
 */
function stubbornBody(chunk?: number) {
  const state: Pulled = {cancels: 0, pulled: 0};
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk === undefined) return new Promise<void>(() => {});
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(97));
    },
    cancel() {
      state.cancels++;
      return new Promise<void>(() => {});
    },
  });
  return {body, state};
}
/** A reader that never answers a cancel on any call, and has nothing to read: what a fetch that is not Node's may hand back. */
function silentReader() {
  const state: Pulled = {cancels: 0, pulled: 0},
    reader = {
      read: () => new Promise<never>(() => {}),
      cancel: () => {
        state.cancels++;
        return new Promise<void>(() => {});
      },
      releaseLock: () => {},
    };
  return {
    state,
    response: {
      ok: true,
      status: 200,
      headers: new Headers(html.headers),
      body: {getReader: () => reader, cancel: reader.cancel},
    } as unknown as Response,
  };
}
async function refusal(run: Promise<unknown>, what: string): Promise<MirrorError> {
  try {
    await within(quickly, run, what);
  } catch (e) {
    assert.ok(e instanceof MirrorError, what + ': a refusal (MirrorError), not ' + String(e));
    return e;
  }
  return assert.fail(what + ': expected a refusal');
}

test('a page that passes the 64 KiB limit is refused at once, without waiting for its source to answer the cancel', async () => {
  const stuck = stubbornBody(16 * KiB),
    e = await refusal(
      downloadDriveMedia(share, drive(() => new Response(stuck.body, html)).fetcher, undefined, {
        idleMs: 60_000,
        overallMs: 120_000,
      }),
      'a page over the limit',
    );
  assertRefused(e, 'DRIVE_FILE_UNAVAILABLE');
  assert.equal(e.details.reason, 'unrecognized_page');
  assert.equal(stuck.state.cancels, 1);
  // It was cut where it passed the limit: the 16 KiB pieces are 4 of the 64 KiB and one more, and the stream's read-ahead.
  assert.ok(stuck.state.pulled <= 8 * 16 * KiB, 'pulled ' + stuck.state.pulled);
});

test('a page whose read fails is given up on at the idle time, though no cancel of its reader is ever answered', async () => {
  const silent = silentReader(),
    began = Date.now(),
    e = await refusal(
      downloadDriveMedia(share, drive(() => silent.response).fetcher, undefined, {idleMs: 60, overallMs: 120_000}),
      'a page that stops',
    );
  assertRefused(e, 'MEDIA_DOWNLOAD_FAILED');
  assert.match(e.message, /stopped sending data/);
  // The idle time ended it (60 ms), not the overall bound (two minutes) and not the test's own bound.
  assert.ok(Date.now() - began < quickly, 'took ' + (Date.now() - began) + ' ms');
  assert.ok(silent.state.cancels >= 1);
});

test('a file cut at the limit is refused at once, without waiting for its source to answer the cancel', async () => {
  const stuck = stubbornBody(4 * KiB),
    e = await refusal(
      readMediaBody(new Response(stuck.body), 1000, undefined, {idleMs: 60_000, signal: AbortSignal.timeout(120_000)}),
      'a stream over the limit',
    );
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(stuck.state.cancels, 1);
  // A sink that refuses a chunk ends the read the same way: the refusal is the sink's, and nothing waits for the cancel.
  const sinkStuck = stubbornBody(4 * KiB),
    sink: MediaSink = {
      write() {
        throw new MirrorError('REVIEW_EXPIRED', 'Media staging expired or was cancelled.');
      },
      finish: () => Buffer.alloc(0),
    },
    refused = await refusal(
      readMediaBody(new Response(sinkStuck.body), 1_000_000, sink, {idleMs: 60_000}),
      'a sink that refuses a chunk',
    );
  assertRefused(refused, 'REVIEW_EXPIRED');
  assert.equal(sinkStuck.state.cancels, 1);
});

// An answer the download does not read is dropped at once too: each of these is a place that cancels a body it never read.
const signIn = 'https://accounts.google.com/ServiceLogin',
  unread: [string, ResponseInit, string, string | undefined][] = [
    ['a redirect', {status: 302, headers: {Location: signIn}}, 'DRIVE_FILE_UNAVAILABLE', 'not_shared'],
    ['an HTTP 404', {status: 404}, 'DRIVE_FILE_UNAVAILABLE', 'not_shared'],
    [
      'a declared length over the limit',
      {headers: {'Content-Length': String(MAX_MEDIA_BYTES + 1)}},
      'MEDIA_TOO_LARGE',
      undefined,
    ],
  ];
for (const [name, init, code, reason] of unread)
  test(
    'a Drive answer that is ' + name + ' is dropped at once, without waiting for its source to answer the cancel',
    async () => {
      const stuck = stubbornBody(),
        e = await refusal(downloadDriveMedia(share, drive(() => new Response(stuck.body, init)).fetcher), name);
      assertRefused(e, code);
      assert.equal(e.details.reason, reason, name);
      assert.equal(stuck.state.cancels, 1, name);
    },
  );
test('the shared reader drops a body whose declared length is over its limit at once too', async () => {
  const stuck = stubbornBody(),
    e = await refusal(
      readMediaBody(new Response(stuck.body, {headers: {'Content-Length': '5000'}}), 1000),
      'a declared length over the limit, in the shared reader',
    );
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(stuck.state.cancels, 1);
});
