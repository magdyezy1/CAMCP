import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {downloadDriveMedia, MAX_MEDIA_BYTES} from '../src/drive-media.js';
import {readMediaBody} from '../src/media-buffer.js';
import {downloadMediaLink, type LinkRequest} from '../src/media-link.js';
import {downloadPrivateDrive, driveGateway} from '../src/private-drive.js';
import {CredentialProvider} from '../src/auth.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MediaSources} from '../src/media-sources.js';
import {MirrorError, errorResult} from '../src/errors.js';
import {createHttpApp} from '../server/http-app.js';
import type {Actor} from '../src/types.js';
import {listenForFetch} from './http-listener.js';
import {assertRefused} from './helpers/assert-refused.js';
import {confirmationPage, counting, drive, file, html, png, share, type Reply} from './helpers/drive-large.js';

/**
 * R2.5 field fix r25-media-drive-large, item 2 (2026-11-19): what a refused Drive download says. DRIVE_FILE_UNAVAILABLE
 * names why in a closed `reason` (not_shared, download_quota, flagged, unrecognized_page); a file that is too large says
 * "too large" with its size and the maximum (size_bytes when AMCP knows it, maximum_bytes); and every sentence has its
 * Arabic. All pages and sizes are synthetic and written by hand.
 */
const key = Buffer.alloc(32, 52).toString('base64'),
  operator: Actor = {tenantId: 't', userId: 'u', role: 'operator'},
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')) as Record<string, string>,
  slots = (text: string) =>
    [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
      .map(m => m[1])
      .sort()
      .join(',');
/** What a message says in the catalog's key space: the template of a parameterized message, else the message itself. */
const keyOf = (e: MirrorError) => e.localization?.key ?? e.message;
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
const mebibytes = (bytes: number) => +(Math.ceil((bytes * 10) / 1048576) / 10).toFixed(1) + ' MiB';

const quotaPage =
  '<html><head><title>Synthetic quota exceeded</title></head><body><p>Sorry, you can’t view or download this file at this time.</p>' +
  '<p>Too many users have viewed or downloaded this file recently. Please try accessing the file again later.</p></body></html>';
const flaggedPage =
  '<html><body><p>This file has been identified as malware or spam and cannot be downloaded.</p></body></html>';
const signInPage =
  '<html><body><p>You need access.</p><p>Request access, or switch to an account with access.</p></body></html>';
const status =
  (code: number, body = '<html><body><p>Synthetic.</p></body></html>'): Reply =>
  () =>
    new Response(body, {status: code, ...html});
const page200 =
  (body: string): Reply =>
  () =>
    new Response(body, html);
const redirect =
  (location: string): Reply =>
  () =>
    new Response(null, {status: 302, headers: {Location: location}});
const signIn =
  'https://accounts.google.com/ServiceLogin?service=wise&continue=https%3A%2F%2Fdrive.usercontent.google.com%2Fdownload';

const reasons: [string, Reply[], string, boolean][] = [
  ['a redirect to the sign-in page', [redirect(signIn)], 'not_shared', false],
  ['a permission page', [page200(signInPage)], 'not_shared', false],
  ['HTTP 401', [status(401)], 'not_shared', false],
  ['HTTP 404', [status(404)], 'not_shared', false],
  ['HTTP 410', [status(410)], 'not_shared', false],
  ['HTTP 403 with a page that names nothing', [status(403)], 'not_shared', false],
  ['a quota page', [page200(quotaPage)], 'download_quota', true],
  ['HTTP 429', [status(429)], 'download_quota', true],
  ['HTTP 403 with a quota page', [status(403, quotaPage)], 'download_quota', true],
  ['a quota page after the confirmation', [confirmationPage, page200(quotaPage)], 'download_quota', true],
  ['a flagged page', [page200(flaggedPage)], 'flagged', false],
  ['HTTP 403 with a flagged page', [status(403, flaggedPage)], 'flagged', false],
  ['a flagged page after the confirmation', [confirmationPage, page200(flaggedPage)], 'flagged', false],
  [
    'a page that says nothing known',
    [page200('<html><body><p>Something else.</p></body></html>')],
    'unrecognized_page',
    false,
  ],
  [
    'a JSON answer',
    [() => new Response('{"error":"x"}', {headers: {'Content-Type': 'application/json'}})],
    'unrecognized_page',
    false,
  ],
  ['a second confirmation page', [confirmationPage, confirmationPage], 'unrecognized_page', false],
  // Drive's page in a shape AMCP does not accept is not a sign-in page, whatever else it says.
  [
    'a confirmation page of another shape that also says sign in',
    [
      page200(
        '<html><body><p>Google Drive can’t scan this file for viruses. Sign in to continue.</p>' +
          '<form action="/other"><input type="submit" value="Download anyway"></form></body></html>',
      ),
    ],
    'unrecognized_page',
    false,
  ],
];
for (const [name, replies, reason, retryable] of reasons)
  test('a refused public Drive download says why: ' + name + ' is ' + reason, async () => {
    const {fetcher, requests} = drive(...replies),
      e = await refusal(downloadDriveMedia(share, fetcher));
    assertRefused(e, 'DRIVE_FILE_UNAVAILABLE');
    assert.equal(e.details.reason, reason);
    assert.equal(e.retryable, retryable);
    // A quota refusal says it may be tried again; no other reason does.
    assert.equal(e.status, reason === 'download_quota' ? 429 : 400);
    // Drive's refusals are answered once each, never retried, and a flagged file is never downloaded another way.
    assert.equal(requests.length, replies.length);
    assert.equal(
      requests.some(r => r.url.searchParams.has('acknowledgeAbuse')),
      false,
    );
    assert.deepEqual([...new Set(requests.map(r => r.url.origin))], ['https://drive.usercontent.google.com']);
  });
test('the four reasons say four different things, and only a quota refusal may be retried', async () => {
  const said = new Map<string, string>();
  for (const [, replies, reason] of reasons) {
    const e = await refusal(downloadDriveMedia(share, drive(...replies).fetcher));
    said.set(reason, e.message);
  }
  assert.deepEqual([...said.keys()].sort(), ['download_quota', 'flagged', 'not_shared', 'unrecognized_page']);
  assert.equal(new Set(said.values()).size, 4);
  assert.match(said.get('not_shared')!, /Drive connection/);
  assert.match(said.get('download_quota')!, /later/);
  assert.match(said.get('flagged')!, /different file/);
});
test('only Google’s sign-in host is read as a sign-in: a redirect to any other host stays an unapproved source', async () => {
  for (const location of [
    'https://www.google.com/',
    'https://drive.google.com/uc?id=synFileIdAbcdefghij1',
    'https://accounts.google.com:8443/ServiceLogin',
    'http://accounts.google.com/ServiceLogin',
    'https://accounts.google.com.attacker.invalid/ServiceLogin',
    'https://attacker.invalid/accounts.google.com',
  ]) {
    const {fetcher, requests} = drive(redirect(location), file);
    const e = await refusal(downloadDriveMedia(share, fetcher));
    assertRefused(e, 'UNAPPROVED_MEDIA_SOURCE');
    assert.equal(e.details.reason, undefined, location);
    assert.equal(requests.length, 1, location);
  }
});
test('a declared length over the limit on a page is refused as too large before the page is read', async () => {
  const long = body(MAX_MEDIA_BYTES + 1, {'Content-Length': String(MAX_MEDIA_BYTES + 1), 'Content-Type': 'text/html'}),
    e = await refusal(downloadDriveMedia(share, drive(() => long.response).fetcher));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 1);
  // The stream's own first chunk may be queued before the answer arrives; nothing is read from it.
  assert.ok(long.sent.pulled <= 1024 * 1024, 'pulled ' + long.sent.pulled);
  assert.equal(long.sent.cancelled, true);
});
test('the shared reader refuses a declared length over its limit before it reads, and cuts an undeclared stream at the limit', async () => {
  const declared = body(5000, {'Content-Length': '5000'}),
    e = await refusal(readMediaBody(declared.response, 1000));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.size_bytes, 5000);
  assert.equal(e.details.maximum_bytes, 1000);
  assert.equal(declared.sent.pulled, 0);
  assert.equal(declared.sent.cancelled, true);
  const undeclared = body(5 * 1024 * 1024),
    cut = await refusal(readMediaBody(undeclared.response, 1000));
  assertRefused(cut, 'MEDIA_TOO_LARGE');
  assert.equal(cut.details.size_bytes, undefined);
  assert.equal(cut.details.maximum_bytes, 1000);
  assert.equal(undeclared.sent.cancelled, true);
  assert.ok(undeclared.sent.pulled <= 3 * 1024 * 1024, 'pulled ' + undeclared.sent.pulled);
});
test('a refusal that came from an HTTP status carries that status, and one that came from a page or a redirect does not', async () => {
  for (const [reply, httpStatus] of [
    [status(404), 404],
    [status(429), 429],
    [status(403, quotaPage), 403],
    [status(401), 401],
  ] as const) {
    const e = await refusal(downloadDriveMedia(share, drive(reply).fetcher));
    assert.equal(e.details.http_status, httpStatus);
  }
  for (const reply of [page200(quotaPage), redirect(signIn)]) {
    const e = await refusal(downloadDriveMedia(share, drive(reply).fetcher));
    assert.equal(e.details.http_status, undefined);
  }
});
test('a length header that is not a whole number of bytes declares nothing: the stream is still read, and still capped', async () => {
  for (const header of ['12abc', '1e9', '-1', '1,2', '99999999999999999999', '']) {
    const got = await downloadDriveMedia(
      share,
      drive(() => new Response(new Uint8Array(png), {headers: {'Content-Length': header}})).fetcher,
    );
    assert.deepEqual(got.bytes, png, 'content-length: ' + header);
  }
  const long = body(MAX_MEDIA_BYTES + 2 * 1024 * 1024, {'Content-Length': '12abc'}),
    e = await refusal(downloadDriveMedia(share, drive(() => long.response).fetcher));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(long.sent.cancelled, true);
});
test('an answer that is neither a page nor a known refusal keeps today’s refusal, with its status and no reason', async () => {
  const e = await refusal(downloadDriveMedia(share, drive(status(500)).fetcher));
  assertRefused(e, 'DRIVE_FILE_UNAVAILABLE');
  assert.equal(e.details.http_status, 500);
  assert.equal(e.details.reason, undefined);
});

