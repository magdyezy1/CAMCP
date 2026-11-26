import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as wire from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const {NativeTransport} = wire;

// r25-mf-jobs item 7, F7 and F8: every request had the transport's 30 s limit, which a 128 MiB video can only meet at 4.3 MiB/s;
// the abort cut the upload off and left the file uncertain. A request that carries a reviewed upload now gets the transport's
// 30 s for the connection and the provider's answer, plus the time its body needs at the media layer's own throughput
// floor (1 MiB/s, src/media-upload.ts), whatever form the body takes: a multipart file, or the base64 of a Meta image in
// JSON. The same holds for LinkedIn's single PUT and for each chunk of a Google video. No request may take longer than
// the window the planner gives a transfer. Every other request keeps the limit, and the abort still cancels the upload.
// Synthetic fetchers only.
const MiB = 1024 * 1024;
const plan = {
  gateway: 'meta_native_action',
  action: 'AMCP_REVIEWED_MEDIA',
  method: 'POST',
  path: '/v26.0/act_123/advideos',
  query: {},
  headers: {},
  body: {title: 'Synthetic video'},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
};
const connection = {
  id: 'c',
  tenantId: 't',
  gateway: 'meta_native_action',
  accounts: ['123'],
  writeAccounts: ['123'],
  label: 'test',
  enabled: true,
  scopes: [],
};
const upload = bytes => ({field: 'source', bytes: Buffer.alloc(bytes), filename: 'v.mp4', mime: 'video/mp4'});

/** The limits every request of `send` asked AbortSignal.timeout for. */
async function limitsOf(send, ...constructor) {
  const asked = [],
    real = AbortSignal.timeout.bind(AbortSignal),
    timer = mock.method(AbortSignal, 'timeout', ms => (asked.push(ms), real(ms)));
  try {
    await send(
      new NativeTransport(
        async () => Response.json({id: '1'}),
        async () => {},
        ...constructor,
      ),
    );
  } finally {
    timer.mock.restore();
  }
  return asked;
}
const request =
  (body, file, extra = {}) =>
  transport =>
    transport.request({...plan, ...extra, body}, connection, {accessToken: 't'}, file);

test('an upload gets the transport’s limit and the time its body needs at the media layer’s throughput floor', async () => {
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(128 * MiB))), [30000 + 128000]);
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(64 * MiB))), [30000 + 64000], 'it grows with the body');
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(MiB))), [30000 + 1000], 'a 1 MiB upload');
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(0))), [30000], 'an upload of fields only');
  // The transport's own limit is the base, whatever it is set to.
  assert.deepEqual(await limitsOf(request({title: 'v'}, upload(MiB)), 45000), [46000]);
});

test('the base64 image of a Meta upload, which is no multipart file, gets the same time (F7)', async () => {
  const image = {path: '/v26.0/act_123/adimages', body: {bytes: 'A'.repeat(40 * MiB), name: 'image.png'}};
  const [limit] = await limitsOf(request(image.body, undefined, {path: image.path}));
  // 40 MiB of base64 and a name: what is sent is about 40 MiB, at 1 MiB/s.
  assert.ok(limit >= 30000 + 40000 && limit <= 30000 + 40100, 'the limit was ' + limit + ' ms');
  const small = await limitsOf(request({bytes: 'A'.repeat(MiB / 2), name: 'image.png'}, undefined, {path: image.path}));
  assert.ok(small[0] >= 30500 && small[0] <= 30600, 'half a mebibyte: ' + small[0] + ' ms');
});

test('a request that is not a reviewed upload keeps the transport’s limit, whatever its body', async () => {
  const ordinary = {action: 'AMCP_CAMPAIGN_WRITE', path: '/v26.0/act_123/campaigns'};
  assert.deepEqual(await limitsOf(request({name: 'x'.repeat(8 * MiB)}, undefined, ordinary)), [30000]);
  assert.deepEqual(await limitsOf(request({name: 'x'}, undefined, ordinary), 45000), [45000]);
  // A read.
  assert.deepEqual(
    await limitsOf(t =>
      t.request({...plan, method: 'GET', readOnly: true, body: undefined}, connection, {accessToken: 't'}),
    ),
    [30000],
  );
});

test('the limit of an upload request is the transport’s plus its transfer, and never more than the planner’s window', () => {
  const limit = (...args) => wire.uploadTimeoutMs(...args);
  assert.equal(limit(30000, 0), 30000);
  assert.equal(limit(30000, 128 * MiB), 30000 + 128000);
  assert.equal(limit(30000, 1024 * MiB), 30000 + 1024000, 'a body of 1 GiB needs 17 minutes more');
  assert.equal(
    limit(30000, 5e12),
    wire.MEDIA_TRANSFER_WINDOW_MS,
    'a body no transfer could finish is held to the window',
  );
  assert.equal(
    limit(wire.MEDIA_TRANSFER_WINDOW_MS + 1, MiB),
    wire.MEDIA_TRANSFER_WINDOW_MS + 1,
    'never below the base',
  );
});

test('the single request of a LinkedIn upload and each chunk of a Google video get the time their bytes need (F7)', async () => {
  const linkedin = await limitsOf(t =>
    t.uploadLinkedIn('https://www.linkedin.com/dms-uploads/abc', Buffer.alloc(128 * MiB), 'video/mp4'),
  );
  assert.deepEqual(linkedin, [30000 + 128000], 'one PUT of 128 MiB');
  // Chunks of 4 MiB: 4, 4 and 1 MiB. A query of the offset carries no body and keeps the transport's limit.
  const google = await limitsOf(t =>
    t.uploadGoogleVideo('https://googleads.googleapis.com/resumable/upload/abc', Buffer.alloc(9 * MiB), 'token', {
      granularity: 262144,
    }),
  );
  assert.deepEqual(google, [34000, 34000, 31000]);
});

test('the request limit and the media planner agree on the throughput floor and the window, from one definition (F8)', () => {
  const href = name => new URL('../dist/src/' + name, import.meta.url).href;
  const script = `
    import * as wire from ${JSON.stringify(href('transport.js'))};
    import * as media from ${JSON.stringify(href('media-upload.js'))};
    const bytes = 128 * 1048576;
    console.log(JSON.stringify({
      limit: wire.uploadTimeoutMs(30000, bytes),
      window: wire.MEDIA_TRANSFER_WINDOW_MS,
      planned: media.MEDIA_TRANSFER_WINDOW_MS,
      estimate: media.mediaTransferEstimateMs({platform: 'meta', kind: 'video'}, bytes),
    }));`;
  const read = env =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: {...process.env, ...env},
        encoding: 'utf8',
      }),
    );
  // A slow floor and a long window, as an operator may configure them: the planner accepts this transfer (2048 s of bytes
  // in a 90-minute window), so no request of it may be cut off at ten minutes.
  const slow = read({AMCP_MEDIA_TRANSFER_BYTES_PER_SECOND: '65536', AMCP_MEDIA_TRANSFER_WINDOW_MINUTES: '90'});
  assert.equal(slow.window, 90 * 60000);
  assert.equal(slow.planned, slow.window, 'the planner and the transport read one window');
  assert.equal(slow.limit, 30000 + 2048000, '128 MiB at 64 KiB/s, and the 30 s');
  assert.ok(slow.limit <= slow.window);
  assert.ok(slow.estimate > slow.limit - 30000, 'the planner counts at least the same transfer time');
  // The defaults.
  const normal = read({});
  assert.equal(normal.window, 60 * 60000);
  assert.equal(normal.limit, 30000 + 128000);
  // A value outside the bounds both read is ignored by both.
  const bad = read({AMCP_MEDIA_TRANSFER_BYTES_PER_SECOND: '1', AMCP_MEDIA_TRANSFER_WINDOW_MINUTES: '1'});
  assert.equal(bad.window, 60 * 60000);
  assert.equal(bad.planned, bad.window);
  assert.equal(bad.limit, 30000 + 128000, 'the default floor applies');
});

test('the abort still cancels an upload: a limit that fires ends it as an uncertain write, and a refusal is unchanged', async () => {
  const controller = new AbortController(),
    timer = mock.method(AbortSignal, 'timeout', () => controller.signal);
  let signal;
  try {
    const transport = new NativeTransport(
        (url, init) => {
          signal = init.signal;
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(init.signal.reason)),
          );
        },
        async () => {},
      ),
      sent = transport.request(plan, connection, {accessToken: 't'}, upload(128 * MiB));
    setTimeout(() => controller.abort(new DOMException('Timer expired', 'TimeoutError')), 20);
    await assert.rejects(sent, error => assertRefused(error, 'WRITE_OUTCOME_UNCERTAIN'));
    assert.equal(signal, controller.signal, 'the request that was sent carries the limit’s own signal');
    assert.equal(signal.aborted, true);
  } finally {
    timer.mock.restore();
  }
  // A read-only upload is still refused before anything is sent.
  await assert.rejects(
    new NativeTransport(
      async () => Response.json({}),
      async () => {},
    ).request({...plan, readOnly: true, method: 'GET'}, connection, {accessToken: 't'}, upload(1)),
    error => assertRefused(error, 'INVALID_UPLOAD'),
  );
});