/** A body of `total` bytes in 1 MiB pieces that records what was pulled and whether it was cancelled. */
function body(total: number, headers: Record<string, string> = {}) {
  const sent = {pulled: 0, cancelled: false};
  const piece = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent.pulled >= total) return c.close();
      const n = Math.min(piece.length, total - sent.pulled);
      sent.pulled += n;
      c.enqueue(piece.subarray(0, n));
    },
    cancel() {
      sent.cancelled = true;
    },
  });
  return {response: new Response(stream, {headers: {'Content-Type': 'application/octet-stream', ...headers}}), sent};
}
test('a declared length over the limit is refused with both sizes before any byte is read, on the first request', async () => {
  const big = body(MAX_MEDIA_BYTES + 5, {'Content-Length': String(MAX_MEDIA_BYTES + 5)}),
    {sink, written} = counting(),
    {fetcher, requests} = drive(() => big.response),
    e = await refusal(downloadDriveMedia(share, fetcher, sink));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 5);
  assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
  assert.match(e.message, /too large/i);
  assert.ok(
    e.message.includes(mebibytes(MAX_MEDIA_BYTES + 5)) && e.message.includes(mebibytes(MAX_MEDIA_BYTES)),
    e.message,
  );
  assert.equal(big.sent.cancelled, true);
  assert.equal(written(), 0);
  assert.equal(requests.length, 1);
});
test('the same refusal after the confirmation: the confirmed answer declares its length, and nothing is staged', async () => {
  const big = body(MAX_MEDIA_BYTES + 5, {'Content-Length': String(MAX_MEDIA_BYTES + 5)}),
    {sink, written} = counting(),
    {fetcher, requests} = drive(confirmationPage, () => big.response),
    e = await refusal(downloadDriveMedia(share, fetcher, sink));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 5);
  assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
  assert.equal(big.sent.cancelled, true);
  assert.equal(written(), 0);
  assert.equal(requests.length, 2);
});
test('a file one byte over the limit never reads as equal to it', async () => {
  const e = await refusal(
    downloadDriveMedia(
      share,
      drive(() => body(MAX_MEDIA_BYTES + 1, {'Content-Length': String(MAX_MEDIA_BYTES + 1)}).response).fetcher,
    ),
  );
  assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 1);
  const [size, maximum] = [e.localization!.values.size, e.localization!.values.maximum];
  assert.notEqual(size, maximum);
  assert.equal(maximum, mebibytes(MAX_MEDIA_BYTES));
});
test('a stream with no declared length is cut once it passes the limit, and the refusal gives the maximum alone', async () => {
  const long = body(MAX_MEDIA_BYTES + 8 * 1024 * 1024),
    {sink, written} = counting(),
    e = await refusal(downloadDriveMedia(share, drive(() => long.response).fetcher, sink));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
  assert.equal(e.details.size_bytes, undefined);
  assert.match(e.message, /too large/i);
  assert.equal(long.sent.cancelled, true);
  assert.ok(written() <= MAX_MEDIA_BYTES, 'the sink held ' + written() + ' bytes');
  assert.ok(long.sent.pulled < MAX_MEDIA_BYTES + 3 * 1024 * 1024, 'pulled ' + long.sent.pulled);
});
test('a link import over the limit gives both sizes too', async () => {
  const request: LinkRequest = async () =>
    new Response(body(MAX_MEDIA_BYTES + 7, {'Content-Length': String(MAX_MEDIA_BYTES + 7)}).response.body, {
      headers: {'Content-Length': String(MAX_MEDIA_BYTES + 7)},
    });
  const e = await refusal(downloadMediaLink('https://cdn.example.com/a.mp4', {request}));
  assertRefused(e, 'MEDIA_TOO_LARGE');
  assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 7);
  assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
});
test('a private Drive file over the limit, by its metadata, gives both sizes before any byte is downloaded', async () => {
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
    const calls: string[] = [],
      fetcher: typeof fetch = async u => {
        calls.push(String(u));
        return new Response(
          JSON.stringify({
            id: fileId,
            size: String(MAX_MEDIA_BYTES + 9),
            mimeType: 'video/mp4',
            capabilities: {canDownload: true},
          }),
        );
      },
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
    assertRefused(e, 'MEDIA_TOO_LARGE');
    assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 9);
    assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
  }
});
test('a website upload that declares more than the limit is refused with both sizes', () => {
  const store = new Store(':memory:', key);
  try {
    const e = (() => {
      try {
        new MediaSources(store, true).begin(operator, {filename: 'big.mp4', size: MAX_MEDIA_BYTES + 3});
      } catch (error) {
        return error as MirrorError;
      }
      return assert.fail('expected a refusal');
    })();
    assertRefused(e, 'MEDIA_TOO_LARGE');
    assert.equal(e.details.size_bytes, MAX_MEDIA_BYTES + 3);
    assert.equal(e.details.maximum_bytes, MAX_MEDIA_BYTES);
  } finally {
    store.close();
  }
});

/** A service whose Drive host is `source`, with a Meta login so prepare gets as far as the download; no platform answers. */
function service(source: typeof fetch) {
  const store = new Store(':memory:', key),
    providerCalls: string[] = [];
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
  const transport = new NativeTransport((async input => {
      providerCalls.push(String(input));
      throw Error('no provider request is expected');
    }) as typeof fetch),
    svc = new MirrorService(
      new Registry(),
      store,
      transport,
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
      source,
    );
  const rows = (table: string) => (store.db.prepare('SELECT count(*) AS n FROM ' + table).get() as {n: number}).n;
  return {
    store,
    svc,
    providerCalls,
    prepare: () =>
      svc.call('amcp_media', {action: 'prepare', platform: 'meta', account_id: '123', drive_url: share}, operator),
    leftBehind: () => ({
      staging: rows('media_staging'),
      chunks: rows('media_chunks'),
      admissions: rows('media_admissions'),
    }),
  };
}
test('prepare with a confirmed file over the limit says so with both sizes, and leaves no staging, chunk or lease', async () => {
  const big = body(MAX_MEDIA_BYTES + 5, {'Content-Length': String(MAX_MEDIA_BYTES + 5)}),
    {fetcher, requests} = drive(confirmationPage, () => big.response),
    f = service(fetcher);
  try {
    const out = await f.prepare();
    assertRefused(out, 'MEDIA_TOO_LARGE', {writes: () => f.providerCalls.length});
    assert.equal(out.error.details.size_bytes, MAX_MEDIA_BYTES + 5);
    assert.equal(out.error.details.maximum_bytes, MAX_MEDIA_BYTES);
    assert.deepEqual(out.error.message_localization.values, {
      size: mebibytes(MAX_MEDIA_BYTES + 5),
      maximum: mebibytes(MAX_MEDIA_BYTES),
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(f.leftBehind(), {staging: 0, chunks: 0, admissions: 0});
  } finally {
    f.store.close();
  }
});
test('prepare with a stream cut at the limit leaves no staging, chunk or lease either', async () => {
  const f = service(drive(() => body(MAX_MEDIA_BYTES + 8 * 1024 * 1024).response).fetcher);
  try {
    const out = await f.prepare();
    assertRefused(out, 'MEDIA_TOO_LARGE', {writes: () => f.providerCalls.length});
    assert.equal(out.error.details.maximum_bytes, MAX_MEDIA_BYTES);
    // The sink had flushed chunks of the stream before it passed the limit: they are gone with the staging row.
    assert.deepEqual(f.leftBehind(), {staging: 0, chunks: 0, admissions: 0});
  } finally {
    f.store.close();
  }
});
test('prepare with a sign-in redirect says the file is not shared, as a refusal with its reason', async () => {
  const f = service(drive(redirect(signIn)).fetcher);
  try {
    const out = await f.prepare();
    assertRefused(out, 'DRIVE_FILE_UNAVAILABLE', {writes: () => f.providerCalls.length});
    assert.equal(out.error.details.reason, 'not_shared');
    assert.equal(out.error.category, 'request');
    assert.deepEqual(f.leftBehind(), {staging: 0, chunks: 0, admissions: 0});
  } finally {
    f.store.close();
  }
});

test('every sentence a refused download or a too-large file says has its Arabic, with the same slots', async () => {
  const errors: MirrorError[] = [];
  for (const [, replies] of reasons) errors.push(await refusal(downloadDriveMedia(share, drive(...replies).fetcher)));
  errors.push(
    await refusal(
      downloadDriveMedia(
        share,
        drive(() => body(MAX_MEDIA_BYTES + 1, {'Content-Length': String(MAX_MEDIA_BYTES + 1)}).response).fetcher,
      ),
    ),
  );
  errors.push(await refusal(downloadDriveMedia(share, drive(() => body(MAX_MEDIA_BYTES + 1).response).fetcher)));
  // A download whose place in the shared media budget lapsed has a sentence of its own (fix round 2, S4-1).
  const lapsed = {
    write() {
      throw new MirrorError('MEDIA_ADMISSION_LOST', 'Fixture');
    },
    finish: () => Buffer.alloc(0),
  };
  errors.push(await refusal(readMediaBody(new Response(new Uint8Array(png)), MAX_MEDIA_BYTES, lapsed)));
  const sentences = new Set<string>();
  for (const e of errors) {
    sentences.add(keyOf(e));
    // A remedy is a sentence the website shows as well.
    sentences.add(errorResult(e, 'request', 1).error.remedy.action);
  }
  assert.ok(sentences.size >= 12, 'sentences: ' + [...sentences].join(' | '));
  for (const sentence of sentences) {
    assert.ok(Object.hasOwn(catalog, sentence), 'no Arabic for: ' + sentence);
    assert.equal(slots(catalog[sentence]!), slots(sentence), 'the slots of the Arabic differ: ' + sentence);
    assert.match(catalog[sentence]!, /[؀-ۿ]/, 'the Arabic has no Arabic letters: ' + sentence);
  }
});

test('the website carries a parameterized refusal’s template and values, so its Arabic can fill them in', async () => {
  const master = Buffer.alloc(32, 53).toString('base64'),
    password = 'synthetic-test-password-only',
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master),
    svc = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    listener = await listenForFetch(
      createHttpApp(svc, store, {website: {origin, masterKey: master, adminPassword: password}}),
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
      refused = await fetch(base + '/api/media/sources', {
        method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-AMCP-CSRF': csrf},
        body: JSON.stringify({filename: 'big.mp4', size: MAX_MEDIA_BYTES + 1, type: 'video/mp4'}),
      }),
      answer = await refused.json();
    assert.equal(refused.status, 400, JSON.stringify(answer));
    assert.equal(answer.error.code, 'MEDIA_TOO_LARGE');
    assert.deepEqual(answer.error.message_localization.values, {
      size: mebibytes(MAX_MEDIA_BYTES + 1),
      maximum: mebibytes(MAX_MEDIA_BYTES),
    });
    assert.ok(Object.hasOwn(catalog, answer.error.message_localization.key));
    assert.equal(
      answer.error.message,
      answer.error.message_localization.key
        .replace('{size}', mebibytes(MAX_MEDIA_BYTES + 1))
        .replace(/\{maximum\}/g, mebibytes(MAX_MEDIA_BYTES)),
    );
    // A refusal with no parameters is unchanged: its code and message, nothing more.
    const plain = await fetch(base + '/api/media/sources/not-an-upload', {headers: {Cookie: cookie}}),
      plainAnswer = await plain.json();
    assert.equal(plain.status, 400, JSON.stringify(plainAnswer));
    assert.deepEqual(Object.keys(plainAnswer.error).sort(), ['code', 'message']);
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
